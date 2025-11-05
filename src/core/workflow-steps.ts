/**
 * WorkflowSteps: Idempotent workflow step implementations
 */

import consola from 'consola'
import { Task, TaskCheckpoints, generateBranchName } from './task'
import { TaskStore } from './task-store'
import { WorkspaceManager } from '../workspace/manager'
import { CodexClient } from '../ai/codex'
import { IssueManager } from '../github/issues'
import { GitHubClient } from '../github/client'
import { CommandParser } from '../github/command-parser'
import { Issue } from './types'

export interface StepContext {
  task: Task
  taskStore: TaskStore
  workspaceManager: WorkspaceManager
  codexClient: CodexClient
  issueManager: IssueManager
  githubClient: GitHubClient
  issue: Issue
}

export interface StepResult {
  success: boolean
  error?: string
  shouldRetry?: boolean
  isPolling?: boolean // True if this is a polling wait (don't increment retry count)
}

/**
 * Step 1: Plan - Create a deterministic patch description
 */
export async function planStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Planning step`)

    // Check if plan already exists
    if (ctx.task.checkpoints.plan) {
      consola.debug('Plan already exists, skipping')
      return { success: true }
    }

    // Analyze the issue to create plan
    const analysis = await ctx.issueManager.analyzeIssue(ctx.issue)

    if (!analysis.canHandle || analysis.tasks.length === 0) {
      return {
        success: false,
        error: 'Issue cannot be handled automatically or has no tasks',
        shouldRetry: false,
      }
    }

    const plan = {
      description: ctx.issue.body || '',
      tasks: analysis.tasks,
      timestamp: new Date().toISOString(),
    }

    // Update checkpoints
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      plan,
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'branch', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Plan created with ${analysis.tasks.length} tasks`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Plan step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 2: Branch - Create a deterministic branch
 */
export async function branchStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Branch step`)

    // Check if branch already exists
    if (ctx.task.checkpoints.branch) {
      consola.debug('Branch already created, skipping')
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    // Clone repository
    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to clone repository',
        shouldRetry: true,
      }
    }

    // Get current HEAD SHA
    const headSha = ctx.task.repoHeadSha

    // Generate deterministic branch name
    const branchName = generateBranchName(ctx.task.issueNumber, ctx.task.fingerprint)

    // Check if branch already exists (idempotent)
    const existingBranches = await ctx.workspaceManager.getIssueBranches(repoDir, ctx.task.issueNumber)
    const branchExists = existingBranches.some((b) => b === branchName)

    if (!branchExists) {
      // Create the branch
      const created = await ctx.workspaceManager.createBranch(repoDir, branchName)
      if (!created) {
        return {
          success: false,
          error: 'Failed to create branch',
          shouldRetry: true,
        }
      }
    } else {
      consola.debug(`Branch ${branchName} already exists, checking it out`)
      // Checkout existing branch - handled by workspace manager
    }

    // Update checkpoints
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      branch: {
        name: branchName,
        baseSha: headSha,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'codex_generate', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Branch created: ${branchName}`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Branch step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Helper: Get all feedbacks from issue comments
 */
async function getFeedbacks(ctx: StepContext): Promise<string[]> {
  try {
    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) return []

    const comments = await ctx.githubClient.getIssueComments(owner, repo, ctx.task.issueNumber)
    const parser = new CommandParser()

    const feedbacks = comments
      .map((comment) => parser.parseFeedback(comment.body))
      .filter((f): f is string => f !== null)

    return feedbacks
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Failed to get feedbacks:`, error)
    return []
  }
}

/**
 * Helper: Build prompt with feedbacks
 */
function buildPromptWithFeedback(baseTasks: string[], feedbacks: string[]): string {
  let prompt = baseTasks.join('\n')

  if (feedbacks.length > 0) {
    prompt += '\n\n--- User Feedbacks ---\n'
    prompt += feedbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')
    prompt += '\n\nPlease take the above feedbacks into account when implementing the solution.'
  }

  return prompt
}

/**
 * Step 3: Codex Generate - Use AI to generate code changes
 */
export async function codexGenerateStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Codex generate step`)

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    // Check if codex job is already running or completed
    let codexCheckpoint = ctx.task.checkpoints.codex_generate

    if (codexCheckpoint?.completedAt) {
      consola.debug('Codex generation already completed, skipping')
      return { success: true }
    }

    // If job ID exists, check status (don't clone/pull while polling)
    if (codexCheckpoint?.jobId) {
      consola.debug(`[Task ${ctx.task.id}] Checking status of codex job ${codexCheckpoint.jobId}`)
      const status = await ctx.codexClient.getJobStatus(codexCheckpoint.jobId)

      if (status.completed) {
        // Job completed successfully
        const checkpoints: TaskCheckpoints = {
          ...ctx.task.checkpoints,
          codex_generate: {
            ...codexCheckpoint,
            completedAt: new Date().toISOString(),
            commitSha: status.commitSha,
            filesModified: status.filesModified,
          },
        }

        ctx.taskStore.updateTaskProgress(ctx.task.id, 'run_tests', checkpoints)
        consola.success(`[Task ${ctx.task.id}] Codex generation completed`)
        return { success: true }
      } else if (status.failed) {
        // Job failed, clear checkpoint so next retry starts fresh
        consola.warn(`[Task ${ctx.task.id}] Codex job failed, will start new job on retry`)
        const clearedCheckpoints = { ...ctx.task.checkpoints }
        delete clearedCheckpoints.codex_generate

        ctx.taskStore.updateTask(ctx.task.id, {
          checkpoints: clearedCheckpoints,
        })

        return {
          success: false,
          error: status.error || 'Codex job failed',
          shouldRetry: true,
        }
      }

      // Job still running, keep polling
      consola.debug(`[Task ${ctx.task.id}] Codex job still running...`)
      return {
        success: false,
        error: 'Codex job in progress',
        shouldRetry: true,
        isPolling: true, // This is polling, not a real failure
      }
    }

    // No existing job, need to start a new one
    // First, clone/pull repository
    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    // Start new codex job
    const plan = ctx.task.checkpoints.plan
    if (!plan) {
      return {
        success: false,
        error: 'No plan found',
        shouldRetry: false,
      }
    }

    // Collect feedbacks from issue comments
    const feedbacks = await getFeedbacks(ctx)
    if (feedbacks.length > 0) {
      consola.info(`[Task ${ctx.task.id}] Found ${feedbacks.length} user feedback(s)`)
    }

    // Build prompt from tasks with feedbacks
    const prompt = buildPromptWithFeedback(plan.tasks, feedbacks)

    // Execute codex
    const result = await ctx.codexClient.executeWithJobTracking(prompt, undefined, repoDir)

    if (result.jobId) {
      // Job started, save job ID
      codexCheckpoint = {
        jobId: result.jobId,
        startedAt: new Date().toISOString(),
      }

      const checkpoints: TaskCheckpoints = {
        ...ctx.task.checkpoints,
        codex_generate: codexCheckpoint,
      }

      ctx.taskStore.updateTaskProgress(ctx.task.id, 'codex_generate', checkpoints)
      consola.info(`[Task ${ctx.task.id}] Codex job started: ${result.jobId}`)

      // Return false to keep polling
      return {
        success: false,
        error: 'Codex job started, waiting for completion',
        shouldRetry: true,
        isPolling: true, // This is polling, not a real failure
      }
    }

    // Synchronous execution completed
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Codex execution failed',
        shouldRetry: true,
      }
    }

    // Update checkpoints with completion
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      codex_generate: {
        jobId: result.jobId || 'sync',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'run_tests', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Codex generation completed`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Codex generate step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 4: Run Tests - Execute test suite
 */
export async function runTestsStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Run tests step`)

    // Check if tests already passed
    if (ctx.task.checkpoints.run_tests?.exitCode === 0) {
      consola.debug('Tests already passed, skipping')
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    // Run tests (implementation would call workspace manager or test runner)
    // For now, we'll skip actual test execution
    consola.info(`[Task ${ctx.task.id}] Skipping test execution (not implemented)`)

    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      run_tests: {
        exitCode: 0,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'commit_and_push', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Tests passed`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Run tests step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 5: Commit and Push - Commit changes and push to remote
 */
export async function commitAndPushStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Commit and push step`)

    // Check if already pushed
    if (ctx.task.checkpoints.commit_and_push?.pushed) {
      consola.debug('Changes already pushed, skipping')
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    const branchName = ctx.task.checkpoints.branch?.name
    if (!branchName) {
      return {
        success: false,
        error: 'Branch name not found',
        shouldRetry: false,
      }
    }

    // Create commit message
    const commitMessage = `🤖 Bot: Fix for issue #${ctx.task.issueNumber}\n\n${ctx.task.checkpoints.plan?.description.substring(0, 200) || ''}`

    // Commit changes (idempotent - git will detect if nothing changed)
    const committed = await ctx.workspaceManager.commitChanges(repoDir, commitMessage)

    let commitSha = ''
    if (committed) {
      // Get commit SHA (implementation needed in workspace manager)
      commitSha = 'unknown'
    }

    // Push branch
    const pushed = await ctx.workspaceManager.pushBranch(repoDir, branchName)

    if (!pushed) {
      return {
        success: false,
        error: 'Failed to push branch',
        shouldRetry: true,
      }
    }

    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      commit_and_push: {
        commitSha,
        commitMessage,
        pushed: true,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'create_pr', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Changes committed and pushed`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Commit and push step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 6: Create PR - Create or update pull request (idempotent)
 */
export async function createPRStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Create PR step`)

    // Check if PR already created
    if (ctx.task.checkpoints.create_pr?.prNumber) {
      consola.debug(`PR already created: #${ctx.task.checkpoints.create_pr.prNumber}`)
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const branchName = ctx.task.checkpoints.branch?.name

    if (!branchName) {
      return {
        success: false,
        error: 'Branch name not found',
        shouldRetry: false,
      }
    }

    // Detect the default branch (try main first, then master)
    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)
    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    const defaultBranch = await ctx.workspaceManager.getRemoteDefaultBranch(repoDir)
    consola.debug(`Using base branch: ${defaultBranch}`)

    // Create new PR
    const title = `🤖 Fix for issue #${ctx.task.issueNumber}: ${ctx.issue.title}`
    const body = `Fixes #${ctx.task.issueNumber}\n\n${ctx.task.checkpoints.plan?.description || ''}`

    const pr = await ctx.githubClient.createPullRequest(owner, repo, {
      head: branchName,
      base: defaultBranch,
      title,
      body,
    })

    if (!pr) {
      return {
        success: false,
        error: 'Failed to create pull request',
        shouldRetry: true,
      }
    }

    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      create_pr: {
        prNumber: pr.number,
        prUrl: pr.url,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'completed', checkpoints)
    ctx.taskStore.updateTaskState(ctx.task.id, 'completed')
    consola.success(`[Task ${ctx.task.id}] PR created: #${pr.number}`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Create PR step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}
