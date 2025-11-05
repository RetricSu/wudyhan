/**
 * Task model and types for the workflow state machine
 */

export type TaskState =
  | 'pending'
  | 'in_progress'
  | 'waiting_feedback' // Waiting for user approval/feedback
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'dead_letter'

export type WorkflowStep =
  | 'plan'
  | 'branch'
  | 'codex_generate'
  | 'post_results' // Post results and wait for user approval
  | 'run_tests'
  | 'commit_and_push'
  | 'create_pr'
  | 'completed'

export interface TaskCheckpoints {
  // Plan step - simplified: just stores the full issue description
  plan?: {
    description: string // Full issue title + body
    timestamp: string
  }

  // Branch step
  branch?: {
    name: string
    baseSha: string
    timestamp: string
  }

  // Codex generate step
  codex_generate?: {
    jobId: string
    startedAt: string
    completedAt?: string
    commitSha?: string
    filesModified?: string[]
    aiSummary?: string // AI's summary of what was done
  }

  // Post results step - show changes to user and wait for approval
  post_results?: {
    commentId: number
    commentUrl: string
    filesChanged: number
    timestamp: string
  }

  // Tests step
  run_tests?: {
    exitCode: number
    output?: string
    timestamp: string
  }

  // Commit and push step
  commit_and_push?: {
    commitSha: string
    commitMessage: string
    pushed: boolean
    timestamp: string
  }

  // Create PR step
  create_pr?: {
    prNumber: number
    prUrl: string
    timestamp: string
  }
}

export interface Task {
  id: string
  issueNumber: number
  repo: string // format: "owner/repo"
  repoHeadSha: string // sha when scanned (to detect changes)
  fingerprint: string // hash(issueNumber + issueBodySha + repoHeadSha)
  state: TaskState
  currentStep?: WorkflowStep
  checkpoints: TaskCheckpoints
  retryCount: number
  maxRetries: number
  nextRetryAt?: string | null
  lastError?: string | null
  workerId?: string | null // current worker holding lock
  lockExpiresAt?: string | null // lock expiration timestamp
  createdAt: string
  updatedAt: string
  // Command system fields (Phase 2)
  commandState?: 'paused' | 'stopped' | 'resume_requested' | null
  pauseRequested?: boolean
  lastCommentCheckAt?: string | null
}

export interface CreateTaskInput {
  issueNumber: number
  repo: string
  repoHeadSha: string
  issueBodySha: string // sha256 of issue body for fingerprint
  maxRetries?: number
}

export interface TaskFilters {
  state?: TaskState | TaskState[]
  repo?: string
  issueNumber?: number
  workerId?: string
  expiredLocksOnly?: boolean
}

/**
 * Generate a unique fingerprint for a task
 */
export function generateTaskFingerprint(issueNumber: number, issueBodySha: string, repoHeadSha: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto')
  const data = `${issueNumber}-${issueBodySha}-${repoHeadSha}`
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 16)
}

/**
 * Generate a deterministic branch name for a task
 */
export function generateBranchName(issueNumber: number, fingerprint: string): string {
  return `bot/issue-${issueNumber}/${fingerprint.substring(0, 8)}`
}

/**
 * Calculate SHA256 hash of a string
 */
export function sha256(content: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const crypto = require('crypto')
  return crypto.createHash('sha256').update(content).digest('hex')
}
