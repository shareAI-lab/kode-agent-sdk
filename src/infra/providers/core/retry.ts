/**
 * Retry Strategy Module
 *
 * Exponential backoff with jitter for handling transient failures.
 * Respects provider-specific retry-after headers.
 */

import {
  ProviderError,
  RateLimitError,
  ServiceUnavailableError,
  parseProviderError,
} from './errors';

/**
 * Retry configuration options.
 */
export interface RetryConfig {
  // Maximum number of retry attempts
  maxRetries: number;

  // Initial delay between retries in ms
  baseDelayMs: number;

  // Maximum delay between retries in ms
  maxDelayMs: number;

  // Jitter factor (0-1) to randomize delays
  jitterFactor: number;

  // Provider for error parsing
  provider?: string;
}

/**
 * Default retry configuration.
 * Suitable for most provider API calls.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
  jitterFactor: 0.2,
};

/**
 * Aggressive retry configuration for critical operations.
 */
export const AGGRESSIVE_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 500,
  maxDelayMs: 120000,
  jitterFactor: 0.3,
};

/**
 * Callback invoked before each retry attempt.
 */
export type OnRetryCallback = (
  error: ProviderError,
  attempt: number,
  delayMs: number
) => void;

/**
 * Execute a function with retry logic.
 *
 * @param fn - Async function to execute
 * @param config - Retry configuration
 * @param onRetry - Optional callback before each retry
 * @returns Result of the function
 * @throws Last error if all retries exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: OnRetryCallback
): Promise<T> {
  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Convert to ProviderError if needed
      const providerError = error instanceof ProviderError
        ? error
        : parseProviderError(error, config.provider || 'unknown');

      lastError = providerError;

      // Don't retry non-retryable errors
      if (!providerError.retryable) {
        throw providerError;
      }

      // Don't retry if we've exhausted attempts
      if (attempt === config.maxRetries) {
        throw providerError;
      }

      // Calculate delay with exponential backoff
      let delay = calculateBackoffDelay(attempt, config);

      // Respect retry-after header if available
      if (providerError instanceof RateLimitError && providerError.retryAfter) {
        delay = Math.max(delay, providerError.retryAfter * 1000);
      } else if (providerError instanceof ServiceUnavailableError && providerError.retryAfter) {
        delay = Math.max(delay, providerError.retryAfter * 1000);
      }

      // Apply jitter
      delay = applyJitter(delay, config.jitterFactor);

      // Invoke callback
      onRetry?.(providerError, attempt + 1, delay);

      // Wait before retry
      await sleep(delay);
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError || new Error('Unexpected retry loop exit');
}

/**
 * Calculate exponential backoff delay.
 */
function calculateBackoffDelay(attempt: number, config: RetryConfig): number {
  const delay = config.baseDelayMs * Math.pow(2, attempt);
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Apply jitter to a delay value.
 */
function applyJitter(delay: number, jitterFactor: number): number {
  const jitter = delay * jitterFactor * (Math.random() - 0.5) * 2;
  return Math.max(0, Math.floor(delay + jitter));
}

/**
 * Sleep for a specified duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a retry wrapper for a provider.
 *
 * @param provider - Provider name for error context
 * @param config - Retry configuration
 * @returns Configured retry function
 */
export function createRetryWrapper(
  provider: string,
  config: Partial<RetryConfig> = {}
): <T>(fn: () => Promise<T>, onRetry?: OnRetryCallback) => Promise<T> {
  const mergedConfig: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    ...config,
    provider,
  };

  return <T>(fn: () => Promise<T>, onRetry?: OnRetryCallback) =>
    withRetry(fn, mergedConfig, onRetry);
}

/**
 * Retry with timeout.
 * Aborts if total time exceeds timeout even if retries remain.
 */
export async function withRetryAndTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: OnRetryCallback
): Promise<T> {
  const startTime = Date.now();

  let lastError: ProviderError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    // Check if we've exceeded timeout
    if (Date.now() - startTime > timeoutMs) {
      throw lastError || new Error(`Operation timed out after ${timeoutMs}ms`);
    }

    try {
      // Create a timeout promise
      const remainingTime = timeoutMs - (Date.now() - startTime);
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout')), remainingTime)
        ),
      ]);
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : parseProviderError(error, config.provider || 'unknown');

      lastError = providerError;

      if (!providerError.retryable || attempt === config.maxRetries) {
        throw providerError;
      }

      let delay = calculateBackoffDelay(attempt, config);

      if (providerError instanceof RateLimitError && providerError.retryAfter) {
        delay = Math.max(delay, providerError.retryAfter * 1000);
      }

      delay = applyJitter(delay, config.jitterFactor);

      // Don't wait longer than remaining timeout
      const remainingTime = timeoutMs - (Date.now() - startTime);
      if (delay > remainingTime) {
        throw lastError;
      }

      onRetry?.(providerError, attempt + 1, delay);

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Check if an operation should be retried.
 * Useful for manual retry logic.
 */
export function shouldRetry(
  error: unknown,
  attempt: number,
  maxRetries: number
): boolean {
  if (attempt >= maxRetries) {
    return false;
  }

  if (error instanceof ProviderError) {
    return error.retryable;
  }

  // For unknown errors, be conservative
  return false;
}

/**
 * Get recommended delay for next retry.
 */
export function getRetryDelay(
  error: ProviderError,
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  let delay = calculateBackoffDelay(attempt, config);

  if (error instanceof RateLimitError && error.retryAfter) {
    delay = Math.max(delay, error.retryAfter * 1000);
  } else if (error instanceof ServiceUnavailableError && error.retryAfter) {
    delay = Math.max(delay, error.retryAfter * 1000);
  }

  return applyJitter(delay, config.jitterFactor);
}
