import { Component, input, output, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Offer, BuyQuote } from '@shared';

import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { WALLET_ERROR_MESSAGES, normalizeWalletError } from '../core/services/wallet-errors';

/**
 * Contract error code for `MarketplaceError::OfferExpired` (309). The API
 * surfaces it as HTTP 410 Gone, which the parent passes down as `errorCode`.
 */
export const OFFER_EXPIRED_ERROR_CODE = 309;

@Component({
  selector: 'app-offer-detail',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    @if (expired()) {
      <div class="offer-detail" role="alertdialog" aria-labelledby="offer-expired-heading">
        <div class="offer-detail__header">
          <h2 id="offer-expired-heading">Offer Expired</h2>
          <button
            class="btn btn-ghost"
            type="button"
            (click)="closed.emit()"
            aria-label="Close offer details"
          >
            ✕
          </button>
        </div>

        <p class="error-message">This offer has expired and is no longer available.</p>

        <div class="offer-detail__actions">
          <a class="btn btn-primary" [routerLink]="['/marketplace']" (click)="closed.emit()">
            Back to marketplace
          </a>
          <button class="btn btn-ghost" type="button" (click)="closed.emit()">Cancel</button>
        </div>
      </div>
    } @else {
      <div class="offer-detail" role="dialog" aria-modal="true" aria-labelledby="offer-heading">
        <div class="offer-detail__header">
          <h2 id="offer-heading">Offer #{{ offer().id }}</h2>
          <button
            class="btn btn-ghost"
            type="button"
            (click)="closed.emit()"
            aria-label="Close offer details"
          >
            ✕
          </button>
        </div>

        <dl class="detail-list">
          <dt>Credit ID</dt>
          <dd class="mono">{{ offer().credit_id }}</dd>
          <dt>Seller</dt>
          <dd class="mono">{{ offer().seller }}</dd>
          <dt>Tonnes Available</dt>
          <dd>{{ formatTonnes(offer().tonnes_available) }}</dd>
          <dt>Payment Asset</dt>
          <dd>{{ paymentAssetLabel() }}</dd>
          <dt>Price</dt>
          <dd>{{ formatPrice(offer()) }}</dd>
          <dt>Status</dt>
          <dd>
            <span class="badge" [class]="'badge-' + offer().status">{{ offer().status }}</span>
          </dd>
        </dl>

        @if (quoteLoading()) {
          <p class="quote-loading" role="status">Loading quote…</p>
        } @else if (quote(); as q) {
          <div class="quote-panel">
            <h3>Purchase Quote</h3>
            <dl class="detail-list">
              <dt>Tonnes</dt>
              <dd>{{ formatTonnes(q.tonnes) }}</dd>
              <dt>Price per Tonne</dt>
              <dd>{{ formatQuoteAmount(q.pricePerTonne, q.paymentAssetCode) }}</dd>
              <dt>Total</dt>
              <dd class="total">{{ formatQuoteAmount(q.totalPrice, q.paymentAssetCode) }}</dd>
            </dl>
          </div>
        }

        <!-- Issue #963: transaction progress is announced, errors are alerted. -->
        <p class="status-message" role="status">{{ actionStatus() }}</p>

        @if (buyError(); as err) {
          <p class="error" role="alert">{{ err }}</p>
        }

        <div class="offer-detail__actions">
          @if (isSeller()) {
            <button
              class="btn btn-danger"
              type="button"
              [disabled]="actionBusy()"
              [attr.aria-busy]="actionBusy()"
              (click)="cancelOffer()"
            >
              {{ actionBusy() ? 'Cancelling…' : 'Cancel Offer' }}
            </button>
          } @else {
            <button
              class="btn btn-primary"
              type="button"
              [disabled]="actionBusy() || offer().status !== 'open'"
              [attr.aria-busy]="actionBusy()"
              (click)="executeBuy()"
            >
              {{ actionBusy() ? 'Signing…' : 'Buy — Sign with Wallet' }}
            </button>
          }
          <button class="btn btn-ghost" type="button" (click)="closed.emit()">Close</button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .offer-detail {
        background: #fff;
        border: 1px solid #d0d0d0;
        border-radius: 8px;
        padding: 1.5rem;
        max-width: 480px;
      }
      .offer-detail__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
      }
      h2 {
        margin: 0;
      }
      .detail-list {
        display: grid;
        grid-template-columns: 140px 1fr;
        gap: 0.4rem 1rem;
        margin: 0 0 1.5rem;
      }
      dt {
        font-weight: 600;
        color: #404040;
      }
      dd {
        margin: 0;
      }
      .mono {
        font-family: monospace;
        word-break: break-all;
      }
      .badge {
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
      }
      .badge-open {
        background: #e8f5e9;
        color: #1b5e20;
      }
      .badge-filled {
        background: #e3f2fd;
        color: #0d47a1;
      }
      .badge-cancelled {
        background: #fce4ec;
        color: #a31515;
      }
      .quote-panel {
        background: #f5f5f5;
        border-radius: 6px;
        padding: 1rem;
        margin-bottom: 1rem;
      }
      .quote-panel h3 {
        margin: 0 0 0.5rem;
        font-size: 0.95rem;
        color: #1a1a1a;
      }
      .total {
        font-weight: 700;
        color: #1b5e20;
      }
      /* Issue #963: #888 was 3.5:1 on white — below AA for body text. */
      .quote-loading {
        color: #595959;
        font-size: 0.85rem;
      }
      .status-message {
        color: #1b5e20;
        font-size: 0.85rem;
        font-weight: 500;
        min-height: 1.2em;
      }
      .offer-detail__actions {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
      }
      .error-message,
      .error {
        color: #a31515;
        font-size: 0.85rem;
        font-weight: 500;
        margin-bottom: 0.5rem;
      }
      .btn {
        padding: 0.5rem 1.2rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.9rem;
      }
      .btn:focus-visible {
        outline: 3px solid #1b5e20;
        outline-offset: 2px;
      }
      .btn-primary {
        background: #2e7d32;
        color: #fff;
      }
      .btn-primary:disabled {
        background: #9c9c9c;
        cursor: not-allowed;
      }
      .btn-danger {
        background: #c62828;
        color: #fff;
      }
      .btn-danger:disabled {
        background: #a8a8a8;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid #767676;
        color: #262626;
      }
    `,
  ],
})
export class OfferDetailComponent implements OnInit {
  readonly offer = input.required<Offer>();
  readonly errorCode = input<number | null>(null);
  readonly closed = output<void>();
  readonly buy = output<Offer>();
  readonly cancelled = output<Offer>();

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly wallet = inject(StellarWalletService);

  readonly quote = signal<BuyQuote | null>(null);
  readonly quoteLoading = signal(false);
  readonly actionBusy = signal(false);
  readonly buyError = signal<string | null>(null);
  /** Issue #963 — polite live region for sign/submit progress. */
  readonly actionStatus = signal('');

  /** True when the contract rejected the offer as expired (code 309 / HTTP 410). */
  readonly expired = () => this.errorCode() === OFFER_EXPIRED_ERROR_CODE;

  ngOnInit(): void {
    void this.loadQuote();
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t';
  }

  private async loadQuote(): Promise<void> {
    this.quoteLoading.set(true);
    try {
      const q = await firstValueFrom(this.api.getBuyQuote(Number(this.offer().id)));
      this.quote.set(q);
    } catch {
      // Quote unavailable — non-fatal
    } finally {
      this.quoteLoading.set(false);
    }
  }

  isSeller(): boolean {
    return this.offer().seller === this.wallet.publicKey();
  }

  paymentAssetLabel(): string {
    const o = this.offer();
    const code = o.payment_asset_code ?? 'XLM';
    const issuer = o.payment_asset_issuer;
    return issuer ? `${code} (${issuer.slice(0, 8)}…)` : code;
  }

  formatPrice(offer: Offer): string {
    const code = offer.payment_asset_code ?? 'XLM';
    const raw = offer.price_raw ?? offer.price_xlm;
    if (code === 'XLM') {
      return (
        (Number(raw) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' XLM'
      );
    }
    // For SAC/USDC tokens, assume 7 decimal places (Stellar standard)
    return (
      (Number(raw) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 7 }) +
      ` ${code}`
    );
  }

  formatQuoteAmount(amount: string, assetCode: string): string {
    return (
      (Number(amount) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 7 }) +
      ` ${assetCode}`
    );
  }

  /**
   * Buy the offer: fetch a fresh unsigned XDR, have the wallet sign it, submit.
   *
   * Issue #960 — each step is a point where the envelope can go stale. A
   * `staleEnvelope` from either the wallet or the submit call is retried once
   * with a completely rebuilt XDR, which is the recovery path for the nonce
   * races in issues #57/#59. Every other failure type gets its own message and
   * is never retried.
   */
  async executeBuy(): Promise<void> {
    this.actionBusy.set(true);
    this.buyError.set(null);
    this.actionStatus.set('Preparing your purchase…');

    const offerId = Number(this.offer().id);
    const publicKey = this.wallet.publicKey();
    const token = this.auth.token();

    if (!publicKey || !token) {
      this.buyError.set('Wallet not connected or not authenticated.');
      this.actionStatus.set('');
      this.actionBusy.set(false);
      return;
    }

    try {
      await this.signAndSubmit(publicKey, token);
      this.actionStatus.set('Purchase submitted.');
    } catch (err) {
      const error = normalizeWalletError(err);

      if (error.type === 'staleEnvelope') {
        // The XDR we signed is gone (or its sequence number lost a race).
        // Rebuild it from scratch and prompt the wallet exactly once more.
        this.actionStatus.set(WALLET_ERROR_MESSAGES.staleEnvelope);
        try {
          await this.signAndSubmit(publicKey, token);
          this.actionStatus.set('Purchase submitted.');
          return;
        } catch (retryErr) {
          this.fail(retryErr);
          return;
        }
      }

      this.fail(error);
    } finally {
      this.actionBusy.set(false);
    }
  }

  /** One full sign-and-submit cycle against a freshly built envelope. */
  private async signAndSubmit(publicKey: string, token: string): Promise<void> {
    const offerId = Number(this.offer().id);
    this.actionStatus.set('Waiting for your wallet…');
    const { xdr } = await firstValueFrom(this.api.getBuyOfferXdr(offerId, publicKey, token));
    const signedXdr = await this.wallet.signTransaction(xdr);
    this.actionStatus.set('Submitting purchase…');
    await firstValueFrom(this.api.buyOffer(offerId, publicKey, signedXdr, token));
    this.buy.emit(this.offer());
  }

  /** Issue #960 — a typed, actionable message; a cancellation is not a failure. */
  private fail(err: unknown): void {
    const error = normalizeWalletError(err);
    this.buyError.set(error.displayMessage);
    this.actionStatus.set('');
  }

  async cancelOffer(): Promise<void> {
    this.actionBusy.set(true);
    this.buyError.set(null);
    this.actionStatus.set('Cancelling offer…');
    const offerId = Number(this.offer().id);
    const seller = this.offer().seller;
    const token = this.auth.token();
    if (!token) {
      this.buyError.set('Not authenticated.');
      this.actionStatus.set('');
      this.actionBusy.set(false);
      return;
    }
    try {
      await firstValueFrom(this.api.cancelOffer(offerId, seller, token));
      this.actionStatus.set('Offer cancelled.');
      this.cancelled.emit(this.offer());
    } catch (err) {
      this.fail(err);
    } finally {
      this.actionBusy.set(false);
    }
  }
}
