import { Component, inject, OnInit, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Offer } from '@shared';
import { ApiService } from '../core/services/api.service';
import { TranslationService } from '../core/services/translation.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { firstValueFrom } from 'rxjs';
import { signal, computed } from '@angular/core';

@Component({
  selector: 'app-marketplace-list',
  standalone: true,
  imports: [CommonModule, TranslatePipe],
  template: `
    <div class="listings">
      <div class="listings__toolbar">
        <h2>{{ 'marketList.title' | translate }}</h2>
        <button class="btn btn-primary" (click)="load()" [disabled]="isLoading()">
          {{ (isLoading() ? 'marketList.loading' : 'marketList.refresh') | translate }}
        </button>
      </div>

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      } @else if (isLoading()) {
        <p class="status">{{ 'marketList.loadingListings' | translate }}</p>
      } @else if (offers().length === 0) {
        <p class="status">{{ 'marketList.noListings' | translate }}</p>
      } @else {
        <table class="offer-table" [attr.aria-label]="'marketList.tableAria' | translate">
          <thead>
            <tr>
              <th scope="col">{{ 'marketList.col.id' | translate }}</th>
              <th scope="col">{{ 'marketList.col.credit' | translate }}</th>
              <th scope="col">{{ 'marketList.col.seller' | translate }}</th>
              <th scope="col">{{ 'marketList.col.tonnes' | translate }}</th>
              <th scope="col">{{ 'marketList.col.price' | translate }}</th>
              <th scope="col">{{ 'marketList.col.action' | translate }}</th>
            </tr>
          </thead>
          <tbody>
            @for (offer of offers(); track offer.id) {
              <tr class="offer-row" (click)="offerSelected.emit(offer)" style="cursor:pointer">
                <td class="mono">{{ offer.id }}</td>
                <td class="mono">{{ offer.credit_id | slice: 0 : 12 }}…</td>
                <td class="mono">{{ offer.seller | slice: 0 : 8 }}…</td>
                <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                <td>{{ formatXlm(offer.price_xlm) }}</td>
                <td>
                  <button
                    class="btn btn-sm btn-primary"
                    (click)="$event.stopPropagation(); offerSelected.emit(offer)"
                  >
                    {{ 'marketList.view' | translate }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    </div>
  `,
  styles: [
    `
      .listings {
        width: 100%;
      }
      .listings__toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
      }
      h2 {
        margin: 0;
      }
      .status {
        color: #888;
      }
      .error {
        color: #e53935;
      }
      .offer-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }
      .offer-table th,
      .offer-table td {
        padding: 0.6rem 0.8rem;
        border-bottom: 1px solid #eee;
        text-align: left;
      }
      .offer-table th {
        background: #f5f5f5;
        font-weight: 600;
      }
      .offer-row:hover {
        background: #f9f9f9;
      }
      .mono {
        font-family: monospace;
      }
      .btn {
        padding: 0.4rem 1rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.85rem;
      }
      .btn-primary {
        background: #4caf50;
        color: #fff;
      }
      .btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .btn-sm {
        padding: 0.25rem 0.6rem;
        font-size: 0.8rem;
      }
    `,
  ],
})
export class MarketplaceListComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly i18n = inject(TranslationService);

  readonly offerSelected = output<Offer>();

  protected readonly offers = signal<Offer[]>([]);
  protected readonly isLoading = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const listings = await firstValueFrom(this.api.getListings());
      this.offers.set(listings);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : this.i18n.t('marketList.loadError'));
    } finally {
      this.isLoading.set(false);
    }
  }

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
