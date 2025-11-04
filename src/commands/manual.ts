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
      consola.level = level as any

      consola.info('Initializing bot for PR creation...')
      const bot = new GitHubMaintainBot(config)

      consola.info(`\nCreating PR for issue #${issueNumber} in ${owner}/${repo}...\n`)
      await bot.createPullRequest(issueNumber, owner, repo)

      consola.success('\nPR creation process completed!')
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
      const customMessage = argv.message as string | undefined

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
      consola.level = level as any

      consola.info('Initializing bot for commit...')
      const bot = new GitHubMaintainBot(config)

      consola.info(`\nCommitting and pushing changes for issue #${issueNumber} in ${owner}/${repo}...\n`)
      const commitMessage =
        customMessage || `🤖 Bot: Fix issue #${issueNumber}\n\nResolves part of issue #${issueNumber}`

      await bot.commitAndPush(issueNumber, owner, repo, commitMessage)

      consola.success('\nCommit and push completed!')
      consola.info('\nNext step: Create a PR with:')
      consola.info(`  pnpm start pr ${issueNumber} ${owner} ${repo}`)
    } catch (error) {
      consola.error('Failed to commit:', error)
      process.exit(1)
    }
  },
}
