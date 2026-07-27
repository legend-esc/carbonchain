import { Injectable, LoggerService } from '@nestjs/common';
import { pinoLogger } from './logger';
import { RequestContextStore } from './request-context';
import { sanitize } from './logging.middleware';

/**
 * NestJS `LoggerService` implementation backed by Pino.
 *
 * Every log line is structured JSON and automatically includes:
 *  - `requestId` — from `RequestContextStore` (populated by `RequestIdMiddleware`)
 *  - `context`   — NestJS module / class name passed to `Logger(name)`
 *  - `level`     — Pino log level string
 *
 * Object messages are sanitized before logging so that accidentally passed
 * objects containing sensitive fields (nonces, keys, tokens) are redacted.
 */
@Injectable()
export class PinoNestLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    pinoLogger.info({ ...this.requestCtx(), context }, this.stringify(message));
  }

  error(message: unknown, trace?: string, context?: string): void {
    pinoLogger.error(
      { ...this.requestCtx(), context, trace },
      this.stringify(message),
    );
  }

  warn(message: unknown, context?: string): void {
    pinoLogger.warn({ ...this.requestCtx(), context }, this.stringify(message));
  }

  debug(message: unknown, context?: string): void {
    pinoLogger.debug(
      { ...this.requestCtx(), context },
      this.stringify(message),
    );
  }

  verbose(message: unknown, context?: string): void {
    pinoLogger.trace(
      { ...this.requestCtx(), context },
      this.stringify(message),
    );
  }

  /**
   * Serialise `message` to a string.
   *
   * If `message` is already a string it is returned as-is.
   * If it is a plain object it is **sanitized** first (sensitive fields
   * are replaced with `[REDACTED]`) and then JSON-serialised.
   * Other types are coerced via `String()`.
   */
  private stringify(message: unknown): string {
    if (typeof message === 'string') {
      return message;
    }
    if (message !== null && typeof message === 'object') {
      return JSON.stringify(sanitize(message));
    }
    return String(message);
  }

  private requestCtx(): { requestId?: string } {
    return { requestId: RequestContextStore.getRequestId() };
  }
}
