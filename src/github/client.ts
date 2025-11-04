import { consola } from 'consola'
import { GitHubMCPClient } from './mcp-client'
import { Issue, PullRequest } from '../core/types'

export class GitHubClient {
  private mcpClient: GitHubMCPClient
  private token: string
  private baseUrl = 'https://api.github.com'

  constructor(token: string) {
    this.token = token
    this.mcpClient = new GitHubMCPClient()
  }

  private async makeRequest(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    const url = `${this.baseUrl}${endpoint}`
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    })

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`)
    }

    return response.json()
  }

  async getAssignedIssues(): Promise<Issue[]> {
    try {
      // Use MCP client for getting assigned issues
      const issues = await this.mcpClient.getAssignedIssues()
      return issues
    } catch (error) {
      consola.error('Error fetching assigned issues:', error)
      return []
    }
  }

  async getIssue(owner: string, repo: string, issueNumber: number): Promise<Issue> {
    return this.makeRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`) as Promise<Issue>
  }

  async getPullRequest(owner: string, repo: string, prNumber: number): Promise<PullRequest> {
    return this.makeRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`) as Promise<PullRequest>
  }

  async createPullRequest(
    owner: string,
    repo: string,
    data: {
      title: string
      body: string
      head: string
      base: string
    },
  ): Promise<PullRequest> {
    return this.makeRequest(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify(data),
    }) as Promise<PullRequest>
  }

  async addComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ id: number; body: string }> {
    return this.makeRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    }) as Promise<{ id: number; body: string }>
  }
}
