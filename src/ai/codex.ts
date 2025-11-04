import { spawn } from 'child_process'
import { consola } from 'consola'

export interface CodexOptions {
  apiKey?: string
  model?: string
  provider?: string
  baseURL?: string
  nonInteractive?: boolean
}

export interface JobStatus {
  completed: boolean
  failed: boolean
  error?: string
  commitSha?: string
  filesModified?: string[]
}

export interface ExecuteResult {
  success: boolean
  output: string
  error?: string
  jobId?: string
}

export class CodexClient {
  private options: CodexOptions
  private jobStatusCache: Map<string, JobStatus> = new Map()

  constructor(options: CodexOptions = {}) {
    this.options = {
      nonInteractive: true,
      ...options,
    }
  }

  /**
   * Execute codex with job tracking support
   */
  async executeWithJobTracking(prompt: string, context?: string, workingDir?: string): Promise<ExecuteResult> {
    const result = await this.execute(prompt, context, workingDir)
    // For now, codex runs synchronously, so no job ID
    // In the future, if codex supports async jobs, this would return a job ID
    return {
      ...result,
      jobId: undefined,
    }
  }

  /**
   * Get the status of a codex job
   * For now, this is a stub as codex runs synchronously
   */
  async getJobStatus(jobId: string): Promise<JobStatus> {
    // Check cache first
    if (this.jobStatusCache.has(jobId)) {
      return this.jobStatusCache.get(jobId)!
    }

    // Try to query codex status
    // This would use `codex status <jobId>` if that command exists
    // For now, assume completed
    return {
      completed: true,
      failed: false,
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
      const args = ['exec', '--profile', 'k2', '--full-auto']

      // Set working directory if provided
      if (workingDir) {
        args.push('--cd', workingDir)
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
