import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { createHash, randomBytes } from 'crypto';
import { CacheService } from './cache.service';

/** Method decorator: marks a route as requiring Idempotency-Key enforcement. */
export const Idempotent = () => SetMetadata('idempotent', true);

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h
const PROCESSING_WAIT_TIMEOUT_MS = 10_000;
const PROCESSING_POLL_INTERVAL_MS = 250;

// ── Redis key helpers ──────────────────────────────────────────────────────

/**
 * Key for the short-lived processing lease.
 * Value: an owner token (random 16-byte hex) that lets the holder prove
 * ownership before releasing, and lets others detect a stale claim.
 *
 * Pattern: idempotency:lease:<sha256(userId+route+clientKey)>
 */
const leaseKey = (fingerprint: string): string =>
  `idempotency:lease:${fingerprint}`;

/**
 * Key for the long-lived completed-response record.
 * Persisted separately from the lease so it survives lease expiry.
 *
 * Pattern: idempotency:done:<sha256(userId+route+clientKey)>
 */
const doneKey = (fingerprint: string): string =>
  `idempotency:done:${fingerprint}`;

interface CompletedRecord {
  statusCode: number;
  body: unknown;
}

/**
 * Issue #915 — Idempotency interceptor with:
 *
 *   1. **User + route scoped key** — the fingerprint is
 *      sha256(userId + "|" + routePath + "|" + clientKey) so two different
 *      users sharing the same Idempotency-Key header value never collide.
 *
 *   2. **Short processing lease** — the lease key has a 60 s TTL with an
 *      owner token (random hex).  If the original worker crashes the lease
 *      auto-expires and the next retry takes over and recomputes.
 *
 *   3. **Stale-lease takeover** — when a concurrent request sees a missing
 *      or expired lease (and no completed record) it immediately claims a
 *      new lease and re-executes rather than waiting indefinitely.
 *
 *   4. **Completed state persisted separately** — once execution succeeds
 *      the response is stored under `idempotency:done:<fp>` with a 24 h TTL,
 *      independent of the lease.  Subsequent retries read the done record
 *      directly without needing to recompute.
 *
 * Unauthenticated requests: when no `req.user.account` is available the key
 * falls back to the raw client-supplied header (previous behaviour), preserving
 * compatibility with unguarded endpoints.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly cache: CacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | string[] | undefined>;
      user?: { account?: string };
      route?: { path?: string };
      path?: string;
    }>();
    const res = context.switchToHttp().getResponse<{ status: (code: number) => void; statusCode?: number }>();

    if (req.method !== 'POST' && req.method !== 'PUT') {
      return next.handle();
    }

    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      return next.handle();
    }

    // Issue #915 — scope the key to userId + route so different users with
    // the same header value never collide.
    const userId = req.user?.account ?? 'anonymous';
    const route = req.route?.path ?? req.path ?? 'unknown';
    const fingerprint = createHash('sha256')
      .update(`${userId}|${route}|${rawKey}`)
      .digest('hex');

    return from(this.handleIdempotent(fingerprint, res, next));
  }

  private async handleIdempotent(
    fingerprint: string,
    res: { status: (code: number) => void; statusCode?: number },
    next: CallHandler,
  ): Promise<unknown> {
    const dk = doneKey(fingerprint);
    const lk = leaseKey(fingerprint);

    // ── 1. Fast path: completed record exists ────────────────────────────────
    const done = await this.cache.get<CompletedRecord>(dk);
    if (done) {
      this.logger.debug(`[#915] Idempotency cache HIT (done) fp=${fingerprint.slice(0, 12)}`);
      res.status(done.statusCode);
      return done.body;
    }

    // ── 2. Acquire the processing lease via SET NX ───────────────────────────
    // Generate a unique owner token so only the holder can release it.
    const ownerToken = randomBytes(16).toString('hex');
    const leaseAcquired = await this.acquireLease(lk, ownerToken);

    if (leaseAcquired) {
      // We own the lease — execute the handler.
      return this.executeWithLease(fingerprint, dk, lk, ownerToken, res, next);
    }

    // ── 3. Lease held by another replica — check for stale lease ─────────────
    // Poll until the done record appears, the lease expires, or the timeout hits.
    return this.waitOrTakeover(fingerprint, dk, lk, ownerToken, res, next);
  }

  /**
   * Execute the downstream handler while holding the processing lease.
   * On success: persist to done key, release lease.
   * On error: release lease (allows the next retry to re-execute).
   */
  private async executeWithLease(
    fingerprint: string,
    dk: string,
    lk: string,
    ownerToken: string,
    res: { status: (code: number) => void; statusCode?: number },
    next: CallHandler,
  ): Promise<unknown> {
    this.logger.debug(
      `[#915] Lease acquired fp=${fingerprint.slice(0, 12)} token=${ownerToken.slice(0, 8)}`,
    );

    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        next.handle().subscribe({ next: resolve, error: reject });
      });

      const statusCode = (res as unknown as { statusCode?: number }).statusCode ?? 201;

      // Persist the completed response separately from the lease with 24 h TTL.
      await this.cache.set(dk, { statusCode, body: result } satisfies CompletedRecord, COMPLETED_TTL_SECONDS);

      this.logger.debug(
        `[#915] Execution complete, persisted done record fp=${fingerprint.slice(0, 12)}`,
      );

      return result;
    } catch (err) {
      // Don't persist a failed result — next retry must recompute.
      this.logger.warn(
        `[#915] Handler threw, releasing lease for retry fp=${fingerprint.slice(0, 12)}: ${(err as Error).message}`,
      );
      throw err;
    } finally {
      // Always release the lease so waiters can proceed (or take over on crash).
      await this.releaseLease(lk, ownerToken);
    }
  }

  /**
   * Issue #915 — Stale-lease takeover path.
   *
   * Polls for the done record or lease expiry.  If the lease disappears before
   * the done record appears the original worker crashed mid-execution — we
   * attempt to acquire a new lease and re-execute (takeover).
   *
   * This loop runs for at most PROCESSING_WAIT_TIMEOUT_MS.  If neither the
   * done record nor an expired lease appears within that window we return 409.
   */
  private async waitOrTakeover(
    fingerprint: string,
    dk: string,
    lk: string,
    ownerToken: string,
    res: { status: (code: number) => void; statusCode?: number },
    next: CallHandler,
  ): Promise<unknown> {
    const deadline = Date.now() + PROCESSING_WAIT_TIMEOUT_MS;

    this.logger.debug(
      `[#915] Waiting for in-flight result fp=${fingerprint.slice(0, 12)}`,
    );

    while (Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, PROCESSING_POLL_INTERVAL_MS));

      // Check for a completed record first.
      const done = await this.cache.get<CompletedRecord>(dk);
      if (done) {
        this.logger.debug(
          `[#915] Waiter saw done record fp=${fingerprint.slice(0, 12)}`,
        );
        res.status(done.statusCode);
        return done.body;
      }

      // Check whether the lease has expired (stale / crashed worker).
      const leaseStillHeld = await this.cache.get<string>(lk);
      if (!leaseStillHeld) {
        // Lease expired and no done record — original worker crashed.
        // Attempt takeover: try to acquire a fresh lease and recompute.
        this.logger.warn(
          `[#915] Stale lease detected, attempting takeover fp=${fingerprint.slice(0, 12)}`,
        );

        const tookOver = await this.acquireLease(lk, ownerToken);
        if (tookOver) {
          return this.executeWithLease(fingerprint, dk, lk, ownerToken, res, next);
        }
        // Another waiter got the lease first — keep polling.
      }
    }

    // Timed out — return 409 so the client can retry later.
    this.logger.warn(
      `[#915] Idempotency wait timeout fp=${fingerprint.slice(0, 12)}`,
    );
    (res as unknown as { status: (n: number) => void }).status(409);
    return {
      statusCode: 409,
      message:
        'Original request with this Idempotency-Key is still processing. Retry after the lease window.',
    };
  }

  // ── Redis lease helpers ────────────────────────────────────────────────────

  /**
   * Attempt to acquire the lease via SET NX PX.
   * Returns true when this caller holds the lease.
   */
  private async acquireLease(lk: string, ownerToken: string): Promise<boolean> {
    // We access the raw ioredis client via CacheService's private field,
    // consistent with how RedisSequenceNumberManager does it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = (this.cache as any)['client'];
    if (!client) {
      // Redis unavailable — fall through without idempotency (best-effort).
      return true;
    }

    const result: string | null = await client.set(
      lk,
      ownerToken,
      'NX',
      'EX',
      PROCESSING_LEASE_TTL_SECONDS,
    );
    return result === 'OK';
  }

  /**
   * Release the lease only if we still own it.
   * Uses a Lua compare-and-delete to avoid evicting another owner's lease.
   */
  private async releaseLease(lk: string, ownerToken: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = (this.cache as any)['client'];
    if (!client) return;

    // Atomic compare-and-delete: only DEL if value matches our token.
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await client.eval(script, 1, lk, ownerToken);
  }
}
