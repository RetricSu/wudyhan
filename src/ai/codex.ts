import { spawn } from 'child_process'
import { consola } from 'consola'

export interface CodexOptions {
  apiKey?: string
  model?: string
  provider?: string
  baseURL?: string
  nonInteractive?: boolean
}

export class CodexClient {
  private options: CodexOptions

  constructor(options: CodexOptions = {}) {
    this.options = {
      nonInteractive: true,
      ...options,
    }
  }

  async execute(
    prompt: string,
    context?: string,
  ): Promise<{
    success: boolean
    output: string
    error?: string
  }> {
    return new Promise((resolve) => {
      // Use --full-auto for non-interactive execution with workspace-write sandbox
      const args = ['exec', '--profile', 'k2', '--full-auto', prompt]

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
        output += data.toString()
      })

      codex.stderr.on('data', (data) => {
        errorOutput += data.toString()
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

  async generateCode(task: string, codebaseContext?: string): Promise<string | null> {
    try {
      const prompt = `Generate code to ${task}. ${codebaseContext ? `Context: ${codebaseContext}` : ''}`
      const result = await this.execute(prompt)

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
