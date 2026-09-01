import { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { CacheService } from './cache.service';

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<Partial<CacheService>>;
  let res: any;

  const makeCtx = (method: string, key?: string): ExecutionContext => {
    const req = {
      method,
      headers: key ? { 'idempotency-key': key } : {},
    };
    res = {
      statusCode: 201,
      status: jest.fn().mockReturnValue(res),
    };
    return {
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => res,
      }),
    } as unknown as ExecutionContext;
  };

  const makeHandler = (result: unknown): CallHandler => ({
    handle: jest.fn(() =>
      result instanceof Error ? throwError(() => result) : of(result),
    ),
  });

  beforeEach(() => {
    cache = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    interceptor = new IdempotencyInterceptor(cache as any);
  });

  it('passes GET requests through without touching the cache', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(makeCtx('GET', 'k'), makeHandler({ ok: true })),
    );
    expect(result).toEqual({ ok: true });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('passes POST through when no idempotency key is present', async () => {
    const result = await lastValueFrom(
      interceptor.intercept(makeCtx('POST'), makeHandler({ ok: true })),
    );
    expect(result).toEqual({ ok: true });
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('returns the cached completed response without invoking the handler', async () => {
    cache.get.mockResolvedValue({
      status: 'completed',
      statusCode: 200,
      body: { cached: true },
    });
    const handler = makeHandler({ fresh: true });
    const result = await lastValueFrom(
      interceptor.intercept(makeCtx('POST', 'k1'), handler),
    );
    expect(result).toEqual({ cached: true });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('stores and returns the handler result on the first request', async () => {
    cache.get.mockResolvedValue(null);
    const handler = makeHandler({ fresh: true });
    const result = await lastValueFrom(
      interceptor.intercept(makeCtx('POST', 'k2'), handler),
    );
    expect(result).toEqual({ fresh: true });
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('idempotency:'),
      { status: 'completed', statusCode: 201, body: { fresh: true } },
      expect.any(Number),
    );
  });

  it('returns the completed body once an in-flight request finishes', async () => {
    cache.get.mockResolvedValueOnce({ status: 'processing' });
    cache.get.mockResolvedValue({
      status: 'completed',
      statusCode: 200,
      body: { done: true },
    });

    let handleCalled = false;
    const handler: CallHandler = {
      handle: () => {
        handleCalled = true;
        return of({ ignored: 1 });
      },
    };

    const result = await lastValueFrom(
      interceptor.intercept(makeCtx('POST', 'k3'), handler),
    );
    expect(result).toEqual({ done: true });
    expect(handleCalled).toBe(false);
  });

  it('clears the processing record when the handler errors', async () => {
    cache.get.mockResolvedValue(null);
    await expect(
      lastValueFrom(
        interceptor.intercept(
          makeCtx('POST', 'k4'),
          makeHandler(new Error('boom')),
        ),
      ),
    ).rejects.toThrow('boom');
    expect(cache.del).toHaveBeenCalled();
  });
});
