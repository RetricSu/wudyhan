/**
 * CodexJobStore: Manages persistent storage for Codex execution jobs
 * Supports async job tracking, process monitoring, and session recovery
 */

import consola from 'consola'
import { TaskDatabase } from './database'

export interface CodexJob {
  jobId: string // Our generated UUID
  sessionId?: string // Codex CLI session UUID (parsed from JSONL)
  pid?: number // Child process PID
  state: 'running' | 'completed' | 'failed' | 'killed' | 'resuming'

  // Job details
  prompt: string
  workingDir?: string
  options: string // JSON stringified CodexOptions

  // Paths
  stdoutPath: string
  stderrPath: string
  jsonlPath?: string // Codex session JSONL path (discovered after start)

  // Results
  exitCode?: number
  error?: string
  output?: string

  // Timestamps
  startedAt: string
  completedAt?: string
  lastHeartbeat?: string // Last time we confirmed process is alive

  createdAt: string
  updatedAt: string
}

export class CodexJobStore {
  private db: TaskDatabase

  constructor(db: TaskDatabase) {
    this.db = db
  }

  /**
   * Initialize codex_jobs table
   */
  initSchema(): void {
    const query = `
      CREATE TABLE IF NOT EXISTS codex_jobs (
        job_id TEXT PRIMARY KEY,
        session_id TEXT,
        pid INTEGER,
        state TEXT NOT NULL,
        
        prompt TEXT NOT NULL,
        working_dir TEXT,
        options TEXT NOT NULL,
        
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        jsonl_path TEXT,
        
        exit_code INTEGER,
        error TEXT,
        output TEXT,
        
        started_at TEXT NOT NULL,
        completed_at TEXT,
        last_heartbeat TEXT,
        
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `
    this.db.getConnection().exec(query)
    consola.debug('CodexJobStore: Schema initialized')
  }

  /**
   * Create a new job record
   */
  createJob(job: Omit<CodexJob, 'createdAt' | 'updatedAt'>): CodexJob {
    const now = new Date().toISOString()
    const fullJob: CodexJob = {
      ...job,
      createdAt: now,
      updatedAt: now,
    }

    const query = `
      INSERT INTO codex_jobs (
        job_id, session_id, pid, state,
        prompt, working_dir, options,
        stdout_path, stderr_path, jsonl_path,
        exit_code, error, output,
        started_at, completed_at, last_heartbeat,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    this.db
      .getConnection()
      .prepare(query)
      .run([
        fullJob.jobId,
        fullJob.sessionId || null,
        fullJob.pid || null,
        fullJob.state,
        fullJob.prompt,
        fullJob.workingDir || null,
        fullJob.options,
        fullJob.stdoutPath,
        fullJob.stderrPath,
        fullJob.jsonlPath || null,
        fullJob.exitCode || null,
        fullJob.error || null,
        fullJob.output || null,
        fullJob.startedAt,
        fullJob.completedAt || null,
        fullJob.lastHeartbeat || null,
        fullJob.createdAt,
        fullJob.updatedAt,
      ])

    consola.debug(`CodexJobStore: Created job ${fullJob.jobId}`)
    return fullJob
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): CodexJob | null {
    const query = `SELECT * FROM codex_jobs WHERE job_id = ?`
    const row = this.db.getConnection().prepare(query).get(jobId) as CodexJob | undefined

    if (!row) {
      return null
    }

    return this.parseJobRow(row)
  }

  /**
   * Update job fields
   */
  updateJob(jobId: string, updates: Partial<CodexJob>): void {
    const now = new Date().toISOString()
    const fields: string[] = []
    const values: unknown[] = []

    // Build dynamic update query
    Object.entries(updates).forEach(([key, value]) => {
      if (key === 'jobId' || key === 'createdAt') return // Don't update these
      const snakeKey = this.camelToSnake(key)
      fields.push(`${snakeKey} = ?`)
      values.push(value ?? null)
    })

    if (fields.length === 0) return

    fields.push('updated_at = ?')
    values.push(now)
    values.push(jobId)

    const query = `UPDATE codex_jobs SET ${fields.join(', ')} WHERE job_id = ?`
    this.db.getConnection().prepare(query).run(values)

    consola.debug(`CodexJobStore: Updated job ${jobId}`)
  }

  /**
   * Get all jobs by state
   */
  getJobsByState(state: CodexJob['state']): CodexJob[] {
    const query = `SELECT * FROM codex_jobs WHERE state = ? ORDER BY created_at DESC`
    const rows = this.db.getConnection().prepare(query).all(state) as CodexJob[]
    return rows.map((row) => this.parseJobRow(row))
  }

  /**
   * Get all running or resuming jobs
   */
  getActiveJobs(): CodexJob[] {
    const query = `SELECT * FROM codex_jobs WHERE state IN ('running', 'resuming') ORDER BY created_at DESC`
    const rows = this.db.getConnection().prepare(query).all() as CodexJob[]
    return rows.map((row) => this.parseJobRow(row))
  }

  /**
   * Delete job
   */
  deleteJob(jobId: string): void {
    const query = `DELETE FROM codex_jobs WHERE job_id = ?`
    this.db.getConnection().prepare(query).run(jobId)
    consola.debug(`CodexJobStore: Deleted job ${jobId}`)
  }

  /**
   * Clean up old completed/failed jobs
   */
  cleanupOldJobs(daysOld: number = 7): number {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysOld)
    const cutoff = cutoffDate.toISOString()

    const query = `
      DELETE FROM codex_jobs 
      WHERE state IN ('completed', 'failed', 'killed') 
      AND completed_at < ?
    `
    const result = this.db.getConnection().prepare(query).run(cutoff)
    const deleted = result.changes || 0
    consola.info(`CodexJobStore: Cleaned up ${deleted} old jobs`)
    return deleted
  }

  private parseJobRow(row: CodexJob): CodexJob {
    return {
      ...row,
      pid: row.pid || undefined,
      sessionId: row.sessionId || undefined,
      jsonlPath: row.jsonlPath || undefined,
      exitCode: row.exitCode || undefined,
      error: row.error || undefined,
      output: row.output || undefined,
      completedAt: row.completedAt || undefined,
      lastHeartbeat: row.lastHeartbeat || undefined,
      workingDir: row.workingDir || undefined,
    }
  }

  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
  }
}
