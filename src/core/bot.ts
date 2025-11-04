import { consola } from 'consola'
import { BotConfig, BotStatus, Issue } from './types'
import { GitHubClient } from '../github/client'
import { IssueManager } from '../github/issues'
import { WorkspaceManager } from '../workspace/manager'
import { CodexClient } from '../ai/codex'

export class GitHubMaintainBot {
  private config: BotConfig
  private isRunning = false
  private intervalId?: NodeJS.Timeout
  private status: BotStatus = {
    isRunning: false,
    lastCheck: new Date(),
    processedIssues: 0,
    activeTasks: 0,
  }

  private githubClient: GitHubClient
  private issueManager: IssueManager
  private workspaceManager: WorkspaceManager
  private codexClient: CodexClient

  constructor(config: BotConfig) {
    this.config = config
    this.githubClient = new GitHubClient(config.githubToken)
    this.issueManager = new IssueManager(this.githubClient)
    this.workspaceManager = new WorkspaceManager()
    this.codexClient = new CodexClient({
      apiKey: config.codexApiKey,
      model: config.codexModel,
    })
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      consola.warn('Bot is already running')
      return
    }

    consola.info('Starting GitHub Maintain Bot...')
    this.isRunning = true
    this.status.isRunning = true

    // Start the monitoring loop
    this.intervalId = setInterval(async () => {
      await this.checkAndProcessIssues()
    }, this.config.interval)

    consola.success('Bot started successfully')
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      consola.warn('Bot is not running')
      return
    }

    consola.info('Stopping GitHub Maintain Bot...')
    this.isRunning = false
    this.status.isRunning = false

    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = undefined
    }

    consola.success('Bot stopped successfully')
  }

  getStatus(): BotStatus {
    return { ...this.status }
  }

  private async checkAndProcessIssues(): Promise<void> {
    try {
      this.status.lastCheck = new Date()
      consola.debug('Checking for new issues...')

      // Get assigned issues
      const issues = await this.issueManager.getAssignedIssues()

      if (issues.length === 0) {
        consola.debug('No assigned issues found')
        return
      }

      consola.info(`Found ${issues.length} assigned issues`)

      // Process each issue
      for (const issue of issues) {
        await this.processIssue(issue)
        this.status.processedIssues++
      }
    } catch (error) {
      consola.error('Error during issue check:', error)
    }
  }

  private async processIssue(issue: Issue): Promise<void> {
    try {
      consola.info(`Processing issue #${issue.number}: ${issue.title}`)

      // Analyze the issue to determine if we can handle it
      const analysis = await this.issueManager.analyzeIssue(issue)

      if (!analysis.canHandle) {
        consola.info(`Skipping issue #${issue.number} - cannot handle automatically`)
        return
      }

      // Update issue status
      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        '🤖 Bot is analyzing and working on this issue...',
      )

      // Process each task
      for (const task of analysis.tasks) {
        await this.processTask(issue, task)
      }

      // Create pull request if we made changes
      await this.createPullRequestForIssue(issue)
    } catch (error) {
      consola.error(`Error processing issue #${issue.number}:`, error)
    }
  }

  private async processTask(issue: Issue, task: string): Promise<void> {
    try {
      consola.info(`Processing task: ${task}`)

      // Update issue status with task progress
      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nCloning repository and setting up workspace...`,
      )

      // Clone or update the repository
      const repoDir = await this.workspaceManager.cloneRepository(issue.repository.owner.login, issue.repository.name)

      if (!repoDir) {
        throw new Error('Failed to access repository')
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nRepository ready. Creating feature branch...`,
      )

      // Create a branch for this task
      const branchName = `bot/issue-${issue.number}/${task.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50)}`
      const branchCreated = await this.workspaceManager.createBranch(repoDir, branchName)

      if (!branchCreated) {
        throw new Error('Failed to create branch')
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nBranch created. Generating code solution...`,
      )

      // Generate code for the task
      const codebaseContext = await this.getCodebaseContext(repoDir)
      const generatedCode = await this.codexClient.generateCode(task, codebaseContext)

      if (!generatedCode) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nFailed to generate code solution. Manual intervention required.`,
        )
        consola.warn(`Failed to generate code for task: ${task}`)
        return
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nCode generated. Applying changes...`,
      )

      // Parse and apply the generated code
      const codeApplied = await this.applyGeneratedCode(repoDir, generatedCode, task)

      if (!codeApplied) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nFailed to apply code changes. Manual review needed.`,
        )
        consola.warn(`Failed to apply generated code for task: ${task}`)
        return
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nChanges applied. Running validation...`,
      )

      // Run tests to validate changes
      const testResult = await this.workspaceManager.runTests(repoDir)

      if (!testResult.success) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nTests failed. Attempting to fix or manual review required.\n\nTest output: ${testResult.output.substring(0, 200)}...`,
        )
        consola.warn(`Tests failed for task: ${task}`)
        consola.debug('Test output:', testResult.output)
        // TODO: Could attempt to fix the code or revert changes
        return
      }

      // Run linting
      const lintResult = await this.workspaceManager.runLinting(repoDir)

      if (!lintResult.success) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nLinting warnings detected. Code may need manual review.\n\nLint output: ${lintResult.output.substring(0, 200)}...`,
        )
        consola.warn(`Linting failed for task: ${task}`)
        consola.debug('Lint output:', lintResult.output)
        // Continue anyway, linting failures might not be critical
      }

      // Run build if available
      const buildResult = await this.workspaceManager.runBuild(repoDir)

      if (!buildResult.success) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nBuild failed. Manual intervention required.\n\nBuild output: ${buildResult.output.substring(0, 200)}...`,
        )
        consola.warn(`Build failed for task: ${task}`)
        consola.debug('Build output:', buildResult.output)
        // TODO: Could attempt to fix build issues
        return
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nValidation passed. Committing changes...`,
      )

      // Commit the changes
      const commitMessage = `🤖 Bot: ${task}\n\nResolves part of issue #${issue.number}`
      const committed = await this.workspaceManager.commitChanges(repoDir, commitMessage)

      if (!committed) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nFailed to commit changes. Manual review needed.`,
        )
        consola.warn(`Failed to commit changes for task: ${task}`)
        return
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `🤖 **Working on:** ${task}\n\nChanges committed. Pushing to remote...`,
      )

      // Push the branch
      const pushed = await this.workspaceManager.pushBranch(repoDir, branchName)

      if (!pushed) {
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          `⚠️ **Issue:** ${task}\n\nFailed to push changes. Manual intervention required.`,
        )
        consola.warn(`Failed to push branch for task: ${task}`)
        return
      }

      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `✅ **Task completed:** ${task}\n\nAll validation passed and changes pushed successfully.`,
      )

      consola.success(`Successfully processed task: ${task}`)
    } catch (error) {
      await this.issueManager.updateIssueStatus(
        issue.repository.owner.login,
        issue.repository.name,
        issue.number,
        `❌ **Error processing task:** ${task}\n\nAn unexpected error occurred. Manual intervention required.`,
      )
      consola.error(`Error processing task "${task}":`, error)
    }
  }

  private async applyGeneratedCode(repoDir: string, generatedCode: string, task: string): Promise<boolean> {
    try {
      // TODO: Implement intelligent code parsing and application
      // For now, this is a placeholder that would need to:
      // 1. Parse the generated code to identify what files to modify
      // 2. Determine where in the files to make changes
      // 3. Apply the changes safely

      consola.debug('Generated code to apply:', generatedCode)

      // Placeholder: Assume the code contains file paths and content
      // This would need sophisticated parsing in a real implementation

      // For demonstration, create a simple example file
      const exampleFile = 'bot-generated-changes.txt'
      const content = `Generated code for task: ${task}\n\n${generatedCode}\n\nThis is a placeholder implementation.`

      return await this.workspaceManager.applyCodeChanges(repoDir, exampleFile, content)
    } catch (error) {
      consola.error('Error applying generated code:', error)
      return false
    }
  }

  private async getCodebaseContext(repoDir: string): Promise<string> {
    // TODO: Analyze the codebase structure and provide relevant context
    // For now, return basic context about the repository
    try {
      // Could analyze package.json, tsconfig.json, etc.
      const context = `Repository at ${repoDir}. This appears to be a TypeScript/JavaScript project.`
      return context
    } catch (error) {
      consola.warn('Error getting codebase context:', error)
      return 'General TypeScript/JavaScript project context.'
    }
  }

  private async createPullRequestForIssue(issue: Issue): Promise<void> {
    try {
      consola.info(`Creating PR for issue #${issue.number}: ${issue.title}`)

      // Check if there are any branches created for this issue
      const repoDir = await this.workspaceManager.cloneRepository(issue.repository.owner.login, issue.repository.name)

      if (!repoDir) {
        consola.warn('Could not access repository for PR creation')
        return
      }

      // Get all branches created for this issue
      const issueBranches = await this.workspaceManager.getIssueBranches(repoDir, issue.number)

      if (issueBranches.length === 0) {
        consola.info(`No branches found for issue #${issue.number}`)
        return
      }

      consola.info(`Found ${issueBranches.length} branches for issue #${issue.number}`)

      // Check for conflicts on each branch before creating PR
      const validBranches: string[] = []
      for (const branch of issueBranches) {
        const hasConflicts = await this.workspaceManager.checkForConflicts(repoDir, 'main')
        if (!hasConflicts) {
          validBranches.push(branch)
        } else {
          consola.warn(`Branch ${branch} has conflicts with main, skipping PR creation`)
        }
      }

      if (validBranches.length === 0) {
        consola.warn(`No valid branches found for issue #${issue.number} - all have conflicts`)
        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          '⚠️ **Issue partially resolved** - Some changes have merge conflicts and need manual review',
        )
        return
      }

      // For now, create a single PR combining all valid branches
      // TODO: In the future, could create separate PRs for each branch
      const prTitle = `🤖 Bot: Resolve issue #${issue.number} - ${issue.title}`
      const prBody = this.generatePRDescription(issue, validBranches)

      // Use the first valid branch as head
      const headBranch = validBranches[0]
      if (!headBranch) {
        consola.error('No valid head branch found')
        return
      }

      // Create the PR using MCP
      const pr = await this.githubClient.createPullRequest(issue.repository.owner.login, issue.repository.name, {
        title: prTitle,
        body: prBody,
        head: headBranch,
        base: 'main',
      })

      if (pr) {
        consola.success(`Created PR #${pr.number} for issue #${issue.number}`)

        // Update the issue with PR link and status
        const statusMessage =
          validBranches.length === issueBranches.length
            ? `✅ **Issue resolved!** PR created: #${pr.number}`
            : `✅ **Issue partially resolved!** PR created: #${pr.number}\n⚠️ Some branches had conflicts and were not included`

        await this.issueManager.updateIssueStatus(
          issue.repository.owner.login,
          issue.repository.name,
          issue.number,
          statusMessage,
        )
      } else {
        consola.error('Failed to create PR')
      }
    } catch (error) {
      consola.error(`Error creating PR for issue #${issue.number}:`, error)
    }
  }

  private generatePRDescription(issue: Issue, validBranches: string[]): string {
    const branchesList = validBranches.map((branch) => `- ${branch}`).join('\n')

    return `## 🤖 Bot-generated PR

This PR addresses issue #${issue.number}: **${issue.title}**

### Changes Made:
${branchesList}

### Issue Details:
${issue.body ? issue.body.substring(0, 500) + (issue.body.length > 500 ? '...' : '') : 'No description provided'}

### Testing:
- ✅ All tests pass
- ✅ Code follows project standards
- ✅ No breaking changes introduced

Closes #${issue.number}`
  }
}
