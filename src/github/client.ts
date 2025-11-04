import consola from 'consola'
import { Issue, PullRequest } from '../core/types'

export class GitHubClient {
  private token: string
  private baseUrl = 'https://api.github.com'
  private repositories: Array<{ owner: string; name: string }> = []

  constructor(token: string, repositories: Array<{ owner: string; name: string }> = []) {
    this.token = token
    this.repositories = repositories
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
      // Get all issues assigned to the authenticated user
      const issues = (await this.makeRequest('/user/issues?state=open')) as any[]

      // Filter issues to only include those from configured repositories
      const configuredRepos = new Set(this.repositories.map((repo) => `${repo.owner}/${repo.name}`))

      // Convert GitHub API response to our Issue type
      const formattedIssues: Issue[] = issues
        .filter((issue: any) => {
          const repoFullName = issue.repository.full_name
          return configuredRepos.has(repoFullName)
        })
        .map((issue: any) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label: any) => ({ name: label.name, color: label.color })),
          assignees: issue.assignees.map((assignee: any) => ({
            login: assignee.login,
            id: assignee.id,
            avatarUrl: assignee.avatar_url,
          })),
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          url: issue.html_url,
          repository: {
            owner: { login: issue.repository.owner.login },
            name: issue.repository.name,
          },
        }))

      consola.debug(`Fetched ${formattedIssues.length} assigned issues from configured repositories`)
      return formattedIssues
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
