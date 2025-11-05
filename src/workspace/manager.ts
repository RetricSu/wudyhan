import { exec, execFile } from 'child_process'
import { promises as fs } from 'fs'
import * as fsSync from 'fs'
import * as path from 'path'
import consola from 'consola'

export class WorkspaceManager {
  private baseDir: string

  constructor(baseDir: string = './workspaces') {
    this.baseDir = path.resolve(baseDir)
  }

  async ensureWorkspaceDir(): Promise<void> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true })
    } catch (error) {
      consola.error('Error creating workspace directory:', error)
    }
  }

  async cloneRepository(owner: string, repo: string, branch?: string): Promise<string | null> {
    // Ensure workspace directory exists first
    await this.ensureWorkspaceDir()

    const repoDir = path.join(this.baseDir, `${owner}-${repo}`)

    try {
      // Check if repo already exists
      await fs.access(repoDir)
      consola.info(`Repository ${owner}/${repo} already exists, pulling latest changes...`)

      // Detect default branch if not specified
      const targetBranch = branch || (await this.getRemoteDefaultBranch(repoDir))

      // Check if the repository has any commits
      try {
        await this.runGitCommand(repoDir, ['rev-parse', 'HEAD'])
        // Has commits, safe to pull
        await this.runGitCommand(repoDir, ['pull', 'origin', targetBranch])
      } catch {
        // Empty repo, just skip pull
        consola.info('Repository is empty, skipping pull')
      }

      return repoDir
    } catch {
      // Repo doesn't exist, clone it
      consola.info(`Cloning repository ${owner}/${repo}...`)
      await this.runGitCommand(this.baseDir, ['clone', `https://github.com/${owner}/${repo}.git`, `${owner}-${repo}`])

      // Detect default branch if not specified
      const targetBranch = branch || (await this.getRemoteDefaultBranch(repoDir))

      // Check if the cloned repo has any commits
      try {
        await this.runGitCommand(repoDir, ['rev-parse', 'HEAD'])
        // Has commits, checkout the branch
        await this.runGitCommand(repoDir, ['checkout', targetBranch])
      } catch {
        // Empty repo, create initial branch
        consola.info('Repository is empty, creating initial branch')
        await this.runGitCommand(repoDir, ['checkout', '-b', targetBranch])
      }

      return repoDir
    }
  }

  async createBranch(repoDir: string, branchName: string): Promise<boolean> {
    try {
      await this.runGitCommand(repoDir, ['checkout', '-b', branchName])
      consola.success(`Created new branch: ${branchName}`)
      return true
    } catch (error) {
      consola.error('Error creating branch:', error)
      return false
    }
  }

  async switchBranch(repoDir: string, branchName: string): Promise<boolean> {
    try {
      await this.runGitCommand(repoDir, ['checkout', branchName])
      consola.success(`Switched to branch: ${branchName}`)
      return true
    } catch (error) {
      consola.error('Error switching branch:', error)
      return false
    }
  }

  /**
   * Get the default branch from remote repository
   * Tries to detect the actual default branch (main/master/etc)
   */
  async getRemoteDefaultBranch(repoDir: string): Promise<string> {
    try {
      const remoteInfo = await this.runGitCommand(repoDir, ['remote', 'show', 'origin'])
      const match = remoteInfo.match(/HEAD branch: (.+)/)
      if (match && match[1]) {
        return match[1].trim()
      }
    } catch (error) {
      consola.warn('Failed to detect default branch from remote, trying fallback methods:', error)
    }

    // Fallback: try to detect from symbolic-ref
    try {
      const symbolicRef = await this.runGitCommand(repoDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
      const match = symbolicRef.match(/refs\/remotes\/origin\/(.+)/)
      if (match && match[1]) {
        consola.info(`Detected default branch via symbolic-ref: ${match[1]}`)
        return match[1].trim()
      }
    } catch (error) {
      consola.warn('Failed to detect default branch from symbolic-ref:', error)
    }

    // Last resort: check which branch exists (main vs master)
    try {
      // Try main first
      await this.runGitCommand(repoDir, ['rev-parse', '--verify', 'origin/main'])
      consola.info('Detected default branch: main')
      return 'main'
    } catch {
      // Try master
      try {
        await this.runGitCommand(repoDir, ['rev-parse', '--verify', 'origin/master'])
        consola.info('Detected default branch: master')
        return 'master'
      } catch {
        consola.warn('Could not detect default branch, using main as ultimate fallback')
        return 'main'
      }
    }
  }

  async getCurrentBranch(repoDir: string): Promise<string> {
    try {
      // Try to get current branch name
      const branch = await this.runGitCommand(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD'])
      return branch
    } catch {
      // If that fails (no commits yet), try symbolic-ref
      try {
        const branch = await this.runGitCommand(repoDir, ['symbolic-ref', '--short', 'HEAD'])
        return branch
      } catch (error) {
        consola.warn('Could not determine current branch, detecting from remote')
        // Use the remote default branch detection
        return await this.getRemoteDefaultBranch(repoDir)
      }
    }
  }

  async commitChanges(repoDir: string, message: string): Promise<boolean> {
    try {
      await this.runGitCommand(repoDir, ['add', '.'])
      await this.runGitCommand(repoDir, ['commit', '-m', message])
      consola.success('Changes committed successfully')
      return true
    } catch (error) {
      consola.error('Error committing changes:', error)
      return false
    }
  }

  async pushBranch(repoDir: string, branchName: string): Promise<boolean> {
    try {
      await this.runGitCommand(repoDir, ['push', 'origin', branchName])
      consola.success(`Branch ${branchName} pushed successfully`)
      return true
    } catch (error) {
      // Check if it's a conflict or other push error
      const errorMessage = (error as Error).message
      if (errorMessage.includes('non-fast-forward') || errorMessage.includes('Updates were rejected')) {
        consola.warn(`Push failed for branch ${branchName}, attempting to resolve conflicts`)
        return await this.resolvePushConflict(repoDir, branchName)
      }

      consola.error('Error pushing branch:', error)
      return false
    }
  }

  async resolvePushConflict(repoDir: string, branchName: string): Promise<boolean> {
    try {
      // Fetch latest changes
      await this.runGitCommand(repoDir, ['fetch', 'origin'])

      // Try to rebase
      try {
        await this.runGitCommand(repoDir, ['rebase', `origin/${branchName}`])
        consola.info('Successfully rebased branch')
      } catch (rebaseError) {
        // If rebase fails, abort and try merge
        try {
          await this.runGitCommand(repoDir, ['rebase', '--abort'])
        } catch (abortError) {
          // Ignore abort errors
        }

        consola.warn('Rebase failed, attempting merge')
        await this.runGitCommand(repoDir, ['merge', `origin/${branchName}`])
        consola.info('Successfully merged branch')
      }

      // Try pushing again
      await this.runGitCommand(repoDir, ['push', 'origin', branchName])
      consola.success(`Branch ${branchName} pushed successfully after conflict resolution`)
      return true
    } catch (error) {
      consola.error('Failed to resolve push conflict:', error)
      return false
    }
  }

  async checkForConflicts(repoDir: string, targetBranch: string = 'main'): Promise<boolean> {
    try {
      // Check if there would be conflicts by attempting a dry-run merge
      await this.runGitCommand(repoDir, ['merge', '--no-commit', '--no-ff', `origin/${targetBranch}`])

      // If we get here, no conflicts
      await this.runGitCommand(repoDir, ['merge', '--abort'])
      return false
    } catch (error) {
      // If merge fails, there might be conflicts
      try {
        await this.runGitCommand(repoDir, ['merge', '--abort'])
      } catch (abortError) {
        // Ignore abort errors
      }

      const errorMessage = (error as Error).message
      if (errorMessage.includes('CONFLICT') || errorMessage.includes('conflict')) {
        return true
      }

      // Other errors might not be conflicts
      return false
    }
  }

  async getIssueBranches(repoDir: string, issueNumber: number): Promise<string[]> {
    try {
      // Get all branches
      const branchesOutput = await this.runGitCommand(repoDir, ['branch', '-r'])
      const branches = branchesOutput
        .split('\n')
        .map((line) => line.trim().replace('origin/', ''))
        .filter((line) => line && line.includes(`issue-${issueNumber}`))

      return branches
    } catch (error) {
      consola.error('Error getting issue branches:', error)
      return []
    }
  }

  async applyCodeChanges(repoDir: string, filePath: string, content: string): Promise<boolean> {
    try {
      const fullPath = path.join(repoDir, filePath)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      await fs.writeFile(fullPath, content, 'utf-8')
      consola.success(`Applied changes to ${filePath}`)
      return true
    } catch (error) {
      consola.error('Error applying code changes:', error)
      return false
    }
  }

  async runTests(repoDir: string): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const testCommand = this.detectTestCommand(repoDir)

      if (!testCommand) {
        consola.warn('No test command detected, skipping tests')
        resolve({ success: true, output: 'No tests configured' })
        return
      }

      consola.info('Running tests...')
      exec(testCommand, { cwd: repoDir }, (error, stdout, stderr) => {
        const output = stdout + stderr
        const success = !error

        if (success) {
          consola.success('Tests passed')
        } else {
          consola.error('Tests failed')
        }

        resolve({ success, output })
      })
    })
  }

  async runLinting(repoDir: string): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const lintCommand = this.detectLintCommand(repoDir)

      if (!lintCommand) {
        consola.warn('No lint command detected, skipping linting')
        resolve({ success: true, output: 'No linting configured' })
        return
      }

      consola.info('Running linting...')
      exec(lintCommand, { cwd: repoDir }, (error, stdout, stderr) => {
        const output = stdout + stderr
        const success = !error

        if (success) {
          consola.success('Linting passed')
        } else {
          consola.error('Linting failed')
        }

        resolve({ success, output })
      })
    })
  }

  async runBuild(repoDir: string): Promise<{ success: boolean; output: string }> {
    return new Promise((resolve) => {
      const buildCommand = this.detectBuildCommand(repoDir)

      if (!buildCommand) {
        consola.warn('No build command detected, skipping build')
        resolve({ success: true, output: 'No build configured' })
        return
      }

      consola.info('Running build...')
      exec(buildCommand, { cwd: repoDir }, (error, stdout, stderr) => {
        const output = stdout + stderr
        const success = !error

        if (success) {
          consola.success('Build passed')
        } else {
          consola.error('Build failed')
        }

        resolve({ success, output })
      })
    })
  }

  private detectTestCommand(repoDir: string): string | null {
    // Check for common test scripts in package.json
    try {
      const packageJsonPath = path.join(repoDir, 'package.json')
      const packageJsonContent = fsSync.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonContent)

      if (packageJson.scripts) {
        if (packageJson.scripts.test) {
          return packageJson.scripts.test
        }
        if (packageJson.scripts['test:unit']) {
          return packageJson.scripts['test:unit']
        }
      }
    } catch (error) {
      // package.json not found or invalid
    }

    // Fallback to common test commands
    return 'npm test'
  }

  private detectLintCommand(repoDir: string): string | null {
    try {
      const packageJsonPath = path.join(repoDir, 'package.json')
      const packageJsonContent = fsSync.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonContent)

      if (packageJson.scripts) {
        if (packageJson.scripts.lint) {
          return packageJson.scripts.lint
        }
        if (packageJson.scripts['lint:fix']) {
          return packageJson.scripts['lint:fix']
        }
      }
    } catch (error) {
      // package.json not found or invalid
    }

    return null
  }

  private detectBuildCommand(repoDir: string): string | null {
    try {
      const packageJsonPath = path.join(repoDir, 'package.json')
      const packageJsonContent = fsSync.readFileSync(packageJsonPath, 'utf-8')
      const packageJson = JSON.parse(packageJsonContent)

      if (packageJson.scripts) {
        if (packageJson.scripts.build) {
          return packageJson.scripts.build
        }
        if (packageJson.scripts['build:prod']) {
          return packageJson.scripts['build:prod']
        }
      }
    } catch (error) {
      // package.json not found or invalid
    }

    return null
  }

  private async runGitCommand(cwd: string, args: string[], silenceExpectedErrors: boolean = false): Promise<string> {
    return new Promise((resolve, reject) => {
      consola.debug('Running git command:', 'git', args.join(' '))

      // Use execFile which doesn't require a shell
      execFile('/usr/bin/git', args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          // Don't log errors that are expected (like checking HEAD on empty repo)
          const isExpectedError =
            silenceExpectedErrors || (args[0] === 'rev-parse' && stderr.includes('unknown revision or path'))

          if (!isExpectedError) {
            consola.error('Git execFile error:', error)
            consola.error('Git stderr:', stderr)
          } else {
            consola.debug('Git command failed (expected):', args.join(' '))
          }

          reject(new Error(`Git command failed: ${stderr || error.message}`))
        } else {
          consola.debug('Git stdout:', stdout.trim())
          resolve(stdout.trim())
        }
      })
    })
  }
}
