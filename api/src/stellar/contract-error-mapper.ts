/**
 * ContractErrorMapper — issue #919
 *
 * Single source of truth for all stable contract error codes.
 * Derived directly from the Rust error enums in contracts/*/src/errors.rs.
 *
 * Error ranges:
 *   100–126  credit_registry  (CarbonChainError)
 *   110–118  retirement       (RetirementError)   — note overlapping with registry by design
 *   115–126  marketplace      (MarketplaceError)
 *   400–409  mrv_oracle       (reserved range)
 *
 * HTTP status mapping convention:
 *   400  — caller sent invalid input
 *   401  — unauthorized / missing credentials
 *   404  — resource not found
 *   409  — conflict / invalid state transition
 *   422  — unprocessable (semantic validation failure)
 *   503  — contract paused / infrastructure unavailable
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

export interface ContractErrorDescriptor {
  /** Numeric error code emitted by the Soroban contract. */
  code: number;
  /** Human-readable name matching the Rust variant. */
  name: string;
  /** User-facing message returned in the API error body. */
  message: string;
  /** HTTP status code to use when this contract error surfaces. */
  httpStatus: 400 | 401 | 403 | 404 | 409 | 422 | 503;
  /** Which contract family emitted this code. */
  contract: 'credit_registry' | 'retirement' | 'marketplace' | 'mrv_oracle';
}

// ── Credit Registry errors (100–126) ─────────────────────────────────────────
// Source: contracts/credit_registry/src/errors.rs  CarbonChainError
const REGISTRY_ERRORS: ContractErrorDescriptor[] = [
  { code: 100, name: 'NotInitialized',            message: 'Contract has not been initialized.',                        httpStatus: 503, contract: 'credit_registry' },
  { code: 101, name: 'AlreadyInitialized',        message: 'Contract has already been initialized.',                    httpStatus: 409, contract: 'credit_registry' },
  { code: 102, name: 'Unauthorized',              message: 'You are not authorized to perform this action.',            httpStatus: 403, contract: 'credit_registry' },
  { code: 103, name: 'InvalidMetadata',           message: 'Credit metadata is invalid or incomplete.',                 httpStatus: 400, contract: 'credit_registry' },
  { code: 104, name: 'CreditNotFound',            message: 'The specified credit was not found.',                       httpStatus: 404, contract: 'credit_registry' },
  { code: 105, name: 'InvalidStatusTransition',   message: 'This state transition is not permitted for the credit.',    httpStatus: 409, contract: 'credit_registry' },
  { code: 106, name: 'VerifierAlreadyExists',     message: 'A verifier with this address is already registered.',       httpStatus: 409, contract: 'credit_registry' },
  { code: 107, name: 'VerifierNotFound',          message: 'No verifier with this address is registered.',              httpStatus: 404, contract: 'credit_registry' },
  { code: 108, name: 'InsufficientBalance',       message: 'Insufficient token balance to complete the operation.',     httpStatus: 422, contract: 'credit_registry' },
  { code: 109, name: 'Overflow',                  message: 'Arithmetic overflow during credit calculation.',            httpStatus: 422, contract: 'credit_registry' },
  { code: 110, name: 'InvalidTonnes',             message: 'Tonnes value must be a positive multiple of 100 000.',      httpStatus: 400, contract: 'credit_registry' },
  { code: 111, name: 'InvalidAdmin',              message: 'The provided admin address is invalid.',                    httpStatus: 400, contract: 'credit_registry' },
  { code: 112, name: 'ContractPaused',            message: 'The credit registry contract is currently paused.',         httpStatus: 503, contract: 'credit_registry' },
  { code: 113, name: 'IssuerNotAllowed',          message: 'This issuer is not permitted to submit credits.',           httpStatus: 403, contract: 'credit_registry' },
  { code: 114, name: 'InvalidMethodology',        message: 'The specified methodology is not recognized.',              httpStatus: 400, contract: 'credit_registry' },
  { code: 115, name: 'InvalidNonce',              message: 'Invalid or replayed nonce — replay attack protection triggered.', httpStatus: 409, contract: 'credit_registry' },
  { code: 116, name: 'NoPendingAdmin',            message: 'No pending admin transfer is in progress.',                 httpStatus: 409, contract: 'credit_registry' },
  { code: 117, name: 'InvalidSplit',              message: 'Split tonnes must be positive and less than total.',         httpStatus: 400, contract: 'credit_registry' },
  { code: 118, name: 'InvalidDisputeStatus',      message: 'Credit is not in a state that allows dispute resolution.',  httpStatus: 409, contract: 'credit_registry' },
  { code: 119, name: 'VerifierHasPendingCredits', message: 'Cannot remove a verifier who has pending credits.',         httpStatus: 409, contract: 'credit_registry' },
  { code: 120, name: 'ProjectNotFound',           message: 'The specified project was not found.',                      httpStatus: 404, contract: 'credit_registry' },
  { code: 121, name: 'DuplicateCredit',           message: 'A credit with this ID already exists.',                     httpStatus: 409, contract: 'credit_registry' },
  { code: 122, name: 'ProjectAlreadyExists',      message: 'A project with this ID already exists.',                    httpStatus: 409, contract: 'credit_registry' },
  { code: 123, name: 'SessionNotFound',           message: 'The specified audit session was not found.',                 httpStatus: 404, contract: 'credit_registry' },
  { code: 124, name: 'InvalidApprovalThreshold',  message: 'Required approvals must be at least 1 and ≤ verifier count.', httpStatus: 400, contract: 'credit_registry' },
  { code: 125, name: 'AlreadyApproved',           message: 'This verifier has already approved this credit.',           httpStatus: 409, contract: 'credit_registry' },
  { code: 126, name: 'NoRetirementContract',      message: 'No retirement contract address is registered.',             httpStatus: 503, contract: 'credit_registry' },
];

// ── Retirement errors (110–118) ───────────────────────────────────────────────
// Source: contracts/retirement/src/errors.rs  RetirementError
const RETIREMENT_ERRORS: ContractErrorDescriptor[] = [
  { code: 110, name: 'CreditNotActive',    message: 'The credit is not active and cannot be retired.',         httpStatus: 409, contract: 'retirement' },
  { code: 111, name: 'AlreadyInitialized', message: 'Retirement contract has already been initialized.',        httpStatus: 409, contract: 'retirement' },
  { code: 112, name: 'NotInitialized',     message: 'Retirement contract has not been initialized.',            httpStatus: 503, contract: 'retirement' },
  { code: 113, name: 'Unauthorized',       message: 'You are not authorized to perform this retirement action.', httpStatus: 403, contract: 'retirement' },
  { code: 114, name: 'ContractPaused',     message: 'The retirement contract is currently paused.',             httpStatus: 503, contract: 'retirement' },
  { code: 115, name: 'InvalidNonce',       message: 'Invalid or replayed nonce on retirement call.',            httpStatus: 409, contract: 'retirement' },
  { code: 116, name: 'NoPendingAdmin',     message: 'No pending admin transfer in retirement contract.',        httpStatus: 409, contract: 'retirement' },
  { code: 117, name: 'InvalidTonnes',      message: 'Retirement tonnes must be a positive multiple of 100 000.', httpStatus: 400, contract: 'retirement' },
  { code: 118, name: 'InvalidInput',       message: 'One or more retirement inputs are invalid.',               httpStatus: 400, contract: 'retirement' },
];

// ── Marketplace errors (115–126) ─────────────────────────────────────────────
// Source: contracts/marketplace/src/lib.rs  MarketplaceError
const MARKETPLACE_ERRORS: ContractErrorDescriptor[] = [
  { code: 115, name: 'OfferNotFound',      message: 'The specified offer was not found.',                     httpStatus: 404, contract: 'marketplace' },
  { code: 116, name: 'Unauthorized',       message: 'You are not authorized to modify this offer.',           httpStatus: 403, contract: 'marketplace' },
  { code: 117, name: 'InvalidPrice',       message: 'Offer price must be a positive value in stroops.',       httpStatus: 400, contract: 'marketplace' },
  { code: 118, name: 'AlreadyClosed',      message: 'This offer is already closed or cancelled.',             httpStatus: 409, contract: 'marketplace' },
  { code: 119, name: 'CreditNotActive',    message: 'The credit in this offer is not active.',                httpStatus: 409, contract: 'marketplace' },
  { code: 120, name: 'NotInitialized',     message: 'Marketplace contract has not been initialized.',         httpStatus: 503, contract: 'marketplace' },
  { code: 121, name: 'ContractPaused',     message: 'The marketplace contract is currently paused.',          httpStatus: 503, contract: 'marketplace' },
  { code: 122, name: 'InvalidNonce',       message: 'Invalid or replayed nonce on marketplace call.',         httpStatus: 409, contract: 'marketplace' },
  { code: 123, name: 'OfferExpired',       message: 'This offer has expired and can no longer be filled.',    httpStatus: 409, contract: 'marketplace' },
  { code: 124, name: 'Overflow',           message: 'Arithmetic overflow in marketplace calculation.',        httpStatus: 422, contract: 'marketplace' },
  { code: 125, name: 'InvalidTonnes',      message: 'Offer tonnes must be a positive multiple of 100 000.',   httpStatus: 400, contract: 'marketplace' },
  { code: 126, name: 'AlreadyInitialized', message: 'Marketplace contract has already been initialized.',     httpStatus: 409, contract: 'marketplace' },
];

/**
 * Flat map from contract error code → descriptor.
 * When the same numeric code appears in multiple contracts we store the first
 * match; callers that know the contract context should use `mapWithContext`.
 */
const ERROR_MAP = new Map<number, ContractErrorDescriptor>();

// Populate in priority order: registry → retirement → marketplace.
// Registry codes are canonical; retirement/marketplace codes that coincide
// (e.g. 115 = InvalidNonce in registry, OfferNotFound in marketplace) are
// disambiguated by the context-aware lookup below.
for (const e of [...REGISTRY_ERRORS, ...RETIREMENT_ERRORS, ...MARKETPLACE_ERRORS]) {
  if (!ERROR_MAP.has(e.code)) {
    ERROR_MAP.set(e.code, e);
  }
}

// Contract-scoped maps for context-aware lookup.
const REGISTRY_MAP   = new Map(REGISTRY_ERRORS.map(e => [e.code, e]));
const RETIREMENT_MAP = new Map(RETIREMENT_ERRORS.map(e => [e.code, e]));
const MARKETPLACE_MAP = new Map(MARKETPLACE_ERRORS.map(e => [e.code, e]));

const CONTRACT_MAPS: Record<ContractErrorDescriptor['contract'], Map<number, ContractErrorDescriptor>> = {
  credit_registry: REGISTRY_MAP,
  retirement:      RETIREMENT_MAP,
  marketplace:     MARKETPLACE_MAP,
  mrv_oracle:      new Map(), // reserved — extend when oracle errors are stable
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extracts the numeric contract error code from a thrown error message.
 *
 * Soroban SDK surfaces errors in several ways:
 *   - "Error(Contract, #112)" — Soroban SDK v11+
 *   - "Contract error: 112"
 *   - plain "112" somewhere in the message
 *
 * Returns `undefined` if no numeric code is found.
 */
export function extractContractErrorCode(error: unknown): number | undefined {
  const msg = (error as Error)?.message ?? String(error);

  // Pattern: Error(Contract, #NNN)
  const sorobanMatch = msg.match(/Error\s*\(\s*Contract\s*,\s*#(\d+)\s*\)/i);
  if (sorobanMatch) return parseInt(sorobanMatch[1], 10);

  // Pattern: Contract error: NNN  or  contract error NNN
  const labeledMatch = msg.match(/contract\s+error[:\s]+(\d+)/i);
  if (labeledMatch) return parseInt(labeledMatch[1], 10);

  // Pattern: HostError ... ContractError ... value:(\d+)
  const hostErrMatch = msg.match(/value[:\s]+(\d+)/i);
  if (hostErrMatch) {
    const code = parseInt(hostErrMatch[1], 10);
    // Only trust this if it falls in a known range
    if (code >= 100 && code <= 500) return code;
  }

  // Fallback: bare code string anywhere in message (last resort)
  const bareMatch = msg.match(/\b(1[0-4]\d|[12]\d{2}|[34]\d{2})\b/);
  if (bareMatch) return parseInt(bareMatch[1], 10);

  return undefined;
}

/**
 * Look up a descriptor by code.  Pass the optional `contract` context to
 * disambiguate codes that appear in multiple contracts.
 */
export function lookupError(
  code: number,
  contract?: ContractErrorDescriptor['contract'],
): ContractErrorDescriptor | undefined {
  if (contract) {
    return CONTRACT_MAPS[contract]?.get(code);
  }
  return ERROR_MAP.get(code);
}

/**
 * Map a contract error to the appropriate NestJS HTTP exception.
 *
 * @param error      The raw error thrown by StellarService / invokeContract.
 * @param contract   Optional: narrows the lookup to a specific contract map.
 * @param fallback   Optional: override for errors that don't match any code.
 *
 * Behaviour:
 * - If a code is found and mapped → throw the corresponding NestJS exception.
 * - If no code is found → re-throw the original error unchanged.
 */
export function mapContractError(
  error: unknown,
  contract?: ContractErrorDescriptor['contract'],
  fallback?: (code: number) => never,
): never {
  const code = extractContractErrorCode(error);

  if (code !== undefined) {
    const descriptor = lookupError(code, contract);

    if (descriptor) {
      throwForDescriptor(descriptor, code);
    }

    // Code recognized as being in a valid range but no descriptor — surface it
    // with a generic message that still exposes the code for debugging.
    if (fallback) {
      fallback(code);
    }

    throw buildGenericError(code, error);
  }

  // Not a contract error — re-throw as-is so the caller handles it.
  throw error as Error;
}

/**
 * Like `mapContractError` but returns a NestJS exception instead of throwing,
 * so callers can decide whether to throw or log first.
 */
export function toHttpException(
  error: unknown,
  contract?: ContractErrorDescriptor['contract'],
): Error {
  const code = extractContractErrorCode(error);

  if (code !== undefined) {
    const descriptor = lookupError(code, contract);
    if (descriptor) {
      return buildExceptionForDescriptor(descriptor, code);
    }
    return buildGenericError(code, error);
  }

  return error instanceof Error ? error : new Error(String(error));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function throwForDescriptor(d: ContractErrorDescriptor, code: number): never {
  throw buildExceptionForDescriptor(d, code);
}

function buildExceptionForDescriptor(d: ContractErrorDescriptor, code: number): Error {
  const body = { error: d.message, code, name: d.name, contract: d.contract };
  switch (d.httpStatus) {
    case 400: return new BadRequestException(body);
    case 403: return new ForbiddenException(body);
    case 404: return new NotFoundException(body);
    case 409: return new ConflictException(body);
    case 422: return new UnprocessableEntityException(body);
    case 503: return new ServiceUnavailableException(body);
    // 401 is not in our set but keep the exhaustive default:
    default:  return new ServiceUnavailableException(body);
  }
}

function buildGenericError(code: number, original: unknown): Error {
  const msg = `Contract error code ${code}: ${(original as Error)?.message ?? 'unknown error'}`;
  return new UnprocessableEntityException({ error: msg, code });
}

// ── Exported descriptor collections (for unit tests) ─────────────────────────
export { REGISTRY_ERRORS, RETIREMENT_ERRORS, MARKETPLACE_ERRORS };
