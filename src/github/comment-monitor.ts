/**
 * Comment Monitor: Polls GitHub issues for new commands in comments
 */

import consola from 'consola'
import { TaskStore } from '../core/task-store'
import { GitHubClient } from './client'
import { CommandParser } from './command-parser'
import { CommandExecutor } from './command-executor'
import { Task } from '../core/task'

export interface CommentMonitorConfig {
  pollInterval: number // in milliseconds (default: 30000 = 30s)
  enabled: boolean
}

export class CommentMonitor {
  private parser: CommandParser
  private executor: CommandExecutor
  private pollTimer?: NodeJS.Timeout
  private isRunning = false

  constructor(
    private taskStore: TaskStore,
    private githubClient: GitHubClient,
    private config: CommentMonitorConfig,
  ) {
    this.parser = new CommandParser()
    this.executor = new CommandExecutor(taskStore)
  }

  /**
   * Start monitoring for commands
   */
  start(): void {
    if (!this.config.enabled) {
      consola.info('Comment monitor disabled')
      return
    }

    if (this.isRunning) {
      consola.warn('Comment monitor already running')
      return
    }

    this.isRunning = true
    consola.info(`Comment monitor started (polling every ${this.config.pollInterval}ms)`)

    // Start polling loop
    this.pollTimer = setInterval(() => {
      this.pollCommands().catch((error) => {
        consola.error('Error in comment polling loop:', error)
      })
    }, this.config.pollInterval)

    // Also do an immediate poll
    this.pollCommands().catch((error) => {
      consola.error('Error in initial comment poll:', error)
    })
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.isRunning = false
    consola.info('Comment monitor stopped')
  }

  /**
   * Poll for new commands in active tasks
   */
  private async pollCommands(): Promise<void> {
    try {
      // Get all active tasks (pending or in_progress)
      // Monitor tasks that are active or could be retried
      const tasks = this.taskStore.getTasks({
        state: ['pending', 'in_progress', 'failed', 'dead_letter'],
      })

      if (tasks.length === 0) {
        consola.debug('No tasks to monitor for commands')
        return
      }

      consola.debug(`Polling commands for ${tasks.length} tasks`)

      // Check each task for new comments
      for (const task of tasks) {
        await this.checkTaskComments(task)
      }
    } catch (error) {
      consola.error('Error polling for commands:', error)
    }
  }

  /**
   * Check a specific task for new commands
   */
  private async checkTaskComments(task: Task): Promise<void> {
    try {
      // Parse repo from "owner/repo" format
      const [owner, repo] = task.repo.split('/')
      if (!owner || !repo) {
        consola.error(`Invalid repo format: ${task.repo}`)
        return
      }

      // Fetch issue details to get full context
      const issue = await this.githubClient.getIssue(owner, repo, task.issueNumber)

      // Get comments since last check
      const since = task.lastCommentCheckAt || undefined
      const comments = await this.githubClient.getIssueComments(owner, repo, task.issueNumber, since)

      if (comments.length === 0) {
        // Don't update last_comment_check_at if no comments found
        // This ensures we don't skip comments that were posted before the check
        return
      }

      consola.debug(`Found ${comments.length} new comments for task ${task.id}`)

      // Process each comment
      for (const comment of comments) {
        await this.processComment(task, comment, issue)
      }

      // Update last check time
      this.taskStore.updateLastCommentCheck(task.id)
    } catch (error) {
      consola.error(`Error checking comments for task ${task.id}:`, error)
    }
  }

  /**
   * Process a single comment for commands
   */
  private async processComment(
    task: Task,
    comment: {
      id: number
      user: { login: string; id: number }
      body: string
      created_at: string
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    issue: any,
  ): Promise<void> {
    try {
      // Parse command from comment
      const parsedCommand = this.parser.parse(comment.body)

      if (!parsedCommand) {
        consola.debug(`No command found in comment ${comment.id}`)
        return
      }

      consola.info(`Found command '${parsedCommand.command}' in comment ${comment.id} from ${comment.user.login}`)

      // Execute command
      const result = await this.executor.execute({
        command: parsedCommand.command,
        task,
        comment: {
          id: comment.id,
          author: comment.user.login,
          body: comment.body,
        },
        issue,
      })

      // Post result as reply
      await this.postCommandResult(task, result)
    } catch (error) {
      consola.error(`Error processing comment ${comment.id}:`, error)

      // Record failed command
      this.taskStore.recordCommand({
        taskId: task.id,
        command: 'unknown',
        commentId: comment.id,
        commentAuthor: comment.user.login,
        commentBody: comment.body,
        result: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Post command result as a comment
   */
  private async postCommandResult(task: Task, result: { success: boolean; message: string }): Promise<void> {
    try {
      const [owner, repo] = task.repo.split('/')
      if (!owner || !repo) return

      await this.githubClient.addComment(owner, repo, task.issueNumber, result.message)
    } catch (error) {
      consola.error('Error posting command result:', error)
    }
  }

  /**
   * Check if monitor is running
   */
  isMonitoring(): boolean {
    return this.isRunning
  }
}
