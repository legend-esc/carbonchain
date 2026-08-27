import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  ServiceUnavailableException,
  ConflictException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { firstValueFrom, Observable } from 'rxjs';
import { createHash } from 'crypto';
import { CacheService } from './cache.service';

export const IDEMPOTENCY_KEY = 'idempotency';
export interface IdempotencyOptions {
  ttlSeconds?: number;
}

export const Idempotent = (options: IdempotencyOptions = {}) =>
  SetMetadata(IDEMPOTENCY_KEY, options);

interface CachedResponse {
  statusCode: number;
  body: unknown;
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly cache: CacheService,
    private readonly reflector: Reflector,
  ) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const options = this.reflector.get<IdempotencyOptions>(
      IDEMPOTENCY_KEY,
      context.getHandler(),
    );
    if (!options) return next.handle();

    return new Observable((subscriber) => {
      void this.handle(context, next, options)
        .then((result) => {
          subscriber.next(result);
          subscriber.complete();
        })
        .catch((error: unknown) => subscriber.error(error));
    });
  }

  private async handle(
    context: ExecutionContext,
    next: CallHandler,
    options: IdempotencyOptions,
  ): Promise<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();
    const idempotencyKey = request.header('idempotency-key');
    if (!idempotencyKey) return firstValueFrom(next.handle());

    const route = `${request.method}:${request.originalUrl.split('?')[0]}`;
    const digest = createHash('sha256')
      .update(`${route}:${idempotencyKey}`)
      .digest('hex');
    const ttlSeconds = options.ttlSeconds ?? 86_400;
    const responseKey = `idempotency:response:${digest}`;
    const lockKey = `idempotency:lock:${digest}`;

    if (!this.cache.isConnected) {
      throw new ServiceUnavailableException(
        'Idempotency service is unavailable',
      );
    }

    const cached = await this.cache.get<CachedResponse>(responseKey);
    if (cached) {
      response.status(cached.statusCode);
      return cached.body;
    }

    if (
      !(await this.cache.setIfAbsent(lockKey, { inFlight: true }, ttlSeconds))
    ) {
      throw new ConflictException('An identical request is already in flight');
    }

    try {
      const body = await firstValueFrom(next.handle());
      await this.cache.setRequired(
        responseKey,
        { statusCode: response.statusCode, body },
        ttlSeconds,
      );
      return body;
    } catch (error) {
      await this.cache.delete(lockKey);
      throw error;
    }
  }
}