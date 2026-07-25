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

describe('ThrottlerGuard (IP-based)', () => {
  let reflector: Reflector;
  let guard: ThrottlerGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ThrottlerGuard(reflector);
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

    await expect(guard.canActivate(makeCtxWithIp('9.9.9.9', 1))).resolves.toBe(true);
    await expect(guard.canActivate(makeCtxWithIp('9.9.9.9', 2))).resolves.toBe(true);
    await expect(guard.canActivate(makeCtxWithIp('9.9.9.9', 3))).rejects.toThrow(
      HttpException,
    );
  });
});
