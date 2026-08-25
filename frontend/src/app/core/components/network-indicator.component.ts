import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StellarWalletService } from '../services/stellar-wallet.service';

/**
 * Issue #539 — shows which Stellar network the connected wallet is on, and
 * warns the user when Freighter's live network no longer matches the
 * network the app persisted (e.g. they switched networks in Freighter, or
 * a stale session was restored from localStorage after a reload).
 */
@Component({
  selector: 'app-network-indicator',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (wallet.network(); as network) {
      <span
        class="network-badge"
        [class.mainnet]="network === 'mainnet'"
        [class.testnet]="network === 'testnet'"
      >
        {{ network === 'mainnet' ? 'Mainnet' : 'Testnet' }}
      </span>
    }

    @if (wallet.networkMismatch()) {
      <div class="network-modal-backdrop" role="alertdialog" aria-modal="true">
        <div class="network-modal">
          <h3>Wrong network</h3>
          <p>Please switch to {{ expectedNetworkLabel() }} in Freighter.</p>
          <button class="btn btn-primary" (click)="recheck()">I've switched</button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .network-badge {
        padding: 0.2rem 0.6rem;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }
      .network-badge.mainnet {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .network-badge.testnet {
        background: #fff3e0;
        color: #ef6c00;
      }

      .network-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }
      .network-modal {
        background: var(--surface, #fff);
        border-radius: 8px;
        padding: 1.5rem;
        max-width: 320px;
        text-align: center;
      }
      .network-modal h3 {
        margin: 0 0 0.5rem;
      }
      .network-modal p {
        margin: 0 0 1rem;
        color: var(--text-muted);
      }
      .btn {
        padding: 0.4rem 1rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.9rem;
      }
      .btn-primary {
        background: #4caf50;
        color: #fff;
      }
    `,
  ],
})
export class NetworkIndicatorComponent {
  protected readonly wallet = inject(StellarWalletService);

  protected readonly expectedNetworkLabel = computed(() =>
    this.wallet.network() === 'mainnet' ? 'Mainnet' : 'Testnet',
  );

  async recheck(): Promise<void> {
    await this.wallet.checkNetworkMatch();
  }
}
