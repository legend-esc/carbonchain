import { Component, inject, computed, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StellarWalletService } from '../services/stellar-wallet.service';
import { NetworkService, ALL_NETWORKS, NetworkMeta } from '../services/network.service';

/**
 * Issue #1355 — Network indicator pill in the top header.
 *
 * - Green pill    → Mainnet
 * - Amber pill    → Testnet
 * - Purple pill   → Futurenet
 *
 * Clicking the pill opens a network-switch modal that lets the user see
 * instructions for switching networks in Freighter, with a faucet link
 * for non-production networks.
 *
 * A separate mismatch alert fires when Freighter's live network no longer
 * matches what the app persisted (e.g. user switched networks in the
 * extension after connecting).
 */
@Component({
  selector: 'app-network-indicator',
  standalone: true,
  imports: [CommonModule],
  template: `
    <!-- ── Network pill ─────────────────────────────────────────────────── -->
    @if (wallet.network(); as network) {
      <button
        class="network-badge"
        [ngClass]="['network-badge--' + network, network]"
        (click)="netSvc.openModal()"
        type="button"
        [attr.aria-label]="'Network: ' + currentMeta().label + '. Click to switch.'"
        aria-haspopup="dialog"
      >
        {{ currentMeta().label }}
      </button>
    }

    <!-- ── Network-switch modal ─────────────────────────────────────────── -->
    @if (netSvc.modalOpen()) {
      <div
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-label="Switch Stellar network"
        (click)="onBackdropClick($event)"
      >
        <div class="modal" #modalPanel (keydown)="onKeydown($event)">
          <div class="modal__header">
            <h2 class="modal__title">Switch Network</h2>
            <button
              class="modal__close"
              type="button"
              aria-label="Close"
              (click)="netSvc.closeModal()"
            >
              ✕
            </button>
          </div>

          <!-- Warning banner for active non-production network -->
          @if (currentMeta().warning) {
            <div class="warning-banner" role="status">
              ⚠ {{ currentMeta().warning }}
            </div>
          }

          <p class="modal__hint">
            To switch networks, change the active network in the
            <strong>Freighter</strong> wallet extension and reconnect.
          </p>

          <ul class="network-list" role="list">
            @for (n of allNetworks; track n.id) {
              <li
                class="network-item"
                [class.network-item--active]="wallet.network() === n.id"
                role="listitem"
              >
                <span class="network-dot" [class]="'network-dot--' + n.id"></span>
                <span class="network-item__label">{{ n.label }}</span>
                @if (wallet.network() === n.id) {
                  <span class="network-item__current" aria-current="true">Connected</span>
                }
              </li>
            }
          </ul>

          <!-- Faucet button for non-production networks -->
          @if (currentMeta().faucetUrl) {
            <div class="faucet-row">
              <a
                class="btn btn-faucet"
                [href]="currentMeta().faucetUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                🚰 Get {{ currentMeta().label }} XLM from faucet
              </a>
            </div>
          }

          <div class="modal__footer">
            <button class="btn btn-primary" type="button" (click)="recheck()">
              I've switched — recheck
            </button>
            <button class="btn btn-ghost" type="button" (click)="netSvc.closeModal()">
              Close
            </button>
          </div>
        </div>
      </div>
    }

    <!-- ── Mismatch overlay (Freighter switched behind the scenes) ───────── -->
    @if (wallet.networkMismatch()) {
      <div
        class="modal-backdrop modal-backdrop--mismatch network-modal-backdrop"
        role="alertdialog"
        aria-modal="true"
        aria-label="Network mismatch warning"
      >
        <div class="modal modal--mismatch">
          <h3 class="modal__title">Wrong network</h3>
          <p>
            Your wallet is on <strong>{{ currentMeta().label }}</strong>
            but the app expects <strong>{{ expectedLabel() }}</strong>.
            Please switch to {{ expectedLabel() }} in Freighter.
          </p>
          <div class="modal__footer">
            <button class="btn btn-primary" type="button" (click)="recheck()">
              I've switched
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [
    `
      /* ── Pill ─────────────────────────────────────────────────────────── */
      .network-badge {
        padding: 0.2rem 0.65rem;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        border: none;
        cursor: pointer;
        transition: filter 0.15s ease;
      }
      .network-badge:hover {
        filter: brightness(0.92);
      }
      .network-badge:focus-visible {
        outline: 3px solid #1565c0;
        outline-offset: 2px;
      }

      .network-badge--mainnet {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .network-badge--testnet {
        background: #fff3e0;
        color: #e65100;
      }
      .network-badge--futurenet {
        background: #ede7f6;
        color: #6a1b9a;
      }

      /* ── Modal backdrop ───────────────────────────────────────────────── */
      .modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
        animation: fade-in 0.15s ease-out;
      }
      .modal-backdrop--mismatch {
        background: rgba(0, 0, 0, 0.6);
      }

      @keyframes fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      /* ── Modal panel ──────────────────────────────────────────────────── */
      .modal {
        background: var(--surface, #fff);
        border-radius: 10px;
        padding: 1.5rem;
        max-width: 380px;
        width: calc(100vw - 2rem);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
        animation: slide-up 0.18s ease-out;
      }
      .modal--mismatch {
        border-top: 4px solid #ef6c00;
      }

      @keyframes slide-up {
        from { transform: translateY(12px); opacity: 0; }
        to   { transform: translateY(0);    opacity: 1; }
      }

      .modal__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.75rem;
      }
      .modal__title {
        margin: 0;
        font-size: 1.1rem;
      }
      .modal__close {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1rem;
        color: #666;
        padding: 0.25rem 0.4rem;
        border-radius: 4px;
      }
      .modal__close:hover {
        background: #f0f0f0;
      }
      .modal__hint {
        font-size: 0.875rem;
        color: var(--text-muted, #555);
        margin: 0 0 1rem;
      }
      .modal__footer {
        display: flex;
        gap: 0.75rem;
        justify-content: flex-end;
        margin-top: 1.25rem;
        flex-wrap: wrap;
      }

      /* ── Warning banner ───────────────────────────────────────────────── */
      .warning-banner {
        background: #fff3e0;
        border: 1px solid #ffcc02;
        border-radius: 6px;
        padding: 0.6rem 0.9rem;
        font-size: 0.82rem;
        color: #5d4037;
        margin-bottom: 0.9rem;
      }

      /* ── Network list ─────────────────────────────────────────────────── */
      .network-list {
        list-style: none;
        margin: 0 0 0.5rem;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }
      .network-item {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.55rem 0.75rem;
        border-radius: 6px;
        font-size: 0.9rem;
        border: 1px solid transparent;
      }
      .network-item--active {
        background: #f0f4ff;
        border-color: #c5cae9;
      }
      .network-item__label {
        flex: 1;
      }
      .network-item__current {
        font-size: 0.75rem;
        font-weight: 600;
        color: #2e7d32;
        background: #e8f5e9;
        padding: 0.1rem 0.4rem;
        border-radius: 999px;
      }

      .network-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
        flex-shrink: 0;
      }
      .network-dot--mainnet  { background: #2e7d32; }
      .network-dot--testnet  { background: #e65100; }
      .network-dot--futurenet { background: #6a1b9a; }

      /* ── Faucet ───────────────────────────────────────────────────────── */
      .faucet-row {
        margin-top: 0.75rem;
      }
      .btn-faucet {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.45rem 1rem;
        border-radius: 6px;
        font-size: 0.875rem;
        font-weight: 500;
        background: #e3f2fd;
        color: #0d47a1;
        border: 1px solid #90caf9;
        text-decoration: none;
        cursor: pointer;
        transition: background 0.15s;
      }
      .btn-faucet:hover {
        background: #bbdefb;
      }

      /* ── Shared buttons ───────────────────────────────────────────────── */
      .btn {
        padding: 0.45rem 1.1rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.875rem;
        font-weight: 500;
      }
      .btn-primary {
        background: #4caf50;
        color: #fff;
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid #bbb;
        color: #444;
      }
    `,
  ],
})
export class NetworkIndicatorComponent {
  protected readonly wallet = inject(StellarWalletService);
  protected readonly netSvc = inject(NetworkService);

  protected readonly allNetworks = ALL_NETWORKS;

  protected readonly currentMeta = computed(() => this.netSvc.metaFor(this.wallet.network()));

  protected readonly expectedLabel = computed(() =>
    this.netSvc.metaFor(this.wallet.network()).label,
  );

  async recheck(): Promise<void> {
    await this.wallet.checkNetworkMatch();
    this.netSvc.closeModal();
  }

  /** Handle keydown on the modal panel (closes on Escape). */
  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.netSvc.closeModal();
    }
  }

  /** Close modal on Escape key — handles both the backdrop and the panel. */
  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.netSvc.modalOpen()) {
      this.netSvc.closeModal();
    }
  }

  /** Close modal when clicking the semi-transparent backdrop (not the panel itself). */
  onBackdropClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal-backdrop')) {
      this.netSvc.closeModal();
    }
  }
}
