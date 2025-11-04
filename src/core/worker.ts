/**
 * Worker: Manages task claiming and execution
 */

import consola from 'consola'
import { TaskStore } from './task-store'
import { WorkflowEngine } from './workflow-engine'
import { IssueManager } from '../github/issues'
import { Task } from './task'

export interface WorkerConfig {
  pollInterval: number // milliseconds between polling for tasks
  lockRenewalInterval: number // milliseconds between lock renewals
  maxConcurrentTasks: number
}

export class Worker {
  private taskStore: TaskStore
  private workflowEngine: WorkflowEngine
  private issueManager: IssueManager
  private config: WorkerConfig
  private isRunning: boolean = false
  private pollIntervalId?: NodeJS.Timeout
  private lockRenewalIntervalId?: NodeJS.Timeout
  private activeTasks: Map<string, Task> = new Map()

  constructor(
    taskStore: TaskStore,
    workflowEngine: WorkflowEngine,
    issueManager: IssueManager,
    config?: Partial<WorkerConfig>,
  ) {
    this.taskStore = taskStore
    this.workflowEngine = workflowEngine
    this.issueManager = issueManager

    this.config = {
      pollInterval: config?.pollInterval || 10000, // 10 seconds
      lockRenewalInterval: config?.lockRenewalInterval || 60000, // 1 minute
      maxConcurrentTasks: config?.maxConcurrentTasks || 3,
    }
  }

  /**
   * Start the worker
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      consola.warn('Worker is already running')
      return
    }

    consola.info('Starting worker...')
    this.isRunning = true

    // Start polling for tasks
    this.pollIntervalId = setInterval(() => this.pollTasks(), this.config.pollInterval)

    // Start lock renewal
    this.lockRenewalIntervalId = setInterval(() => this.renewLocks(), this.config.lockRenewalInterval)

    // Also poll for retry tasks
    setInterval(() => this.pollRetryTasks(), this.config.pollInterval * 2)

    // Do an initial poll
    await this.pollTasks()

    consola.success('Worker started')
  }

  /**
   * Stop the worker
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      consola.warn('Worker is not running')
      return
    }

    consola.info('Stopping worker...')
    this.isRunning = false

    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId)
    }

    if (this.lockRenewalIntervalId) {
      clearInterval(this.lockRenewalIntervalId)
    }

    // Wait for active tasks to complete (with timeout)
    const timeout = 30000 // 30 seconds
    const startTime = Date.now()

    while (this.activeTasks.size > 0 && Date.now() - startTime < timeout) {
      consola.info(`Waiting for ${this.activeTasks.size} active tasks to complete...`)
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    if (this.activeTasks.size > 0) {
      consola.warn(`${this.activeTasks.size} tasks still active, releasing locks...`)
      for (const [taskId] of this.activeTasks) {
        this.taskStore.releaseLock(taskId)
      }
    }

    consola.success('Worker stopped')
  }

  /**
   * Poll for pending tasks
   */
  private async pollTasks(): Promise<void> {
    if (!this.isRunning) return

    try {
      // Check if we can handle more tasks
      if (this.activeTasks.size >= this.config.maxConcurrentTasks) {
        consola.debug(`Max concurrent tasks (${this.config.maxConcurrentTasks}) reached, skipping poll`)
        return
      }

      // Try to claim a task
      const task = this.taskStore.claimPendingTask()

      if (!task) {
        consola.debug('No pending tasks available')
        return
      }

      // Execute task
      await this.executeTask(task)
    } catch (error) {
      consola.error('Error polling tasks:', error)
    }
  }

  /**
   * Poll for tasks ready for retry
   */
  private async pollRetryTasks(): Promise<void> {
    if (!this.isRunning) return

    try {
      const retryTasks = this.taskStore.getTasksReadyForRetry()

      for (const task of retryTasks) {
        // Reset to pending
        this.taskStore.resetTaskToPending(task.id)
        consola.info(`Task ${task.id} reset to pending for retry`)
      }
    } catch (error) {
      consola.error('Error polling retry tasks:', error)
    }
  }

  /**
   * Renew locks on active tasks
   */
  private renewLocks(): void {
    for (const [taskId] of this.activeTasks) {
      const renewed = this.taskStore.renewLock(taskId)
      if (renewed) {
        consola.debug(`Lock renewed for task ${taskId}`)
      } else {
        consola.warn(`Failed to renew lock for task ${taskId}`)
      }
    }
  }

  /**
   * Execute a task
   */
  private async executeTask(task: Task): Promise<void> {
    // Add to active tasks
    this.activeTasks.set(task.id, task)

    try {
      consola.info(`Executing task ${task.id} for issue #${task.issueNumber}`)

      // Get the issue
      const issues = await this.issueManager.getAssignedIssues()
      const issue = issues.find(
        (i) => i.number === task.issueNumber && `${i.repository.owner.login}/${i.repository.name}` === task.repo,
      )

      if (!issue) {
        throw new Error(`Issue #${task.issueNumber} not found or not assigned`)
      }

      // Execute workflow
      await this.workflowEngine.executeTask(task, issue)

      // Release lock
      this.taskStore.releaseLock(task.id)
    } catch (error) {
      consola.error(`Error executing task ${task.id}:`, error)

      // Update task with error
      this.taskStore.updateTaskState(task.id, 'failed', (error as Error).message)

      // Release lock
      this.taskStore.releaseLock(task.id)
    } finally {
      // Remove from active tasks
      this.activeTasks.delete(task.id)
    }
  }

  /**
   * Get worker status
   */
  getStatus(): {
    isRunning: boolean
    activeTasks: number
    activeTaskIds: string[]
  } {
    return {
      isRunning: this.isRunning,
      activeTasks: this.activeTasks.size,
      activeTaskIds: Array.from(this.activeTasks.keys()),
    }
  }
}
