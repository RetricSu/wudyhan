/**
 * RetryManager: Handles retry logic with exponential backoff
 */

export class RetryManager {
  private baseDelay: number // Base delay in milliseconds
  private maxDelay: number // Maximum delay in milliseconds
  private jitterFactor: number // Jitter factor (0-1)

  constructor(baseDelay: number = 1000, maxDelay: number = 60000, jitterFactor: number = 0.1) {
    this.baseDelay = baseDelay
    this.maxDelay = maxDelay
    this.jitterFactor = jitterFactor
  }

  /**
   * Calculate the delay for the next retry using exponential backoff
   * @param retryCount Current retry count
   * @returns Delay in milliseconds
   */
  calculateDelay(retryCount: number): number {
    // Exponential backoff: baseDelay * 2^retryCount
    const exponentialDelay = this.baseDelay * Math.pow(2, retryCount)

    // Cap at max delay
    const cappedDelay = Math.min(exponentialDelay, this.maxDelay)

    // Add jitter to prevent thundering herd
    const jitter = cappedDelay * this.jitterFactor * (Math.random() * 2 - 1)
    const delayWithJitter = cappedDelay + jitter

    return Math.max(0, Math.floor(delayWithJitter))
  }

  /**
   * Determine if an error is retryable
   * @param error The error to check
   * @returns true if the error should be retried
   */
  isRetryable(error: Error): boolean {
    const errorMessage = error.message.toLowerCase()

    // Network errors are retryable
    if (
      errorMessage.includes('timeout') ||
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('network') ||
      errorMessage.includes('fetch failed') ||
      errorMessage.includes('socket hang up')
    ) {
      return true
    }

    // Rate limiting errors are retryable
    if (errorMessage.includes('rate limit') || errorMessage.includes('429')) {
      return true
    }

    // Temporary GitHub errors are retryable
    if (errorMessage.includes('502') || errorMessage.includes('503') || errorMessage.includes('504')) {
      return true
    }

    // Codex temporary errors are retryable
    if (errorMessage.includes('codex') && (errorMessage.includes('timeout') || errorMessage.includes('busy'))) {
      return true
    }

    // Non-retryable errors:
    // - Authentication errors (401, 403)
    // - Not found errors (404)
    // - Validation errors (400, 422)
    // - Permanent failures
    return false
  }

  /**
   * Check if a retry should be attempted based on retry count and max retries
   */
  shouldRetry(retryCount: number, maxRetries: number, error: Error): boolean {
    if (retryCount >= maxRetries) {
      return false
    }

    return this.isRetryable(error)
  }
}
