import { Component, input, output, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Offer, BuyQuote } from '@shared';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { firstValueFrom } from 'rxjs';
import { Offer } from '@shared';
import { RouterModule } from '@angular/router';

@Component({
  selector: 'app-offer-detail',
  standalone: true,
  imports: [CommonModule, RouterModule],
  template: `
    @if (expired()) {
      <div class="offer-detail" role="alert" aria-label="Expired offer">
        <div class="offer-detail__header">
          <h2>Offer Expired</h2>
          <button class="btn btn-ghost" (click)="closed.emit()" aria-label="Close">✕</button>
        </div>

        <p class="error-message">This offer has expired</p>

        <div class="offer-detail__actions">
          <a class="btn btn-primary" [routerLink]="['/marketplace']" (click)="closed.emit()">
            Back to marketplace
          </a>
          <button class="btn btn-ghost" (click)="closed.emit()">Cancel</button>
        </div>
      </div>
    } @else {
      <div class="offer-detail" role="dialog" aria-label="Offer detail">
        <div class="offer-detail__header">
          <h2>Offer #{{ offer().id }}</h2>
          <button class="btn btn-ghost" (click)="closed.emit()" aria-label="Close">✕</button>
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
        <dd><span class="badge badge-open">{{ offer().status }}</span></dd>
      </dl>

      @if (quoteLoading()) {
        <p class="quote-loading">Loading quote…</p>
      } @else if (quote()) {
        <div class="quote-panel">
          <h3>Purchase Quote</h3>
          <dl class="detail-list">
            <dt>Tonnes</dt>
            <dd>{{ formatTonnes(quote()!.tonnes) }}</dd>
            <dt>Price per Tonne</dt>
            <dd>{{ formatQuoteAmount(quote()!.pricePerTonne, quote()!.paymentAssetCode) }}</dd>
            <dt>Total</dt>
            <dd class="total">{{ formatQuoteAmount(quote()!.totalPrice, quote()!.paymentAssetCode) }}</dd>
          </dl>
        </div>
      }

      @if (buyError()) {
        <p class="error" role="alert">{{ buyError() }}</p>
      }

      <div class="offer-detail__actions">
        @if (isSeller()) {
          <button class="btn btn-danger" [disabled]="actionBusy()" (click)="cancelOffer()">
            {{ actionBusy() ? 'Cancelling…' : 'Cancel Offer' }}
          </button>
        } @else {
          <button class="btn btn-primary" [disabled]="actionBusy() || offer().status !== 'open'" (click)="executeBuy()">
            {{ actionBusy() ? 'Signing…' : 'Buy — Sign with Wallet' }}
          </button>
        }
        <button class="btn btn-ghost" (click)="closed.emit()">Close</button>
        <dl class="detail-list">
          <dt>Credit ID</dt>
          <dd class="mono">{{ offer().credit_id }}</dd>
          <dt>Seller</dt>
          <dd class="mono">{{ offer().seller }}</dd>
          <dt>Tonnes Available</dt>
          <dd>{{ formatTonnes(offer().tonnes_available) }}</dd>
          <dt>Price</dt>
          <dd>{{ formatXlm(offer().price_xlm) }}</dd>
          <dt>Status</dt>
          <dd>
            <span class="badge badge-open">{{ offer().status }}</span>
          </dd>
        </dl>

        <div class="offer-detail__actions">
          <button class="btn btn-primary" (click)="buy.emit(offer())">Buy Credit</button>
          <button class="btn btn-ghost" (click)="closed.emit()">Cancel</button>
        </div>
      </div>
    }
  `,
  styles: [`
    .offer-detail { background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.5rem; max-width: 480px; }
    .offer-detail__header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; }
    h2 { margin: 0; }
    .detail-list { display: grid; grid-template-columns: 140px 1fr; gap: 0.4rem 1rem; margin-bottom: 1.5rem; }
    dt { font-weight: 600; color: #555; }
    dd { margin: 0; }
    .mono { font-family: monospace; word-break: break-all; }
    .badge { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; text-transform: uppercase; }
    .badge-open { background: #e8f5e9; color: #2e7d32; }
    .quote-panel { background: #f5f5f5; border-radius: 6px; padding: 1rem; margin-bottom: 1rem; }
    .quote-panel h3 { margin: 0 0 0.5rem; font-size: 0.95rem; color: #333; }
    .total { font-weight: 700; color: #1b5e20; }
    .quote-loading { color: #888; font-size: 0.85rem; }
    .offer-detail__actions { display: flex; gap: 0.75rem; }
    .error { color: #e53935; font-size: 0.85rem; margin-bottom: 0.5rem; }
    .btn { padding: 0.5rem 1.2rem; border-radius: 6px; cursor: pointer; border: none; font-size: 0.9rem; }
    .btn-primary { background: #4caf50; color: #fff; }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-danger { background: #e53935; color: #fff; }
    .btn-danger:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-ghost { background: transparent; border: 1px solid #ccc; }
  `],
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

  ngOnInit(): void {
    void this.loadQuote();
  protected readonly expired = () => this.errorCode() === 123;

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
        (Number(raw) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
        ' XLM'
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

  formatTonnes(raw: string): string {
    return (
      (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t'
    );
  }

  async executeBuy(): Promise<void> {
    this.actionBusy.set(true);
    this.buyError.set(null);
    const offerId = Number(this.offer().id);
    const publicKey = this.wallet.publicKey();
    const token = this.auth.token();
    if (!publicKey || !token) {
      this.buyError.set('Wallet not connected or not authenticated.');
      this.actionBusy.set(false);
      return;
    }
    try {
      const { xdr } = await firstValueFrom(
        this.api.getBuyOfferXdr(offerId, publicKey, token),
      );
      const signedXdr = await this.wallet.signTransaction(xdr);
      await firstValueFrom(this.api.buyOffer(offerId, publicKey, signedXdr, token));
      this.buy.emit(this.offer());
    } catch (err) {
      this.buyError.set(err instanceof Error ? err.message : 'Buy failed.');
    } finally {
      this.actionBusy.set(false);
    }
  }

  async cancelOffer(): Promise<void> {
    this.actionBusy.set(true);
    this.buyError.set(null);
    const offerId = Number(this.offer().id);
    const seller = this.offer().seller;
    const token = this.auth.token();
    if (!token) {
      this.buyError.set('Not authenticated.');
      this.actionBusy.set(false);
      return;
    }
    try {
      await firstValueFrom(this.api.cancelOffer(offerId, seller, token));
      this.cancelled.emit(this.offer());
    } catch (err) {
      this.buyError.set(err instanceof Error ? err.message : 'Cancel failed.');
    } finally {
      this.actionBusy.set(false);
    }
  }
}
