import { Component, inject, input, effect } from '@angular/core';

import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth.service';
import { StellarWalletService, WalletProvider } from '../services/stellar-wallet.service';
import { TranslatePipe } from '../pipes/translate.pipe';

@Component({
  selector: 'app-connect-wallet',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    @if (auth.isAuthenticated()) {
      <div class="wallet-info">
        <span class="pubkey" [title]="wallet.publicKey()!">
          {{ wallet.publicKey()! | slice: 0 : 6 }}…{{ wallet.publicKey()! | slice: -4 }}
        </span>

        <span class="balance" aria-live="polite">
          @if (wallet.xlmBalance() !== null) {
            {{ wallet.xlmBalance()! | number: '1.7-7' }} XLM
          } @else {
            <span class="balance-loading">Loading…</span>
          }
        </span>

        <button class="btn btn-outline" (click)="auth.logout()">
          {{ 'wallet.disconnect' | translate }}
        </button>
      </div>
    } @else {
      @if (compact()) {
        <button
          class="btn btn-primary"
          [disabled]="auth.authState() === 'authenticating'"
          (click)="login()"
        >
          @if (auth.authState() === 'authenticating') {
            {{ 'wallet.connecting' | translate }}
          } @else {
            {{ 'wallet.connect' | translate }}
          }
        </button>
      } @else {
        <div class="wallet-page">
          <h2>{{ 'wallet.pageTitle' | translate }}</h2>
          <p class="wallet-desc">{{ 'wallet.pageDescription' | translate }}</p>
          <div class="wallet-grid">
            @for (adapter of adapters; track adapter.id) {
              <div class="wallet-card">
                <div class="wallet-card-header">
                  <span class="wallet-name">{{ adapter.name }}</span>
                  @if (adapter.isInstalled()) {
                    <span class="badge badge-installed">Installed</span>
                  } @else {
                    <span class="badge badge-not-installed">Not Installed</span>
                  }
                </div>
                @if (adapter.isInstalled()) {
                  <button
                    class="btn btn-primary"
                    [disabled]="auth.authState() === 'authenticating'"
                    (click)="login(adapter.id)"
                  >
                    @if (auth.authState() === 'authenticating' && wallet.selectedProvider() === adapter.id) {
                      {{ 'wallet.connecting' | translate }}
                    } @else {
                      {{ 'wallet.connect' | translate }}
                    }
                  </button>
                } @else {
                  <a
                    class="btn btn-outline"
                    [href]="adapter.installUrl"
                    target="_blank"
                    rel="noopener"
                  >
                    {{ 'wallet.install' | translate }}
                  </a>
                }
              </div>
            }
          </div>
        </div>
      }

      @if (auth.authError()) {
        <p class="error">{{ auth.authError() }}</p>
      }
    }
  `,
  styles: [
    `
      .wallet-info {
        display: flex;
        align-items: center;
        gap: 0.75rem;
      }
      .pubkey {
        font-family: monospace;
        font-size: 0.85rem;
      }
      .balance {
        font-family: monospace;
        font-size: 0.85rem;
        color: var(--text-muted);
        white-space: nowrap;
      }
      .balance-loading {
        opacity: 0.7;
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
      .btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-outline {
        background: transparent;
        border: 1px solid var(--border);
      }
      .error {
        color: #e53935;
        font-size: 0.8rem;
        margin: 0;
      }
      .wallet-page {
        max-width: 540px;
      }
      .wallet-page h2 {
        margin: 0 0 0.5rem;
        font-size: 1.3rem;
      }
      .wallet-desc {
        margin: 0 0 1rem;
        color: var(--text-muted);
        line-height: 1.5;
      }
      .wallet-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 0.75rem;
      }
      .wallet-card {
        border: 1px solid var(--border, #e0e0e0);
        border-radius: 8px;
        padding: 0.75rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .wallet-card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }
      .wallet-name {
        font-weight: 600;
        font-size: 0.95rem;
      }
      .badge {
        font-size: 0.7rem;
        padding: 0.15rem 0.5rem;
        border-radius: 999px;
        font-weight: 500;
      }
      .badge-installed {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .badge-not-installed {
        background: #f5f5f5;
        color: #757575;
      }
    `,
  ],
})
export class ConnectWalletComponent {
  readonly compact = input(false);
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  readonly adapters = this.wallet.getAvailableAdapters();

  // Start/stop balance polling automatically based on wallet connection state.
  constructor() {
    effect(() => {
      if (this.wallet.isConnected()) {
        this.wallet.startBalancePolling();
      } else {
        this.wallet.stopBalancePolling();
      }
    });
  }

  async login(provider?: WalletProvider): Promise<void> {
    try {
      if (provider) {
        await this.wallet.connectWithProvider(provider);
        await this.auth.login();
      } else {
        await this.auth.login();
      }
    } catch {
      // error already stored in auth.authError signal
    }
  }
}
