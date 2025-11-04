import { CommandModule } from 'yargs'
import consola from 'consola'
import { config as dotenvConfig } from 'dotenv'
import { GitHubMaintainBot } from '../core/bot'
import { ConfigManager } from '../config/config'

// Scan command - manually scan for assigned issues
export const scan: CommandModule = {
  command: 'scan',
  describe: 'Scan for assigned GitHub issues and analyze tasks',
  handler: async () => {
    try {
      // Load environment variables
      dotenvConfig()

      const configManager = new ConfigManager()
      const config = await configManager.loadConfig()

      // Set log level
      const logLevels: Record<string, number> = { error: 0, warn: 1, info: 3, debug: 4 }
      const level = logLevels[config.logLevel || 'info'] ?? 3
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consola.level = level as any

      consola.info('Initializing bot for issue scanning...')
      const bot = new GitHubMaintainBot(config)

      consola.info('Scanning for assigned issues...\n')
      const issues = await bot.scanIssues()

      if (issues.length === 0) {
        consola.info('No issues found. Make sure you have issues assigned to you in the configured repositories.')
      } else {
        consola.success(`\nScan complete! Found ${issues.length} issue(s).`)
        consola.info('\nTo process an issue, use: pnpm start start')
      }
    } catch (error) {
      consola.error('Failed to scan issues:', error)
      process.exit(1)
    }
  },
}

// PR command - manually create PR for an issue after code generation
export const pr: CommandModule = {
  command: 'pr <issue> <owner> <repo>',
  describe: 'Create a pull request for a specific issue (after code has been generated)',
  builder: (yargs) =>
    yargs
      .positional('issue', {
        describe: 'Issue number',
        type: 'number',
      })
      .positional('owner', {
        describe: 'Repository owner',
        type: 'string',
      })
      .positional('repo', {
        describe: 'Repository name',
        type: 'string',
      }),
  handler: async (argv) => {
    try {
      const issueNumber = argv.issue as number
      const owner = argv.owner as string
      const repo = argv.repo as string

      if (!issueNumber || !owner || !repo) {
        consola.error('Missing required arguments: issue, owner, repo')
        process.exit(1)
      }

      // Load environment variables
      dotenvConfig()

      const configManager = new ConfigManager()
      const config = await configManager.loadConfig()

      // Set log level
      const logLevels: Record<string, number> = { error: 0, warn: 1, info: 3, debug: 4 }
      const level = logLevels[config.logLevel || 'info'] ?? 3
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consola.level = level as any

      consola.warn('\nNOTE: The "pr" command is deprecated in the new workflow architecture.')
      consola.info('PRs are now created automatically as part of the automated workflow.')
      consola.info(`\nTo process issue #${issueNumber}, use the scan command instead:`)
      consola.info(`  pnpm start scan`)
      consola.info('\nThe bot will automatically:')
      consola.info('  1. Create a task for the issue')
      consola.info('  2. Generate code fixes')
      consola.info('  3. Run tests')
      consola.info('  4. Commit and push changes')
      consola.info('  5. Create a pull request')

      // For backwards compatibility, we could manually create a task
      // but the old bot.createPullRequest method has been removed
      consola.error('\nDirect PR creation is no longer supported.')
      consola.info('Please use the automated workflow instead.')
      process.exit(1)
    } catch (error) {
      consola.error('Failed to create PR:', error)
      process.exit(1)
    }
  },
}

// Commit command - commit and push changes for an issue
export const commit: CommandModule = {
  command: 'commit <issue> <owner> <repo> [message]',
  describe: 'Commit and push changes for a specific issue',
  builder: (yargs) =>
    yargs
      .positional('issue', {
        describe: 'Issue number',
        type: 'number',
      })
      .positional('owner', {
        describe: 'Repository owner',
        type: 'string',
      })
      .positional('repo', {
        describe: 'Repository name',
        type: 'string',
      })
      .positional('message', {
        describe: 'Commit message (optional)',
        type: 'string',
      }),
  handler: async (argv) => {
    try {
      const issueNumber = argv.issue as number
      const owner = argv.owner as string
      const repo = argv.repo as string

      if (!issueNumber || !owner || !repo) {
        consola.error('Missing required arguments: issue, owner, repo')
        process.exit(1)
      }

      // Load environment variables
      dotenvConfig()

      const configManager = new ConfigManager()
      const config = await configManager.loadConfig()

      // Set log level
      const logLevels: Record<string, number> = { error: 0, warn: 1, info: 3, debug: 4 }
      const level = logLevels[config.logLevel || 'info'] ?? 3
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consola.level = level as any

      consola.warn('\nNOTE: The "commit" command is deprecated in the new workflow architecture.')
      consola.info('Commits are now handled automatically as part of the workflow.')
      consola.info(`\nTo process issue #${issueNumber}, use the scan command instead:`)
      consola.info(`  pnpm start scan`)
      consola.info('\nThe bot will automatically handle all commit and push operations.')

      // For backwards compatibility, we could manually create a task
      // but the old bot.commitAndPush method has been removed
      consola.error('\nDirect commit/push is no longer supported.')
      consola.info('Please use the automated workflow instead.')
      process.exit(1)
    } catch (error) {
      consola.error('Failed to commit:', error)
      process.exit(1)
    }
  },
}
