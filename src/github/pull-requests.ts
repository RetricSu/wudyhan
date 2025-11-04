import { consola } from 'consola'
import { PullRequest } from '../core/types'
import { GitHubClient } from './client'

export class PullRequestManager {
  private client: GitHubClient

  constructor(client: GitHubClient) {
    this.client = client
  }

  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    body: string,
    headBranch: string,
    baseBranch: string = 'main',
  ): Promise<PullRequest | null> {
    try {
      const pr = await this.client.createPullRequest(owner, repo, {
        title,
        body,
        head: headBranch,
        base: baseBranch,
      })

      consola.success(`Created PR #${pr.number}: ${title}`)
      return pr
    } catch (error) {
      consola.error('Error creating pull request:', error)
      return null
    }
  }

  async addPRComment(owner: string, repo: string, prNumber: number, comment: string): Promise<void> {
    try {
      await this.client.addComment(owner, repo, prNumber, comment)
      consola.info(`Added comment to PR #${prNumber}`)
    } catch (error) {
      consola.error('Error adding PR comment:', error)
    }
  }

  async getPRDetails(owner: string, repo: string, prNumber: number): Promise<PullRequest | null> {
    try {
      // TODO: Use MCP tool mcp_gitkraken_pull_request_get_detail
      const pr = await this.client.getIssue(owner, repo, prNumber)
      return pr
    } catch (error) {
      consola.error('Error getting PR details:', error)
      return null
    }
  }
}
