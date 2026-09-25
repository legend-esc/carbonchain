import { EventEmitter } from 'events';

/**
 * DI token for the metrics event emitter.
 * Services emit events on this emitter; MetricsListener subscribes
 * and updates Prometheus metrics — keeping domain services decoupled
 * from prom-client.
 */
export const METRICS_EVENT_EMITTER = 'METRICS_EVENT_EMITTER';

// ── Event names ──────────────────────────────────────────────────────────────

/** Fired after a Stellar contract invocation completes (success or failure). */
export const CONTRACT_INVOCATION_COMPLETED = 'contract.invocation.completed';

/**
 * Issue #944 — Fired after a Stellar contract read (simulation-only) completes.
 * Used to record `stellar_rpc_duration_seconds` and `stellar_contract_ops_total`
 * counters without coupling StellarService to MetricsService.
 */
export const CONTRACT_READ_COMPLETED = 'contract.read.completed';

/** Fired after a credit retirement completes. */
export const RETIREMENT_COMPLETED = 'retirement.completed';

/** Fired when a credit's status changes (e.g. Active → Retired). */
export const CREDIT_STATUS_CHANGED = 'credit.status.changed';

// ── Payload interfaces ───────────────────────────────────────────────────────

export interface ContractInvocationCompletedEvent {
  contract: string;
  method: string;
  status: 'success' | 'failure';
  /** Wall-clock duration of the entire invokeContract call in ms. */
  durationMs: number;
  /** Fee paid in stroops (only on success). */
  feeStroops?: number;
}

/**
 * Issue #944 — Payload for CONTRACT_READ_COMPLETED events.
 * Emitted by StellarService.readContract on both success and failure.
 */
export interface ContractReadCompletedEvent {
  contract: string;
  method: string;
  status: 'success' | 'failure';
  /** Wall-clock duration of the readContract call (simulation) in ms. */
  durationMs: number;
}

export interface RetirementCompletedEvent {
  /** 'single' for single-credit retire, 'batch' for batch_retire. */
  type: 'single' | 'batch';
  /** Number of credits successfully retired in this call. */
  count: number;
}

export interface CreditStatusChangedEvent {
  creditId: string;
  previousStatus: string;
  newStatus: string;
}

// ── Provider factory ─────────────────────────────────────────────────────────

export const metricsEventEmitterProvider = {
  provide: METRICS_EVENT_EMITTER,
  useValue: new EventEmitter(),
};
