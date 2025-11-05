import { spawn } from 'child_process'
import { consola } from 'consola'
import { CodexJobManager } from '../core/codex-job-manager'

export interface CodexOptions {
  apiKey?: string
  model?: string
  provider?: string
  baseURL?: string
  nonInteractive?: boolean
  maxExecutionTime?: number // Max execution time in seconds (default: 1800 = 30 min)
  maxSteps?: number // Max agent iterations to prevent token drain (default: 50)
}

export interface JobStatus {
  completed: boolean
  failed: boolean
  error?: string
  commitSha?: string
  filesModified?: string[]
  aiSummary?: string // AI's summary of what was done
}

export interface ExecuteResult {
  success: boolean
  output: string
  error?: string
  jobId?: string
}

export class CodexClient {
  private options: CodexOptions
  private jobManager?: CodexJobManager

  constructor(options: CodexOptions = {}) {
    this.options = {
      nonInteractive: true,
      maxExecutionTime: 1800, // 30 minutes default
      maxSteps: 50, // Default max iterations to prevent token drain
      ...options,
    }
  }

  /**
   * Set the job manager for async execution
   */
  setJobManager(jobManager: CodexJobManager): void {
    this.jobManager = jobManager
  }

  /**
   * Execute codex with job tracking support (async background execution)
   */
  async executeWithJobTracking(prompt: string, context?: string, workingDir?: string): Promise<ExecuteResult> {
    if (!this.jobManager) {
      // Fallback to synchronous execution if no job manager
      consola.warn('No job manager set, falling back to synchronous execution')
      const result = await this.execute(prompt, context, workingDir)
      return {
        ...result,
        jobId: undefined,
      }
    }

    // Start async job
    try {
      const fullPrompt = context ? `${prompt}\n\nContext: ${context}` : prompt

      const jobId = await this.jobManager.startJob({
        prompt: fullPrompt,
        workingDir,
        codexOptions: this.options,
        maxExecutionTime: this.options.maxExecutionTime,
      })

      return {
        success: true,
        output: '',
        jobId,
      }
    } catch (error) {
      consola.error('Failed to start Codex job:', error)
      return {
        success: false,
        output: '',
        error: (error as Error).message,
        jobId: undefined,
      }
    }
  }

  /**
   * Get the status of a codex job
   */
  async getJobStatus(jobId: string): Promise<JobStatus> {
    if (!this.jobManager) {
      throw new Error('No job manager configured')
    }

    try {
      const status = await this.jobManager.getJobStatus(jobId)

      return {
        completed: status.state === 'completed',
        failed: status.state === 'failed' || status.state === 'killed',
        error: status.error,
        filesModified: status.filesModified,
        aiSummary: status.aiSummary,
      }
    } catch (error) {
      consola.error(`Failed to get job status for ${jobId}:`, error)
      return {
        completed: false,
        failed: true,
        error: (error as Error).message,
      }
    }
  }

  async execute(
    prompt: string,
    context?: string,
    workingDir?: string,
  ): Promise<{
    success: boolean
    output: string
    error?: string
  }> {
    return new Promise((resolve) => {
      // Use --full-auto for non-interactive execution with workspace-write sandbox
      const args = ['exec', '--full-auto']

      // Use profile if specified
      if (this.options.provider) {
        args.push('--profile', this.options.provider)
      }

      // Set working directory if provided
      if (workingDir) {
        args.push('--cd', workingDir)
      }

      // Add max steps configuration to prevent token drain
      if (this.options.maxSteps) {
        args.push('--config', `agent.max_iterations=${this.options.maxSteps}`)
      }

      args.push(prompt)

      if (this.options.model) {
        args.push('--model', this.options.model)
      }

      if (this.options.provider) {
        args.push('--provider', this.options.provider)
      }

      if (context) {
        args.push('--context', context)
      }

      consola.debug('Running codex exec with args:', args)

      // Set up environment variables - Codex CLI will use its own configuration
      const envVars: Record<string, string | undefined> = { ...process.env }

      // If an API key is provided, set it as CODEX_API_KEY for Codex CLI
      if (this.options.apiKey) {
        envVars['CODEX_API_KEY'] = this.options.apiKey
      }

      const codex = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: envVars,
      })

      let output = ''
      let errorOutput = ''

      codex.stdout.on('data', (data) => {
        const text = data.toString()
        output += text
        // Stream stdout to console in real-time
        process.stdout.write(text)
      })

      codex.stderr.on('data', (data) => {
        const text = data.toString()
        errorOutput += text
        // Stream stderr to console in real-time
        process.stderr.write(text)
      })

      codex.on('close', (code) => {
        const success = code === 0
        resolve({
          success,
          output: output.trim(),
          error: success ? undefined : errorOutput.trim(),
        })
      })

      codex.on('error', (error) => {
        resolve({
          success: false,
          output: '',
          error: error.message,
        })
      })
    })
  }

  async generateCode(task: string, codebaseContext?: string, workingDir?: string): Promise<string | null> {
    try {
      const prompt = `Generate code to ${task}. ${codebaseContext ? `Context: ${codebaseContext}` : ''}`
      const result = await this.execute(prompt, undefined, workingDir)

      if (result.success) {
        consola.success('Code generation successful')
        return result.output
      } else {
        consola.error('Code generation failed:', result.error)
        return null
      }
    } catch (error) {
      consola.error('Error in code generation:', error)
      return null
    }
  }
}
