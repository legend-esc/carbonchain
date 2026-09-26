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
