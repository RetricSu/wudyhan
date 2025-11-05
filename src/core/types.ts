// Core types for the GitHub Maintain Bot
export interface BotConfig {
  githubToken: string
  repositories: RepositoryConfig[]
  codexApiKey?: string
  codexProfile?: string // Codex profile to use (default: 'k2')
  interval: number
  maxConcurrent: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  codexMaxSteps?: number // Max agent iterations (default: 50)
  codexMaxExecutionTime?: number // Max execution time in seconds (default: 1800)
}

export interface RepositoryConfig {
  owner: string
  name: string
  labels?: string[]
  assignees?: string[]
}

export interface Issue {
  id: number
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: Label[]
  assignees: User[]
  user?: User // Issue author
  createdAt: string
  updatedAt: string
  url: string
  repository: {
    owner: {
      login: string
    }
    name: string
  }
}

export interface Label {
  name: string
  color: string
}

export interface User {
  login: string
  id: number
  avatarUrl: string
}

export interface PullRequest {
  id: number
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  head: {
    ref: string
    sha: string
  }
  base: {
    ref: string
  }
  createdAt: string
  updatedAt: string
  url: string
}

export interface BotStatus {
  isRunning: boolean
  lastCheck: Date
  processedIssues: number
  activeTasks: number
}
