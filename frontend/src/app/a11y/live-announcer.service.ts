import { DOCUMENT } from '@angular/common';
import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { type TxStatusStep, type WalletState } from '../core/services/stellar-wallet.service';

export type AriaLivePoliteness = 'polite' | 'assertive';

export interface OrderFillAnnouncement {
  offerId: string | number;
  tonnes?: string | number;
  price?: string | number;
  asset?: string;
}

export interface PriceChangeAnnouncement {
  projectId?: string;
  offerId?: string | number;
  price: string | number;
  asset?: string;
}

/**
 * Issue #1356 — Screen reader live region announcements for real-time
 * WebSocket marketplace events, order fills, and wallet state changes.
 *
 * Manages an off-screen `aria-live="polite"` / `aria-atomic="true"` DOM
 * container appended to `document.body`.
 */
@Injectable({ providedIn: 'root' })
export class LiveAnnouncerService implements OnDestroy {
  private readonly document = inject(DOCUMENT);
  private container: HTMLElement | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly _lastAnnouncement = signal<string>('');
  /** Most recent message dispatched to the live region (useful for testing/debugging). */
  readonly lastAnnouncement = this._lastAnnouncement.asReadonly();

  constructor() {
    this.ensureContainer();
  }

  /**
   * Dispatch a descriptive message to the screen reader live region.
   * Clears and re-populates the node so identical consecutive messages are still spoken.
   */
  announce(message: string, politeness: AriaLivePoliteness = 'polite'): void {
    const trimmed = message.trim();
    if (!trimmed) return;

    this._lastAnnouncement.set(trimmed);
    const el = this.ensureContainer();
    if (!el) return;

    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');

    if (this.announceTimer) {
      clearTimeout(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.clearTimer) {
      clearTimeout(this.clearTimer);
      this.clearTimer = null;
    }

    el.textContent = '';
    this.announceTimer = setTimeout(() => {
      if (this.container) {
        this.container.textContent = trimmed;
      }
      this.announceTimer = null;
    }, 50);

    // Clear after screen reader has had time to read so stale text is not re-read on focus.
    this.clearTimer = setTimeout(() => {
      if (this.container && this.container.textContent === trimmed) {
        this.container.textContent = '';
      }
      this.clearTimer = null;
    }, 10_000);
  }

  /** Announce a marketplace order fill event. */
  announceOrderFill(params: OrderFillAnnouncement): void {
    const parts: string[] = [`Order #${params.offerId} filled.`];
    if (params.tonnes !== undefined && params.tonnes !== '') {
      parts.push(`${params.tonnes} tonnes`);
    }
    if (params.price !== undefined && params.price !== '') {
      const asset = params.asset ?? 'XLM';
      parts.push(`at ${params.price} ${asset}`);
    }
    this.announce(parts.join(' '), 'polite');
  }

  /** Announce a live marketplace price update. */
  announcePriceChange(params: PriceChangeAnnouncement): void {
    const target = params.offerId
      ? `Offer #${params.offerId}`
      : params.projectId
        ? `Project ${params.projectId}`
        : 'Marketplace';
    const asset = params.asset ?? 'XLM';
    this.announce(`${target} price updated to ${params.price} ${asset}.`, 'polite');
  }

  /** Announce wallet connection, disconnection, or network state changes. */
  announceWalletState(
    state: WalletState,
    address?: string | null,
    network?: string | null,
  ): void {
    switch (state) {
      case 'connecting':
        this.announce('Connecting Stellar wallet.', 'polite');
        break;
      case 'connected': {
        const shortAddr =
          address && address.length > 10
            ? `${address.slice(0, 4)}…${address.slice(-4)}`
            : (address ?? 'wallet');
        const netLabel = network ? ` on ${network}` : '';
        this.announce(`Wallet connected: ${shortAddr}${netLabel}.`, 'polite');
        break;
      }
      case 'disconnected':
        this.announce('Wallet disconnected.', 'polite');
        break;
      case 'error':
        this.announce('Wallet connection error.', 'assertive');
        break;
    }
  }

  /** Announce transaction lifecycle updates (confirmation or failure). */
  announceTxStatus(
    step: TxStatusStep,
    label?: string,
    txHash?: string | null,
    errorMessage?: string | null,
  ): void {
    const prefix = label ? `${label}: ` : 'Transaction ';
    if (step === 'confirmed') {
      const hashSuffix = txHash ? ` Hash ${txHash.slice(0, 8)}.` : '';
      this.announce(`${prefix}confirmed on Stellar.${hashSuffix}`, 'polite');
    } else if (step === 'error') {
      const reason = errorMessage ? ` ${errorMessage}` : '';
      this.announce(`${prefix}failed.${reason}`, 'assertive');
    } else if (step === 'submitting') {
      this.announce(`${prefix}submitting to network.`, 'polite');
    }
  }

  ngOnDestroy(): void {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    if (this.clearTimer) clearTimeout(this.clearTimer);
    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
    this.container = null;
  }

  private ensureContainer(): HTMLElement | null {
    if (this.container && this.document.body?.contains(this.container)) {
      return this.container;
    }

    const existing = this.document.getElementById('cc-live-announcer');
    if (existing) {
      this.container = existing;
      return existing;
    }

    if (!this.document.body) {
      return null;
    }

    const el = this.document.createElement('div');
    el.id = 'cc-live-announcer';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', 'status');
    Object.assign(el.style, {
      position: 'absolute',
      width: '1px',
      height: '1px',
      padding: '0',
      margin: '-1px',
      overflow: 'hidden',
      clip: 'rect(0, 0, 0, 0)',
      whiteSpace: 'nowrap',
      border: '0',
    });

    this.document.body.appendChild(el);
    this.container = el;
    return el;
  }
}
