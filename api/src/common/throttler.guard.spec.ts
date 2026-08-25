import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  ThrottleOptions,
  ACCOUNT_THROTTLE_KEY,
  AccountThrottleOptions,
} from './throttler.guard';

function makeIpContext(
  ip: string,
  path: string,
  options?: ThrottleOptions,
): ExecutionContext {
  const reflector = new Reflector();
  const mockReq = {
    headers: {},
    socket: { remoteAddress: ip },
    path,
    body: {},
  };

  jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
    if (key === ACCOUNT_THROTTLE_KEY) return undefined;
    return options;
  });

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => mockReq,
      getResponse: () => ({ set: jest.fn() }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;

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

  it('allows requests when no throttle options are set', async () => {
    jest.spyOn(reflector, 'get').mockReturnValue(undefined);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: {},
          socket: { remoteAddress: '1.2.3.4' },
          path: '/test',
          body: {},
        }),
        getResponse: () => ({ set: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('allows requests within the limit', async () => {
    const options: ThrottleOptions = { limit: 3, ttl: 60_000 };
    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return undefined;
      return options;
    });

    const mockReq = {
      headers: {},
      socket: { remoteAddress: '1.2.3.4' },
      path: '/auth/challenge',
      body: {},
    };

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => ({ set: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('blocks requests exceeding the limit', async () => {
    const options: ThrottleOptions = { limit: 2, ttl: 60_000 };
    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return undefined;
      return options;
    });

    const mockReq = {
      headers: {},
      socket: { remoteAddress: '5.6.7.8' },
      path: '/credits/issue',
      body: {},
    };

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => ({ set: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    await guard.canActivate(ctx);

    await expect(guard.canActivate(ctx)).rejects.toThrow(
      new HttpException(
        { message: 'Too Many Requests', retryAfter: expect.any(Number) },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
  });

  it('resets count after TTL expires', async () => {
    jest.useFakeTimers();
    const options: ThrottleOptions = { limit: 1, ttl: 1_000 };
    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return undefined;
      return options;
    });

    const mockReq = {
      headers: {},
      socket: { remoteAddress: '9.9.9.9' },
      path: '/auth/challenge',
      body: {},
    };

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => ({ set: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);

    jest.advanceTimersByTime(1_001);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);

    jest.useRealTimers();
  });

  it('uses x-forwarded-for header when present', async () => {
    const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return undefined;
      return options;
    });

    const mockReq = {
      headers: { 'x-forwarded-for': '10.0.0.1, 192.168.1.1' },
      socket: { remoteAddress: '127.0.0.1' },
      path: '/auth/challenge',
      body: {},
    };

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => ({ set: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
  });
});

describe('ThrottlerGuard (per-account mode)', () => {
  let reflector: Reflector;
  let guard: ThrottlerGuard;

  beforeEach(() => {
    reflector = new Reflector();
    // No CacheService injected — exercises in-memory fallback path
    guard = new ThrottlerGuard(reflector);
  });

  function makeAccountCtx(
    ip: string,
    account: string | null,
    opts: AccountThrottleOptions,
  ): ExecutionContext {
    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return opts;
      return undefined;
    });

    const body: Record<string, string> = {};
    if (account) body['account'] = account;

    const mockReq = {
      headers: {},
      socket: { remoteAddress: ip },
      path: '/auth/verify',
      body,
    };

    return {
      switchToHttp: () => ({
        getRequest: () => mockReq,
        getResponse: () => ({ set: jest.fn() }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  it('allows requests within the account limit', async () => {
    const opts: AccountThrottleOptions = {
      accountLimit: 10,
      ipLimit: 50,
      ttl: 300_000,
    };

    for (let i = 0; i < 10; i++) {
      const ctx = makeAccountCtx('1.2.3.4', 'GABC123', opts);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    }
  });

  it('blocks after account limit exceeded and sets Retry-After', async () => {
    const opts: AccountThrottleOptions = {
      accountLimit: 2,
      ipLimit: 50,
      ttl: 300_000,
    };

    const retryAfterSpy = jest.fn();
    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return opts;
      return undefined;
    });

    const body = { account: 'GDEF456' };
    const mockRes = { set: retryAfterSpy };
    const mockReq = {
      headers: {},
      socket: { remoteAddress: '5.6.7.8' },
      path: '/auth/verify',
      body,
    };

    const makeCtx = () =>
      ({
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => mockRes,
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as unknown as ExecutionContext;

    await guard.canActivate(makeCtx());
    await guard.canActivate(makeCtx());

    await expect(guard.canActivate(makeCtx())).rejects.toThrow(
      new HttpException(
        { message: 'Too Many Requests', retryAfter: expect.any(Number) },
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    expect(retryAfterSpy).toHaveBeenCalledWith(
      'Retry-After',
      expect.any(String),
    );
  });

  it('different accounts have independent limits', async () => {
    const opts: AccountThrottleOptions = {
      accountLimit: 1,
      ipLimit: 50,
      ttl: 300_000,
    };

    const ctx1 = makeAccountCtx('1.1.1.1', 'GACCOUNT1', opts);
    const ctx2 = makeAccountCtx('2.2.2.2', 'GACCOUNT2', opts);

    await expect(guard.canActivate(ctx1)).resolves.toBe(true);
    await expect(guard.canActivate(ctx2)).resolves.toBe(true);
  });

  it('applies IP limit independently of account limit', async () => {
    const opts: AccountThrottleOptions = {
      accountLimit: 100,
      ipLimit: 2,
      ttl: 300_000,
    };

    jest.spyOn(reflector, 'get').mockImplementation((key: unknown) => {
      if (key === ACCOUNT_THROTTLE_KEY) return opts;
      return undefined;
    });

    const makeCtxWithIp = (ip: string, i: number) => {
      const body = { account: `GACCOUNT${i}` }; // different account each time
      const mockReq = {
        headers: {},
        socket: { remoteAddress: ip },
        path: '/auth/verify',
        body,
      };
      return {
        switchToHttp: () => ({
          getRequest: () => mockReq,
          getResponse: () => ({ set: jest.fn() }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;
    };

    await expect(guard.canActivate(makeCtxWithIp('9.9.9.9', 1))).resolves.toBe(
      true,
    );
    await expect(guard.canActivate(makeCtxWithIp('9.9.9.9', 2))).resolves.toBe(
      true,
    );
    await expect(
      guard.canActivate(makeCtxWithIp('9.9.9.9', 3)),
    ).rejects.toThrow(HttpException);
  });

  // ── THROTTLER_SKIP_IPS (skip-list) tests ────────────────────────────────

  describe('skip list (THROTTLER_SKIP_IPS)', () => {
    it('bypasses throttling for an IP in the skip list (exact host /32)', async () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('203.0.113.42/32');
      jest
        .spyOn(skipGuard['reflector'], 'get')
        .mockImplementation((key: unknown) =>
          key === ACCOUNT_THROTTLE_KEY ? undefined : options,
        );

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
      await expect(skipGuard.canActivate(makeCtx())).resolves.toBe(true);
      await expect(skipGuard.canActivate(makeCtx())).resolves.toBe(true);
    });

    it('bypasses throttling for an IP matched by a CIDR range', async () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      // 127.0.0.1/8 covers the entire 127.x.x.x loopback block.
      const skipGuard = makeGuardWithSkipIps('127.0.0.1/8,10.0.0.0/8');
      jest
        .spyOn(skipGuard['reflector'], 'get')
        .mockImplementation((key: unknown) =>
          key === ACCOUNT_THROTTLE_KEY ? undefined : options,
        );

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
      await expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).resolves.toBe(
        true,
      );
      await expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).resolves.toBe(
        true,
      );

      // Private 10.x.x.x
      await expect(skipGuard.canActivate(makeCtx('10.20.30.40'))).resolves.toBe(
        true,
      );
      await expect(skipGuard.canActivate(makeCtx('10.20.30.40'))).resolves.toBe(
        true,
      );
    });

    it('does NOT bypass throttling for an IP outside the skip list', async () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('127.0.0.1/8');
      jest
        .spyOn(skipGuard['reflector'], 'get')
        .mockImplementation((key: unknown) =>
          key === ACCOUNT_THROTTLE_KEY ? undefined : options,
        );

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

      await expect(skipGuard.canActivate(makeCtx())).resolves.toBe(true);
      // Second call must be throttled because 203.0.113.1 is not skipped.
      await expect(skipGuard.canActivate(makeCtx())).rejects.toThrow(
        new HttpException(
          { message: 'Too Many Requests', retryAfter: expect.any(Number) },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
    });

    it('does not add bypass headers for skipped IPs', async () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('10.0.0.0/8');
      jest
        .spyOn(skipGuard['reflector'], 'get')
        .mockImplementation((key: unknown) =>
          key === ACCOUNT_THROTTLE_KEY ? undefined : options,
        );

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

      await skipGuard.canActivate(ctx);

      // No X-RateLimit-Bypass or similar header must be set.
      expect(mockSetHeader).not.toHaveBeenCalled();
    });

    it('handles empty THROTTLER_SKIP_IPS gracefully (default behaviour unchanged)', async () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      const skipGuard = makeGuardWithSkipIps('');
      jest
        .spyOn(skipGuard['reflector'], 'get')
        .mockImplementation((key: unknown) =>
          key === ACCOUNT_THROTTLE_KEY ? undefined : options,
        );

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

      await expect(skipGuard.canActivate(makeCtx())).resolves.toBe(true);
      await expect(skipGuard.canActivate(makeCtx())).rejects.toThrow(
        HttpException,
      );
    });

    it('ignores malformed CIDR entries without crashing', async () => {
      const options: ThrottleOptions = { limit: 1, ttl: 60_000 };
      // "bad-cidr" is not valid — should be silently discarded.
      const skipGuard = makeGuardWithSkipIps('bad-cidr,127.0.0.0/8');
      jest
        .spyOn(skipGuard['reflector'], 'get')
        .mockImplementation((key: unknown) =>
          key === ACCOUNT_THROTTLE_KEY ? undefined : options,
        );

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
      await expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).resolves.toBe(
        true,
      );
      await expect(skipGuard.canActivate(makeCtx('127.0.0.1'))).resolves.toBe(
        true,
      );

      // A non-skipped IP is still throttled.
      await expect(skipGuard.canActivate(makeCtx('8.8.8.8'))).resolves.toBe(
        true,
      );
      await expect(skipGuard.canActivate(makeCtx('8.8.8.8'))).rejects.toThrow(
        HttpException,
      );
    });
  });
});
