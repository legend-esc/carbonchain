/**
 * #1302 — CustomThrottlerGuard unit tests.
 *
 * Verifies tier resolution from JWT / X-API-Key headers and that the guard
 * throws 429 with Retry-After / standard rate-limit headers when a tier's
 * per-minute quota is exceeded.
 */
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { CustomThrottlerGuard, RateLimitTier } from './custom-throttler.guard';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(overrides: {
  authorization?: string;
  'x-api-key'?: string;
}): Partial<Request> {
  return {
    headers: { ...overrides } as any,
    socket: { remoteAddress: '127.0.0.1' } as any,
    path: '/test',
  };
}

function makeResponse(): { set: jest.Mock } {
  return { set: jest.fn() };
}

function makeContext(
  req: Partial<Request>,
  res: ReturnType<typeof makeResponse>,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('CustomThrottlerGuard', () => {
  let guard: CustomThrottlerGuard;

  beforeEach(() => {
    // Fresh guard with no Redis (uses in-memory fallback).
    guard = new CustomThrottlerGuard(undefined);
  });

  // ── Tier resolution ────────────────────────────────────────────────────────

  describe('resolveTier', () => {
    it('returns "anonymous" when no headers are present', () => {
      const req = makeRequest({}) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('anonymous');
    });

    it('returns "authenticated" when a Bearer token is present', () => {
      const req = makeRequest({
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.test.sig',
      }) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('authenticated');
    });

    it('returns "authenticated" for case-insensitive bearer header', () => {
      const req = makeRequest({ authorization: 'bearer sometoken' }) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('authenticated');
    });

    it('returns "oracle" when X-API-Key matches ORACLE_API_KEYS env', () => {
      const originalEnv = process.env['ORACLE_API_KEYS'];
      process.env['ORACLE_API_KEYS'] = 'sk_oracle_abc,sk_partner_xyz';

      const req = makeRequest({ 'x-api-key': 'sk_oracle_abc' }) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('oracle');

      process.env['ORACLE_API_KEYS'] = originalEnv ?? '';
    });

    it('returns "anonymous" for an X-API-Key not in ORACLE_API_KEYS', () => {
      const originalEnv = process.env['ORACLE_API_KEYS'];
      process.env['ORACLE_API_KEYS'] = 'sk_oracle_abc';

      const req = makeRequest({ 'x-api-key': 'sk_unknown_key' }) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('anonymous');

      process.env['ORACLE_API_KEYS'] = originalEnv ?? '';
    });

    it('returns "anonymous" when ORACLE_API_KEYS is not set', () => {
      const originalEnv = process.env['ORACLE_API_KEYS'];
      delete process.env['ORACLE_API_KEYS'];

      const req = makeRequest({ 'x-api-key': 'sk_some_key' }) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('anonymous');

      if (originalEnv !== undefined) {
        process.env['ORACLE_API_KEYS'] = originalEnv;
      }
    });

    it('oracle tier takes priority over Bearer token when both are present', () => {
      const originalEnv = process.env['ORACLE_API_KEYS'];
      process.env['ORACLE_API_KEYS'] = 'sk_oracle_abc';

      const req = makeRequest({
        'x-api-key': 'sk_oracle_abc',
        authorization: 'Bearer sometoken',
      }) as Request;
      expect(guard.resolveTier(req)).toBe<RateLimitTier>('oracle');

      process.env['ORACLE_API_KEYS'] = originalEnv ?? '';
    });
  });

  // ── Quota enforcement ──────────────────────────────────────────────────────

  describe('canActivate — quota limits', () => {
    it('allows requests within the anonymous quota (60/min)', async () => {
      const req = makeRequest({});
      const res = makeResponse();
      const ctx = makeContext(req, res);

      // 60 requests should all pass.
      for (let i = 0; i < 60; i++) {
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }
    });

    it('throws 429 on the 61st request for anonymous tier', async () => {
      const req = makeRequest({});
      const res = makeResponse();
      const ctx = makeContext(req, res);

      for (let i = 0; i < 60; i++) {
        await guard.canActivate(ctx);
      }

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
    });

    it('throws 429 with Retry-After header when quota exceeded', async () => {
      const req = makeRequest({});
      const res = makeResponse();
      const ctx = makeContext(req, res);

      for (let i = 0; i < 60; i++) {
        await guard.canActivate(ctx);
      }

      try {
        await guard.canActivate(ctx);
      } catch {
        // expected
      }

      const setCalls: string[][] = res.set.mock.calls;
      const retryAfterCall = setCalls.find((c) => c[0] === 'Retry-After');
      expect(retryAfterCall).toBeDefined();
    });

    it('sets X-RateLimit-Limit header matching the tier quota', async () => {
      const req = makeRequest({});
      const res = makeResponse();
      const ctx = makeContext(req, res);

      await guard.canActivate(ctx);

      const limitCall = res.set.mock.calls.find(
        (c: string[]) => c[0] === 'X-RateLimit-Limit',
      );
      expect(limitCall).toBeDefined();
      expect(limitCall![1]).toBe('60'); // anonymous limit
    });

    it('sets X-RateLimit-Remaining header counting down', async () => {
      const req = makeRequest({});
      const res = makeResponse();
      const ctx = makeContext(req, res);

      await guard.canActivate(ctx); // 1st request

      const remainingCall = res.set.mock.calls.find(
        (c: string[]) => c[0] === 'X-RateLimit-Remaining',
      );
      expect(remainingCall).toBeDefined();
      expect(Number(remainingCall![1])).toBe(59); // 60 - 1
    });

    it('sets X-RateLimit-Reset header', async () => {
      const req = makeRequest({});
      const res = makeResponse();
      const ctx = makeContext(req, res);

      await guard.canActivate(ctx);

      const resetCall = res.set.mock.calls.find(
        (c: string[]) => c[0] === 'X-RateLimit-Reset',
      );
      expect(resetCall).toBeDefined();
      expect(Number(resetCall![1])).toBeGreaterThan(0);
    });

    it('authenticated tier allows up to 300 req/min', async () => {
      const req = makeRequest({
        authorization: 'Bearer token.for.user',
      });
      const res = makeResponse();
      const ctx = makeContext(req, res);

      for (let i = 0; i < 300; i++) {
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    });

    it('oracle tier allows up to 1200 req/min', async () => {
      const originalEnv = process.env['ORACLE_API_KEYS'];
      process.env['ORACLE_API_KEYS'] = 'sk_oracle_test';

      const req = makeRequest({ 'x-api-key': 'sk_oracle_test' });
      const res = makeResponse();
      const ctx = makeContext(req, res);

      for (let i = 0; i < 1200; i++) {
        await expect(guard.canActivate(ctx)).resolves.toBe(true);
      }

      await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

      process.env['ORACLE_API_KEYS'] = originalEnv ?? '';
    });

    it('different IPs use independent counters', async () => {
      const req1 = { headers: {}, socket: { remoteAddress: '1.2.3.4' } as any, path: '/a' };
      const req2 = { headers: {}, socket: { remoteAddress: '5.6.7.8' } as any, path: '/a' };
      const res = makeResponse();

      const ctx1 = makeContext(req1, res);
      const ctx2 = makeContext(req2, res);

      for (let i = 0; i < 60; i++) {
        await guard.canActivate(ctx1);
      }

      // ctx1 is exhausted but ctx2 should still pass.
      await expect(guard.canActivate(ctx2)).resolves.toBe(true);
    });
  });
});
