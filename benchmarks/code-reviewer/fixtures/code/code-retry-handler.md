# Retry Handler Implementation

Please review the following retry handler utility:

```typescript
/**
 * Generic retry handler with exponential backoff and jitter.
 * Used by all external service integrations (payment gateway, email, SMS).
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Jitter factor 0-1 (default: 0.1) */
  jitterFactor: number;
  /** HTTP status codes that should trigger a retry */
  retryableStatusCodes: number[];
  /** Custom predicate for retryable errors */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each retry with attempt number and delay */
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitterFactor: 0.1,
  retryableStatusCodes: [429, 500, 502, 503, 504],
};

/**
 * Calculate delay with exponential backoff and jitter.
 */
function calculateDelay(attempt: number, options: RetryOptions): number {
  const exponentialDelay = options.baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, options.maxDelayMs);
  const jitter = cappedDelay * options.jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, cappedDelay + jitter);
}

/**
 * Determine if an error is retryable based on the configured options.
 */
function isRetryableError(error: unknown, options: RetryOptions): boolean {
  // Custom predicate takes priority
  if (options.isRetryable) {
    return options.isRetryable(error);
  }

  // Check HTTP status codes
  if (error && typeof error === 'object') {
    const statusCode = (error as Record<string, unknown>).statusCode ??
      (error as Record<string, unknown>).status;
    if (typeof statusCode === 'number') {
      return options.retryableStatusCodes.includes(statusCode);
    }
  }

  // Network errors are generally retryable
  if (error instanceof Error) {
    const networkErrors = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'];
    return networkErrors.some((code) => error.message.includes(code));
  }

  return false;
}

/**
 * Execute a function with retry logic.
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration (merged with defaults)
 * @returns The result of the function
 * @throws The last error if all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts: RetryOptions = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      if (attempt >= opts.maxRetries || !isRetryableError(error, opts)) {
        throw error;
      }

      const delayMs = calculateDelay(attempt, opts);
      opts.onRetry?.(attempt + 1, delayMs, error);

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
```
