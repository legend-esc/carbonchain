/**
 * Issue #1336 — enhanced ToastService.
 *
 * Added:
 *  - `txHash` field on Toast renders a "View on StellarExpert" action link
 *  - `warning` toast type alongside existing error / info / success
 *  - `showTx()` convenience helper for transaction results
 *  - Toasts now carry an optional `action` for arbitrary button/link actions
 */
import { Injectable, signal } from '@angular/core';

/** Base URL for the StellarExpert transaction explorer. */
export const STELLAR_EXPERT_TX_BASE = 'https://stellar.expert/explorer/public/tx/';

export interface ToastAction {
  label: string;
  /** Absolute or relative URL.  When set, the action renders as an <a>. */
  href?: string;
  /** Callback for button-style actions.  Ignored when `href` is set. */
  onClick?: () => void;
}

export interface Toast {
  id: number;
  message: string;
  type: 'error' | 'info' | 'success' | 'warning';
  /** Stellar transaction hash — if present, an explorer link is shown. */
  txHash?: string;
  /** Optional extra action rendered alongside the dismiss button. */
  action?: ToastAction;
}

@Injectable({ providedIn: 'root' })
export class ToastService {
  private _counter = 0;
  private readonly _toasts = signal<Toast[]>([]);

  readonly toasts = this._toasts.asReadonly();

  show(
    message: string,
    type: Toast['type'] = 'error',
    durationMs = 5000,
    extras: Pick<Toast, 'txHash' | 'action'> = {},
  ): void {
    const id = ++this._counter;
    this._toasts.update((list) => [...list, { id, message, type, ...extras }]);
    setTimeout(() => this.dismiss(id), durationMs);
  }

  showError(message: string): void {
    this.show(message, 'error');
  }

  showSuccess(message: string): void {
    this.show(message, 'success');
  }

  showInfo(message: string): void {
    this.show(message, 'info');
  }

  showWarning(message: string): void {
    this.show(message, 'warning');
  }

  /**
   * Show a transaction result toast with an auto-generated StellarExpert link.
   *
   * @param message  Human-readable description of the transaction.
   * @param txHash   Stellar transaction hash (hex or base64).
   * @param type     Toast severity — defaults to 'success'.
   */
  showTx(message: string, txHash: string, type: Toast['type'] = 'success'): void {
    this.show(message, type, 5000, { txHash });
  }

  dismiss(id: number): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
