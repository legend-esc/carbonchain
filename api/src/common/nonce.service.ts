import {
  Injectable,
  Logger,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type Redis as RedisClient } from 'ioredis';

/**
 * Stellar ledger close time in seconds — the window during which a nonce
 * remains reserved.  A transaction finalized in ledger N is invalid by
 * ledger N+1, so 10 seconds gives a comfortable safety margin over the
 * ~5 s median ledger close time.
 *
 * Reference: https://developers.stellar.org/docs/learn/fundamentals/transactions/ledger-close-time
 */
export const NONCE_TTL_SECONDS = 10;

/**
 * Redis key scheme: `nonce:{address}:{nonce}`.
 * Presence of the key means the nonce has been submitted (consumed).
 */
export const nonceKey = (address: string, nonce: string | bigint): string =>
  `nonce:${address}:${nonce}`;

// ── #938: Circuit-breaker constants ──────────────────────────────────────────

/**
 * How often to probe Redis for reconnection while the circuit is open (down).
 * Default: 30 seconds.
 */
export const RECONNECT_PROBE_INTERVAL_MS = 30_000;

/**
 * Circuit-breaker states for the nonce service:
 *  - up:       Redis is reachable; full duplicate detection is active.
 *  - degraded: Redis had a transient error; the last call fell back.
 *  - down:     Redis has been unreachable since the circuit opened; active
 *              reconnect probing is running.
 */
export type CircuitState = 'up' | 'degraded' | 'down';

/**
 * Thrown instead of a silent fall-through when the nonce service is in
 * `degraded` or `down` state and a nonce claim is attempted.
 *
 * Distinct from ConflictException (409) so callers can surface a
 * "503 nonce_service_degraded" without mistaking it for a replay attack.
 */
export class NonceDegradedException extends ServiceUnavailableException {
  constructor(state: CircuitState, address: string, nonce: string | bigint) {
    super({
      error: 'nonce_service_degraded',
      state,
      message:
        `Nonce service is ${state} — cannot guarantee duplicate detection ` +
        `for ${address}:${nonce}. The on-chain guard remains active.`,
    });
  }
}

/**
 * NonceService — API-layer replay-attack protection (#415, #938).
 *
 * Before forwarding a transaction to the Stellar contract, the API calls
 * `consumeNonce`.  The method uses Redis SET NX (atomic) to claim the key:
 *
 *   • If the key does not exist  → SET succeeds → nonce is reserved → proceed
 *   • If the key already exists  → SET fails    → 409 Conflict thrown
 *
 * The key automatically expires after `NONCE_TTL_SECONDS`, matching the
 * Stellar ledger close window.
 *
 * #938 — Circuit-breaker enhancement:
 *
 *   • `up`       — Redis healthy; full deduplication.
 *   • `degraded` — A single SET NX call failed with a connectivity error;
 *                  the nonce claim returns NonceDegradedException (503)
 *                  instead of silently passing through.
 *   • `down`     — Redis has been unreachable; a background probe polls
 *                  every RECONNECT_PROBE_INTERVAL_MS until reconnection
 *                  succeeds.  Claims in `down` state also throw
 *                  NonceDegradedException so operators see the failure.
 *
 * Metrics: `circuitStateChanges` counter increments each time the state
 * transitions so dashboards can alert on flapping.
 */
@Injectable()
export class NonceService {
  private readonly logger = new Logger(NonceService.name);
  private client: RedisClient | null = null;
  private connected = false;

  // ── #938: Circuit-breaker state ───────────────────────────────────────────

  private _circuitState: CircuitState = 'up';
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Total number of circuit-state transitions (observable metric). */
  public circuitStateChanges = 0;

  constructor(private readonly config: ConfigService) {}

  // ── Public accessors ──────────────────────────────────────────────────────

  /** Current circuit-breaker state. */
  get circuitState(): CircuitState {
    return this._circuitState;
  }

  /** Returns true when a live Redis connection is available. */
  get isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Connect to Redis.  Called by NonceModule.onApplicationBootstrap. */
  async connect(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set — nonce deduplication disabled (on-chain guard only)',
      );
      this._transitionCircuit('down');
      return;
    }

    try {
      this.client = new Redis(url);
      this.client.on('error', (err: Error) => {
        this.logger.error(`NonceService Redis error: ${err.message}`);
        // Connectivity error from the ioredis event loop — open the circuit.
        if (this._circuitState === 'up') {
          this._transitionCircuit('degraded');
        }
      });
      await this.client.ping();
      this.connected = true;
      this._transitionCircuit('up');
      this.logger.log(`NonceService connected to Redis at ${url}`);
    } catch (err) {
      this.logger.error(
        `NonceService failed to connect to Redis: ${(err as Error).message}`,
      );
      this.client = null;
      this.connected = false;
      this._transitionCircuit('down');
      this._startReconnectProbe(url);
    }
  }

  async disconnect(): Promise<void> {
    this._stopReconnectProbe();
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  // ── Core method ───────────────────────────────────────────────────────────

  /**
   * Atomically claim a nonce for a given address.
   *
   * Uses SET NX EX so two concurrent requests with the same nonce race on
   * a single Redis round-trip — only one will win.
   *
   * #938: When Redis is degraded or down, throws NonceDegradedException
   * (503) instead of silently passing through so operators can observe the
   * failure and the caller can surface it to the user.
   *
   * @throws ConflictException (409) when the nonce has already been claimed
   *         within the TTL window.
   * @throws NonceDegradedException (503) when the nonce service is degraded
   *         or down.
   */
  async consumeNonce(
    address: string,
    nonce: string | bigint,
    ttlSeconds = NONCE_TTL_SECONDS,
  ): Promise<void> {
    // ── #938: circuit check ───────────────────────────────────────────────
    if (!this.client || !this.connected) {
      this.logger.warn(
        `NonceService [${this._circuitState}]: Redis unavailable — ` +
          `raising NonceDegradedException for ${address}:${nonce}`,
      );
      throw new NonceDegradedException(this._circuitState, address, nonce);
    }

    const key = nonceKey(address, nonce);

    try {
      // SET NX returns 'OK' on success and null when the key already exists.
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');

      if (result === null) {
        // Key already set — duplicate submission within TTL window.
        throw new ConflictException(
          `Duplicate nonce: nonce ${nonce} for address ${address} was already submitted`,
        );
      }

      // Successful SET NX — heal the circuit if it was degraded.
      if (this._circuitState === 'degraded') {
        this._transitionCircuit('up');
      }
    } catch (err) {
      // Re-throw our own typed exceptions.
      if (
        err instanceof ConflictException ||
        err instanceof NonceDegradedException
      ) {
        throw err;
      }

      // Redis connectivity error — open the circuit and raise a degraded error.
      this.logger.warn(
        `NonceService SET NX failed for key "${key}": ${(err as Error).message}`,
      );

      if (this._circuitState !== 'down') {
        this._transitionCircuit('degraded');
      }

      throw new NonceDegradedException(this._circuitState, address, nonce);
    }
  }

  // ── Circuit-breaker internals ─────────────────────────────────────────────

  private _transitionCircuit(next: CircuitState): void {
    if (this._circuitState === next) return;
    const prev = this._circuitState;
    this._circuitState = next;
    this.circuitStateChanges++;
    this.logger.log(
      `NonceService circuit: ${prev} → ${next} (total transitions: ${this.circuitStateChanges})`,
    );
  }

  /**
   * Start a background timer that probes Redis every
   * RECONNECT_PROBE_INTERVAL_MS until connectivity is restored.
   */
  private _startReconnectProbe(url: string): void {
    if (this.reconnectTimer) return; // already running

    this.logger.log(
      `NonceService: starting reconnect probe (every ${RECONNECT_PROBE_INTERVAL_MS}ms)`,
    );

    this.reconnectTimer = setInterval(() => {
      void this._probe(url);
    }, RECONNECT_PROBE_INTERVAL_MS);
  }

  private _stopReconnectProbe(): void {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async _probe(url: string): Promise<void> {
    try {
      const probe = new Redis(url);
      await probe.ping();
      await probe.quit();

      // Reconnection succeeded — replace the dead client.
      if (this.client) {
        try {
          await this.client.quit();
        } catch {
          /* ignore */
        }
      }
      this.client = new Redis(url);
      this.client.on('error', (err: Error) => {
        this.logger.error(`NonceService Redis error: ${err.message}`);
        if (this._circuitState === 'up') {
          this._transitionCircuit('degraded');
        }
      });
      this.connected = true;
      this._transitionCircuit('up');
      this._stopReconnectProbe();

      this.logger.log(`NonceService: Redis reconnected at ${url}`);
    } catch (err) {
      this.logger.debug(
        `NonceService reconnect probe failed: ${(err as Error).message}`,
      );
    }
  }
}
