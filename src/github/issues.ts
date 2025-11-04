import { consola } from 'consola'
import { Issue } from '../core/types'
import { GitHubClient } from './client'
import { GitHubMCPClient } from './mcp-client'

export class IssueManager {
  private client: GitHubClient
  private mcpClient: GitHubMCPClient

  constructor(client: GitHubClient) {
    this.client = client
    this.mcpClient = new GitHubMCPClient()
  }

  async getAssignedIssues(): Promise<Issue[]> {
    try {
      // Use GitHub REST API client for getting assigned issues
      const issues = await this.client.getAssignedIssues()
      consola.debug(`Fetched ${issues.length} assigned issues`)
      return issues
    } catch (error) {
      consola.error('Error fetching assigned issues:', error)
      return []
    }
  }

  async analyzeIssue(issue: Issue): Promise<{
    canHandle: boolean
    tasks: string[]
    complexity: 'low' | 'medium' | 'high'
  }> {
    try {
      consola.debug(`Analyzing issue #${issue.number}: ${issue.title}`)

      // Basic analysis - check if this looks like a coding task
      const title = issue.title.toLowerCase()
      const body = issue.body?.toLowerCase() || ''

      // Keywords that suggest this is a coding task
      const codingKeywords = [
        'add',
        'implement',
        'create',
        'fix',
        'update',
        'change',
        'modify',
        'function',
        'class',
        'method',
        'component',
        'feature',
        'bug',
        'error',
        'issue',
        'problem',
        'refactor',
        'optimize',
      ]

      const hasCodingKeywords = codingKeywords.some((keyword) => title.includes(keyword) || body.includes(keyword))

      // Check for labels that indicate bot-friendly tasks
      const botFriendlyLabels = ['good first issue', 'help wanted', 'enhancement', 'bug']
      const hasBotFriendlyLabels = issue.labels.some((label) => botFriendlyLabels.includes(label.name.toLowerCase()))

      // Determine if we can handle this issue
      const canHandle = hasCodingKeywords || hasBotFriendlyLabels

      if (!canHandle) {
        return {
          canHandle: false,
          tasks: [],
          complexity: 'high',
        }
      }

      // Break down the issue into tasks
      const tasks = this.extractTasksFromIssue(issue)

      // Estimate complexity
      const complexity = this.estimateComplexity(issue, tasks)

      return {
        canHandle: true,
        tasks,
        complexity,
      }
    } catch (error) {
      consola.error('Error analyzing issue:', error)
      return {
        canHandle: false,
        tasks: [],
        complexity: 'high',
      }
    }
  }

  private extractTasksFromIssue(issue: Issue): string[] {
    const tasks: string[] = []
    const content = `${issue.title}\n\n${issue.body || ''}`

    // Look for task lists (checkboxes)
    const taskListRegex = /- \[ \] (.+)/g
    let match
    while ((match = taskListRegex.exec(content)) !== null) {
      if (match[1]) {
        tasks.push(match[1].trim())
      }
    }

    // If no explicit tasks, create tasks based on the issue description
    if (tasks.length === 0) {
      // Simple task extraction - split by sentences or keywords
      const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 10)

      // Take up to 3 main tasks
      for (let i = 0; i < Math.min(sentences.length, 3); i++) {
        const sentence = sentences[i]
        if (sentence && sentence.trim().length > 0) {
          tasks.push(sentence.trim())
        }
      }

      // If still no tasks, create a generic task
      if (tasks.length === 0) {
        tasks.push(`Implement the requested changes for: ${issue.title}`)
      }
    }

    return tasks
  }

  private estimateComplexity(issue: Issue, tasks: string[]): 'low' | 'medium' | 'high' {
    let score = 0

    // Factor in number of tasks
    score += Math.min(tasks.length, 5)

    // Factor in issue labels
    const complexityLabels = ['complex', 'major', 'breaking change']
    if (issue.labels.some((label) => complexityLabels.includes(label.name.toLowerCase()))) {
      score += 3
    }

    // Factor in body length (longer = more complex)
    if (issue.body && issue.body.length > 500) {
      score += 2
    }

    // Factor in assignees (multiple assignees might indicate complexity)
    if (issue.assignees.length > 1) {
      score += 1
    }

    if (score <= 3) return 'low'
    if (score <= 7) return 'medium'
    return 'high'
  }

  async updateIssueStatus(owner: string, repo: string, issueNumber: number, status: string): Promise<void> {
    try {
      await this.client.addComment(owner, repo, issueNumber, `🤖 Bot Status: ${status}`)
      consola.info(`Updated issue #${issueNumber} status: ${status}`)
    } catch (error) {
      consola.error('Error updating issue status:', error)
    }
  }
}
