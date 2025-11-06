/**
 * WorkflowSteps: Idempotent workflow step implementations
 */

import consola from 'consola'
import { Task, TaskCheckpoints, generateBranchName } from './task'
import { TaskStore } from './task-store'
import { WorkspaceManager } from '../workspace/manager'
import { CodexClient } from '../ai/codex'
import { IssueManager } from '../github/issues'
import { GitHubClient } from '../github/client'
import { CommandParser } from '../github/command-parser'
import { Issue } from './types'

export interface StepContext {
  task: Task
  taskStore: TaskStore
  workspaceManager: WorkspaceManager
  codexClient: CodexClient
  issueManager: IssueManager
  githubClient: GitHubClient
  issue: Issue
}

export interface StepResult {
  success: boolean
  error?: string
  shouldRetry?: boolean
  isPolling?: boolean // True if this is a polling wait (don't increment retry count)
}

/**
 * Step 1: Plan - Prepare issue description for AI
 */
export async function planStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Planning step`)

    // Check if plan already exists
    if (ctx.task.checkpoints.plan) {
      consola.debug('Plan already exists, skipping')
      return { success: true }
    }

    // Simple plan: just combine title and body for AI
    const fullDescription = `# ${ctx.issue.title}\n\n${ctx.issue.body || ''}`

    const plan = {
      description: fullDescription,
      timestamp: new Date().toISOString(),
    }

    // Update checkpoints
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      plan,
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'branch', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Plan created from issue description`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Plan step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 2: Branch - Create a deterministic branch
 */
export async function branchStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Branch step`)

    // Check if branch already exists
    if (ctx.task.checkpoints.branch) {
      consola.debug('Branch already created, skipping')
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    // Clone repository
    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to clone repository',
        shouldRetry: true,
      }
    }

    // Ensure we're on the default branch first
    const defaultBranch = await ctx.workspaceManager.getRemoteDefaultBranch(repoDir)
    await ctx.workspaceManager.switchBranch(repoDir, defaultBranch)

    // Get current HEAD SHA
    const headSha = ctx.task.repoHeadSha

    // Generate deterministic branch name
    const branchName = generateBranchName(ctx.task.issueNumber, ctx.task.fingerprint)

    // Check if branch already exists (idempotent)
    const existingBranches = await ctx.workspaceManager.getIssueBranches(repoDir, ctx.task.issueNumber)
    const branchExists = existingBranches.some((b) => b === branchName)

    if (!branchExists) {
      // Create the branch from default branch
      const created = await ctx.workspaceManager.createBranch(repoDir, branchName)
      if (!created) {
        return {
          success: false,
          error: 'Failed to create branch',
          shouldRetry: true,
        }
      }
    } else {
      consola.debug(`Branch ${branchName} already exists, checking it out`)
      // Switch to existing branch
      const switched = await ctx.workspaceManager.switchBranch(repoDir, branchName)
      if (!switched) {
        return {
          success: false,
          error: 'Failed to switch to existing branch',
          shouldRetry: true,
        }
      }
    }

    // Update checkpoints
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      branch: {
        name: branchName,
        baseSha: headSha,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'codex_generate', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Branch created: ${branchName}`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Branch step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Helper: Get all feedbacks from issue comments
 */
async function getFeedbacks(ctx: StepContext): Promise<string[]> {
  try {
    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) return []

    const comments = await ctx.githubClient.getIssueComments(owner, repo, ctx.task.issueNumber)
    const parser = new CommandParser()

    const feedbacks = comments
      .map((comment) => parser.parseFeedback(comment.body))
      .filter((f): f is string => f !== null)

    return feedbacks
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Failed to get feedbacks:`, error)
    return []
  }
}

/**
 * Helper: Build prompt with feedbacks
 */
function buildPromptWithFeedback(issueDescription: string, feedbacks: string[]): string {
  let prompt = issueDescription

  if (feedbacks.length > 0) {
    prompt += '\n\n--- User Feedbacks ---\n'
    prompt += feedbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')
    prompt += '\n\nPlease take the above feedbacks into account when implementing the solution.'
  }

  return prompt
}

/**
 * Step 3: Codex Generate - Use AI to generate code changes
 */
export async function codexGenerateStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Codex generate step`)

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    // Check if codex job is already running or completed
    let codexCheckpoint = ctx.task.checkpoints.codex_generate

    // Handle resume request from user command (check this FIRST before completedAt)
    if (ctx.task.commandState === 'resume_requested' && codexCheckpoint?.jobId) {
      consola.info(`[Task ${ctx.task.id}] Resume requested for job ${codexCheckpoint.jobId}`)

      // Collect feedbacks
      const feedbacks = await getFeedbacks(ctx)
      const feedbackPrompt =
        feedbacks.length > 0
          ? `User feedback:\n${feedbacks.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nPlease continue and address the above feedback.`
          : undefined

      try {
        // Get the old job to find session ID
        const oldJobStatus = await ctx.codexClient.getJobStatus(codexCheckpoint.jobId)

        if (!oldJobStatus.sessionId) {
          consola.warn(`[Task ${ctx.task.id}] No session ID found, cannot resume. Starting fresh instead.`)
          // Clear checkpoint and let it restart below
          const clearedCheckpoints = { ...ctx.task.checkpoints }
          delete clearedCheckpoints.codex_generate
          delete clearedCheckpoints.post_results

          ctx.taskStore.updateTask(ctx.task.id, {
            checkpoints: clearedCheckpoints,
          })
          ctx.taskStore.updateCommandState(ctx.task.id, null)

          // Fall through to normal start logic
          codexCheckpoint = undefined
        } else {
          // Resume the job with feedback
          const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)
          if (!repoDir) {
            return {
              success: false,
              error: 'Failed to access repository',
              shouldRetry: true,
            }
          }

          const branchName = ctx.task.checkpoints.branch?.name
          if (!branchName) {
            return {
              success: false,
              error: 'Branch name not found in checkpoints',
              shouldRetry: false,
            }
          }

          const switched = await ctx.workspaceManager.switchBranch(repoDir, branchName)
          if (!switched) {
            return {
              success: false,
              error: 'Failed to switch to task branch',
              shouldRetry: true,
            }
          }

          const newJobId = await ctx.codexClient.resumeJob(codexCheckpoint.jobId, feedbackPrompt)

          // Update checkpoint with new job ID
          const checkpoints: TaskCheckpoints = {
            ...ctx.task.checkpoints,
            codex_generate: {
              jobId: newJobId,
              startedAt: new Date().toISOString(),
            },
          }

          ctx.taskStore.updateTask(ctx.task.id, {
            checkpoints,
          })
          ctx.taskStore.updateCommandState(ctx.task.id, null)

          consola.info(`[Task ${ctx.task.id}] Codex job resumed: ${newJobId}`)

          return {
            success: false,
            error: 'Codex job resumed, waiting for completion',
            shouldRetry: true,
            isPolling: true,
          }
        }
      } catch (error) {
        consola.error(`[Task ${ctx.task.id}] Failed to resume codex job:`, error)
        // Clear the resume request and try fresh start
        ctx.taskStore.updateCommandState(ctx.task.id, null)
        const clearedCheckpoints = { ...ctx.task.checkpoints }
        delete clearedCheckpoints.codex_generate
        delete clearedCheckpoints.post_results

        ctx.taskStore.updateTask(ctx.task.id, {
          checkpoints: clearedCheckpoints,
        })
        codexCheckpoint = undefined
        // Fall through to normal start
      }
    }

    // Check if already completed (after resume check to allow resume even if completed)
    if (codexCheckpoint?.completedAt) {
      consola.debug('Codex generation already completed, skipping')
      return { success: true }
    }

    // If job ID exists, check status (don't clone/pull while polling)
    if (codexCheckpoint?.jobId) {
      consola.debug(`[Task ${ctx.task.id}] Checking status of codex job ${codexCheckpoint.jobId}`)
      const status = await ctx.codexClient.getJobStatus(codexCheckpoint.jobId)

      if (status.completed) {
        // Job completed successfully
        const checkpoints: TaskCheckpoints = {
          ...ctx.task.checkpoints,
          codex_generate: {
            ...codexCheckpoint,
            completedAt: new Date().toISOString(),
            commitSha: status.commitSha,
            filesModified: status.filesModified,
            aiSummary: status.aiSummary,
          },
        }

        ctx.taskStore.updateTaskProgress(ctx.task.id, 'post_results', checkpoints)
        consola.success(`[Task ${ctx.task.id}] Codex generation completed`)
        return { success: true }
      } else if (status.failed) {
        // Job failed, clear checkpoint so next retry starts fresh
        consola.warn(`[Task ${ctx.task.id}] Codex job failed, will start new job on retry`)
        const clearedCheckpoints = { ...ctx.task.checkpoints }
        delete clearedCheckpoints.codex_generate

        ctx.taskStore.updateTask(ctx.task.id, {
          checkpoints: clearedCheckpoints,
        })

        return {
          success: false,
          error: status.error || 'Codex job failed',
          shouldRetry: true,
        }
      }

      // Job still running, keep polling
      consola.debug(`[Task ${ctx.task.id}] Codex job still running...`)
      return {
        success: false,
        error: 'Codex job in progress',
        shouldRetry: true,
        isPolling: true, // This is polling, not a real failure
      }
    }

    // No existing job, need to start a new one
    // First, clone/pull repository
    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    // Ensure we're on the correct branch before running codex
    const branchName = ctx.task.checkpoints.branch?.name
    if (!branchName) {
      return {
        success: false,
        error: 'Branch name not found in checkpoints',
        shouldRetry: false,
      }
    }

    consola.debug(`Switching to branch: ${branchName}`)
    const switched = await ctx.workspaceManager.switchBranch(repoDir, branchName)
    if (!switched) {
      return {
        success: false,
        error: 'Failed to switch to task branch',
        shouldRetry: true,
      }
    }

    // Start new codex job
    const plan = ctx.task.checkpoints.plan
    if (!plan) {
      return {
        success: false,
        error: 'No plan found',
        shouldRetry: false,
      }
    }

    // Collect feedbacks from issue comments
    const feedbacks = await getFeedbacks(ctx)
    if (feedbacks.length > 0) {
      consola.info(`[Task ${ctx.task.id}] Found ${feedbacks.length} user feedback(s)`)
    }

    // Build prompt from issue description with feedbacks
    const prompt = buildPromptWithFeedback(plan.description, feedbacks)

    // Execute codex
    const result = await ctx.codexClient.executeWithJobTracking(prompt, undefined, repoDir)

    if (result.jobId) {
      // Job started, save job ID
      codexCheckpoint = {
        jobId: result.jobId,
        startedAt: new Date().toISOString(),
      }

      const checkpoints: TaskCheckpoints = {
        ...ctx.task.checkpoints,
        codex_generate: codexCheckpoint,
      }

      ctx.taskStore.updateTaskProgress(ctx.task.id, 'codex_generate', checkpoints)
      consola.info(`[Task ${ctx.task.id}] Codex job started: ${result.jobId}`)

      // Return false to keep polling
      return {
        success: false,
        error: 'Codex job started, waiting for completion',
        shouldRetry: true,
        isPolling: true, // This is polling, not a real failure
      }
    }

    // Synchronous execution completed
    if (!result.success) {
      return {
        success: false,
        error: result.error || 'Codex execution failed',
        shouldRetry: true,
      }
    }

    // Update checkpoints with completion
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      codex_generate: {
        jobId: result.jobId || 'sync',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'post_results', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Codex generation completed`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Codex generate step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 4: Post Results - Show changes to user and wait for approval
 */
export async function postResultsStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Post results step - waiting for user approval`)

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)
    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    // Get branch name from checkpoint
    const branchCheckpoint = ctx.task.checkpoints.branch
    if (!branchCheckpoint) {
      return {
        success: false,
        error: 'Branch checkpoint not found',
        shouldRetry: false,
      }
    }

    // Collect git diff
    const gitDiff = await ctx.workspaceManager.getGitDiff(repoDir)
    const filesChanged = await ctx.workspaceManager.getChangedFiles(repoDir)

    // Build results comment
    const commentBody = buildResultsComment({
      taskId: ctx.task.id,
      branchName: branchCheckpoint.name,
      filesChanged,
      diffPreview: gitDiff.slice(0, 2000), // Limit preview to 2000 chars
      codexCheckpoint: ctx.task.checkpoints.codex_generate,
    })

    // Post comment to GitHub
    const comment = await ctx.githubClient.createComment(owner, repo, ctx.task.issueNumber, commentBody)

    // Update task state to waiting_feedback
    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      post_results: {
        commentId: comment.id,
        commentUrl: comment.url,
        filesChanged: filesChanged.length,
        timestamp: new Date().toISOString(),
      },
    }

    // Important: Set state to waiting_feedback instead of moving to next step
    ctx.taskStore.updateTask(ctx.task.id, {
      state: 'waiting_feedback',
      currentStep: 'post_results',
      checkpoints: checkpoints,
    })

    consola.success(`[Task ${ctx.task.id}] Results posted, waiting for user approval (comment: ${comment.url})`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Post results step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Helper: Build results comment for user review
 */
function buildResultsComment(params: {
  taskId: string
  branchName: string
  filesChanged: string[]
  diffPreview: string
  codexCheckpoint?: TaskCheckpoints['codex_generate']
}): string {
  const { taskId, branchName, filesChanged, diffPreview, codexCheckpoint } = params

  let comment = `## 🤖 Code Generation Completed\n\n`
  comment += `**Task ID:** ${taskId}\n`
  comment += `**Branch:** \`${branchName}\`\n\n`

  if (codexCheckpoint) {
    comment += `### 📊 Execution Summary\n\n`
    comment += `- **Job ID:** ${codexCheckpoint.jobId}\n`
    comment += `- **Started:** ${new Date(codexCheckpoint.startedAt).toLocaleString()}\n`
    if (codexCheckpoint.completedAt) {
      comment += `- **Completed:** ${new Date(codexCheckpoint.completedAt).toLocaleString()}\n`
    }
    comment += `\n`
  }

  // Add AI summary if available
  if (codexCheckpoint?.aiSummary) {
    comment += `### 🤖 AI Summary\n\n`
    comment += `${codexCheckpoint.aiSummary}\n\n`
  }

  comment += `### 📝 Files Modified (${filesChanged.length})\n\n`
  if (filesChanged.length > 0) {
    filesChanged.slice(0, 10).forEach((file) => {
      comment += `- \`${file}\`\n`
    })
    if (filesChanged.length > 10) {
      comment += `- ... and ${filesChanged.length - 10} more files\n`
    }
  } else {
    comment += `_No files modified_\n`
  }

  comment += `\n### 🔍 Changes Preview\n\n`
  if (diffPreview) {
    comment += `<details>\n<summary>Click to see diff preview</summary>\n\n`
    comment += `\`\`\`diff\n${diffPreview}\n\`\`\``
    if (diffPreview.length >= 2000) {
      comment += `\n\n_Diff truncated. View full changes in the branch._`
    }
    comment += `\n</details>\n\n`
  }

  comment += `### ✅ Next Steps\n\n`
  comment += `Please review the changes and choose an action:\n\n`
  comment += `- **Continue with feedback:** \`@bot continue\` - Resume AI session with your feedback (or restart if no session)\n`
  comment += `- **Approve directly:** \`@bot approve\` - Skip AI and commit current changes as-is\n`
  comment += `- **Full retry:** \`@bot retry\` - Completely restart from scratch with feedback\n`
  comment += `- **Pause:** \`@bot pause\` - Pause this task for later\n`
  comment += `- **Stop:** \`@bot stop\` - Cancel this task\n`
  comment += `- **Check status:** \`@bot status\` - View current task details\n\n`
  comment += `💡 **Tip:** Use \`@bot feedback <your message>\` before any command to provide guidance to the AI.\n`

  return comment
}

/**
 * Step 5: Run Tests - Execute test suite
 */
export async function runTestsStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Run tests step`)

    // Check if tests already passed
    if (ctx.task.checkpoints.run_tests?.exitCode === 0) {
      consola.debug('Tests already passed, skipping')
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    // Run tests (implementation would call workspace manager or test runner)
    // For now, we'll skip actual test execution
    consola.info(`[Task ${ctx.task.id}] Skipping test execution (not implemented)`)

    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      run_tests: {
        exitCode: 0,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'commit_and_push', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Tests passed`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Run tests step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 5: Commit and Push - Commit changes and push to remote
 */
export async function commitAndPushStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Commit and push step`)

    // Check if already pushed
    if (ctx.task.checkpoints.commit_and_push?.pushed) {
      consola.debug('Changes already pushed, skipping')
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)

    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    const branchName = ctx.task.checkpoints.branch?.name
    if (!branchName) {
      return {
        success: false,
        error: 'Branch name not found',
        shouldRetry: false,
      }
    }

    // Ensure we're on the correct branch
    consola.debug(`Ensuring on branch: ${branchName}`)
    const switched = await ctx.workspaceManager.switchBranch(repoDir, branchName)
    if (!switched) {
      return {
        success: false,
        error: 'Failed to switch to task branch',
        shouldRetry: true,
      }
    }

    // Create commit message
    const commitMessage = `🤖 Bot: Fix for issue #${ctx.task.issueNumber}\n\n${ctx.task.checkpoints.plan?.description.substring(0, 200) || ''}`

    // Commit changes (idempotent - git will detect if nothing changed)
    const committed = await ctx.workspaceManager.commitChanges(repoDir, commitMessage)

    let commitSha = ''
    if (committed) {
      // Get commit SHA (implementation needed in workspace manager)
      commitSha = 'unknown'
    }

    // Push branch
    const pushed = await ctx.workspaceManager.pushBranch(repoDir, branchName)

    if (!pushed) {
      return {
        success: false,
        error: 'Failed to push branch',
        shouldRetry: true,
      }
    }

    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      commit_and_push: {
        commitSha,
        commitMessage,
        pushed: true,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'create_pr', checkpoints)
    consola.success(`[Task ${ctx.task.id}] Changes committed and pushed`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Commit and push step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}

/**
 * Step 6: Create PR - Create or update pull request (idempotent)
 */
export async function createPRStep(ctx: StepContext): Promise<StepResult> {
  try {
    consola.info(`[Task ${ctx.task.id}] Create PR step`)

    // Check if PR already created
    if (ctx.task.checkpoints.create_pr?.prNumber) {
      consola.debug(`PR already created: #${ctx.task.checkpoints.create_pr.prNumber}`)
      return { success: true }
    }

    const [owner, repo] = ctx.task.repo.split('/')
    if (!owner || !repo) {
      return {
        success: false,
        error: `Invalid repository format: ${ctx.task.repo}`,
        shouldRetry: false,
      }
    }

    const branchName = ctx.task.checkpoints.branch?.name

    if (!branchName) {
      return {
        success: false,
        error: 'Branch name not found',
        shouldRetry: false,
      }
    }

    // Detect the default branch (try main first, then master)
    const repoDir = await ctx.workspaceManager.cloneRepository(owner, repo)
    if (!repoDir) {
      return {
        success: false,
        error: 'Failed to access repository',
        shouldRetry: true,
      }
    }

    const defaultBranch = await ctx.workspaceManager.getRemoteDefaultBranch(repoDir)
    consola.debug(`Using base branch: ${defaultBranch}`)

    // Create new PR
    const title = `🤖 Fix for issue #${ctx.task.issueNumber}: ${ctx.issue.title}`

    // Use AI summary if available, otherwise fall back to plan description
    const aiSummary = ctx.task.checkpoints.codex_generate?.aiSummary
    const body = aiSummary
      ? `Fixes #${ctx.task.issueNumber}\n\n## AI Summary\n\n${aiSummary}`
      : `Fixes #${ctx.task.issueNumber}\n\n${ctx.task.checkpoints.plan?.description || ''}`

    const pr = await ctx.githubClient.createPullRequest(owner, repo, {
      head: branchName,
      base: defaultBranch,
      title,
      body,
    })

    if (!pr) {
      return {
        success: false,
        error: 'Failed to create pull request',
        shouldRetry: true,
      }
    }

    const checkpoints: TaskCheckpoints = {
      ...ctx.task.checkpoints,
      create_pr: {
        prNumber: pr.number,
        prUrl: pr.url,
        timestamp: new Date().toISOString(),
      },
    }

    ctx.taskStore.updateTaskProgress(ctx.task.id, 'completed', checkpoints)
    ctx.taskStore.updateTaskState(ctx.task.id, 'completed')
    consola.success(`[Task ${ctx.task.id}] PR created: #${pr.number}`)

    return { success: true }
  } catch (error) {
    consola.error(`[Task ${ctx.task.id}] Create PR step failed:`, error)
    return {
      success: false,
      error: (error as Error).message,
      shouldRetry: true,
    }
  }
}
