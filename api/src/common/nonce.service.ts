import { Injectable, Logger, ConflictException } from '@nestjs/common';
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

/**
 * NonceService — API-layer replay-attack protection (#415).
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
 * Graceful degradation: when Redis is unavailable the service logs a warning
 * and allows the request through so on-chain nonce logic remains the final
 * guard.  This prevents Redis downtime from halting all API traffic.
 */
@Injectable()
export class NonceService {
  private readonly logger = new Logger(NonceService.name);
  private client: RedisClient | null = null;
  private connected = false;

  constructor(private readonly config: ConfigService) {}

  /** Connect to Redis.  Called by NonceModule.onApplicationBootstrap. */
  async connect(): Promise<void> {
    const url = this.config.get<string>('REDIS_URL');
    if (!url) {
      this.logger.warn(
        'REDIS_URL not set — nonce deduplication disabled (on-chain guard only)',
      );
      return;
    }

    try {
      this.client = new Redis(url);
      this.client.on('error', (err: Error) =>
        this.logger.error(`NonceService Redis error: ${err.message}`),
      );
      await this.client.ping();
      this.connected = true;
      this.logger.log(`NonceService connected to Redis at ${url}`);
    } catch (err) {
      this.logger.error(
        `NonceService failed to connect to Redis: ${(err as Error).message}`,
      );
      this.client = null;
      this.connected = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  /**
   * Atomically claim a nonce for a given address.
   *
   * Uses SET NX EX so two concurrent requests with the same nonce race on
   * a single Redis round-trip — only one will win.
   *
   * @throws ConflictException (409) when the nonce has already been claimed
   *         within the TTL window.
   */
  async consumeNonce(
    address: string,
    nonce: string | bigint,
    ttlSeconds = NONCE_TTL_SECONDS,
  ): Promise<void> {
    if (!this.client || !this.connected) {
      // Graceful degradation — skip Redis check, on-chain guard applies
      this.logger.warn(
        `NonceService: Redis unavailable — skipping nonce check for ${address}:${nonce}`,
      );
      return;
    }

    const key = nonceKey(address, nonce);

    try {
      // SET NX returns 'OK' on success and null when the key already exists.
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');

      if (result === null) {
        // Key already set — duplicate submission within TTL window
        throw new ConflictException(
          `Duplicate nonce: nonce ${nonce} for address ${address} was already submitted`,
        );
      }
    } catch (err) {
      // Re-throw our own ConflictException
      if (err instanceof ConflictException) {
        throw err;
      }
      // Redis connectivity error — degrade gracefully
      this.logger.warn(
        `NonceService SET NX failed for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  /** Returns true when a live Redis connection is available. */
  get isConnected(): boolean {
    return this.connected && this.client !== null;
  }
}
