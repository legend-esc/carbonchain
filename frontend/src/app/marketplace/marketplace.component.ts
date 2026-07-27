import { Component, inject, signal, computed, OnInit, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Offer } from '@shared';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ToastService } from '../core/services/toast.service';
import { ConnectWalletComponent } from '../core/components/connect-wallet.component';
import { TranslatePipe } from '../core/pipes/translate.pipe';

interface FilterState {
  methodology: string;
  geography: string;
  vintageYear: string;
  minTonnes: string;
  maxTonnes: string;
}

@Component({
  selector: 'app-marketplace',
  standalone: true,
  imports: [CommonModule, FormsModule, ConnectWalletComponent, TranslatePipe],
  template: `
    <div class="marketplace">
      <h1>{{ 'marketplace.title' | translate }}</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>{{ 'marketplace.walletPrompt' | translate }}</p>
          <app-connect-wallet />
        </div>
      } @else {
        <!-- Filter controls -->
        <section class="filters" aria-label="Filter marketplace listings">
          <div class="filters__grid">
            <label class="filter-field" for="filter-methodology">
              <span>Methodology</span>
              <select
                id="filter-methodology"
                [(ngModel)]="filters.methodology"
                (ngModelChange)="applyFilters()"
                aria-label="Filter by methodology"
              >
                <option value="">All methodologies</option>
                @for (m of methodologies; track m) {
                  <option [value]="m">{{ m }}</option>
                }
              </select>
            </label>

            <label class="filter-field" for="filter-geography">
              <span>Geography</span>
              <input
                id="filter-geography"
                type="text"
                placeholder="e.g. NG, BR, US"
                [(ngModel)]="filters.geography"
                (ngModelChange)="applyFilters()"
                aria-label="Filter by geography"
              />
            </label>

            <label class="filter-field" for="filter-vintage">
              <span>Vintage Year</span>
              <input
                id="filter-vintage"
                type="number"
                placeholder="e.g. 2024"
                [(ngModel)]="filters.vintageYear"
                (ngModelChange)="applyFilters()"
                aria-label="Filter by vintage year"
              />
            </label>

            <label class="filter-field" for="filter-min-tonnes">
              <span>Min Tonnes</span>
              <input
                id="filter-min-tonnes"
                type="number"
                placeholder="e.g. 1"
                [(ngModel)]="filters.minTonnes"
                (ngModelChange)="applyFilters()"
                aria-label="Filter by minimum tonnes"
                min="0"
              />
            </label>

            <label class="filter-field" for="filter-max-tonnes">
              <span>Max Tonnes</span>
              <input
                id="filter-max-tonnes"
                type="number"
                placeholder="e.g. 1000"
                [(ngModel)]="filters.maxTonnes"
                (ngModelChange)="applyFilters()"
                aria-label="Filter by maximum tonnes"
                min="0"
              />
            </label>

            <button
              class="btn btn-outline filter-reset"
              type="button"
              (click)="resetFilters()"
              [disabled]="!hasActiveFilters()"
              aria-label="Reset all filters"
            >
              Reset Filters
            </button>
          </div>
        </section>

        <!-- Loading skeleton (initial load) -->
        @if (isLoading() && visibleOffers().length === 0) {
          <div class="skeleton-wrapper" aria-busy="true" aria-label="Loading listings">
            @for (i of skeletonRows; track i) {
              <div class="skeleton-row">
                <div class="skeleton-cell wide"></div>
                <div class="skeleton-cell"></div>
                <div class="skeleton-cell narrow"></div>
                <div class="skeleton-cell"></div>
                <div class="skeleton-cell narrow"></div>
                <div class="skeleton-cell narrow"></div>
                <div class="skeleton-cell narrow"></div>
                <div class="skeleton-cell narrow"></div>
              </div>
            }
          </div>
        } @else if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        } @else if (visibleOffers().length === 0) {
          <p class="status">No active listings.</p>
        } @else {
          <table class="offer-table" aria-label="Marketplace listings">
            <thead>
              <tr>
                <th scope="col">Credit ID</th>
                <th scope="col">Project</th>
                <th scope="col">Vintage</th>
                <th scope="col">Methodology</th>
                <th scope="col">Tonnes</th>
                <th scope="col">Price</th>
                <th scope="col">Asset</th>
                <th scope="col">Status</th>
                <th scope="col">
                  Action
                  <label class="asset-picker-inline" for="global-asset-picker">
                    <select
                      id="global-asset-picker"
                      aria-label="Select payment asset"
                      (change)="onAssetChange($event)"
                    >
                      @for (a of paymentAssets; track a.label) {
                        <option [value]="a.label">{{ a.label }}</option>
                      }
                    </select>
                  </label>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (offer of visibleOffers(); track offer.id) {
                <tr class="offer-row">
                  <td class="mono">{{ offer.credit_id | slice: 0 : 12 }}…</td>
                  <td>{{ offer.credit_id | slice: 0 : 8 }}</td>
                  <td>—</td>
                  <td>{{ offer.methodology ?? '—' }}</td>
                  <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                  <td>{{ formatPrice(offer) }}</td>
                  <td>
                    <span class="badge badge-asset">{{ offer.price_asset_label ?? 'XLM' }}</span>
                  </td>
                  <td>
                    <span class="badge" [class]="'badge-' + offer.status">{{ offer.status }}</span>
                  </td>
                  <td>
                    <button
                      class="btn btn-sm btn-primary"
                      type="button"
                      [disabled]="offer.status !== 'open' || buying() === offer.id"
                      (click)="buy(offer)"
                      [attr.aria-label]="'Buy credit ' + offer.credit_id"
                      [attr.aria-busy]="buying() === offer.id"
                    >
                      {{ buying() === offer.id ? 'Buying…' : 'Buy' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>

          <!-- Infinite scroll sentinel + Load More button -->
          <div class="load-more-area" aria-live="polite">
            @if (isLoadingMore()) {
              <div class="spinner" role="status" aria-label="Loading more listings">
                <span class="spinner-dot"></span>
                <span class="spinner-dot"></span>
                <span class="spinner-dot"></span>
              </div>
            } @else if (hasMore()) {
              <button
                class="btn btn-outline load-more-btn"
                type="button"
                (click)="loadMore()"
                aria-label="Load more listings"
              >
                Load More ({{ visibleOffers().length }} loaded)
              </button>
            } @else {
              <p class="end-of-list">
                All {{ visibleOffers().length }} listing{{ visibleOffers().length === 1 ? '' : 's' }} loaded
              </p>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .marketplace {
        max-width: 1100px;
        margin: 0 auto;
        padding: 1.5rem 1rem;
      }
      h1 {
        margin-bottom: 1.5rem;
      }
      .auth-prompt {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        align-items: flex-start;
      }

      /* Filters */
      .filters {
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 1rem 1.25rem;
        margin-bottom: 1.25rem;
      }
      .filters__grid {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem;
        align-items: flex-end;
      }
      .filter-field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        font-weight: 500;
        min-width: 130px;
      }
      .filter-field input,
      .filter-field select {
        padding: 0.4rem 0.6rem;
        border: 1px solid #ccc;
        border-radius: 6px;
        font-size: 0.9rem;
        background: #fff;
      }
      .filter-reset {
        align-self: flex-end;
      }

      /* Skeleton */
      .skeleton-wrapper {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        margin-top: 0.5rem;
      }
      .skeleton-row {
        display: flex;
        gap: 0.75rem;
        padding: 0.6rem 0;
        border-bottom: 1px solid #eee;
      }
      .skeleton-cell {
        height: 16px;
        flex: 1;
        background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%);
        background-size: 200% 100%;
        animation: shimmer 1.4s infinite;
        border-radius: 4px;
      }
      .skeleton-cell.wide { flex: 2; }
      .skeleton-cell.narrow { flex: 0.5; }
      @keyframes shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }

      /* Table */
      .status { color: #888; }
      .error { color: #e53935; font-weight: 500; }
      .offer-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.9rem;
      }
      .offer-table th,
      .offer-table td {
        padding: 0.65rem 0.8rem;
        border-bottom: 1px solid #eee;
        text-align: left;
      }
      .offer-table th {
        background: #f5f5f5;
        font-weight: 600;
        white-space: nowrap;
      }
      .offer-row:hover { background: #fafafa; }
      .mono { font-family: monospace; }
      .badge {
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
        font-size: 0.75rem;
        text-transform: uppercase;
        font-weight: 600;
      }
      .badge-open   { background: #e8f5e9; color: #2e7d32; }
      .badge-filled { background: #e3f2fd; color: #1565c0; }
      .badge-cancelled { background: #fce4ec; color: #c62828; }
      .badge-asset  { background: #f3e5f5; color: #6a1b9a; }

      /* Load More / Infinite scroll */
      .load-more-area {
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 1.5rem 0;
        min-height: 56px;
      }
      .load-more-btn {
        min-width: 200px;
      }
      .end-of-list {
        font-size: 0.85rem;
        color: #999;
        margin: 0;
      }
      .spinner {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .spinner-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #4caf50;
        animation: bounce 1s infinite ease-in-out;
      }
      .spinner-dot:nth-child(2) { animation-delay: 0.15s; }
      .spinner-dot:nth-child(3) { animation-delay: 0.3s; }
      @keyframes bounce {
        0%, 80%, 100% { transform: scale(0.7); opacity: 0.5; }
        40% { transform: scale(1); opacity: 1; }
      }

      /* Buttons */
      .btn {
        padding: 0.45rem 1.1rem;
        border-radius: 6px;
        cursor: pointer;
        border: none;
        font-size: 0.9rem;
        font-weight: 500;
      }
      .btn:focus-visible {
        outline: 2px solid #4caf50;
        outline-offset: 2px;
      }
      .btn-primary { background: #4caf50; color: #fff; }
      .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
      .btn-outline {
        background: transparent;
        border: 1px solid #ccc;
        color: #333;
      }
      .btn-outline:disabled { opacity: 0.4; cursor: not-allowed; }
      .btn-sm { padding: 0.25rem 0.65rem; font-size: 0.8rem; }

      /* Inline asset picker in table header */
      .asset-picker-inline {
        display: inline-flex;
        align-items: center;
        margin-left: 0.4rem;
        font-weight: 400;
        font-size: 0.75rem;
      }
      .asset-picker-inline select {
        padding: 0.15rem 0.3rem;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 0.75rem;
        background: #fff;
        cursor: pointer;
      }
    `,
  ],
})
export class MarketplaceComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly PAGE_SIZE = 20;
  readonly skeletonRows = [1, 2, 3, 4, 5];
  readonly methodologies = ['REDD+', 'VCS', 'Gold Standard', 'CDM', 'Plan Vivo', 'Custom'];

  /** Payment assets available in the asset picker when buying a credit. */
  readonly paymentAssets = [
    { label: 'XLM',  type: 'native' as const, address: null },
    { label: 'USDC', type: 'asset'  as const, address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75' },
    { label: 'EURC', type: 'asset'  as const, address: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP' },
  ];

  filters: FilterState = {
    methodology: '',
    geography: '',
    vintageYear: '',
    minTonnes: '',
    maxTonnes: '',
  };

  /** Selected payment asset for the Buy action. Defaults to XLM. */
  readonly selectedPaymentAsset = signal(this.paymentAssets[0]);

  /** All offers loaded so far (accumulated across cursor pages). */
  readonly visibleOffers = signal<Offer[]>([]);
  readonly isLoading = signal(false);
  /** True while loading additional pages after the first. */
  readonly isLoadingMore = signal(false);
  readonly error = signal<string | null>(null);
  readonly buying = signal<string | null>(null);
  /** Cursor for the next page; null means no more results. */
  private nextCursor: string | null = null;

  readonly hasMore = computed(() => this.nextCursor !== null);

  readonly hasActiveFilters = computed(() => {
    const f = this.filters;
    return !!(f.methodology || f.geography || f.vintageYear || f.minTonnes || f.maxTonnes);
  });

  async ngOnInit(): Promise<void> {
    if (this.auth.isAuthenticated()) {
      await this.load();
    }
  }

  /** Load (or reload) the first page of results, resetting state. */
  async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    this.nextCursor = null;
    this.visibleOffers.set([]);

    try {
      const result = await firstValueFrom(
        this.api.getListingsCursor(this.buildParams()),
      );
      this.visibleOffers.set(result.data);
      this.nextCursor = result.next_cursor ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load listings.';
      this.error.set(msg);
      this.toast.show(msg, 'error');
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Append the next cursor page to the visible list. */
  async loadMore(): Promise<void> {
    if (!this.nextCursor || this.isLoadingMore()) return;
    this.isLoadingMore.set(true);

    try {
      const result = await firstValueFrom(
        this.api.getListingsCursor({
          ...this.buildParams(),
          cursor: this.nextCursor,
        }),
      );
      this.visibleOffers.update((prev) => [...prev, ...result.data]);
      this.nextCursor = result.next_cursor ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load more listings.';
      this.toast.show(msg, 'error');
    } finally {
      this.isLoadingMore.set(false);
    }
  }

  applyFilters(): void {
    // Reset to first page on filter change
    void this.load();
  }

  resetFilters(): void {
    this.filters = {
      methodology: '',
      geography: '',
      vintageYear: '',
      minTonnes: '',
      maxTonnes: '',
    };
    void this.load();
  }

  onAssetChange(event: Event): void {
    const label = (event.target as HTMLSelectElement).value;
    const found = this.paymentAssets.find((a) => a.label === label);
    if (found) this.selectedPaymentAsset.set(found);
  }

  async buy(offer: Offer): Promise<void> {
    const pk = this.wallet.publicKey();
    if (!pk) {
      this.toast.show('Please connect your wallet first.', 'error');
      return;
    }

    this.buying.set(offer.id);
    try {
      const { networkPassphrase } = await this.wallet.getNetworkDetails();
      // The buy flow: build a transaction XDR client-side then sign via Freighter.
      await firstValueFrom(
        this.api.createOffer(
          {
            sellerPublicKey: offer.seller,
            creditId: offer.credit_id,
            priceXlm: offer.price_xlm,
            tonnes: offer.tonnes_available,
          },
          this.auth.token() ?? '',
        ),
      );
      this.toast.show('Purchase submitted successfully!', 'success');
      await this.load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Purchase failed.';
      this.toast.show(msg, 'error');
    } finally {
      this.buying.set(null);
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

  /**
   * Format the price field for any asset type.
   * Offers may have price_xlm (legacy) or price_amount + price_asset (new).
   */
  formatPrice(offer: Offer): string {
    if ((offer as any).price_amount !== undefined) {
      const amount = Number((offer as any).price_amount) / 10_000_000;
      return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }
    // Legacy XLM-only offer
    return this.formatXlm(offer.price_xlm);
  }

  private buildParams(): Record<string, string> {
    const p: Record<string, string> = { limit: String(this.PAGE_SIZE) };
    if (this.filters.methodology) p['methodology'] = this.filters.methodology;
    if (this.filters.geography) p['geography'] = this.filters.geography;
    if (this.filters.vintageYear) p['vintage_year'] = this.filters.vintageYear;
    if (this.filters.minTonnes) p['min_tonnes'] = this.filters.minTonnes;
    if (this.filters.maxTonnes) p['max_tonnes'] = this.filters.maxTonnes;
    return p;
  }
}
