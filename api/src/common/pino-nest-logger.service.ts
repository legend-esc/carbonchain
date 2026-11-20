import { Injectable, LoggerService } from '@nestjs/common';
import { pinoLogger } from './logger';
import { RequestContextStore } from './request-context';
import { sanitize } from './logging.middleware';

/**
 * NestJS `LoggerService` implementation backed by Pino.
 *
 * Every log line is structured JSON and automatically includes:
 *  - `requestId` — injected by the Pino `mixin` (see `logger.ts`), which reads
 *    from `RequestContextStore` (populated by `RequestIdMiddleware`). The
 *    `requestCtx()` fallback below only fills it in when the mixin did not
 *    already provide a value.
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
      return this.redactString(message);
    }
    if (message !== null && typeof message === 'object') {
      return JSON.stringify(sanitize(message));
    }
    return String(message);
  }

  /**
   * Redact sensitive `key=value` pairs inside a plain-text log message so that
   * secrets (passwords, tokens, keys, ...) are not emitted in clear text.
   */
  private redactString(value: string): string {
    return value.replace(
      /\b(?:password|token|apiKey|accessToken|refreshToken|secret|privateKey|signature|nonce|clientSecret|authorization)=[^\s]+/gi,
      (match) => {
        const key = match.split('=')[0];
        return `${key}=[REDACTED]`;
      },
    );
  }

  /**
   * Fallback `requestId` binding.
   *
   * The Pino `mixin` already attaches `requestId` to every log record, so this
   * only matters when the mixin is unavailable (e.g. a bare logger instance).
   * Returning an empty object avoids emitting `requestId: undefined` and keeps
   * the mixin-provided value authoritative.
   */
  private requestCtx(): { requestId?: string } {
    const requestId = RequestContextStore.getRequestId();
    return requestId ? { requestId } : {};
  }
}
