import { CommandModule } from 'yargs'
import { consola } from 'consola'
import { GitHubMaintainBot } from '../core/bot'
import { ConfigManager } from '../config/config'

let bot: GitHubMaintainBot | null = null

const start: CommandModule = {
  command: 'start',
  describe: 'Start the GitHub maintain bot',
  handler: async () => {
    try {
      if (bot) {
        consola.warn('Bot is already running')
        return
      }

      const configManager = new ConfigManager()
      const config = await configManager.loadConfig()

      bot = new GitHubMaintainBot(config)
      await bot.start()
    } catch (error) {
      consola.error('Failed to start bot:', error)
      process.exit(1)
    }
  },
}

const stop: CommandModule = {
  command: 'stop',
  describe: 'Stop the GitHub maintain bot',
  handler: async () => {
    try {
      if (!bot) {
        consola.warn('Bot is not running')
        return
      }

      await bot.stop()
      bot = null
    } catch (error) {
      consola.error('Failed to stop bot:', error)
      process.exit(1)
    }
  },
}

const status: CommandModule = {
  command: 'status',
  describe: 'Check the status of the GitHub maintain bot',
  handler: () => {
    if (!bot) {
      consola.info('Bot is not running')
      return
    }

    const botStatus = bot.getStatus()
    consola.info('Bot Status:', {
      running: botStatus.isRunning,
      lastCheck: botStatus.lastCheck.toISOString(),
      processedIssues: botStatus.processedIssues,
      activeTasks: botStatus.activeTasks,
    })
  },
}

const config: CommandModule = {
  command: 'config',
  describe: 'Manage bot configuration',
  builder: (yargs) =>
    yargs
      .command('show', 'Show current configuration', {}, async () => {
        try {
          const configManager = new ConfigManager()
          const config = await configManager.loadConfig()
          consola.info('Current Configuration:', JSON.stringify(config, null, 2))
        } catch (error) {
          consola.error('Failed to load configuration:', error)
        }
      })
      .command('validate', 'Validate current configuration', {}, async () => {
        try {
          const configManager = new ConfigManager()
          const config = await configManager.loadConfig()
          const validation = await configManager.validateConfig(config)

          if (validation.valid) {
            consola.success('Configuration is valid')
          } else {
            consola.error('Configuration validation failed:')
            validation.errors.forEach((error: string) => consola.error(`- ${error}`))
          }
        } catch (error) {
          consola.error('Failed to validate configuration:', error)
        }
      })
      .demandCommand(1, 'You need to specify a config subcommand'),
  handler: () => {
    // This won't be called due to demandCommand
  },
}

export { start, stop, status, config }
