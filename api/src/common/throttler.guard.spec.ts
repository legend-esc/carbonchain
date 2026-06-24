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

describe('ThrottlerGuard', () => {
  let reflector: Reflector;
  let guard: ThrottlerGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ThrottlerGuard(reflector);
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
});
