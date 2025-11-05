/**
 * TaskStore: Persistent storage layer for tasks with locking and checkpoint management
 */

import { Database } from 'better-sqlite3'
import { nanoid } from 'nanoid'
import consola from 'consola'
import {
  Task,
  TaskState,
  TaskCheckpoints,
  CreateTaskInput,
  TaskFilters,
  generateTaskFingerprint,
  WorkflowStep,
} from './task'
import { TaskDatabase } from './database'

export class TaskStore {
  private db: Database
  private workerId: string
  private lockLeaseDuration: number // in milliseconds

  constructor(database: TaskDatabase, workerId?: string, lockLeaseDuration: number = 5 * 60 * 1000) {
    this.db = database.getConnection()
    this.workerId = workerId || nanoid(8)
    this.lockLeaseDuration = lockLeaseDuration
  }

  /**
   * Create a new task (idempotent - returns existing if fingerprint matches)
   */
  createTask(input: CreateTaskInput): Task | null {
    const fingerprint = generateTaskFingerprint(input.issueNumber, input.issueBodySha, input.repoHeadSha)

    // Check if task already exists with this fingerprint
    const existing = this.getTaskByFingerprint(fingerprint)
    if (existing) {
      consola.debug(`Task already exists for fingerprint ${fingerprint}:`, existing.id)
      return existing
    }

    const taskId = nanoid()
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, issue_number, repo, repo_head_sha, fingerprint, state,
        checkpoints, retry_count, max_retries, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    try {
      stmt.run(
        taskId,
        input.issueNumber,
        input.repo,
        input.repoHeadSha,
        fingerprint,
        'pending',
        JSON.stringify({}),
        0,
        input.maxRetries || 5,
        now,
        now,
      )

      consola.info(`Created task ${taskId} for issue #${input.issueNumber} in ${input.repo}`)
      return this.getTask(taskId)
    } catch (error) {
      consola.error('Error creating task:', error)
      return null
    }
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE id = ?')
    const row = stmt.get(taskId) as Record<string, unknown>

    if (!row) return null
    return this.rowToTask(row)
  }

  /**
   * Get a task by fingerprint
   */
  getTaskByFingerprint(fingerprint: string): Task | null {
    const stmt = this.db.prepare('SELECT * FROM tasks WHERE fingerprint = ?')
    const row = stmt.get(fingerprint) as Record<string, unknown>

    if (!row) return null
    return this.rowToTask(row)
  }

  /**
   * Get tasks by filters
   */
  getTasks(filters: TaskFilters = {}): Task[] {
    let query = 'SELECT * FROM tasks WHERE 1=1'
    const params: (string | number)[] = []

    if (filters.state) {
      if (Array.isArray(filters.state)) {
        query += ` AND state IN (${filters.state.map(() => '?').join(',')})`
        params.push(...filters.state)
      } else {
        query += ' AND state = ?'
        params.push(filters.state)
      }
    }

    if (filters.repo) {
      query += ' AND repo = ?'
      params.push(filters.repo)
    }

    if (filters.issueNumber) {
      query += ' AND issue_number = ?'
      params.push(filters.issueNumber)
    }

    if (filters.workerId) {
      query += ' AND worker_id = ?'
      params.push(filters.workerId)
    }

    if (filters.expiredLocksOnly) {
      query += ' AND lock_expires_at < ?'
      params.push(new Date().toISOString())
    }

    query += ' ORDER BY created_at ASC'

    const stmt = this.db.prepare(query)
    const rows = stmt.all(...params) as Record<string, unknown>[]

    return rows.map((row) => this.rowToTask(row))
  }

  /**
   * Claim a pending task (atomic lock acquisition)
   * Returns the task if successfully claimed, null otherwise
   */
  claimPendingTask(): Task | null {
    return this.db.transaction(() => {
      // Find a pending task or a task with expired lock
      const now = new Date().toISOString()
      const lockExpiresAt = new Date(Date.now() + this.lockLeaseDuration).toISOString()

      // Try to claim a pending task
      const stmt = this.db.prepare(`
        SELECT * FROM tasks 
        WHERE state = 'pending' 
        ORDER BY created_at ASC 
        LIMIT 1
      `)

      let row = stmt.get() as Record<string, unknown> | undefined

      // If no pending tasks, try to claim tasks with expired locks
      if (!row) {
        const expiredStmt = this.db.prepare(`
          SELECT * FROM tasks 
          WHERE state = 'in_progress' 
            AND lock_expires_at < ? 
          ORDER BY created_at ASC 
          LIMIT 1
        `)
        row = expiredStmt.get(now) as Record<string, unknown> | undefined
      }

      if (!row) return null

      // Claim the task
      const taskId = (row as { id: string }).id
      const updateStmt = this.db.prepare(`
        UPDATE tasks 
        SET state = 'in_progress',
            worker_id = ?,
            lock_expires_at = ?,
            updated_at = ?
        WHERE id = ?
      `)

      updateStmt.run(this.workerId, lockExpiresAt, now, taskId)

      consola.info(`Worker ${this.workerId} claimed task ${taskId}`)
      return this.getTask(taskId)
    })()
  }

  /**
   * Renew the lock on a task
   */
  renewLock(taskId: string): boolean {
    const lockExpiresAt = new Date(Date.now() + this.lockLeaseDuration).toISOString()
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET lock_expires_at = ?,
          updated_at = ?
      WHERE id = ? AND worker_id = ?
    `)

    const result = stmt.run(lockExpiresAt, now, taskId, this.workerId)
    return result.changes > 0
  }

  /**
   * Release the lock on a task
   */
  releaseLock(taskId: string): boolean {
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET worker_id = NULL,
          lock_expires_at = NULL,
          updated_at = ?
      WHERE id = ? AND worker_id = ?
    `)

    const result = stmt.run(now, taskId, this.workerId)
    return result.changes > 0
  }

  /**
   * Update task state
   */
  updateTaskState(taskId: string, state: TaskState, error?: string): boolean {
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET state = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(state, error || null, now, taskId)
    return result.changes > 0
  }

  /**
   * Generic update task method for flexible field updates
   */
  updateTask(taskId: string, updates: Partial<Task>): boolean {
    const now = new Date().toISOString()
    const fields: string[] = []
    const values: unknown[] = []

    // Map allowed fields for update
    if (updates.state !== undefined) {
      fields.push('state = ?')
      values.push(updates.state)
    }
    if (updates.lastError !== undefined) {
      fields.push('last_error = ?')
      values.push(updates.lastError)
    }
    if (updates.retryCount !== undefined) {
      fields.push('retry_count = ?')
      values.push(updates.retryCount)
    }
    if (updates.nextRetryAt !== undefined) {
      fields.push('next_retry_at = ?')
      values.push(updates.nextRetryAt)
    }
    if (updates.workerId !== undefined) {
      fields.push('worker_id = ?')
      values.push(updates.workerId)
    }
    if (updates.lockExpiresAt !== undefined) {
      fields.push('lock_expires_at = ?')
      values.push(updates.lockExpiresAt)
    }
    if (updates.currentStep !== undefined) {
      fields.push('current_step = ?')
      values.push(updates.currentStep)
    }
    if (updates.checkpoints !== undefined) {
      fields.push('checkpoints = ?')
      values.push(JSON.stringify(updates.checkpoints))
    }

    if (fields.length === 0) return false

    fields.push('updated_at = ?')
    values.push(now)
    values.push(taskId)

    const query = `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`
    const stmt = this.db.prepare(query)
    const result = stmt.run(...values)

    return result.changes > 0
  }

  /**
   * Update task current step and checkpoints
   */
  updateTaskProgress(taskId: string, currentStep: WorkflowStep, checkpoints: TaskCheckpoints): boolean {
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET current_step = ?,
          checkpoints = ?,
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(currentStep, JSON.stringify(checkpoints), now, taskId)
    return result.changes > 0
  }

  /**
   * Increment retry count and schedule next retry
   */
  incrementRetry(taskId: string, nextRetryDelay: number): boolean {
    const task = this.getTask(taskId)
    if (!task) return false

    const newRetryCount = task.retryCount + 1
    const nextRetryAt = new Date(Date.now() + nextRetryDelay).toISOString()
    const now = new Date().toISOString()

    // If max retries exceeded, move to dead letter
    if (newRetryCount >= task.maxRetries) {
      return this.updateTaskState(taskId, 'dead_letter', task.lastError || undefined)
    }

    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET retry_count = ?,
          next_retry_at = ?,
          state = 'failed',
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(newRetryCount, nextRetryAt, now, taskId)
    return result.changes > 0
  }

  /**
   * Get tasks ready for retry
   */
  getTasksReadyForRetry(): Task[] {
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      SELECT * FROM tasks 
      WHERE state = 'failed' 
        AND next_retry_at IS NOT NULL 
        AND next_retry_at <= ?
      ORDER BY next_retry_at ASC
    `)

    const rows = stmt.all(now) as Record<string, unknown>[]
    return rows.map((row) => this.rowToTask(row))
  }

  /**
   * Reset a failed task to pending for retry
   */
  resetTaskToPending(taskId: string): boolean {
    const now = new Date().toISOString()

    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET state = 'pending',
          next_retry_at = NULL,
          worker_id = NULL,
          lock_expires_at = NULL,
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(now, taskId)
    return result.changes > 0
  }

  /**
   * Log a message for a task
   */
  logTask(
    taskId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO task_logs (task_id, level, message, metadata, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    stmt.run(taskId, level, message, metadata ? JSON.stringify(metadata) : null, new Date().toISOString())
  }

  /**
   * Get logs for a task
   */
  getTaskLogs(taskId: string, limit: number = 100): Record<string, unknown>[] {
    const stmt = this.db.prepare(`
      SELECT * FROM task_logs 
      WHERE task_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `)

    return stmt.all(taskId, limit) as Record<string, unknown>[]
  }

  /**
   * Update command state (for pause/stop)
   */
  updateCommandState(taskId: string, commandState: 'paused' | 'stopped' | null): boolean {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET command_state = ?, 
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(commandState, now, taskId)
    return result.changes > 0
  }

  /**
   * Set pause requested flag
   */
  setPauseRequested(taskId: string, requested: boolean): boolean {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET pause_requested = ?, 
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(requested ? 1 : 0, now, taskId)
    return result.changes > 0
  }

  /**
   * Update last comment check timestamp
   */
  updateLastCommentCheck(taskId: string): boolean {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      UPDATE tasks 
      SET last_comment_check_at = ?, 
          updated_at = ?
      WHERE id = ?
    `)

    const result = stmt.run(now, now, taskId)
    return result.changes > 0
  }

  /**
   * Record a command execution
   */
  recordCommand(input: {
    taskId: string
    command: string
    commentId: number
    commentAuthor: string
    commentBody: string
    result: 'success' | 'failed' | 'ignored'
    errorMessage?: string
  }): boolean {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`
      INSERT INTO task_commands (
        task_id, command, comment_id, comment_author, comment_body,
        executed_at, result, error_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    try {
      stmt.run(
        input.taskId,
        input.command,
        input.commentId,
        input.commentAuthor,
        input.commentBody,
        now,
        input.result,
        input.errorMessage || null,
        now,
      )
      return true
    } catch (error) {
      consola.error('Error recording command:', error)
      return false
    }
  }

  /**
   * Get commands for a task
   */
  getTaskCommands(taskId: string, limit: number = 50): Record<string, unknown>[] {
    const stmt = this.db.prepare(`
      SELECT * FROM task_commands 
      WHERE task_id = ? 
      ORDER BY executed_at DESC 
      LIMIT ?
    `)

    return stmt.all(taskId, limit) as Record<string, unknown>[]
  }

  /**
   * Convert database row to Task object
   */
  private rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row.id as string,
      issueNumber: row.issue_number as number,
      repo: row.repo as string,
      repoHeadSha: row.repo_head_sha as string,
      fingerprint: row.fingerprint as string,
      state: row.state as TaskState,
      currentStep: row.current_step as WorkflowStep | undefined,
      checkpoints: JSON.parse((row.checkpoints as string) || '{}'),
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      nextRetryAt: row.next_retry_at as string | null | undefined,
      lastError: row.last_error as string | null | undefined,
      workerId: row.worker_id as string | null | undefined,
      lockExpiresAt: row.lock_expires_at as string | null | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      // Command system fields
      commandState: row.command_state as 'paused' | 'stopped' | null | undefined,
      pauseRequested: Boolean(row.pause_requested),
      lastCommentCheckAt: row.last_comment_check_at as string | null | undefined,
    }
  }
}
