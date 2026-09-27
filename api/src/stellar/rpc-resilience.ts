import { ServiceUnavailableException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Issue #939 — RPC resilience: circuit breaker + jittered exponential retry
// ---------------------------------------------------------------------------

export const enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/** Failure threshold before the breaker trips to OPEN. */
const DEFAULT_FAILURE_THRESHOLD = 5;

/** How long (ms) to stay OPEN before moving to HALF_OPEN for a probe. */
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

/**
 * RpcCircuitBreaker — tracks consecutive RPC failures and short-circuits
 * new calls while the breaker is OPEN, giving the upstream time to recover.
 *
 * State machine:
 *   CLOSED  → (≥ threshold failures)  → OPEN
 *   OPEN    → (resetTimeout elapsed)  → HALF_OPEN
 *   HALF_OPEN → (success)             → CLOSED
 *   HALF_OPEN → (failure)             → OPEN
 */
export class RpcCircuitBreaker {
  private _state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number = DEFAULT_FAILURE_THRESHOLD,
    private readonly resetTimeoutMs: number = DEFAULT_RESET_TIMEOUT_MS,
  ) {}

  get state(): CircuitState {
    return this._state;
  }

  /**
   * Execute `fn` through the breaker.
   * - OPEN: immediately throws ServiceUnavailableException.
   * - HALF_OPEN: allows one probe; success → CLOSED, failure → re-OPEN.
   * - CLOSED: passes through; on failure increments counter and may trip.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === CircuitState.OPEN) {
      // Check whether the reset timeout has elapsed
      if (
        this.openedAt !== null &&
        Date.now() - this.openedAt >= this.resetTimeoutMs
      ) {
        this._state = CircuitState.HALF_OPEN;
      } else {
        throw new ServiceUnavailableException('stellar.rpc.degraded');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.openedAt = null;
    this._state = CircuitState.CLOSED;
  }

  private onFailure(): void {
    this.failureCount += 1;
    if (
      this._state === CircuitState.HALF_OPEN ||
      this.failureCount >= this.threshold
    ) {
      this._state = CircuitState.OPEN;
      this.openedAt = Date.now();
    }
  }
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

const TRANSIENT_MESSAGES = [
  'timeout',
  'econnreset',
  'econnrefused',
  'rate limit',
  '429',
  '503',
] as const;

function isTransientError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const statusCode =
    (err as { response?: { status?: number }; code?: number })?.response
      ?.status ??
    (err as { code?: number })?.code;

  if (statusCode === 429 || statusCode === 503) return true;
  return TRANSIENT_MESSAGES.some((fragment) => message.includes(fragment));
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (first attempt + retries). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms for the exponential back-off formula. Default 200. */
  baseDelayMs?: number;
}

/**
 * Retry `fn` with jittered exponential back-off.
 *
 * Only retries on transient errors (timeout / connection reset / rate-limit /
 * 429 / 503).  Non-transient errors are re-thrown immediately.
 *
 * Delay formula (per attempt index starting at 0):
 *   delay = baseDelayMs * 2^attempt + random(0..200)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Fail fast on non-transient errors
      if (!isTransientError(err)) {
        throw err;
      }

      // No more retries after the final attempt
      if (attempt === maxAttempts - 1) {
        break;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Singleton breaker — shared across all StellarService instances
// ---------------------------------------------------------------------------
export const rpcBreaker = new RpcCircuitBreaker();
