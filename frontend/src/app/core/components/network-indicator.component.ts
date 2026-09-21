import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { StellarWalletService } from '../services/stellar-wallet.service';
import { TranslationService } from '../services/translation.service';
import { TranslatePipe } from '../pipes/translate.pipe';

/**
 * Issue #539 — shows which Stellar network the connected wallet is on, and
 * warns the user when Freighter's live network no longer matches the
 * network the app persisted (e.g. they switched networks in Freighter, or
 * a stale session was restored from localStorage after a reload).
 */
@Component({
  selector: 'app-network-indicator',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    @if (wallet.network(); as network) {
      <span
        class="network-badge"
        [class.mainnet]="network === 'mainnet'"
        [class.testnet]="network === 'testnet'"
      >
        {{ (network === 'mainnet' ? 'network.mainnet' : 'network.testnet') | translate }}
      </span>
    }

    @if (wallet.networkMismatch()) {
      <div class="network-modal-backdrop" role="alertdialog" aria-modal="true">
        <div class="network-modal">
          <h3>{{ 'network.wrongTitle' | translate }}</h3>
          <p>{{ 'network.switchTo' | translate: { network: expectedNetworkLabel() } }}</p>
          <button class="btn btn-primary" (click)="recheck()">
            {{ 'network.switched' | translate }}
          </button>
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
  private readonly i18n = inject(TranslationService);

  protected readonly expectedNetworkLabel = computed(() =>
    this.i18n.t(this.wallet.network() === 'mainnet' ? 'network.mainnet' : 'network.testnet'),
  );

  async recheck(): Promise<void> {
    await this.wallet.checkNetworkMatch();
  }
}
