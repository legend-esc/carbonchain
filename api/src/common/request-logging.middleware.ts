import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { pinoLogger } from './logger';
import { RequestContextStore } from './request-context';

interface AuthenticatedRequest extends Request {
  user?: { account?: string };
}

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  use(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      pinoLogger.info({
        requestId: RequestContextStore.getRequestId(),
        userId: req.user?.account,
        method: req.method,
        path: req.originalUrl ?? req.url,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    });

    next();
  }
}
