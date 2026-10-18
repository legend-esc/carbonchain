/**
 * Issue #960 — structured error taxonomy for wallet failures.
 *
 * Freighter surfaces a grab-bag of failures: the user closing the approval
 * modal, the extension never responding, a dead RPC, an unsupported network, or
 * a stale transaction envelope rejected because another submission already
 * consumed the account sequence number. Without a taxonomy every one of those
 * arrives as `Error: <some string>` and the UI shows one generic failure.
 *
 * `normalizeWalletError` maps the raw thrown value onto a small closed set of
 * types, so callers can (a) render a message that tells the user what to do and
 * (b) decide whether an automatic retry is safe.
 */

/** Closed set of wallet failure modes the UI knows how to talk about. */
export type WalletErrorType =
  /** The user dismissed the approval prompt, or locked the extension. */
  | 'userRejected'
  /** The wallet/RPC did not answer within the deadline. */
  | 'timeout'
  /** Transport-level failure talking to Freighter or the RPC. */
  | 'network'
  /** Freighter missing, wrong network, or the action is not available. */
  | 'unsupported'
  /**
   * The signed envelope was rejected because it was already consumed or its
   * sequence number lost a race (issues #57 / #59). Safe to rebuild + re-prompt.
   */
  | 'staleEnvelope'
  | 'unknown';

/**
 * User-facing copy per type. `staleEnvelope` and `timeout` are phrased as
 * recoverable because the UI does recover them; `userRejected` explicitly
 * avoids reading as a failure.
 */
export const WALLET_ERROR_MESSAGES: Record<WalletErrorType, string> = {
  userRejected: 'You cancelled the request in your wallet. Nothing was submitted.',
  timeout: 'Your wallet did not respond in time. Check that it is unlocked, then try again.',
  network: 'Could not reach your wallet. Check your connection and try again.',
  unsupported: 'Your wallet cannot complete this action right now.',
  staleEnvelope:
    'The transaction was superseded by a newer one. Retrying with a fresh transaction…',
  unknown: 'Something went wrong in your wallet. Please try again.',
};

/** True when retrying with a rebuilt transaction envelope can succeed. */
export function isRetryable(type: WalletErrorType): boolean {
  return type === 'staleEnvelope' || type === 'timeout';
}

/** A wallet failure with a machine-readable `type`. */
export class WalletError extends Error {
  readonly type: WalletErrorType;
  /** The original throwable, kept for logging / Sentry breadcrumbs. */
  override readonly cause?: unknown;

  constructor(message: string, type: WalletErrorType = 'unknown', cause?: unknown) {
    super(message);
    this.name = 'WalletError';
    this.type = type;
    this.cause = cause;
  }

  /** Message already chosen for display. */
  get displayMessage(): string {
    return WALLET_ERROR_MESSAGES[this.type];
  }
}

/** Type guard for `WalletError`. */
export function isWalletError(err: unknown): err is WalletError {
  return err instanceof WalletError;
}

function textOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    const message = (err as { message?: unknown }).message;
    return [typeof code === 'string' ? code : '', typeof message === 'string' ? message : '']
      .filter(Boolean)
      .join(' ');
  }
  return String(err ?? '');
}

/**
 * Classify a raw wallet/transport failure.
 *
 * Ordering matters: the stale-envelope and rejection signatures are checked
 * before the generic network/timeout buckets, because Freighter wraps real
 * causes in generic `Error`s whose text is the only signal available.
 */
export function normalizeWalletError(err: unknown): WalletError {
  if (isWalletError(err)) return err;

  const text = textOf(err).toLowerCase();

  if (
    text.includes('tx_bad_seq') ||
    text.includes('bad sequence') ||
    text.includes('already submitted') ||
    text.includes('tx_too_early') ||
    text.includes('stale') ||
    text.includes('envelope')
  ) {
    return new WalletError(textOf(err) || 'Stale transaction envelope.', 'staleEnvelope', err);
  }

  if (
    text.includes('user declined') ||
    text.includes('user rejected') ||
    text.includes('user cancelled') ||
    text.includes('user canceled') ||
    text.includes('request rejected') ||
    text.includes('denied') ||
    text.includes('cancelled') ||
    text.includes('canceled') ||
    text.includes('locked')
  ) {
    return new WalletError(textOf(err) || 'Request rejected.', 'userRejected', err);
  }

  if (text.includes('timeout') || text.includes('timed out') || text.includes('etimedout')) {
    return new WalletError(textOf(err) || 'Wallet request timed out.', 'timeout', err);
  }

  if (
    text.includes('err_bad_response') ||
    text.includes('err_bad_request') ||
    text.includes('network') ||
    text.includes('failed to fetch') ||
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('fetch') ||
    text.includes('disconnected')
  ) {
    return new WalletError(textOf(err) || 'Wallet network failure.', 'network', err);
  }

  if (
    text.includes('not installed') ||
    text.includes('unsupported') ||
    text.includes('network mismatch') ||
    text.includes('not connected') ||
    text.includes('no freighter') ||
    text.includes('undefined')
  ) {
    return new WalletError(textOf(err) || 'Unsupported wallet state.', 'unsupported', err);
  }

  return new WalletError(textOf(err) || 'Unknown wallet error.', 'unknown', err);
}
