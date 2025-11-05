/* eslint-disable @typescript-eslint/no-explicit-any */
import { CodexClient } from './codex'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'

// Mock child_process
jest.mock('child_process')

describe('CodexClient', () => {
  let codexClient: CodexClient
  let mockSpawn: jest.MockedFunction<typeof spawn>

  beforeEach(() => {
    codexClient = new CodexClient()
    mockSpawn = spawn as jest.MockedFunction<typeof spawn>
    jest.clearAllMocks()
  })

  describe('execute', () => {
    it('should execute codex with correct arguments', async () => {
      // Create mock process
      const mockProcess = new EventEmitter() as any
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockSpawn.mockReturnValue(mockProcess)

      // Start execution
      const executePromise = codexClient.execute('test prompt', undefined, '/test/dir')

      // Simulate successful execution
      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('test output'))
        mockProcess.emit('close', 0)
      }, 10)

      const result = await executePromise

      // Verify spawn was called with correct arguments (no --profile when provider not set)
      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        ['exec', '--full-auto', '--cd', '/test/dir', '--config', 'agent.max_iterations=50', 'test prompt'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      )

      expect(result.success).toBe(true)
      expect(result.output).toBe('test output')
    })

    it('should handle execution errors', async () => {
      const mockProcess = new EventEmitter() as any
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockSpawn.mockReturnValue(mockProcess)

      const executePromise = codexClient.execute('test prompt')

      setTimeout(() => {
        mockProcess.stderr.emit('data', Buffer.from('error message'))
        mockProcess.emit('close', 1)
      }, 10)

      const result = await executePromise

      expect(result.success).toBe(false)
      expect(result.error).toBe('error message')
    })

    it('should include working directory when provided', async () => {
      const mockProcess = new EventEmitter() as any
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockSpawn.mockReturnValue(mockProcess)

      const executePromise = codexClient.execute('test prompt', undefined, '/custom/working/dir')

      setTimeout(() => {
        mockProcess.emit('close', 0)
      }, 10)

      await executePromise

      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining(['--cd', '/custom/working/dir']),
        expect.any(Object),
      )
    })

    it('should not include --cd flag when working directory is not provided', async () => {
      const mockProcess = new EventEmitter() as any
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockSpawn.mockReturnValue(mockProcess)

      const executePromise = codexClient.execute('test prompt')

      setTimeout(() => {
        mockProcess.emit('close', 0)
      }, 10)

      await executePromise

      const spawnArgs = mockSpawn.mock.calls[0]?.[1]
      expect(spawnArgs).toBeDefined()
      expect(spawnArgs).not.toContain('--cd')
    })
  })

  describe('generateCode', () => {
    it('should generate code successfully', async () => {
      const mockProcess = new EventEmitter() as any
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockSpawn.mockReturnValue(mockProcess)

      const generatePromise = codexClient.generateCode('add two numbers', 'JavaScript project', '/repo/path')

      setTimeout(() => {
        mockProcess.stdout.emit('data', Buffer.from('generated code'))
        mockProcess.emit('close', 0)
      }, 10)

      const result = await generatePromise

      expect(result).toBe('generated code')
      expect(mockSpawn).toHaveBeenCalledWith(
        'codex',
        expect.arrayContaining(['--cd', '/repo/path']),
        expect.any(Object),
      )
    })

    it('should return null on generation failure', async () => {
      const mockProcess = new EventEmitter() as any
      mockProcess.stdout = new EventEmitter()
      mockProcess.stderr = new EventEmitter()
      mockSpawn.mockReturnValue(mockProcess)

      const generatePromise = codexClient.generateCode('test task')

      setTimeout(() => {
        mockProcess.stderr.emit('data', Buffer.from('generation failed'))
        mockProcess.emit('close', 1)
      }, 10)

      const result = await generatePromise

      expect(result).toBeNull()
    })
  })
})
