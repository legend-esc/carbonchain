import { createHash } from 'node:crypto';
import {
  IdempotencyMiddleware,
  IDEMPOTENCY_HEADER,
} from './idempotency.middleware';
import { CacheService } from '../cache.service';
import { UnprocessableEntityException } from '@nestjs/common';
import type { Request, Response } from 'express';

const makeCacheStub = (): jest.Mocked<CacheService> =>
  ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn(),
    delPattern: jest.fn(),
    isConnected: false,
  }) as unknown as jest.Mocked<CacheService>;

function makeReq(
  method: string,
  body: unknown,
  key?: string,
): Partial<Request> {
  return {
    method,
    headers: key ? { [IDEMPOTENCY_HEADER]: key } : {},
    body,
  };
}

function makeRes(): jest.Mocked<Response> & {
  _statusCode: number;
  _body: unknown;
} {
  const r = {
    _statusCode: 200,
    _body: undefined as unknown,
    statusCode: 200,
    setHeader: jest.fn(),
    getHeader: jest.fn().mockReturnValue('application/json'),
    status: jest.fn(),
    json: jest.fn(),
  } as unknown as jest.Mocked<Response> & {
    _statusCode: number;
    _body: unknown;
  };
  (r.status as jest.Mock).mockReturnValue(r);
  (r.json as jest.Mock).mockReturnValue(r);
  return r;
}

describe('IdempotencyMiddleware', () => {
  let middleware: IdempotencyMiddleware;
  let cache: jest.Mocked<CacheService>;

  beforeEach(() => {
    cache = makeCacheStub();
    middleware = new IdempotencyMiddleware(cache);
  });

  it('passes through non-POST/PUT requests', () => {
    const next = jest.fn();
    middleware.use(makeReq('GET', {}) as Request, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('passes through POST without Idempotency-Key', () => {
    const next = jest.fn();
    middleware.use(makeReq('POST', { a: 1 }) as Request, makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next on first request with key', async () => {
    const next = jest.fn();
    cache.get.mockResolvedValue(null);
    middleware.use(
      makeReq('POST', { a: 1 }, 'key-001') as Request,
      makeRes(),
      next,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(next).toHaveBeenCalled();
  });

  it('replays cached response on duplicate key + same body', async () => {
    const cached = {
      statusCode: 201,
      body: { id: 'abc' },
      contentType: 'application/json',
      idempotencyKey: 'key-002',
      bodyHash: createHash('sha256')
        .update(JSON.stringify({ a: 1 }))
        .digest('hex'),
    };
    cache.get.mockResolvedValue(cached);

    const res = makeRes();
    const next = jest.fn();
    middleware.use(makeReq('POST', { a: 1 }, 'key-002') as Request, res, next);
    await new Promise((r) => setTimeout(r, 20));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ id: 'abc' });
  });

  it('throws 422 on duplicate key with different body', async () => {
    const originalHash = createHash('sha256')
      .update(JSON.stringify({ a: 1 }))
      .digest('hex');
    const cached = {
      statusCode: 201,
      body: { id: 'abc' },
      contentType: 'application/json',
      idempotencyKey: 'key-003',
      bodyHash: originalHash,
    };
    cache.get.mockResolvedValue(cached);

    const next = jest.fn();
    middleware.use(
      makeReq('POST', { a: 2 }, 'key-003') as Request,
      makeRes(),
      next,
    );
    await new Promise((r) => setTimeout(r, 20));
    // next should have been called with the error
    expect(next).toHaveBeenCalledWith(expect.any(UnprocessableEntityException));
  });
});
