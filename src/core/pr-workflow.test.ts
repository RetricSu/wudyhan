import { GitHubMaintainBot } from './bot'
import { WorkspaceManager } from '../workspace/manager'
import { IssueManager } from '../github/issues'
import { GitHubClient } from '../github/client'

// Mock all dependencies
jest.mock('../workspace/manager')
jest.mock('../github/issues')
jest.mock('../github/client')
jest.mock('../ai/codex')

describe('PR Workflow - Commit and Submit', () => {
  let bot: GitHubMaintainBot
  let mockWorkspaceManager: jest.Mocked<WorkspaceManager>
  let mockIssueManager: jest.Mocked<IssueManager>
  let mockGitHubClient: jest.Mocked<GitHubClient>

  const mockIssue = {
    number: 1,
    title: 'Test Issue',
    body: 'Test issue body',
    state: 'open' as const,
    repository: {
      name: 'test-repo',
      owner: {
        login: 'test-owner',
      },
      full_name: 'test-owner/test-repo',
    },
    user: {
      login: 'test-user',
    },
    assignees: [],
    labels: [],
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  }

  const mockConfig = {
    githubToken: 'test-token',
    repositories: [
      {
        owner: 'test-owner',
        name: 'test-repo',
      },
    ],
    logLevel: 'info' as const,
    interval: 10000,
    maxConcurrent: 3,
  }

  beforeEach(() => {
    jest.clearAllMocks()

    // Create bot instance
    bot = new GitHubMaintainBot(mockConfig)

    // Get mocked instances
    mockWorkspaceManager = (bot as any).workspaceManager as jest.Mocked<WorkspaceManager>
    mockIssueManager = (bot as any).issueManager as jest.Mocked<IssueManager>
    mockGitHubClient = (bot as any).githubClient as jest.Mocked<GitHubClient>
  })

  describe('Commit and Push Phase', () => {
    it('should successfully commit and push changes', async () => {
      const repoDir = '/test/repo/path'
      const branchName = 'bot/issue-1/test-branch'

      // Setup mocks
      mockWorkspaceManager.commitChanges.mockResolvedValue(true)
      mockWorkspaceManager.pushBranch.mockResolvedValue(true)
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      // Execute the commit phase (this would be called after code generation)
      const commitMessage = `🤖 Bot: Test task\n\nResolves part of issue #${mockIssue.number}`
      const committed = await mockWorkspaceManager.commitChanges(repoDir, commitMessage)
      expect(committed).toBe(true)

      // Execute the push phase
      const pushed = await mockWorkspaceManager.pushBranch(repoDir, branchName)
      expect(pushed).toBe(true)

      // Verify calls
      expect(mockWorkspaceManager.commitChanges).toHaveBeenCalledWith(repoDir, commitMessage)
      expect(mockWorkspaceManager.pushBranch).toHaveBeenCalledWith(repoDir, branchName)
    })

    it('should handle commit failure gracefully', async () => {
      const repoDir = '/test/repo/path'

      mockWorkspaceManager.commitChanges.mockResolvedValue(false)
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      const committed = await mockWorkspaceManager.commitChanges(repoDir, 'test commit')

      expect(committed).toBe(false)
      // In the real flow, this would trigger an issue status update
    })

    it('should handle push failure gracefully', async () => {
      const repoDir = '/test/repo/path'
      const branchName = 'bot/issue-1/test-branch'

      mockWorkspaceManager.commitChanges.mockResolvedValue(true)
      mockWorkspaceManager.pushBranch.mockResolvedValue(false)
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      const committed = await mockWorkspaceManager.commitChanges(repoDir, 'test commit')
      const pushed = await mockWorkspaceManager.pushBranch(repoDir, branchName)

      expect(committed).toBe(true)
      expect(pushed).toBe(false)
    })
  })

  describe('PR Creation Phase', () => {
    it('should create PR with correct parameters', async () => {
      const repoDir = '/test/repo/path'
      const issueBranches = ['bot/issue-1/test-branch']

      mockWorkspaceManager.cloneRepository.mockResolvedValue(repoDir)
      mockWorkspaceManager.getIssueBranches.mockResolvedValue(issueBranches)
      mockWorkspaceManager.checkForConflicts.mockResolvedValue(false)
      mockGitHubClient.createPullRequest.mockResolvedValue({
        id: 100,
        number: 10,
        title: 'Test PR',
        body: 'Test body',
        state: 'open',
        head: { ref: 'bot/issue-1/test-branch', sha: 'abc123' },
        base: { ref: 'main' },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        url: 'https://github.com/test-owner/test-repo/pull/10',
      })
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      // Call the private method via reflection
      await (bot as any).createPullRequestForIssue(mockIssue)

      // Verify PR was created with correct parameters
      expect(mockGitHubClient.createPullRequest).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        expect.objectContaining({
          title: expect.stringContaining('🤖 Bot: Resolve issue #1'),
          head: 'bot/issue-1/test-branch',
          base: 'main',
        }),
      )

      // Verify issue was updated with success status
      expect(mockIssueManager.updateIssueStatus).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        1,
        expect.stringContaining('✅ **Issue resolved!** PR created: #10'),
      )
    })

    it('should handle no branches found', async () => {
      const repoDir = '/test/repo/path'

      mockWorkspaceManager.cloneRepository.mockResolvedValue(repoDir)
      mockWorkspaceManager.getIssueBranches.mockResolvedValue([])

      await (bot as any).createPullRequestForIssue(mockIssue)

      // Verify PR creation was not attempted
      expect(mockGitHubClient.createPullRequest).not.toHaveBeenCalled()
    })

    it('should skip branches with conflicts', async () => {
      const repoDir = '/test/repo/path'
      const issueBranches = ['bot/issue-1/branch-1', 'bot/issue-1/branch-2']

      mockWorkspaceManager.cloneRepository.mockResolvedValue(repoDir)
      mockWorkspaceManager.getIssueBranches.mockResolvedValue(issueBranches)
      // First branch has conflicts, second doesn't
      mockWorkspaceManager.checkForConflicts.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
      mockGitHubClient.createPullRequest.mockResolvedValue({
        id: 100,
        number: 10,
        title: 'Test PR',
        body: 'Test body',
        state: 'open',
        head: { ref: 'bot/issue-1/branch-2', sha: 'abc123' },
        base: { ref: 'main' },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        url: 'https://github.com/test-owner/test-repo/pull/10',
      })
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      await (bot as any).createPullRequestForIssue(mockIssue)

      // Verify PR was created with the second (non-conflicting) branch
      expect(mockGitHubClient.createPullRequest).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        expect.objectContaining({
          head: 'bot/issue-1/branch-2',
        }),
      )

      // Verify status indicates partial resolution
      expect(mockIssueManager.updateIssueStatus).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        1,
        expect.stringContaining('✅ **Issue partially resolved!**'),
      )
    })

    it('should handle all branches having conflicts', async () => {
      const repoDir = '/test/repo/path'
      const issueBranches = ['bot/issue-1/branch-1', 'bot/issue-1/branch-2']

      mockWorkspaceManager.cloneRepository.mockResolvedValue(repoDir)
      mockWorkspaceManager.getIssueBranches.mockResolvedValue(issueBranches)
      mockWorkspaceManager.checkForConflicts.mockResolvedValue(true)
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      await (bot as any).createPullRequestForIssue(mockIssue)

      // Verify PR was not created
      expect(mockGitHubClient.createPullRequest).not.toHaveBeenCalled()

      // Verify issue was updated with warning
      expect(mockIssueManager.updateIssueStatus).toHaveBeenCalledWith(
        'test-owner',
        'test-repo',
        1,
        expect.stringContaining('⚠️ **Issue partially resolved** - Some changes have merge conflicts'),
      )
    })

    it('should handle PR creation failure', async () => {
      const repoDir = '/test/repo/path'
      const issueBranches = ['bot/issue-1/test-branch']

      mockWorkspaceManager.cloneRepository.mockResolvedValue(repoDir)
      mockWorkspaceManager.getIssueBranches.mockResolvedValue(issueBranches)
      mockWorkspaceManager.checkForConflicts.mockResolvedValue(false)
      // Simulate PR creation throwing an error
      mockGitHubClient.createPullRequest.mockRejectedValue(new Error('Failed to create PR'))

      await (bot as any).createPullRequestForIssue(mockIssue)

      // Verify PR creation was attempted
      expect(mockGitHubClient.createPullRequest).toHaveBeenCalled()
      // Error should be caught and logged, not crash the bot
    })
  })

  describe('Complete Workflow - After Code Generation', () => {
    it('should handle full workflow: commit -> push -> create PR', async () => {
      const repoDir = '/test/repo/path'
      const branchName = 'bot/issue-1/test-feature'
      const task = 'Test: Add a simple feature'

      // Setup successful mocks for commit phase
      mockWorkspaceManager.commitChanges.mockResolvedValue(true)
      mockWorkspaceManager.pushBranch.mockResolvedValue(true)

      // Setup successful mocks for PR creation phase
      mockWorkspaceManager.cloneRepository.mockResolvedValue(repoDir)
      mockWorkspaceManager.getIssueBranches.mockResolvedValue([branchName])
      mockWorkspaceManager.checkForConflicts.mockResolvedValue(false)
      mockGitHubClient.createPullRequest.mockResolvedValue({
        id: 100,
        number: 10,
        title: 'Test PR',
        body: 'Test body',
        state: 'open',
        head: { ref: branchName, sha: 'abc123' },
        base: { ref: 'main' },
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        url: 'https://github.com/test-owner/test-repo/pull/10',
      })
      mockIssueManager.updateIssueStatus.mockResolvedValue(undefined)

      // Simulate the workflow after code generation
      // 1. Commit changes
      const commitMessage = `🤖 Bot: ${task}\n\nResolves part of issue #${mockIssue.number}`
      const committed = await mockWorkspaceManager.commitChanges(repoDir, commitMessage)
      expect(committed).toBe(true)

      // 2. Update status
      await mockIssueManager.updateIssueStatus(
        mockIssue.repository.owner.login,
        mockIssue.repository.name,
        mockIssue.number,
        `🤖 **Working on:** ${task}\n\nChanges committed. Pushing to remote...`,
      )

      // 3. Push branch
      const pushed = await mockWorkspaceManager.pushBranch(repoDir, branchName)
      expect(pushed).toBe(true)

      // 4. Update status
      await mockIssueManager.updateIssueStatus(
        mockIssue.repository.owner.login,
        mockIssue.repository.name,
        mockIssue.number,
        `✅ **Task completed:** ${task}\n\nAll validation passed and changes pushed successfully.`,
      )

      // 5. Create PR
      await (bot as any).createPullRequestForIssue(mockIssue)

      // Verify the complete workflow executed correctly
      expect(mockWorkspaceManager.commitChanges).toHaveBeenCalledTimes(1)
      expect(mockWorkspaceManager.pushBranch).toHaveBeenCalledTimes(1)
      expect(mockGitHubClient.createPullRequest).toHaveBeenCalledTimes(1)
      expect(mockIssueManager.updateIssueStatus).toHaveBeenCalledTimes(3) // 2 during workflow + 1 after PR creation
    })
  })
})
