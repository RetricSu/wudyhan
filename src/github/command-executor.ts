/**
 * Command Executor: Executes bot commands with permission checking and state management
 */

import consola from 'consola'
import { Task, TaskState } from '../core/task'
import { TaskStore } from '../core/task-store'
import { BotCommand } from './command-parser'
import { Issue } from '../core/types'

export interface CommandContext {
  command: BotCommand
  task: Task
  comment: {
    id: number
    author: string
    body: string
  }
  issue: Issue
}

export interface CommandResult {
  success: boolean
  message: string
  error?: string
}

/**
 * State transition rules for commands
 */
const VALID_TRANSITIONS: Record<BotCommand, TaskState[]> = {
  stop: ['pending', 'in_progress', 'waiting_feedback', 'paused'],
  pause: ['in_progress', 'waiting_feedback'],
  continue: ['in_progress', 'waiting_feedback'], // Smart continue: resume if has session, else restart
  approve: ['waiting_feedback'], // Direct approve: skip codex and commit
  retry: ['failed', 'dead_letter', 'waiting_feedback'], // Full retry: clear checkpoints and restart
  status: ['pending', 'in_progress', 'waiting_feedback', 'paused', 'stopped', 'completed', 'failed', 'dead_letter'],
  help: ['pending', 'in_progress', 'waiting_feedback', 'paused', 'stopped', 'completed', 'failed', 'dead_letter'],
}

export class CommandExecutor {
  constructor(private taskStore: TaskStore) {}

  /**
   * Execute a command
   */
  async execute(context: CommandContext): Promise<CommandResult> {
    const { command, task, comment, issue } = context

    // Check permissions
    if (!this.hasPermission(comment.author, issue)) {
      return {
        success: false,
        message: `⛔ @${comment.author} does not have permission to control this task.`,
        error: 'permission_denied',
      }
    }

    // Check state validity
    if (!this.isValidTransition(command, task)) {
      return {
        success: false,
        message: this.getInvalidStateMessage(command, task),
        error: 'invalid_state',
      }
    }

    // Execute command
    try {
      const result = await this.executeCommand(command, task)

      // Record command execution
      this.taskStore.recordCommand({
        taskId: task.id,
        command,
        commentId: comment.id,
        commentAuthor: comment.author,
        commentBody: comment.body,
        result: result.success ? 'success' : 'failed',
        errorMessage: result.error,
      })

      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      consola.error(`Error executing command ${command}:`, error)

      this.taskStore.recordCommand({
        taskId: task.id,
        command,
        commentId: comment.id,
        commentAuthor: comment.author,
        commentBody: comment.body,
        result: 'failed',
        errorMessage,
      })

      return {
        success: false,
        message: `❌ Failed to execute command: ${errorMessage}`,
        error: errorMessage,
      }
    }
  }

  /**
   * Check if user has permission to execute commands
   */
  private hasPermission(username: string, issue: Issue): boolean {
    // Permission rules:
    // 1. Issue assignees can control
    // 2. Repository owner can control
    // 3. Issue author can control their own issue

    const isAssignee = issue.assignees.some((assignee) => assignee.login === username)
    const isOwner = issue.repository.owner.login === username
    const isAuthor = issue.user?.login === username

    return isAssignee || isOwner || isAuthor
  }

  /**
   * Check if command can be executed in current task state
   */
  private isValidTransition(command: BotCommand, task: Task): boolean {
    const validStates = VALID_TRANSITIONS[command]
    if (!validStates) return false

    // Special case for continue: can be paused OR waiting_feedback
    if (command === 'continue') {
      const isPaused = task.state === 'in_progress' && task.commandState === 'paused'
      const isWaitingFeedback = task.state === 'waiting_feedback'
      return isPaused || isWaitingFeedback
    }

    return validStates.includes(task.state)
  }

  /**
   * Execute the actual command logic
   */
  private async executeCommand(command: BotCommand, task: Task): Promise<CommandResult> {
    switch (command) {
      case 'stop':
        return this.executeStop(task)

      case 'pause':
        return this.executePause(task)

      case 'continue':
        return this.executeContinue(task)

      case 'approve':
        return this.executeApprove(task)

      case 'retry':
        return this.executeRetry(task)

      case 'status':
        return this.executeStatus(task)

      case 'help':
        return this.executeHelp()

      default:
        return {
          success: false,
          message: `❌ Unknown command: ${command}`,
          error: 'unknown_command',
        }
    }
  }

  /**
   * Stop command: Set state to failed
   */
  private async executeStop(task: Task): Promise<CommandResult> {
    this.taskStore.updateTask(task.id, {
      state: 'failed',
      lastError: 'Stopped by user command',
    })
    this.taskStore.updateCommandState(task.id, 'stopped')

    consola.info(`Task ${task.id} stopped by user command`)
    return {
      success: true,
      message: `✅ Task stopped. The task has been marked as failed.`,
    }
  }

  /**
   * Pause command: Set pause flag
   */
  private async executePause(task: Task): Promise<CommandResult> {
    this.taskStore.setPauseRequested(task.id, true)
    this.taskStore.updateCommandState(task.id, 'paused')

    consola.info(`Task ${task.id} pause requested`)
    return {
      success: true,
      message: `⏸️ Task paused. The task will pause at the next workflow step.`,
    }
  }

  /**
   * Continue command: Smart continuation - resume if session exists, else restart with feedback
   */
  private async executeContinue(task: Task): Promise<CommandResult> {
    // If in waiting_feedback state, intelligently decide whether to resume or restart
    if (task.state === 'waiting_feedback') {
      const codexCheckpoint = task.checkpoints.codex_generate

      // Check if we have a session ID to resume from
      if (codexCheckpoint?.jobId) {
        // Mark as ready to resume - the workflow will handle the resume logic
        this.taskStore.updateTask(task.id, {
          state: 'in_progress',
          currentStep: 'codex_generate', // Go back to codex_generate to resume
          commandState: 'resume_requested', // Set command state in same update
        })

        consola.info(`Task ${task.id} will resume codex session with feedback`)
        return {
          success: true,
          message: `🔄 Resuming AI session with your feedback...`,
        }
      } else {
        // No session, need to restart from scratch
        const clearedCheckpoints = { ...task.checkpoints }
        delete clearedCheckpoints.codex_generate
        delete clearedCheckpoints.post_results

        this.taskStore.updateTask(task.id, {
          state: 'in_progress',
          currentStep: 'codex_generate',
          checkpoints: clearedCheckpoints,
        })

        consola.info(`Task ${task.id} restarting codex with feedback (no session to resume)`)
        return {
          success: true,
          message: `🔄 Restarting AI with your feedback...`,
        }
      }
    }

    // If paused, clear pause flag
    this.taskStore.setPauseRequested(task.id, false)
    this.taskStore.updateCommandState(task.id, null)

    consola.info(`Task ${task.id} resumed from pause`)
    return {
      success: true,
      message: `▶️ Task resumed. The task will continue execution.`,
    }
  }

  /**
   * Approve command: Directly approve current changes and move to commit
   */
  private async executeApprove(task: Task): Promise<CommandResult> {
    if (task.state !== 'waiting_feedback') {
      return {
        success: false,
        message: `❌ Can only approve when waiting for feedback. Current state: ${task.state}`,
        error: 'invalid_state',
      }
    }

    // Move directly to commit_and_push without regenerating
    this.taskStore.updateTask(task.id, {
      state: 'in_progress',
      currentStep: 'commit_and_push',
    })

    consola.info(`Task ${task.id} approved - moving to commit and push`)
    return {
      success: true,
      message: `✅ Changes approved! Moving to commit and create PR.`,
    }
  }

  /**
   * Retry command: Reset task to regenerate code or recover from failure
   */
  private async executeRetry(task: Task): Promise<CommandResult> {
    // If in waiting_feedback state, go back to codex_generate to regenerate
    if (task.state === 'waiting_feedback') {
      // Clear codex_generate and post_results checkpoints to regenerate with feedback
      const clearedCheckpoints = { ...task.checkpoints }
      delete clearedCheckpoints.codex_generate
      delete clearedCheckpoints.post_results

      this.taskStore.updateTask(task.id, {
        state: 'in_progress',
        currentStep: 'codex_generate',
        checkpoints: clearedCheckpoints,
      })

      consola.info(`Task ${task.id} reset to regenerate code with feedback`)
      return {
        success: true,
        message: `🔄 Regenerating code with your feedback...`,
      }
    }

    // If failed, clear codex_generate checkpoint to force a fresh start
    const clearedCheckpoints = { ...task.checkpoints }
    delete clearedCheckpoints.codex_generate

    this.taskStore.updateTask(task.id, {
      state: 'pending',
      retryCount: 0,
      nextRetryAt: null,
      lastError: null,
      workerId: null,
      lockExpiresAt: null,
      checkpoints: clearedCheckpoints,
    })
    this.taskStore.updateCommandState(task.id, null)
    this.taskStore.setPauseRequested(task.id, false)

    consola.info(`Task ${task.id} reset for retry (cleared codex checkpoint)`)
    return {
      success: true,
      message: `🔄 Task queued for retry. The task has been reset to pending state with fresh codex session.`,
    }
  }

  /**
   * Status command: Get current task status
   */
  private async executeStatus(task: Task): Promise<CommandResult> {
    const stateEmoji: Record<TaskState, string> = {
      pending: '⏳',
      in_progress: '🔄',
      waiting_feedback: '⏸️',
      paused: '⏸️',
      stopped: '🛑',
      completed: '✅',
      failed: '❌',
      dead_letter: '💀',
    }

    const emoji = stateEmoji[task.state] || '❓'
    let message = `${emoji} **Task Status**\n\n`
    message += `- **State:** ${task.state}\n`
    message += `- **Current Step:** ${task.currentStep || 'N/A'}\n`
    message += `- **Retry Count:** ${task.retryCount}/${task.maxRetries}\n`

    if (task.commandState) {
      message += `- **Command State:** ${task.commandState}\n`
    }

    if (task.lastError) {
      message += `- **Last Error:** ${task.lastError}\n`
    }

    if (task.workerId) {
      message += `- **Worker ID:** ${task.workerId}\n`
    }

    return {
      success: true,
      message,
    }
  }

  /**
   * Help command: Show available commands
   */
  private async executeHelp(): Promise<CommandResult> {
    const message = `**🤖 Bot Commands**

Available commands:
- \`@bot stop\` - Stop the current task
- \`@bot pause\` - Pause the task (will pause at next step)
- \`@bot continue\` - Resume a paused task
- \`@bot retry\` - Retry a failed task
- \`@bot status\` - Get current task status
- \`@bot help\` - Show this message

**Permissions:** Only issue assignees, repository owners, and issue authors can control tasks.`

    return {
      success: true,
      message,
    }
  }

  /**
   * Get error message for invalid state transition
   */
  private getInvalidStateMessage(command: BotCommand, task: Task): string {
    if (command === 'continue' && task.commandState !== 'paused') {
      return `⚠️ Cannot continue: Task is not paused (state: ${task.state})`
    }

    const validStates = VALID_TRANSITIONS[command]?.join(', ') || 'none'
    return `⚠️ Cannot execute \`${command}\` in current state: ${task.state}. Valid states: ${validStates}`
  }
}
