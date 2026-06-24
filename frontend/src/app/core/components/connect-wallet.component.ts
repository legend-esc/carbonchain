import { Component, inject, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { AuthService } from '../services/auth.service';
import { StellarWalletService } from '../services/stellar-wallet.service';
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
          <ol class="wallet-steps">
            <li>{{ 'wallet.step1' | translate }}</li>
            <li>{{ 'wallet.step2' | translate }}</li>
            <li>{{ 'wallet.step3' | translate }}</li>
          </ol>
          @if (!wallet.isFreighterInstalled) {
            <a class="btn btn-primary" href="https://freighter.app" target="_blank" rel="noopener">
              {{ 'wallet.install' | translate }}
            </a>
          } @else {
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
          }
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
        max-width: 480px;
      }
      .wallet-page h2 {
        margin: 0 0 0.5rem;
        font-size: 1.3rem;
      }
      .wallet-desc {
        margin: 0 0 0.5rem;
        color: var(--text-muted);
        line-height: 1.5;
      }
      .wallet-steps {
        margin: 0 0 1.25rem;
        padding-left: 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        font-size: 0.9rem;
        color: var(--text-muted);
      }
    `,
  ],
})
export class ConnectWalletComponent {
  readonly compact = input(false);
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);

  async login(): Promise<void> {
    try {
      await this.auth.login();
    } catch {
      // error already stored in auth.authError signal
    }
  }
}
