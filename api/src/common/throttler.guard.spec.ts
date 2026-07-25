import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerGuard, ThrottleOptions } from './throttler.guard';

function makeContext(
  ip: string,
  path: string,
  options?: ThrottleOptions,
): ExecutionContext {
  const reflector = new Reflector();
  const guard = new ThrottlerGuard(reflector);

  const mockReq = {
    headers: {},
    socket: { remoteAddress: ip },
    path,
  };

  const ctx = {
    switchToHttp: () => ({ getRequest: () => mockReq }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

  // Inject options directly onto the handler mock
  if (options) {
    jest.spyOn(reflector, 'get').mockReturnValue(options);
  } else {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
  }

  return ctx;
}

/** Helper: create a guard with a specific THROTTLER_SKIP_IPS value. */
function makeGuardWithSkipIps(skipIps: string): ThrottlerGuard {
  const original = process.env['THROTTLER_SKIP_IPS'];
  process.env['THROTTLER_SKIP_IPS'] = skipIps;
  const reflector = new Reflector();
  const guard = new ThrottlerGuard(reflector);
  // Restore the env var so tests don't bleed into each other.
  if (original === undefined) {
    delete process.env['THROTTLER_SKIP_IPS'];
  } else {
    process.env['THROTTLER_SKIP_IPS'] = original;
  }
  return guard;
}

describe('ThrottlerGuard', () => {
  let reflector: Reflector;
  let guard: ThrottlerGuard;

  beforeEach(() => {
    // Ensure THROTTLER_SKIP_IPS is unset for the default guard instances.
    delete process.env['THROTTLER_SKIP_IPS'];
    reflector = new Reflector();
    guard = new ThrottlerGuard(reflector);
  });

  afterEach(() => {
    delete process.env['THROTTLER_SKIP_IPS'];
  });

  it('allows requests when no throttle options are set', () => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          socket: { remoteAddress: '1.2.3.4' },
          path: '/test',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows requests within the limit', () => {
    const options: ThrottleOptions = { limit: 3, ttl: 60_000 };
    jest.spyOn(reflector, 'get').mockReturnValue(options);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          socket: { remoteAddress: '1.2.3.4' },
          path: '/auth/challenge',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('blocks requests exceeding the limit', () => {
    const options: ThrottleOptions = { limit: 2, ttl: 60_000 };
    jest.spyOn(reflector, 'get').mockReturnValue(options);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          socket: { remoteAddress: '5.6.7.8' },
          path: '/credits/issue',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    guard.canActivate(ctx);
    guard.canActivate(ctx);

    expect(() => guard.canActivate(ctx)).toThrow(
      new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
    );
  });

  it('resets count after TTL expires', () => {
    jest.useFakeTimers();
    const options: ThrottleOptions = { limit: 1, ttl: 1_000 };
    jest.spyOn(reflector, 'get').mockReturnValue(options);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          socket: { remoteAddress: '9.9.9.9' },
          path: '/auth/challenge',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);

    jest.advanceTimersByTime(1_001);
    expect(guard.canActivate(ctx)).toBe(true);

    jest.useRealTimers();
  });

  it('uses x-forwarded-for header when present', () => {
    const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
    jest.spyOn(reflector, 'get').mockReturnValue(options);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' },
          socket: { remoteAddress: '127.0.0.1' },
          path: '/auth/challenge',
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });

  // ── THROTTLER_SKIP_IPS (skip-list) tests ────────────────────────────────

  describe('skip list (THROTTLER_SKIP_IPS)', () => {
    it('bypasses throttling for an IP in the skip list (exact host /32)', () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('203.0.113.42/32');
      jest.spyOn(skipGuard['reflector'], 'get').mockReturnValue(options);

      const makeCtx = () =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              socket: { remoteAddress: '203.0.113.42' },
              path: '/auth/challenge',
            }),
          }),
          getHandler: () => ({}),
          getClass: () => ({}),
        }) as unknown as ExecutionContext;

      // Both calls succeed despite limit=1 because the IP is skipped.
      expect(skipGuard.canActivate(makeCtx())).toBe(true);
      expect(skipGuard.canActivate(makeCtx())).toBe(true);
    });

    it('bypasses throttling for an IP matched by a CIDR range', () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      // 127.0.0.1/8 covers the entire 127.x.x.x loopback block.
      const skipGuard = makeGuardWithSkipIps('127.0.0.1/8,10.0.0.0/8');
      jest.spyOn(skipGuard['reflector'], 'get').mockReturnValue(options);

      const makeCtx = (ip: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              socket: { remoteAddress: ip },
              path: '/auth/verify',
            }),
          }),
          getHandler: () => ({}),
          getClass: () => ({}),
        }) as unknown as ExecutionContext;

      // Loopback
      expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).toBe(true);
      expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).toBe(true);

      // Private 10.x.x.x
      expect(skipGuard.canActivate(makeCtx('10.20.30.40'))).toBe(true);
      expect(skipGuard.canActivate(makeCtx('10.20.30.40'))).toBe(true);
    });

    it('does NOT bypass throttling for an IP outside the skip list', () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('127.0.0.1/8');
      jest.spyOn(skipGuard['reflector'], 'get').mockReturnValue(options);

      const makeCtx = () =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              socket: { remoteAddress: '203.0.113.1' }, // not in 127/8
              path: '/auth/challenge',
            }),
          }),
          getHandler: () => ({}),
          getClass: () => ({}),
        }) as unknown as ExecutionContext;

      expect(skipGuard.canActivate(makeCtx())).toBe(true);
      // Second call must be throttled because 203.0.113.1 is not skipped.
      expect(() => skipGuard.canActivate(makeCtx())).toThrow(
        new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS),
      );
    });

    it('does not add bypass headers for skipped IPs', () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('10.0.0.0/8');
      jest.spyOn(skipGuard['reflector'], 'get').mockReturnValue(options);

      const mockSetHeader = jest.fn();
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({
            headers: {},
            socket: { remoteAddress: '10.0.0.1' },
            path: '/auth/challenge',
          }),
          getResponse: () => ({ setHeader: mockSetHeader }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;

      skipGuard.canActivate(ctx);

      // No X-RateLimit-Bypass or similar header must be set.
      expect(mockSetHeader).not.toHaveBeenCalled();
    });

    it('handles empty THROTTLER_SKIP_IPS gracefully (default behaviour unchanged)', () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('');
      jest.spyOn(skipGuard['reflector'], 'get').mockReturnValue(options);

      const makeCtx = () =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              socket: { remoteAddress: '1.2.3.4' },
              path: '/auth/challenge',
            }),
          }),
          getHandler: () => ({}),
          getClass: () => ({}),
        }) as unknown as ExecutionContext;

      expect(skipGuard.canActivate(makeCtx())).toBe(true);
      expect(() => skipGuard.canActivate(makeCtx())).toThrow(HttpException);
    });

    it('ignores malformed CIDR entries without crashing', () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      // "bad-cidr" is not valid — should be silently discarded.
      const skipGuard = makeGuardWithSkipIps('bad-cidr,127.0.0.0/8');
      jest.spyOn(skipGuard['reflector'], 'get').mockReturnValue(options);

      const makeCtx = (ip: string) =>
        ({
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {},
              socket: { remoteAddress: ip },
              path: '/auth/challenge',
            }),
          }),
          getHandler: () => ({}),
          getClass: () => ({}),
        }) as unknown as ExecutionContext;

      // Valid entry still works.
      expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).toBe(true);
      expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).toBe(true);

      // A non-skipped IP is still throttled.
      expect(skipGuard.canActivate(makeCtx('8.8.8.8'))).toBe(true);
      expect(() => skipGuard.canActivate(makeCtx('8.8.8.8'))).toThrow(HttpException);
    });
  });
});
