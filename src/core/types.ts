// Core types for the GitHub Maintain Bot
export interface BotConfig {
  githubToken: string
  repositories: RepositoryConfig[]
  codexApiKey?: string
  interval: number
  maxConcurrent: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
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
