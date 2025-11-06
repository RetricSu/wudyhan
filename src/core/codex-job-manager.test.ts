import { CodexJobManager } from './codex-job-manager'
import { CodexJobStore } from './codex-job-store'
import fs from 'fs'
import path from 'path'

// Type to access private methods for testing
interface CodexJobManagerWithPrivates {
  extractLastAgentMessage: (job: { jobId: string; stdoutPath: string }) => string | undefined
}

// Mock uuid to avoid ESM issues in Jest
jest.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}))

describe('CodexJobManager - AI Summary Extraction', () => {
  let jobManager: CodexJobManager
  let mockJobStore: CodexJobStore
  let tempDir: string

  beforeEach(() => {
    // Create temp directory for test files
    tempDir = path.join(__dirname, '../../data/test-jobs')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    // Create a minimal mock JobStore
    mockJobStore = {
      createJob: jest.fn(),
      updateJob: jest.fn(),
      getJob: jest.fn(),
      getAllJobs: jest.fn(),
      deleteJob: jest.fn(),
      initSchema: jest.fn(),
    } as unknown as CodexJobStore

    jobManager = new CodexJobManager(mockJobStore, tempDir)
  })

  afterEach(() => {
    // Clean up temp files
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
    jest.clearAllMocks()
  })

  /**
   * Core test: Verify extractLastAgentMessage finds the correct message
   * This is the key method that was failing in production
   */
  test('extractLastAgentMessage should find the last agent_message', () => {
    // Create a test file with multiple agent messages
    const jobId = 'test-extract'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')

    const content = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"First message"}}',
      '{"type":"other_event","data":"something"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Last message - this should be extracted"}}',
      '{"type":"item.completed","item":{"type":"function_call","name":"test"}}',
    ].join('\n')

    fs.writeFileSync(stdoutPath, content, 'utf-8')

    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    // Access private method via any for testing
    const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    expect(result).toBe('Last message - this should be extracted')
  })

  test('extractLastAgentMessage should return undefined if no agent_message found', () => {
    const jobId = 'test-no-message'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')

    const content = [
      '{"type":"other_event","data":"something"}',
      '{"type":"item.completed","item":{"type":"function_call","name":"test"}}',
    ].join('\n')

    fs.writeFileSync(stdoutPath, content, 'utf-8')

    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    expect(result).toBeUndefined()
  })

  test('extractLastAgentMessage should handle malformed JSON gracefully', () => {
    const jobId = 'test-bad-json'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')

    const content = [
      'not valid json',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Valid message"}}',
      '{incomplete json',
    ].join('\n')

    fs.writeFileSync(stdoutPath, content, 'utf-8')

    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    expect(result).toBe('Valid message')
  })

  /**
   * Test the actual production scenario from the bug report
   */
  test('should extract real gemini-flash output format', () => {
    const jobId = 'test-real-output'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')

    // This is the actual format from gemini-flash in production
    const realOutput = `{"type":"item.started","item":{"type":"agent_message"}}
{"type":"item.completed","item":{"type":"agent_message","text":"Then, I'll update the 'CKB Fundamentals' section to reflect the new order and move the specified items to the 'Core Structure' section under a new 'Cell' label."}}
{"type":"item.started","item":{"type":"function_call_list"}}
`

    fs.writeFileSync(stdoutPath, realOutput, 'utf-8')

    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    expect(result).toContain("Then, I'll update the 'CKB Fundamentals' section")
    expect(result).toContain('Core Structure')
  })

  /**
   * Critical test: Verify file is readable AFTER stream finishes
   * This simulates the timing issue we had in production
   */
  test('should read file after stream finishes writing', (done) => {
    const jobId = 'test-stream-timing'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')
    const testMessage = 'Message written by stream'

    // Create a write stream
    const stream = fs.createWriteStream(stdoutPath, { flags: 'a' })

    // Write data
    const data = `{"type":"item.completed","item":{"type":"agent_message","text":"${testMessage}"}}\n`
    stream.write(data)

    // End the stream
    stream.end()

    // Listen for finish event
    stream.on('finish', () => {
      // NOW the file should be completely written
      const mockJob = {
        jobId,
        stdoutPath,
        stderrPath: path.join(jobDir, 'stderr.log'),
      }

      const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

      expect(result).toBe(testMessage)
      done()
    })
  })

  /**
   * Test what happens if we read BEFORE stream finishes (the bug!)
   */
  test('reading before stream finishes may return incomplete data', (done) => {
    const jobId = 'test-premature-read'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')
    const testMessage = 'This message might not be visible yet'

    const stream = fs.createWriteStream(stdoutPath, { flags: 'a' })

    const data = `{"type":"item.completed","item":{"type":"agent_message","text":"${testMessage}"}}\n`
    stream.write(data)

    // Try to read IMMEDIATELY without waiting for finish
    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    // This might return undefined because stream hasn't flushed yet
    const immediateResult = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    // Now end and wait for finish
    stream.end()
    stream.on('finish', () => {
      const afterFinishResult = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

      // After finish, we should definitely get the result
      expect(afterFinishResult).toBe(testMessage)

      // The immediate read might have failed (this was the bug!)
      // We don't assert on immediateResult because it's timing-dependent,
      // but this demonstrates why we need to wait for 'finish' event
      // eslint-disable-next-line no-console
      console.log('Immediate read result:', immediateResult)
      // eslint-disable-next-line no-console
      console.log('After finish result:', afterFinishResult)

      done()
    })
  }, 10000)

  /**
   * CRITICAL TEST: Skip empty/whitespace-only agent messages
   * This was the actual production bug!
   */
  test('should skip empty or whitespace-only agent messages', () => {
    const jobId = 'test-empty-messages'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')

    // Real production scenario: last message is just a newline
    const content = [
      '{"type":"item.completed","item":{"type":"agent_message","text":"This is the real summary"}}',
      '{"type":"item.completed","item":{"type":"function_call","name":"test"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"\\n"}}', // Empty message at the end!
      '{"type":"turn.completed","usage":{}}',
    ].join('\n')

    fs.writeFileSync(stdoutPath, content, 'utf-8')

    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    // Should skip the empty "\n" and return the real message
    expect(result).toBe('This is the real summary')
  })

  /**
   * Test with actual production output format
   */
  test('should handle actual gemini-flash output with trailing empty message', () => {
    const jobId = 'test-gemini-real'
    const jobDir = path.join(tempDir, jobId)
    fs.mkdirSync(jobDir, { recursive: true })

    const stdoutPath = path.join(jobDir, 'stdout.log')

    // Exact production output
    const realOutput = `{"type":"item.started","item":{"type":"agent_message"}}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I'll start by examining \`website/sidebars.js\` to understand its structure. My goal is to reorder \\"CKB fundamentals\\" and move \\"cell\\" and \\"capacity\\" to a new \\"Cell\\" label under \\"core-structure,\\" then apply the necessary patch."}}
{"type":"item.started","item":{"id":"item_1","type":"command_execution"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"\\n"}}
{"type":"turn.completed","usage":{"input_tokens":0}}`

    fs.writeFileSync(stdoutPath, realOutput, 'utf-8')

    const mockJob = {
      jobId,
      stdoutPath,
      stderrPath: path.join(jobDir, 'stderr.log'),
    }

    const result = (jobManager as unknown as CodexJobManagerWithPrivates).extractLastAgentMessage(mockJob)

    // Should get item_0's message, not the empty item_2
    expect(result).toContain("I'll start by examining")
    expect(result).toContain('website/sidebars.js')
  })
})
