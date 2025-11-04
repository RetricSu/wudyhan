import { spawn } from 'child_process'
import { consola } from 'consola'

export interface CodexOptions {
  apiKey?: string
  model?: string
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
      const args = ['exec', prompt]

      if (this.options.nonInteractive) {
        args.push('--non-interactive')
      }

      if (this.options.model) {
        args.push('--model', this.options.model)
      }

      if (context) {
        args.push('--context', context)
      }

      consola.debug('Running codex exec with args:', args)

      const codex = spawn('codex', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(this.options.apiKey && { CODEX_API_KEY: this.options.apiKey }),
        },
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
