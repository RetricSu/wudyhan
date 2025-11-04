import { promises as fs } from 'fs'
import * as path from 'path'
import { consola } from 'consola'
import { BotConfig } from '../core/types'

export class ConfigManager {
  private configPath: string
  private defaultConfig: Partial<BotConfig> = {
    interval: 300000, // 5 minutes
    maxConcurrent: 3,
    logLevel: 'info',
  }

  constructor(configPath: string = './config/bot-config.json') {
    this.configPath = path.resolve(configPath)
  }

  async loadConfig(): Promise<BotConfig> {
    try {
      const configData = await fs.readFile(this.configPath, 'utf-8')
      const config = JSON.parse(configData)

      // Validate required fields
      if (!config.githubToken) {
        throw new Error('GitHub token is required')
      }

      if (!config.repositories || config.repositories.length === 0) {
        throw new Error('At least one repository must be configured')
      }

      return { ...this.defaultConfig, ...config } as BotConfig
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        consola.warn('Config file not found, using environment variables')
        return this.loadFromEnv()
      }
      throw error
    }
  }

  async saveConfig(config: BotConfig): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.configPath), { recursive: true })
      await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), 'utf-8')
      consola.success('Configuration saved successfully')
    } catch (error) {
      consola.error('Error saving configuration:', error)
      throw error
    }
  }

  private loadFromEnv(): BotConfig {
    const githubToken = process.env.GITHUB_TOKEN
    const repositories =
      process.env.GITHUB_REPOS?.split(',').map((repo) => {
        const [owner, name] = repo.trim().split('/')
        return { owner, name }
      }) || []

    if (!githubToken) {
      throw new Error('GITHUB_TOKEN environment variable is required')
    }

    if (repositories.length === 0) {
      throw new Error('GITHUB_REPOS environment variable is required')
    }

    return {
      ...this.defaultConfig,
      githubToken,
      repositories,
      codexApiKey: process.env.CODEX_API_KEY,
      codexModel: process.env.CODEX_MODEL,
      interval: parseInt(process.env.BOT_INTERVAL || '300000'),
      maxConcurrent: parseInt(process.env.BOT_MAX_CONCURRENT || '3'),
      logLevel: (process.env.BOT_LOG_LEVEL as BotConfig['logLevel']) || 'info',
    } as BotConfig
  }

  async validateConfig(config: BotConfig): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = []

    if (!config.githubToken) {
      errors.push('GitHub token is required')
    }

    if (!config.repositories || config.repositories.length === 0) {
      errors.push('At least one repository must be configured')
    }

    config.repositories?.forEach((repo, index) => {
      if (!repo.owner || !repo.name) {
        errors.push(`Repository ${index + 1}: owner and name are required`)
      }
    })

    if (config.interval && config.interval < 60000) {
      errors.push('Interval must be at least 60 seconds')
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }
}
