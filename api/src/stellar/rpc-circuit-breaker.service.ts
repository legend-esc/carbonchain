/**
 * Issue #1319 — Horizon RPC circuit breaker with health-check probing.
 *
 * Maintains a 10-second rolling window of RPC call outcomes and trips to OPEN
 * when the error rate exceeds 50% (after at least 2 calls in the window).
 * While OPEN, `getActiveUrl()` returns `BACKUP_HORIZON_URL` so callers
 * automatically route traffic to the standby endpoint.
 *
 * A `@Cron(CronExpression.EVERY_10_SECONDS)` probe pings the primary Horizon
 * URL with a plain HTTP GET.  On a 200 response the breaker resets to CLOSED
 * and primary traffic resumes.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CircuitState } from './rpc-resilience';

/** A single call outcome recorded in the rolling window. */
interface CallRecord {
  /** Unix timestamp in ms when this record was created. */
  timestamp: number;
  /** Whether the call succeeded. */
  success: boolean;
}

@Injectable()
export class RpcCircuitBreakerService {
  private readonly logger = new Logger(RpcCircuitBreakerService.name);

  /** Fraction of failures that trips the breaker. Default 0.5 (50%). */
  private readonly failureRateThreshold: number;

  /** Rolling-window duration in ms. Default 10 000 ms. */
  private readonly windowMs: number;

  /** Primary Horizon URL (from `HORIZON_URL` env var). */
  private readonly primaryUrl: string;

  /** Failover Horizon URL (from `BACKUP_HORIZON_URL` env var). */
  private readonly failoverUrl: string;

  /** Current breaker state. */
  private _state: CircuitState = CircuitState.CLOSED;

  /**
   * Circular buffer of call records within the current rolling window.
   * Records older than `windowMs` are pruned before each evaluation.
   */
  private readonly window: CallRecord[] = [];

  constructor(@Optional() private readonly configService?: ConfigService) {
    this.failureRateThreshold = 0.5;
    this.windowMs = 10_000;
    this.primaryUrl =
      this.configService?.get<string>('HORIZON_URL') ??
      'https://horizon-testnet.stellar.org';
    this.failoverUrl =
      this.configService?.get<string>('BACKUP_HORIZON_URL') ?? this.primaryUrl;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Returns the URL that callers should use for the current breaker state. */
  getActiveUrl(): string {
    return this._state === CircuitState.OPEN
      ? this.failoverUrl
      : this.primaryUrl;
  }

  /** Current circuit state (`CLOSED` | `OPEN` | `HALF_OPEN`). */
  getState(): CircuitState {
    return this._state;
  }

  /** True when the breaker has tripped and traffic is on the failover URL. */
  isOpen(): boolean {
    return this._state === CircuitState.OPEN;
  }

  /** Record a successful RPC call in the rolling window. */
  recordSuccess(): void {
    this.addRecord(true);
  }

  /** Record a failed RPC call in the rolling window and re-evaluate. */
  recordFailure(): void {
    this.addRecord(false);
    this.evaluate();
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private addRecord(success: boolean): void {
    this.window.push({ timestamp: Date.now(), success });
    this.pruneWindow();
  }

  /** Remove records that have fallen outside the rolling window. */
  private pruneWindow(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.window.length && this.window[i].timestamp < cutoff) {
      i++;
    }
    if (i > 0) {
      this.window.splice(0, i);
    }
  }

  /**
   * Re-evaluate the error rate after a failure is recorded.
   * Only trips the breaker when at least 2 calls are present in the window
   * to avoid false positives on cold starts.
   */
  private evaluate(): void {
    if (this._state === CircuitState.OPEN) {
      // Already open — the probe cron handles reset.
      return;
    }

    this.pruneWindow();

    const total = this.window.length;
    if (total < 2) {
      return;
    }

    const failures = this.window.filter((r) => !r.success).length;
    const errorRate = failures / total;

    if (errorRate > this.failureRateThreshold) {
      this._state = CircuitState.OPEN;
      this.logger.warn(
        `[#1319] Circuit breaker OPEN — error rate ${(errorRate * 100).toFixed(1)}% ` +
          `(${failures}/${total} calls failed in the last ${this.windowMs}ms). ` +
          `Switching to failover URL: ${this.failoverUrl}`,
      );
    }
  }

  // ── Health-check probe ─────────────────────────────────────────────────────

  /**
   * Probe the primary Horizon URL every 10 seconds while the breaker is OPEN.
   *
   * A GET request to the root path (`/`) of the primary URL is used as the
   * liveness check.  On a 200 response the breaker is reset to CLOSED, the
   * rolling window is cleared, and traffic returns to the primary.
   *
   * The probe is a no-op when the breaker is CLOSED or HALF_OPEN.
   */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async probeHealthCheck(): Promise<void> {
    if (this._state !== CircuitState.OPEN) {
      return;
    }

    this.logger.debug(
      `[#1319] Circuit breaker probe: pinging primary URL ${this.primaryUrl}`,
    );

    try {
      // Use the global fetch (available in Node 18+) for a minimal HTTP probe.
      const response = await fetch(this.primaryUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });

      if (response.ok || response.status === 200) {
        this._state = CircuitState.CLOSED;
        this.window.splice(0); // clear rolling window
        this.logger.log(
          `[#1319] Circuit breaker CLOSED — primary Horizon responded 200. ` +
            `Switching back to primary URL: ${this.primaryUrl}`,
        );
      } else {
        this.logger.warn(
          `[#1319] Circuit breaker probe: primary returned HTTP ${response.status}, staying OPEN`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[#1319] Circuit breaker probe failed: ${(err as Error).message} — staying OPEN`,
      );
    }
  }
}
