import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Offer } from '@shared';
import { RouterModule } from '@angular/router';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-offer-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, TranslatePipe],
  template: `
    @if (expired()) {
      <div class="offer-detail" role="alert" [attr.aria-label]="'offer.expiredAria' | translate">
        <div class="offer-detail__header">
          <h2>{{ 'offer.expiredTitle' | translate }}</h2>
          <button
            class="btn btn-ghost"
            (click)="closed.emit()"
            [attr.aria-label]="'offer.close' | translate"
          >
            ✕
          </button>
        </div>

        <p class="error-message">{{ 'offer.expiredMessage' | translate }}</p>

        <div class="offer-detail__actions">
          <a class="btn btn-primary" [routerLink]="['/marketplace']" (click)="closed.emit()">
            {{ 'offer.backToMarketplace' | translate }}
          </a>
          <button class="btn btn-ghost" (click)="closed.emit()">
            {{ 'offer.cancel' | translate }}
          </button>
        </div>
      </div>
    } @else {
      <div class="offer-detail" role="dialog" [attr.aria-label]="'offer.detailAria' | translate">
        <div class="offer-detail__header">
          <h2>{{ 'offer.title' | translate: { id: offer().id } }}</h2>
          <button
            class="btn btn-ghost"
            (click)="closed.emit()"
            [attr.aria-label]="'offer.close' | translate"
          >
            ✕
          </button>
        </div>

        <dl class="detail-list">
          <dt>{{ 'offer.col.creditId' | translate }}</dt>
          <dd class="mono">{{ offer().credit_id }}</dd>
          <dt>{{ 'offer.col.seller' | translate }}</dt>
          <dd class="mono">{{ offer().seller }}</dd>
          <dt>{{ 'offer.col.tonnes' | translate }}</dt>
          <dd>{{ formatTonnes(offer().tonnes_available) }}</dd>
          <dt>{{ 'offer.col.price' | translate }}</dt>
          <dd>{{ formatXlm(offer().price_xlm) }}</dd>
          <dt>{{ 'offer.col.status' | translate }}</dt>
          <dd>
            <span class="badge badge-open">{{ offer().status }}</span>
          </dd>
        </dl>

        <div class="offer-detail__actions">
          <button class="btn btn-primary" (click)="buy.emit(offer())">
            {{ 'offer.buy' | translate }}
          </button>
          <button class="btn btn-ghost" (click)="closed.emit()">
            {{ 'offer.cancel' | translate }}
          </button>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .offer-detail {
        background: #fff;
        border: 1px solid #e0e0e0;
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
        margin-bottom: 1.5rem;
      }
      dt {
        font-weight: 600;
        color: #555;
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
      }
      .badge-open {
        background: #e8f5e9;
        color: #2e7d32;
      }
      .offer-detail__actions {
        display: flex;
        gap: 0.75rem;
      }
      .btn {
        padding: 0.5rem 1.2rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.9rem;
      }
      .btn-primary {
        background: #4caf50;
        color: #fff;
      }
      .btn-ghost {
        background: transparent;
        border: 1px solid #ccc;
      }
    `,
  ],
})
export class OfferDetailComponent {
  readonly offer = input.required<Offer>();
  readonly errorCode = input<number | null>(null);
  readonly closed = output<void>();
  readonly buy = output<Offer>();

  protected readonly expired = () => this.errorCode() === 123;

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t';
  }

  formatXlm(stroops: string): string {
    return (
      (Number(stroops) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) +
      ' XLM'
    );
  }
}
