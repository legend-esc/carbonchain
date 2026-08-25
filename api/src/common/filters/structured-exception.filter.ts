import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Structured error response shape for API clients.
 *
 * Handles:
 *  - HttpException (NestJS standard) — preserves status code and message.
 *  - QueryTimeoutError (pg / TypeORM) — returns 503 with Retry-After header.
 *    Issue #551: long-running queries exceeding statement_timeout produce a
 *    QueryTimeoutError that must be surfaced as a retryable service error, not
 *    a generic 500. Clients receive `Retry-After: 5` so they can back off.
 *
 * To adopt: register globally in app.module.ts providers array:
 *   { provide: APP_FILTER, useClass: StructuredExceptionFilter }
 */
export interface StructuredErrorResponse {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Minimal shape of a node-postgres / TypeORM query-timeout error. */
interface QueryTimeoutError extends Error {
  code?: string;
}

function isQueryTimeout(err: unknown): err is QueryTimeoutError {
  if (!(err instanceof Error)) return false;
  const e = err as QueryTimeoutError;
  // pg driver surfaces statement_timeout as error code '57014' (query_canceled).
  // TypeORM also wraps it as a QueryTimeoutError with name 'QueryTimeoutError'.
  return (
    e.name === 'QueryTimeoutError' ||
    e.code === '57014' ||
    e.message.includes('canceling statement due to statement timeout') ||
    e.message.includes('query timeout')
  );
}

@Catch()
export class StructuredExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(StructuredExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // ── Issue #551: QueryTimeoutError → 503 Service Unavailable ─────────────
    if (isQueryTimeout(exception)) {
      this.logger.warn(
        `[QueryTimeout] A database query exceeded the statement_timeout limit. ` +
          `Returning 503 to the client so it may retry.`,
      );
      response
        .status(HttpStatus.SERVICE_UNAVAILABLE)
        .set('Retry-After', '5')
        .json({
          code: 'QUERY_TIMEOUT',
          message:
            'The request could not be completed because a database query timed out. ' +
            'Please retry after a few seconds.',
        } satisfies StructuredErrorResponse);
      return;
    }

    // ── Standard HttpException handling ─────────────────────────────────────
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const { code, message, details } = this.normalize(status, body);
      response.status(status).json({ code, message, details });
      return;
    }

    // ── Unhandled errors — log and return 500 ───────────────────────────────
    this.logger.error('Unhandled exception', exception);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
    } satisfies StructuredErrorResponse);
  }

  private normalize(
    status: number,
    body: string | object,
  ): StructuredErrorResponse {
    const code = HttpStatus[status] ?? 'ERROR';

    if (typeof body === 'string') {
      return { code, message: body };
    }

    const obj = body as Record<string, unknown>;
    const message = Array.isArray(obj.message)
      ? obj.message.join('; ')
      : ((obj.message as string) ?? 'An error occurred');

    const details = { ...obj };
    delete details.message;
    delete details.statusCode;
    delete details.error;

    return {
      code: typeof obj.error === 'string' ? obj.error : code,
      message,
      details: Object.keys(details).length ? details : undefined,
    };
  }
}
