/**
 * WorkflowEngine: Orchestrates workflow step execution with resume capability
 */

import consola from 'consola'
import { Task, WorkflowStep } from './task'
import { TaskStore } from './task-store'
import { RetryManager } from './retry-manager'
import {
  StepContext,
  StepResult,
  planStep,
  branchStep,
  codexGenerateStep,
  postResultsStep,
  runTestsStep,
  commitAndPushStep,
  createPRStep,
} from './workflow-steps'
import { WorkspaceManager } from '../workspace/manager'
import { CodexClient } from '../ai/codex'
import { IssueManager } from '../github/issues'
import { GitHubClient } from '../github/client'
import { Issue } from './types'

export class WorkflowEngine {
  private taskStore: TaskStore
  private retryManager: RetryManager
  private workspaceManager: WorkspaceManager
  private codexClient: CodexClient
  private issueManager: IssueManager
  private githubClient: GitHubClient

  constructor(
    taskStore: TaskStore,
    workspaceManager: WorkspaceManager,
    codexClient: CodexClient,
    issueManager: IssueManager,
    githubClient: GitHubClient,
    retryManager?: RetryManager,
  ) {
    this.taskStore = taskStore
    this.workspaceManager = workspaceManager
    this.codexClient = codexClient
    this.issueManager = issueManager
    this.githubClient = githubClient
    this.retryManager = retryManager || new RetryManager()
  }

  /**
   * Execute a task through its workflow steps
   * Resumes from the last successful step
   */
  async executeTask(task: Task, issue: Issue): Promise<void> {
    const ctx: StepContext = {
      task,
      taskStore: this.taskStore,
      workspaceManager: this.workspaceManager,
      codexClient: this.codexClient,
      issueManager: this.issueManager,
      githubClient: this.githubClient,
      issue,
    }

    try {
      // Determine which step to start from
      const currentStep = task.currentStep || 'plan'

      consola.info(`[Task ${task.id}] Starting workflow from step: ${currentStep}`)
      this.taskStore.logTask(task.id, 'info', `Starting workflow from step: ${currentStep}`)

      // Execute steps in order
      const steps: { name: WorkflowStep; fn: (ctx: StepContext) => Promise<StepResult> }[] = [
        { name: 'plan', fn: planStep },
        { name: 'branch', fn: branchStep },
        { name: 'codex_generate', fn: codexGenerateStep },
        { name: 'post_results', fn: postResultsStep },
        { name: 'run_tests', fn: runTestsStep },
        { name: 'commit_and_push', fn: commitAndPushStep },
        { name: 'create_pr', fn: createPRStep },
      ]

      // Find starting step index
      const startIndex = steps.findIndex((s) => s.name === currentStep)
      if (startIndex === -1) {
        throw new Error(`Invalid workflow step: ${currentStep}`)
      }

      // Execute steps from current step onwards
      for (let i = startIndex; i < steps.length; i++) {
        const step = steps[i]
        if (!step) continue

        // Check if task is paused before executing next step
        const refreshedTask = this.taskStore.getTask(task.id)
        if (refreshedTask?.pauseRequested) {
          consola.info(`[Task ${task.id}] Pause requested, stopping workflow execution`)
          this.taskStore.logTask(task.id, 'info', 'Workflow paused by user command')
          return // Exit gracefully - task will resume when pause is lifted
        }

        consola.info(`[Task ${task.id}] Executing step: ${step.name}`)

        const result = await step.fn(ctx)

        if (!result.success) {
          // Use different log level based on whether this is polling or a real failure
          if (result.isPolling) {
            consola.debug(`[Task ${task.id}] Step ${step.name} in progress: ${result.error}`)
            this.taskStore.logTask(task.id, 'info', `Step ${step.name} in progress`, { message: result.error })

            // For polling, just release the lock and let the task be picked up again
            // Don't mark as failed or set retry time
            this.taskStore.releaseLock(task.id)
            consola.debug(`[Task ${task.id}] Released lock for polling, task remains in_progress`)
            return
          } else {
            consola.error(`[Task ${task.id}] Step ${step.name} failed: ${result.error}`)
            this.taskStore.logTask(task.id, 'error', `Step ${step.name} failed`, { error: result.error })
          }

          // Handle failure (only for real failures, not polling)
          await this.handleStepFailure(task, result.error || 'Unknown error', result.shouldRetry || false)
          return
        }

        consola.success(`[Task ${task.id}] Step ${step.name} completed`)
        this.taskStore.logTask(task.id, 'info', `Step ${step.name} completed`)

        // Refresh task to get latest checkpoints and state
        const updatedTask = this.taskStore.getTask(task.id)
        if (updatedTask) {
          ctx.task = updatedTask

          // If task is now waiting_feedback, stop workflow execution
          if (updatedTask.state === 'waiting_feedback') {
            consola.info(`[Task ${task.id}] Workflow paused - waiting for user feedback/approval`)
            this.taskStore.logTask(task.id, 'info', 'Waiting for user feedback/approval')
            return // Exit workflow - will resume when user approves or retries
          }
        }
      }

      // All steps completed successfully
      this.taskStore.updateTaskState(task.id, 'completed')
      this.taskStore.logTask(task.id, 'info', 'Workflow completed successfully')
      consola.success(`[Task ${task.id}] Workflow completed successfully`)

      // Post success comment to issue
      await this.postStatusComment(issue, task, true)
    } catch (error) {
      consola.error(`[Task ${task.id}] Workflow execution error:`, error)
      this.taskStore.logTask(task.id, 'error', 'Workflow execution error', { error: (error as Error).message })
      await this.handleStepFailure(task, (error as Error).message, true)
    }
  }

  /**
   * Handle step failure with retry logic
   */
  private async handleStepFailure(task: Task, errorMessage: string, shouldRetry: boolean): Promise<void> {
    // Determine if we should retry
    const error = new Error(errorMessage)
    const canRetry = shouldRetry
      ? task.retryCount < task.maxRetries
      : this.retryManager.shouldRetry(task.retryCount, task.maxRetries, error)

    if (canRetry) {
      // Calculate retry delay
      const delay = this.retryManager.calculateDelay(task.retryCount)

      // Increment retry count and schedule retry
      this.taskStore.incrementRetry(task.id, delay)
      consola.warn(`[Task ${task.id}] Scheduled for retry in ${Math.floor(delay / 1000)}s`)
      this.taskStore.logTask(task.id, 'warn', `Scheduled for retry`, { delay, retryCount: task.retryCount + 1 })

      // Post retry comment to issue
      const [owner, repo] = task.repo.split('/')
      if (owner && repo) {
        await this.issueManager.updateIssueStatus(
          owner,
          repo,
          task.issueNumber,
          `⚠️ Task failed but will retry (attempt ${task.retryCount + 1}/${task.maxRetries}):\n\n${errorMessage}`,
        )
      }
    } else {
      // Move to dead letter
      this.taskStore.updateTaskState(task.id, 'dead_letter', errorMessage)
      consola.error(`[Task ${task.id}] Moved to dead letter queue after ${task.retryCount} retries`)
      this.taskStore.logTask(task.id, 'error', 'Moved to dead letter queue', {
        retryCount: task.retryCount,
        error: errorMessage,
      })

      // Get full task for posting comment
      const fullTask = this.taskStore.getTask(task.id)
      if (fullTask) {
        const issues = await this.issueManager.getAssignedIssues()
        const issue = issues.find((i) => i.number === fullTask.issueNumber)

        if (issue) {
          await this.postStatusComment(issue, fullTask, false)
        }
      }
    }
  }

  /**
   * Post status comment to the issue
   */
  private async postStatusComment(_issue: Issue, task: Task, success: boolean): Promise<void> {
    const [owner, repo] = task.repo.split('/')
    if (!owner || !repo) return

    if (success) {
      const prUrl = task.checkpoints.create_pr?.prUrl || 'Unknown'
      const message = `✅ **Bot has completed work on this issue!**\n\nPull request created: ${prUrl}\n\nPlease review the changes.`

      await this.issueManager.updateIssueStatus(owner, repo, task.issueNumber, message)
    } else {
      const logs = this.taskStore.getTaskLogs(task.id, 10)
      const logsText = logs
        .reverse()
        .map((l) => `- [${l.level}] ${l.message}`)
        .join('\n')

      const message = `❌ **Bot failed to complete this issue**\n\nLast error: ${task.lastError}\n\n**Recent logs:**\n${logsText}\n\nTask has been moved to dead letter queue after ${task.retryCount} retry attempts.`

      await this.issueManager.updateIssueStatus(owner, repo, task.issueNumber, message)
    }
  }
}
