import {
  Injectable,
  NestMiddleware,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { CacheService } from '../cache.service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

interface CachedResponse {
  statusCode: number;
  body: unknown;
  contentType: string;
  idempotencyKey: string;
  bodyHash: string;
}

function hashBody(body: unknown): string {
  const serialised =
    typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return createHash('sha256').update(serialised).digest('hex');
}

/**
 * IdempotencyMiddleware
 *
 * Intercepts POST and PUT requests that carry an `Idempotency-Key` header.
 *
 * - On first request: processes normally and caches the response for 24 hours.
 * - Duplicate key + identical body: returns cached response immediately.
 * - Duplicate key + different body: returns 422 Unprocessable Entity.
 */
@Injectable()
export class IdempotencyMiddleware implements NestMiddleware {
  private readonly logger = new Logger(IdempotencyMiddleware.name);

  constructor(private readonly cache: CacheService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const method = req.method.toUpperCase();
    if (method !== 'POST' && method !== 'PUT') {
      next();
      return;
    }

    const idempotencyKey = req.headers[IDEMPOTENCY_HEADER] as
      | string
      | undefined;
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      next();
      return;
    }

    const cacheKey = `idempotency:${idempotencyKey}`;
    const incomingHash = hashBody(req.body);

    // Run async logic without making `use` async (NestJS middleware typing)
    this.handleAsync(
      req,
      res,
      next,
      cacheKey,
      incomingHash,
      idempotencyKey,
    ).catch((err: Error) => {
      this.logger.error(`Idempotency middleware error: ${err.message}`);
      next(err);
    });
  }

  private async handleAsync(
    req: Request,
    res: Response,
    next: NextFunction,
    cacheKey: string,
    incomingHash: string,
    idempotencyKey: string,
  ): Promise<void> {
    const cached = await this.cache.get<CachedResponse>(cacheKey);

    if (cached) {
      if (cached.bodyHash !== incomingHash) {
        throw new UnprocessableEntityException(
          'Idempotency-Key reused with a different request body',
        );
      }
      this.logger.debug(`Idempotency cache hit for key: ${idempotencyKey}`);
      res.setHeader('X-Idempotent-Replayed', 'true');
      res.setHeader('Content-Type', cached.contentType || 'application/json');
      res.status(cached.statusCode).json(cached.body);
      return;
    }

    // Intercept response to cache it
    const originalJson = res.json.bind(res);
    res.json = (body: unknown): Response => {
      const entry: CachedResponse = {
        statusCode: res.statusCode,
        body,
        contentType:
          (res.getHeader('Content-Type') as string) || 'application/json',
        idempotencyKey,
        bodyHash: incomingHash,
      };
      // Fire and forget — cache failure must not break the response
      this.cache
        .set(cacheKey, entry, CACHE_TTL_SECONDS)
        .catch((err: Error) =>
          this.logger.warn(
            `Failed to cache idempotent response: ${err.message}`,
          ),
        );
      return originalJson(body);
    };

    next();
  }
}
