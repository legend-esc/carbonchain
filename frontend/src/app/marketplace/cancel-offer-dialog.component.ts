import { Component, computed, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Offer } from '@shared';

/** Base Stellar transaction fee per operation (100 stroops). */
const BASE_FEE_STROOPS = 100;
/** Default estimated Soroban resource fee for offer cancellation (stroops). */
const DEFAULT_RESOURCE_FEE_STROOPS = 100_000;

@Component({
  selector: 'app-cancel-offer-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="cancel-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cancel-offer-heading"
    >
      <h2 id="cancel-offer-heading">Cancel Marketplace Offer</h2>

      <div class="warning-banner" role="alert">
        <strong>Escrow Return Notice:</strong> Cancelling this offer will close the listing and
        return the escrowed carbon credits to your Stellar wallet.
      </div>

      <dl class="detail-list">
        <dt>Offer ID</dt>
        <dd class="mono">#{{ offer().id }}</dd>

        <dt>Returning Credit ID</dt>
        <dd class="mono">{{ offer().credit_id }}</dd>

        <dt>Escrowed Tonnes</dt>
        <dd>{{ formatTonnes(offer().tonnes_available) }}</dd>

        <dt>Listed Price</dt>
        <dd>{{ formatPrice(offer()) }}</dd>
      </dl>

      <section class="fee-breakdown" aria-label="Estimated network gas fee breakdown">
        <h3>Estimated Network Gas Fee</h3>
        <dl class="fee-list">
          <dt>Base Network Fee</dt>
          <dd>{{ formatXlm(baseFeeStroops) }} ({{ baseFeeStroops }} stroops)</dd>

          <dt>Estimated Resource Fee</dt>
          <dd>
            {{ formatXlm(resourceFeeStroops()) }} ({{ resourceFeeStroops() | number }} stroops)
          </dd>

          <dt class="total-label">Total Estimated Fee</dt>
          <dd class="total-value">
            {{ formatXlm(totalFeeStroops()) }} ({{ totalFeeStroops() | number }} stroops)
          </dd>
        </dl>
      </section>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }

      <div class="actions">
        <button class="btn btn-ghost" type="button" [disabled]="busy()" (click)="cancelled.emit()">
          Keep Offer
        </button>
        <button
          class="btn btn-danger"
          type="button"
          [disabled]="busy()"
          [attr.aria-busy]="busy()"
          (click)="confirmed.emit(offer())"
        >
          {{ busy() ? 'Cancelling…' : 'Confirm Cancellation' }}
        </button>
      </div>
    </div>
  `,
  styles: [
    `
      .cancel-dialog {
        background: #fff;
        border-radius: 8px;
        padding: 1.5rem;
        max-width: 480px;
        width: 100%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
      }
      h2 {
        margin: 0 0 1rem;
        font-size: 1.2rem;
      }
      .warning-banner {
        background: #fff8e1;
        border: 1px solid #ffe082;
        border-radius: 6px;
        padding: 0.75rem 1rem;
        color: #6d4c00;
        font-size: 0.9rem;
        margin-bottom: 1rem;
        line-height: 1.4;
      }
      .detail-list,
      .fee-list {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.4rem 1rem;
        margin: 0 0 1rem;
        font-size: 0.9rem;
      }
      dt {
        color: #555;
        font-weight: 600;
      }
      dd {
        margin: 0;
        text-align: right;
        word-break: break-all;
      }
      .mono {
        font-family: monospace;
      }
      .fee-breakdown {
        background: #f8faf9;
        border: 1px solid #e0e7e3;
        border-radius: 6px;
        padding: 0.85rem 1rem;
        margin-bottom: 1rem;
      }
      .fee-breakdown h3 {
        margin: 0 0 0.6rem;
        font-size: 0.95rem;
        color: #1b5e20;
      }
      .fee-list {
        margin-bottom: 0;
      }
      .total-label,
      .total-value {
        border-top: 1px solid #dce3df;
        padding-top: 0.45rem;
        margin-top: 0.2rem;
        font-weight: 700;
        color: #111;
      }
      .error {
        color: #b71c1c;
        background: #ffebee;
        border-radius: 4px;
        padding: 0.5rem 0.75rem;
        font-size: 0.875rem;
        margin: 0 0 1rem;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.75rem;
      }
      .btn {
        padding: 0.5rem 1rem;
        border-radius: 6px;
        border: 1px solid transparent;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.9rem;
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-ghost {
        background: #f5f5f5;
        color: #333;
        border-color: #ddd;
      }
      .btn-danger {
        background: #c62828;
        color: #fff;
      }
    `,
  ],
})
export class CancelOfferDialogComponent {
  readonly offer = input.required<Offer>();
  readonly estimatedResourceFeeStroops = input<number>(DEFAULT_RESOURCE_FEE_STROOPS);
  readonly busy = input<boolean>(false);
  readonly error = input<string | null>(null);

  readonly confirmed = output<Offer>();
  readonly cancelled = output<void>();

  readonly baseFeeStroops = BASE_FEE_STROOPS;
  readonly resourceFeeStroops = computed(() => this.estimatedResourceFeeStroops());
  readonly totalFeeStroops = computed(() => this.baseFeeStroops + this.resourceFeeStroops());

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t';
  }

  formatXlm(stroops: number): string {
    return (
      (stroops / 10_000_000).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 5,
      }) + ' XLM'
    );
  }

  formatPrice(offer: Offer): string {
    const raw = offer.price_amount ?? offer.price_xlm;
    const amount = Number(raw) / 10_000_000;
    const asset = offer.price_asset_label ?? 'XLM';
    return `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${asset}`;
  }
}
