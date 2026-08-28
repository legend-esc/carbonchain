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
 *  - Soroban contract errors — numeric code extracted from the error message
 *    and mapped to an HTTP status using the stable contract error ranges
 *    documented in docs/features/ERROR_CODES_REFERENCE.md.
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

/** Shape returned when a Soroban contract error is detected. */
export interface ContractErrorInfo {
  contractCode: number;
  httpStatus: number;
  code: string;
}

// === Contract error code tables (stable — see ERROR_CODES_REFERENCE.md)

/*
 * Credit Registry: 100-125
 * Retirement:      200-209  (re-mapped range in the canonical reference)
 * Marketplace:     300-313
 * MRV Oracle:      400-409
 *
 * HTTP mapping rationale:
 *   - NotFound variants        → 404
 *   - Unauthorized             → 403
 *   - InvalidInput / metadata  → 400
 *   - AlreadyExists / duplicate→ 409
 *   - ContractPaused           → 503
 *   - InvalidNonce             → 422
 *   - Overflow                 → 500 (server-side arithmetic fault)
 *   - EscrowFailed             → 502 (external call fault)
 *   - Everything else          → 400 (caller-supplied bad input)
 */
const CONTRACT_ERROR_MAP: Record<number, { httpStatus: number; code: string }> =
  {
    // === Credit Registry (100-125)
    100: { httpStatus: 503, code: 'CONTRACT_NOT_INITIALIZED' },
    101: { httpStatus: 409, code: 'CONTRACT_ALREADY_INITIALIZED' },
    102: { httpStatus: 403, code: 'UNAUTHORIZED' },
    103: { httpStatus: 400, code: 'INVALID_METADATA' },
    104: { httpStatus: 404, code: 'CREDIT_NOT_FOUND' },
    105: { httpStatus: 400, code: 'INVALID_STATUS_TRANSITION' },
    106: { httpStatus: 409, code: 'VERIFIER_ALREADY_EXISTS' },
    107: { httpStatus: 404, code: 'VERIFIER_NOT_FOUND' },
    109: { httpStatus: 500, code: 'OVERFLOW' },
    110: { httpStatus: 400, code: 'INVALID_TONNES' },
    112: { httpStatus: 503, code: 'CONTRACT_PAUSED' },
    113: { httpStatus: 403, code: 'ISSUER_NOT_ALLOWED' },
    115: { httpStatus: 422, code: 'INVALID_NONCE' },
    116: { httpStatus: 400, code: 'NO_PENDING_ADMIN' },
    117: { httpStatus: 400, code: 'INVALID_SPLIT' },
    118: { httpStatus: 400, code: 'INVALID_DISPUTE_STATUS' },
    119: { httpStatus: 400, code: 'VERIFIER_HAS_PENDING_CREDITS' },
    120: { httpStatus: 404, code: 'PROJECT_NOT_FOUND' },
    121: { httpStatus: 409, code: 'DUPLICATE_CREDIT' },
    122: { httpStatus: 409, code: 'PROJECT_ALREADY_EXISTS' },
    123: { httpStatus: 404, code: 'SESSION_NOT_FOUND' },
    124: { httpStatus: 400, code: 'INVALID_APPROVAL_THRESHOLD' },
    125: { httpStatus: 409, code: 'ALREADY_APPROVED' },

    // === Retirement (200-209)
    200: { httpStatus: 400, code: 'RETIREMENT_CREDIT_NOT_ACTIVE' },
    201: { httpStatus: 409, code: 'RETIREMENT_ALREADY_INITIALIZED' },
    202: { httpStatus: 503, code: 'RETIREMENT_NOT_INITIALIZED' },
    203: { httpStatus: 403, code: 'RETIREMENT_UNAUTHORIZED' },
    204: { httpStatus: 503, code: 'RETIREMENT_CONTRACT_PAUSED' },
    205: { httpStatus: 422, code: 'RETIREMENT_INVALID_NONCE' },
    206: { httpStatus: 400, code: 'RETIREMENT_NO_PENDING_ADMIN' },
    207: { httpStatus: 400, code: 'RETIREMENT_INVALID_TONNES' },
    208: { httpStatus: 400, code: 'RETIREMENT_INVALID_INPUT' },

    // === Marketplace (300-313)
    300: { httpStatus: 404, code: 'OFFER_NOT_FOUND' },
    301: { httpStatus: 403, code: 'MARKETPLACE_UNAUTHORIZED' },
    302: { httpStatus: 400, code: 'INVALID_PRICE' },
    303: { httpStatus: 400, code: 'MARKETPLACE_INVALID_TONNES' },
    304: { httpStatus: 409, code: 'OFFER_ALREADY_CLOSED' },
    305: { httpStatus: 400, code: 'MARKETPLACE_CREDIT_NOT_ACTIVE' },
    306: { httpStatus: 503, code: 'MARKETPLACE_NOT_INITIALIZED' },
    307: { httpStatus: 503, code: 'MARKETPLACE_CONTRACT_PAUSED' },
    308: { httpStatus: 422, code: 'MARKETPLACE_INVALID_NONCE' },
    309: { httpStatus: 410, code: 'OFFER_EXPIRED' },
    310: { httpStatus: 500, code: 'MARKETPLACE_OVERFLOW' },
    311: { httpStatus: 409, code: 'MARKETPLACE_ALREADY_INITIALIZED' },
    312: { httpStatus: 402, code: 'INSUFFICIENT_FUNDS' },
    313: { httpStatus: 502, code: 'ESCROW_FAILED' },

    // === MRV Oracle (400-409)
    400: { httpStatus: 503, code: 'ORACLE_NOT_INITIALIZED' },
    401: { httpStatus: 403, code: 'ORACLE_UNAUTHORIZED' },
    402: { httpStatus: 409, code: 'ORACLE_ALREADY_INITIALIZED' },
    403: { httpStatus: 500, code: 'ORACLE_OVERFLOW' },
    404: { httpStatus: 503, code: 'ORACLE_CONTRACT_PAUSED' },
    405: { httpStatus: 404, code: 'ORACLE_PROJECT_NOT_FOUND' },
    406: { httpStatus: 422, code: 'ORACLE_INVALID_NONCE' },
    407: { httpStatus: 400, code: 'ORACLE_INVALID_PROJECT' },
    408: { httpStatus: 400, code: 'ORACLE_INVALID_TIMESTAMP' },
    409: { httpStatus: 400, code: 'ORACLE_NO_PENDING_ADMIN' },
  };

/**
 * Extracts a numeric contract error code from a Soroban error message.
 *
 * Soroban surfaces contract errors in the form:
 *   "Error(Contract, #NNN)"
 *   "HostError: Error(Contract, #NNN)"
 *   "transaction simulation failed ... Error(Contract, #NNN)"
 *
 * Returns null when no contract code is present.
 */
export function extractContractErrorCode(message: string): number | null {
  const match = /Error\(Contract,\s*#(\d+)\)/i.exec(message);
  if (!match) return null;
  return parseInt(match[1], 10);
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

/**
 * Resolves a raw Error to contract error info when the message contains a
 * Soroban contract error code. Returns null for non-contract errors.
 */
export function resolveContractError(
  err: unknown,
): ContractErrorInfo | null {
  if (!(err instanceof Error)) return null;
  const contractCode = extractContractErrorCode(err.message);
  if (contractCode === null) return null;
  const entry = CONTRACT_ERROR_MAP[contractCode];
  if (!entry) return null;
  return { contractCode, httpStatus: entry.httpStatus, code: entry.code };
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

    // ── Soroban contract errors → mapped HTTP status ─────────────────────────
    const contractInfo = resolveContractError(exception);
    if (contractInfo) {
      const msg =
        exception instanceof Error ? exception.message : 'Contract error';
      this.logger.warn(
        `[ContractError] code=${contractInfo.contractCode} http=${contractInfo.httpStatus}`,
      );
      response.status(contractInfo.httpStatus).json({
        code: contractInfo.code,
        message: msg,
        details: { contractCode: contractInfo.contractCode },
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
