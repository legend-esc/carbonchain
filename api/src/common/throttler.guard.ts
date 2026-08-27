import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { CacheService } from './cache.service';

export const THROTTLE_KEY = 'throttle';

export interface ThrottleOptions {
  /** Max requests allowed in the window. */
  limit: number;
  /** Window duration in milliseconds. */
  ttl: number;
}

/** Decorator to set per-route throttle options. */
export const Throttle =
  (options: ThrottleOptions) =>
  (target: object, key?: string | symbol, descriptor?: PropertyDescriptor) => {
    if (descriptor) {
      Reflect.defineMetadata(THROTTLE_KEY, options, descriptor.value as object);
    } else {
      Reflect.defineMetadata(THROTTLE_KEY, options, target);
    }
    return descriptor;
  };

interface HitRecord {
  count: number;
  resetAt: number;
}

/**
 * Per-IP rate limiting guard backed by Redis when available.
 */
@Injectable()
export class ThrottlerGuard implements CanActivate {
  private readonly logger = new Logger(ThrottlerGuard.name);
  private readonly store = new Map<string, HitRecord>();

  constructor(
    private readonly reflector: Reflector,
    private readonly cache?: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options: ThrottleOptions | undefined =
      this.reflector.get<ThrottleOptions>(THROTTLE_KEY, context.getHandler()) ??
      this.reflector.get<ThrottleOptions>(THROTTLE_KEY, context.getClass());

    if (!options) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        .trim() ??
      req.socket.remoteAddress ??
      'unknown';

    const key = `${ip}:${req.path}`;
    if (this.cache?.isConnected) {
      try {
        const key = `throttle:${ip}:${req.path}`;
        const count = await this.cache.increment(
          key,
          Math.ceil(options.ttl / 1000),
        );
        if (count > options.limit) {
          throw new HttpException(
            'Too Many Requests',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        return true;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.logger.warn('Redis throttling unavailable; using memory fallback');
      }
    }

    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + options.ttl });
      return true;
    }

    if (record.count >= options.limit) {
      throw new HttpException(
        'Too Many Requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    record.count += 1;
    return true;
  }
}
