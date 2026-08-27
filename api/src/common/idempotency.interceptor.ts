import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from } from 'rxjs';
import { createHash } from 'crypto';
import { CacheService } from './cache.service';

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h
const PROCESSING_WAIT_TIMEOUT_MS = 10_000;
const PROCESSING_POLL_INTERVAL_MS = 250;

interface IdempotencyRecord {
  status: 'processing' | 'completed';
  statusCode?: number;
  body?: unknown;
}

/**
 * Idempotency-Key support for POST/PUT requests.
 *
 * Stores { key: sha256(key), response, status } in Redis with a 24h TTL so a
 * retried request (e.g. a double-submitted "Issue Credit" click) returns the
 * original response instead of creating a duplicate resource. While the
 * original request is still in flight, concurrent requests with the same key
 * long-poll (up to 10s) for the result rather than racing ahead.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly cache: CacheService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    const method: string = req.method;
    if (method !== 'POST' && method !== 'PUT') {
      return next.handle();
    }

    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      return next.handle();
    }

    const cacheKey = `idempotency:${createHash('sha256').update(rawKey).digest('hex')}`;

    return from(this.handleIdempotent(cacheKey, req, res, next));
  }

  private async handleIdempotent(
    cacheKey: string,
    req: any,
    res: any,
    next: CallHandler,
  ): Promise<unknown> {
    const existing = await this.cache.get<IdempotencyRecord>(cacheKey);

    if (existing?.status === 'completed') {
      res.status(existing.statusCode ?? 200);
      return existing.body;
    }

    if (existing?.status === 'processing') {
      return this.waitForCompletion(cacheKey, res);
    }

    await this.cache.set(
      cacheKey,
      { status: 'processing' },
      IDEMPOTENCY_TTL_SECONDS,
    );

    try {
      const result = await new Promise((resolve, reject) => {
        next.handle().subscribe({ next: resolve, error: reject });
      });

      await this.cache.set(
        cacheKey,
        {
          status: 'completed',
          statusCode: res.statusCode ?? 201,
          body: result,
        },
        IDEMPOTENCY_TTL_SECONDS,
      );

      return result;
    } catch (err) {
      // Don't leave a dangling "processing" record for a failed request —
      // let the next attempt with the same key retry from scratch.
      await this.cache.del(cacheKey);
      throw err;
    }
  }

  private async waitForCompletion(
    cacheKey: string,
    res: any,
  ): Promise<unknown> {
    const deadline = Date.now() + PROCESSING_WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, PROCESSING_POLL_INTERVAL_MS));
      const record = await this.cache.get<IdempotencyRecord>(cacheKey);
      if (record?.status === 'completed') {
        res.status(record.statusCode ?? 200);
        return record.body;
      }
    }

    res.status(409);
    return {
      statusCode: 409,
      message: 'Original request with this Idempotency-Key is still processing',
    };
  }
}
