import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { pinoLogger } from './logger';
import { RequestContextStore } from './request-context';

/**
 * Fields whose values are replaced with `[REDACTED]` before logging.
 *
 * The pattern covers:
 *  - Exact field names: `nonce`, `signature`, `admin_secret`
 *  - Any field whose name contains: secret, key, token, password, Authorization
 */
const SENSITIVE_FIELD_PATTERN =
  /^(nonce|signature|admin_secret|.*secret.*|.*key.*|.*token.*|.*password.*|authorization)$/i;

/**
 * Recursively sanitize a plain object, replacing sensitive field values with
 * `[REDACTED]`. Non-object values are returned unchanged.
 *
 * The field name is still present in the output so consumers can see that a
 * sensitive field was sent, without seeing its value.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = SENSITIVE_FIELD_PATTERN.test(k)
      ? '[REDACTED]'
      : sanitize(v, depth + 1);
  }
  return result;
}

interface AuthenticatedRequest extends Request {
  user?: { account?: string };
}

/**
 * Structured request / response logging middleware with automatic redaction.
 *
 * Every log line includes:
 *  - `requestId`   — X-Request-ID propagated by RequestIdMiddleware
 *  - `method`      — HTTP verb
 *  - `path`        — request URL
 *  - `statusCode`  — response status (logged on finish)
 *  - `durationMs`  — wall-clock time in milliseconds
 *  - `userId`      — authenticated account address (if present)
 *  - `body`        — sanitized request body (only on non-GET requests, max depth 5)
 *
 * Register this middleware **after** `RequestIdMiddleware` so the request ID
 * is already stored in `RequestContextStore` when this middleware runs.
 *
 * Usage in AppModule:
 * ```ts
 * consumer
 *   .apply(RequestIdMiddleware, LoggingMiddleware, ...)
 *   .forRoutes('*');
 * ```
 */
@Injectable()
export class LoggingMiddleware implements NestMiddleware {
  use(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const requestId = RequestContextStore.getRequestId();

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      const logEntry: Record<string, unknown> = {
        requestId,
        userId: req.user?.account,
        method: req.method,
        path: req.originalUrl ?? req.url,
        statusCode: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      };

      // Include sanitized body for mutating requests to aid debugging.
      // GET requests typically carry no body; skip them to reduce noise.
      if (req.method !== 'GET' && req.body !== undefined) {
        logEntry['body'] = sanitize(req.body);
      }

      // Also redact sensitive request headers before logging
      const sensitiveHeaders = ['authorization', 'x-api-key', 'cookie'];
      const safeHeaders: Record<string, unknown> = {};
      for (const [header, val] of Object.entries(req.headers)) {
        safeHeaders[header] = sensitiveHeaders.includes(header.toLowerCase())
          ? '[REDACTED]'
          : val;
      }
      logEntry['headers'] = safeHeaders;

      pinoLogger.info(logEntry);
    });

    next();
  }
}
