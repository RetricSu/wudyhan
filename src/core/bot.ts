import consola from 'consola'
import { BotConfig, BotStatus, Issue } from './types'
import { GitHubClient } from '../github/client'
import { IssueManager } from '../github/issues'
import { WorkspaceManager } from '../workspace/manager'
import { CodexClient } from '../ai/codex'
import { TaskDatabase } from './database'
import { TaskStore } from './task-store'
import { WorkflowEngine } from './workflow-engine'
import { Worker } from './worker'
import { RetryManager } from './retry-manager'
import { CodexJobStore } from './codex-job-store'
import { CodexJobManager } from './codex-job-manager'
import { CommentMonitor } from '../github/comment-monitor'
import { sha256 } from './task'

export class GitHubMaintainBot {
  private config: BotConfig
  private isRunning = false
  private scanIntervalId?: NodeJS.Timeout
  private status: BotStatus = {
    isRunning: false,
    lastCheck: new Date(),
    processedIssues: 0,
    activeTasks: 0,
  }

  private githubClient: GitHubClient
  private issueManager: IssueManager
  private workspaceManager: WorkspaceManager
  private codexClient: CodexClient

  // New architecture components
  private database: TaskDatabase
  private taskStore: TaskStore
  private workflowEngine: WorkflowEngine
  private worker: Worker
  private retryManager: RetryManager
  private codexJobStore: CodexJobStore
  private codexJobManager: CodexJobManager
  private commentMonitor: CommentMonitor

  constructor(config: BotConfig) {
    this.config = config
    this.githubClient = new GitHubClient(config.githubToken, config.repositories)
    this.issueManager = new IssueManager(this.githubClient)
    this.workspaceManager = new WorkspaceManager()
    this.codexClient = new CodexClient({
      apiKey: config.codexApiKey,
      maxSteps: config.codexMaxSteps,
      maxExecutionTime: config.codexMaxExecutionTime,
    })

    // Initialize new architecture components
    this.database = new TaskDatabase('./data/tasks.db')
    this.taskStore = new TaskStore(this.database, undefined, 5 * 60 * 1000) // 5 min lock lease
    this.retryManager = new RetryManager(1000, 60000, 0.1) // 1s base, 60s max, 10% jitter

    // Initialize Codex job management
    this.codexJobStore = new CodexJobStore(this.database)
    this.codexJobStore.initSchema()
    this.codexJobManager = new CodexJobManager(this.codexJobStore)
    this.codexClient.setJobManager(this.codexJobManager)

    this.workflowEngine = new WorkflowEngine(
      this.taskStore,
      this.workspaceManager,
      this.codexClient,
      this.issueManager,
      this.githubClient,
      this.retryManager,
    )
    this.worker = new Worker(this.taskStore, this.workflowEngine, this.issueManager, {
      pollInterval: 10000, // 10 seconds
      lockRenewalInterval: 60000, // 1 minute
      maxConcurrentTasks: config.maxConcurrent || 3,
    })

    // Initialize comment monitor for command system
    this.commentMonitor = new CommentMonitor(this.taskStore, this.githubClient, {
      pollInterval: 30000, // 30 seconds
      enabled: true,
    })
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      consola.warn('Bot is already running')
      return
    }

    // Configure logging level first
    const logLevels: Record<string, number> = { error: 0, warn: 1, info: 3, debug: 4 }
    const level = logLevels[this.config.logLevel] ?? 3
    consola.level = level as 0 | 1 | 2 | 3 | 4 | 5

    consola.info('Starting GitHub Maintain Bot (New Architecture)...')
    consola.debug('Log level set to:', this.config.logLevel, '(level:', level, ')')
    this.isRunning = true
    this.status.isRunning = true

    // Recover orphaned Codex jobs
    consola.info('Recovering orphaned Codex jobs...')
    await this.codexJobManager.recoverJobs()

    // Start the worker
    await this.worker.start()

    // Start the comment monitor
    this.commentMonitor.start()

    // Run initial issue scan immediately
    consola.debug('Running initial issue scan...')
    await this.scanAndQueueIssues()

    // Start the scanning loop (creates tasks from issues)
    this.scanIntervalId = setInterval(async () => {
      await this.scanAndQueueIssues()
    }, this.config.interval)

    consola.success('Bot started successfully')
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      consola.warn('Bot is not running')
      return
    }

    consola.info('Stopping GitHub Maintain Bot...')
    this.isRunning = false
    this.status.isRunning = false

    if (this.scanIntervalId) {
      clearInterval(this.scanIntervalId)
      this.scanIntervalId = undefined
    }

    // Stop the comment monitor
    this.commentMonitor.stop()

    // Stop the worker
    await this.worker.stop()

    // Close database
    this.database.close()

    consola.success('Bot stopped successfully')
  }

  getStatus(): BotStatus {
    const workerStatus = this.worker.getStatus()
    return {
      ...this.status,
      activeTasks: workerStatus.activeTasks,
    }
  }

  /**
   * Scan for assigned issues and create tasks
   */
  private async scanAndQueueIssues(): Promise<void> {
    try {
      consola.debug('Scanning for assigned issues...')
      this.status.lastCheck = new Date()

      // Get assigned issues
      const issues = await this.issueManager.getAssignedIssues()

      if (issues.length === 0) {
        consola.debug('No assigned issues found')
        return
      }

      consola.info(`Found ${issues.length} assigned issues`)

      // Process each issue
      for (const issue of issues) {
        await this.queueIssueTask(issue)
      }
    } catch (error) {
      consola.error('Error during issue scan:', error)
    }
  }

  /**
   * Queue a task for an issue (idempotent)
   */
  private async queueIssueTask(issue: Issue): Promise<void> {
    try {
      // Analyze the issue to determine if we can handle it
      const analysis = await this.issueManager.analyzeIssue(issue)

      if (!analysis.canHandle) {
        consola.debug(`Issue #${issue.number} cannot be handled automatically`)
        return
      }

      const repo = `${issue.repository.owner.login}/${issue.repository.name}`

      // Get current repo HEAD SHA (for fingerprint)
      const repoHeadSha = issue.repository.owner.login // Placeholder - should get actual HEAD SHA

      // Calculate issue body hash
      const issueBodySha = sha256(issue.body || '')

      // Create task (idempotent - will return existing if fingerprint matches)
      const task = this.taskStore.createTask({
        issueNumber: issue.number,
        repo,
        repoHeadSha,
        issueBodySha,
        maxRetries: 5,
      })

      if (task) {
        if (task.state === 'pending') {
          consola.info(`Queued task ${task.id} for issue #${issue.number}`)
          this.status.processedIssues++
        } else {
          consola.debug(`Task ${task.id} already exists for issue #${issue.number} (state: ${task.state})`)
        }
      }
    } catch (error) {
      consola.error(`Error queuing task for issue #${issue.number}:`, error)
    }
  }

  // ============================================================================
  // Public API Methods
  // ============================================================================

  /**
   * Public method to manually scan for issues
   */
  async scanIssues(): Promise<Issue[]> {
    consola.info('Scanning for assigned issues...')
    const issues = await this.issueManager.getAssignedIssues()

    if (issues.length === 0) {
      consola.info('No assigned issues found')
      return []
    }

    consola.success(`Found ${issues.length} assigned issue(s)`)

    for (const issue of issues) {
      consola.info(`Issue #${issue.number}: ${issue.title}`)
      consola.info(`  Repository: ${issue.repository.owner.login}/${issue.repository.name}`)
      consola.info(`  State: ${issue.state}`)

      // Analyze if we can handle it
      const analysis = await this.issueManager.analyzeIssue(issue)
      consola.info(`  Can handle: ${analysis.canHandle}`)
      if (analysis.canHandle) {
        consola.info(`  Tasks found: ${analysis.tasks.length}`)
      }
      consola.info('') // Empty line for readability
    }

    return issues
  }

  /**
   * Get task store for advanced operations
   */
  getTaskStore(): TaskStore {
    return this.taskStore
  }

  /**
   * Get worker for status monitoring
   */
  getWorker(): Worker {
    return this.worker
  }
}
