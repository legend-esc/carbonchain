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

/**
 * Issue #916 — Fired every time a tx_bad_seq error triggers a retry.
 * Used to increment the `tx_bad_seq_total` Prometheus counter so operators
 * can alert on persistent sequence clashes across replicas.
 */
export const TX_BAD_SEQ = 'transaction.bad_seq';

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

/**
 * Issue #916 — Payload for the TX_BAD_SEQ metric event.
 * Records which account and method triggered the bad-sequence retry,
 * and which attempt number this is (1 = first retry).
 */
export interface TxBadSeqEvent {
  /** Stellar public key of the signing account that received tx_bad_seq. */
  publicKey: string;
  /** Contract method (or 'buildAndSubmit') that triggered the error. */
  method: string;
  /** Retry attempt number (1-indexed). */
  attempt: number;
}

// ── Provider factory ─────────────────────────────────────────────────────────

export const metricsEventEmitterProvider = {
  provide: METRICS_EVENT_EMITTER,
  useValue: new EventEmitter(),
};
