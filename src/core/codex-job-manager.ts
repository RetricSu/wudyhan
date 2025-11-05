/**
 * CodexJobManager: Manages Codex CLI processes with async execution and recovery
 */

import { spawn, ChildProcess } from 'child_process'
import { consola } from 'consola'
import * as fs from 'fs'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { CodexJobStore, CodexJob } from './codex-job-store'
import { CodexOptions } from '../ai/codex'

export interface StartJobOptions {
  prompt: string
  workingDir?: string
  codexOptions: CodexOptions
  maxExecutionTime?: number // seconds, default 1800 (30 min)
}

export interface JobStatusResult {
  state: CodexJob['state']
  progress?: string
  error?: string
  output?: string
  sessionId?: string
  filesModified?: string[]
}

export class CodexJobManager {
  private jobStore: CodexJobStore
  private activeProcesses: Map<string, ChildProcess> = new Map()
  private jobsDir: string
  private defaultMaxExecutionTime = 1800 // 30 minutes

  constructor(jobStore: CodexJobStore, jobsDir: string = './data/codex-jobs') {
    this.jobStore = jobStore
    this.jobsDir = path.resolve(jobsDir)

    // Ensure jobs directory exists
    if (!fs.existsSync(this.jobsDir)) {
      fs.mkdirSync(this.jobsDir, { recursive: true })
    }

    consola.debug('CodexJobManager initialized')
  }

  /**
   * Start a new Codex job with background execution
   */
  async startJob(options: StartJobOptions): Promise<string> {
    const jobId = uuidv4()
    const jobDir = path.join(this.jobsDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')
    const stderrPath = path.join(jobDir, 'stderr.log')
    const jsonlPath = path.join(jobDir, 'session.jsonl')

    consola.info(`[Job ${jobId}] Starting Codex job`)

    // Build codex exec arguments
    const args = ['exec', '--json', '--full-auto']

    if (options.workingDir) {
      args.push('--cd', options.workingDir)
    }

    if (options.codexOptions.provider) {
      args.push('--profile', options.codexOptions.provider)
    }

    if (options.codexOptions.model) {
      args.push('--model', options.codexOptions.model)
    }

    // Add max steps configuration to prevent token drain
    if (options.codexOptions.maxSteps) {
      args.push('--config', `agent.max_iterations=${options.codexOptions.maxSteps}`)
      consola.debug(`[Job ${jobId}] Setting max iterations to ${options.codexOptions.maxSteps}`)
    }

    args.push(options.prompt)

    // Spawn the process
    const codex = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_API_KEY: options.codexOptions.apiKey,
      },
      detached: false, // Keep it attached so we can monitor
    })

    const pid = codex.pid!

    // Create file streams
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' })
    const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' })
    const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' })

    // Pipe outputs to files
    codex.stdout.on('data', (data) => {
      stdoutStream.write(data)
      jsonlStream.write(data)
    })

    codex.stderr.on('data', (data) => {
      stderrStream.write(data)
    })

    // Create job record
    this.jobStore.createJob({
      jobId,
      pid,
      state: 'running',
      prompt: options.prompt,
      workingDir: options.workingDir,
      options: JSON.stringify(options.codexOptions),
      stdoutPath,
      stderrPath,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    })

    // Store active process
    this.activeProcesses.set(jobId, codex)

    // Set up process event handlers
    codex.on('exit', (code, signal) => {
      this.handleProcessExit(jobId, code, signal)
      stdoutStream.end()
      stderrStream.end()
      jsonlStream.end()
    })

    codex.on('error', (error) => {
      consola.error(`[Job ${jobId}] Process error:`, error)
      this.jobStore.updateJob(jobId, {
        state: 'failed',
        error: error.message,
        completedAt: new Date().toISOString(),
      })
      this.activeProcesses.delete(jobId)
    })

    // Set up timeout
    const maxTime = options.maxExecutionTime || this.defaultMaxExecutionTime
    const timeoutHandle = setTimeout(() => {
      this.killJob(jobId, `Timeout after ${maxTime} seconds`)
    }, maxTime * 1000)

    // Clear timeout when process exits
    codex.on('exit', () => clearTimeout(timeoutHandle))

    // Parse session ID from JSONL in background
    this.parseSessionIdAsync(jobId, jsonlPath)

    consola.success(`[Job ${jobId}] Codex job started (PID: ${pid})`)
    return jobId
  }

  /**
   * Get the status of a job
   */
  async getJobStatus(jobId: string): Promise<JobStatusResult> {
    const job = this.jobStore.getJob(jobId)
    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    // If job is completed/failed/killed, return cached result
    if (job.state !== 'running' && job.state !== 'resuming') {
      return {
        state: job.state,
        error: job.error,
        output: job.output,
        sessionId: job.sessionId,
      }
    }

    // Check if process is still running
    const isAlive = this.isProcessAlive(job.pid)

    if (!isAlive) {
      // Process died unexpectedly
      consola.warn(`[Job ${jobId}] Process ${job.pid} is not alive`)

      // Try to read exit code from logs
      const output = await this.readJobOutput(job)
      const error = await this.readJobError(job)

      this.jobStore.updateJob(jobId, {
        state: 'failed',
        error: error || 'Process died unexpectedly',
        output,
        completedAt: new Date().toISOString(),
      })

      return {
        state: 'failed',
        error: error || 'Process died unexpectedly',
        output,
        sessionId: job.sessionId,
      }
    }

    // Process is alive, update heartbeat
    this.jobStore.updateJob(jobId, {
      lastHeartbeat: new Date().toISOString(),
    })

    // Try to get progress from JSONL
    const progress = await this.getProgressFromJsonl(job)

    return {
      state: 'running',
      progress,
      sessionId: job.sessionId,
    }
  }

  /**
   * Kill a running job
   */
  killJob(jobId: string, reason?: string): void {
    const job = this.jobStore.getJob(jobId)
    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    consola.warn(`[Job ${jobId}] Killing job${reason ? `: ${reason}` : ''}`)

    const process = this.activeProcesses.get(jobId)
    if (process) {
      process.kill('SIGTERM')
      this.activeProcesses.delete(jobId)
    } else if (job.pid && this.isProcessAlive(job.pid)) {
      // Try to kill by PID using Node.js process.kill
      try {
        global.process.kill(job.pid, 'SIGTERM')
      } catch (error) {
        consola.error(`[Job ${jobId}] Failed to kill process:`, error)
      }
    }

    this.jobStore.updateJob(jobId, {
      state: 'killed',
      error: reason || 'Job was killed',
      completedAt: new Date().toISOString(),
    })
  }

  /**
   * Resume a failed/killed job using Codex session
   */
  async resumeJob(jobId: string): Promise<string> {
    const job = this.jobStore.getJob(jobId)
    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    if (!job.sessionId) {
      throw new Error(`Job ${jobId} has no session ID, cannot resume`)
    }

    consola.info(`[Job ${jobId}] Resuming from session ${job.sessionId}`)

    // Create new job for the resume
    const newJobId = uuidv4()
    const jobDir = path.join(this.jobsDir, newJobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')
    const stderrPath = path.join(jobDir, 'stderr.log')
    const jsonlPath = path.join(jobDir, 'session.jsonl')

    // Parse original options
    const codexOptions = JSON.parse(job.options) as CodexOptions

    // Build resume command
    const args = ['exec', 'resume', '--json', job.sessionId]

    if (job.workingDir) {
      args.push('--cd', job.workingDir)
    }

    // Spawn the resume process
    const codex = spawn('codex', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CODEX_API_KEY: codexOptions.apiKey,
      },
      detached: false,
    })

    const pid = codex.pid!

    // Create file streams
    const stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' })
    const stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' })
    const jsonlStream = fs.createWriteStream(jsonlPath, { flags: 'a' })

    codex.stdout.on('data', (data) => {
      stdoutStream.write(data)
      jsonlStream.write(data)
    })

    codex.stderr.on('data', (data) => {
      stderrStream.write(data)
    })

    // Create new job record
    this.jobStore.createJob({
      jobId: newJobId,
      sessionId: job.sessionId, // Reuse same session
      pid,
      state: 'resuming',
      prompt: `[RESUMED] ${job.prompt}`,
      workingDir: job.workingDir,
      options: job.options,
      stdoutPath,
      stderrPath,
      startedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    })

    this.activeProcesses.set(newJobId, codex)

    codex.on('exit', (code, signal) => {
      this.handleProcessExit(newJobId, code, signal)
      stdoutStream.end()
      stderrStream.end()
      jsonlStream.end()
    })

    codex.on('error', (error) => {
      consola.error(`[Job ${newJobId}] Resume process error:`, error)
      this.jobStore.updateJob(newJobId, {
        state: 'failed',
        error: error.message,
        completedAt: new Date().toISOString(),
      })
      this.activeProcesses.delete(newJobId)
    })

    consola.success(`[Job ${newJobId}] Resumed from session ${job.sessionId}`)
    return newJobId
  }

  /**
   * Recover orphaned jobs on startup
   */
  async recoverJobs(): Promise<void> {
    consola.info('CodexJobManager: Recovering orphaned jobs...')
    const activeJobs = this.jobStore.getActiveJobs()

    for (const job of activeJobs) {
      consola.debug(`Checking job ${job.jobId} (state: ${job.state}, PID: ${job.pid})`)

      const isAlive = this.isProcessAlive(job.pid)

      if (isAlive) {
        consola.info(`[Job ${job.jobId}] Process still running, monitoring`)
        // Process is still alive, we'll monitor it
        // Note: We can't reattach to the process, but we can check its status
        continue
      }

      // Process is dead
      consola.warn(`[Job ${job.jobId}] Process died, attempting recovery`)

      if (job.sessionId) {
        // Try to resume
        try {
          await this.resumeJob(job.jobId)
          consola.success(`[Job ${job.jobId}] Resumed successfully`)
        } catch (error) {
          consola.error(`[Job ${job.jobId}] Failed to resume:`, error)
          this.jobStore.updateJob(job.jobId, {
            state: 'failed',
            error: `Recovery failed: ${(error as Error).message}`,
            completedAt: new Date().toISOString(),
          })
        }
      } else {
        // No session ID, mark as failed
        consola.warn(`[Job ${job.jobId}] No session ID, marking as failed`)
        this.jobStore.updateJob(job.jobId, {
          state: 'failed',
          error: 'Process died without session ID',
          completedAt: new Date().toISOString(),
        })
      }
    }

    consola.success('CodexJobManager: Job recovery complete')
  }

  /**
   * Check if a process is alive
   */
  private isProcessAlive(pid?: number): boolean {
    if (!pid) return false

    try {
      // Send signal 0 to check if process exists
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * Handle process exit
   */
  private handleProcessExit(jobId: string, code: number | null, signal: NodeJS.Signals | null): void {
    consola.info(`[Job ${jobId}] Process exited (code: ${code}, signal: ${signal})`)

    const job = this.jobStore.getJob(jobId)
    if (!job) return

    this.activeProcesses.delete(jobId)

    if (code === 0) {
      // Success
      this.readJobOutput(job).then((output) => {
        this.jobStore.updateJob(jobId, {
          state: 'completed',
          exitCode: code,
          output,
          completedAt: new Date().toISOString(),
        })
      })
    } else {
      // Failure
      this.readJobError(job).then((error) => {
        this.jobStore.updateJob(jobId, {
          state: 'failed',
          exitCode: code || undefined,
          error: error || `Process exited with code ${code}`,
          completedAt: new Date().toISOString(),
        })
      })
    }
  }

  /**
   * Parse session ID from JSONL asynchronously
   */
  private async parseSessionIdAsync(jobId: string, jsonlPath: string): Promise<void> {
    // Wait a bit for the file to be written
    await new Promise((resolve) => setTimeout(resolve, 1000))

    try {
      const sessionId = await this.extractSessionIdFromJsonl(jsonlPath)
      if (sessionId) {
        this.jobStore.updateJob(jobId, { sessionId, jsonlPath })
        consola.debug(`[Job ${jobId}] Extracted session ID: ${sessionId}`)
      }
    } catch (error) {
      consola.error(`[Job ${jobId}] Failed to parse session ID:`, error)
    }
  }

  /**
   * Extract session ID from JSONL file
   */
  private async extractSessionIdFromJsonl(jsonlPath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(jsonlPath)) return null

      const content = fs.readFileSync(jsonlPath, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim())

      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'session_meta' && event.payload?.id) {
            return event.payload.id
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    } catch (error) {
      consola.error('Failed to extract session ID from JSONL:', error)
    }

    return null
  }

  /**
   * Get progress from JSONL file
   */
  private async getProgressFromJsonl(job: CodexJob): Promise<string | undefined> {
    if (!job.jsonlPath || !fs.existsSync(job.jsonlPath)) {
      return undefined
    }

    try {
      const content = fs.readFileSync(job.jsonlPath, 'utf-8')
      const lines = content.split('\n').filter((line) => line.trim())

      // Get last few events
      const recentEvents = lines.slice(-10)
      const events = recentEvents
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)

      // Extract last meaningful message
      for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i]
        if (event.type === 'event_msg' && event.payload?.message) {
          return event.payload.message
        }
      }
    } catch (error) {
      consola.error('Failed to get progress from JSONL:', error)
    }

    return undefined
  }

  /**
   * Read job output from stdout
   */
  private async readJobOutput(job: CodexJob): Promise<string | undefined> {
    try {
      if (fs.existsSync(job.stdoutPath)) {
        const content = fs.readFileSync(job.stdoutPath, 'utf-8')
        return content.trim() || undefined
      }
    } catch (error) {
      consola.error('Failed to read job output:', error)
    }
    return undefined
  }

  /**
   * Read job error from stderr
   */
  private async readJobError(job: CodexJob): Promise<string | undefined> {
    try {
      if (fs.existsSync(job.stderrPath)) {
        const content = fs.readFileSync(job.stderrPath, 'utf-8')
        return content.trim() || undefined
      }
    } catch (error) {
      consola.error('Failed to read job error:', error)
    }
    return undefined
  }
}
