import { Component, inject, signal, computed, OnInit, ElementRef, viewChild } from '@angular/core';
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
import { MarketplaceStore } from '../core/store/marketplace.store';
import { MarketEventsStore } from '../core/store/market-events.store';
import { WatchlistStore, defaultOfferKey } from '../core/store/watchlist.store';
import { MarketplaceListComponent } from './marketplace-list.component';
import { OfferDetailComponent } from './offer-detail.component';
import { PriceHistoryChartComponent } from './price-history-chart.component';
import { WatchlistComponent } from './watchlist.component';

interface FilterState {
  methodology: string;
  geography: string;
  vintageYear: string;
  minTonnes: string;
  maxTonnes: string;
}

/** Focusable selector used for the dialog's focus trap (issue #963). */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

@Component({
  selector: 'app-marketplace',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ConnectWalletComponent,
    TranslatePipe,
    MarketplaceListComponent,
    OfferDetailComponent,
    PriceHistoryChartComponent,
    WatchlistComponent,
  ],
  template: `
    <div class="marketplace">
      <h1>{{ 'marketplace.title' | translate }}</h1>

      @if (!auth.isAuthenticated()) {
        <div class="auth-prompt">
          <p>{{ 'marketplace.walletPrompt' | translate }}</p>
          <app-connect-wallet />
        </div>
      } @else {
        @if (wallet.networkMismatch()) {
          <div class="network-warning" role="alert">
            ⚠ Your wallet is on the wrong network. Please switch to
            {{ wallet.expectedNetwork() }} in Freighter.
          </div>
        }

        <app-marketplace-list (offerSelected)="onOfferSelected($event)" />

        <!-- Filter controls -->
        <section class="filters" aria-label="Filter marketplace listings">
          <div class="filters__grid">
            <label class="filter-field" for="filter-methodology">
              <span>Methodology</span>
              <select
                id="filter-methodology"
                [(ngModel)]="filters.methodology"
                (ngModelChange)="applyFilters()"
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
                min="0"
              />
            </label>

            <button
              class="btn btn-outline filter-reset"
              type="button"
              (click)="resetFilters()"
              [disabled]="!hasActiveFilters()"
            >
              Reset Filters
            </button>
          </div>
        </section>

        <!-- Issue #958: watchlist + client-side target-price alerts -->
        <app-watchlist [offers]="visibleOffers()" (alertSelected)="onAlertSelected($event)" />

        <!-- Issue #958: price history fed by the indexed event log -->
        @if (historyKey()) {
          <section class="card chart-card" aria-label="Price history">
            <app-price-history-chart
              [series]="eventsStore.historyFor(historyKey()!)"
              [projectLabel]="historyKey()!"
            />
            <button class="btn btn-outline" type="button" (click)="toggleWatch(historyKey()!)">
              {{ watchlist.isWatching(historyKey()!) ? 'Stop watching' : 'Watch' }}
              {{ historyKey() }}
            </button>
          </section>
        }

        <!-- Loading skeleton (initial load) -->
        @if (isLoading() && visibleOffers().length === 0) {
          <div
            class="skeleton-wrapper"
            aria-busy="true"
            role="status"
            aria-label="Loading listings"
          >
            @for (i of skeletonRows; track i) {
              <div class="skeleton-row" aria-hidden="true">
                <div class="skeleton-cell wide"></div>
                <div class="skeleton-cell"></div>
                <div class="skeleton-cell narrow"></div>
                <div class="skeleton-cell"></div>
                <div class="skeleton-cell narrow"></div>
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
          <div class="table-scroll">
            <table class="offer-table" aria-label="Marketplace listings">
              <thead>
                <tr>
                  <th scope="col">Credit ID</th>
                  <th scope="col">Project</th>
                  <th scope="col">Tonnes</th>
                  <th scope="col">Methodology</th>
                  <th scope="col">Price</th>
                  <th scope="col">Asset</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <label class="asset-picker-inline" for="global-asset-picker">
                      Payment asset
                      <select id="global-asset-picker" (change)="onAssetChange($event)">
                        @for (a of paymentAssets; track a.label) {
                          <option
                            [value]="a.label"
                            [selected]="a.label === selectedPaymentAsset().label"
                          >
                            {{ a.label }}
                          </option>
                        }
                      </select>
                    </label>
                  </th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                @for (offer of visibleOffers(); track offer.id) {
                  <tr class="offer-row">
                    <td class="mono">{{ offer.credit_id | slice: 0 : 12 }}…</td>
                    <td>{{ projectOf(offer) }}</td>
                    <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                    <td>{{ offer.methodology ?? '—' }}</td>
                    <td>{{ formatPrice(offer) }}</td>
                    <td>
                      <span class="badge badge-asset">{{ offer.price_asset_label ?? 'XLM' }}</span>
                    </td>
                    <td>
                      <span class="badge" [class]="'badge-' + offer.status">{{
                        offer.status
                      }}</span>
                    </td>
                    <td>
                      <button
                        class="btn btn-sm btn-primary"
                        type="button"
                        [disabled]="offer.status !== 'open' || buying() === offer.id"
                        (click)="buy(offer)"
                        [attr.aria-label]="
                          'Buy credit ' + offer.credit_id + ' for ' + formatPrice(offer)
                        "
                        [attr.aria-busy]="buying() === offer.id"
                      >
                        {{ buying() === offer.id ? 'Buying…' : 'Buy' }}
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <!-- Load More -->
          <div class="load-more-area" aria-live="polite">
            @if (isLoadingMore()) {
              <div class="spinner" role="status" aria-label="Loading more listings">
                <span class="spinner-dot"></span>
                <span class="spinner-dot"></span>
                <span class="spinner-dot"></span>
              </div>
            } @else if (hasMore()) {
              <button class="btn btn-outline load-more-btn" type="button" (click)="loadMore()">
                Load More ({{ visibleOffers().length }} loaded)
              </button>
            } @else {
              <p class="end-of-list">
                All {{ visibleOffers().length }} listing{{
                  visibleOffers().length === 1 ? '' : 's'
                }}
                loaded
              </p>
            }
          </div>
        }

        <!-- Offer detail dialog. Issue #963: focus is trapped and restored. -->
        @if (selectedOffer()) {
          <div class="overlay" (click)="closeOffer()" role="presentation"></div>
          <div
            #offerDialog
            class="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="marketplace-offer-dialog"
            (keydown)="onDialogKeydown($event)"
          >
            <h2 id="marketplace-offer-dialog" class="visually-hidden">Offer details</h2>
            <app-offer-detail
              [offer]="selectedOffer()!"
              (closed)="closeOffer()"
              (buy)="onBuyComplete($event)"
              (cancelled)="onCancelled($event)"
            />
          </div>
        }
      }
    </div>
  `,
  styles: [
    `
      .marketplace {
        max-width: 960px;
        margin: 0 auto;
        padding: 1rem;
      }
      h1 {
        margin-bottom: 1.5rem;
      }
      .network-warning {
        background: #fff3cd;
        border: 1px solid #ffc107;
        border-radius: 6px;
        padding: 0.75rem 1rem;
        margin-bottom: 1rem;
        color: #856404;
        font-size: 0.9rem;
      }
      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        z-index: 10;
      }
      .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 11;
      }
    `,
    `
      .marketplace {
        max-width: 1100px;
        margin: 0 auto;
        padding: 1.5rem 1rem;
      }
      h1 {
        margin-bottom: 1.5rem;
      }
      .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0 0 0 0);
        clip-path: inset(50%);
        white-space: nowrap;
        border: 0;
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
        border: 1px solid #767676;
        border-radius: 6px;
        font-size: 0.9rem;
        background: #fff;
      }
      .filter-field input:focus-visible,
      .filter-field select:focus-visible {
        outline: 3px solid #1565c0;
        outline-offset: 1px;
      }
      .filter-reset {
        align-self: flex-end;
      }

      /* Cards */
      .card {
        background: #f9f9f9;
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        padding: 1.25rem;
        margin-bottom: 1.25rem;
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
      .skeleton-cell.wide {
        flex: 2;
      }
      .skeleton-cell.narrow {
        flex: 0.5;
      }
      @keyframes shimmer {
        0% {
          background-position: 200% 0;
        }
        100% {
          background-position: -200% 0;
        }
      }

      /* Table */
      .status {
        color: #595959;
      }
      .error {
        color: #a31515;
        font-weight: 500;
      }
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
        background: #f0f0f0;
        font-weight: 600;
        white-space: nowrap;
      }
      .offer-row:hover {
        background: #fafafa;
      }
      .mono {
        font-family: monospace;
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
      .badge-asset {
        background: #f3e5f5;
        color: #6a1b9a;
      }

      /* Load More */
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
        color: #595959;
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
        background: #2e7d32;
        animation: bounce 1s infinite ease-in-out;
      }
      .spinner-dot:nth-child(2) {
        animation-delay: 0.15s;
      }
      .spinner-dot:nth-child(3) {
        animation-delay: 0.3s;
      }
      @keyframes bounce {
        0%,
        80%,
        100% {
          transform: scale(0.7);
          opacity: 0.5;
        }
        40% {
          transform: scale(1);
          opacity: 1;
        }
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
        outline: 3px solid #1565c0;
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
      .btn-outline {
        background: transparent;
        border: 1px solid #767676;
        color: #262626;
      }
      .btn-outline:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .btn-sm {
        padding: 0.25rem 0.65rem;
        font-size: 0.8rem;
      }

      /* Inline asset picker in table header */
      .asset-picker-inline {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-weight: 400;
        font-size: 0.75rem;
      }
      .asset-picker-inline select {
        padding: 0.15rem 0.3rem;
        border: 1px solid #767676;
        border-radius: 4px;
        font-size: 0.75rem;
        background: #fff;
        cursor: pointer;
      }

      /* #962 — responsive pass: scroll the wide table, stack the filter bar
         and enlarge touch targets on small screens. */
      .table-scroll {
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
      }

      @media (max-width: 768px) {
        .offer-table {
          min-width: 720px;
        }
        .load-more-btn {
          min-width: 100%;
          min-height: 44px;
        }
        .btn-sm {
          min-height: 44px;
          padding: 0.5rem 0.9rem;
        }
        .asset-picker-inline {
          margin-left: 0;
          margin-top: 0.25rem;
          display: flex;
        }
        .asset-picker-inline select {
          min-height: 44px;
          font-size: 0.85rem;
        }
      }

      @media (max-width: 480px) {
        .offer-table {
          min-width: 640px;
          font-size: 0.82rem;
        }
        .offer-table th,
        .offer-table td {
          padding: 0.5rem 0.6rem;
        }
      }
    `,
  ],
})
export class MarketplaceComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  protected readonly store = inject(MarketplaceStore);
  protected readonly eventsStore = inject(MarketEventsStore);
  protected readonly watchlist = inject(WatchlistStore);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly PAGE_SIZE = 20;
  readonly skeletonRows = [1, 2, 3, 4, 5];
  readonly methodologies = ['REDD+', 'VCS', 'Gold Standard', 'CDM', 'Plan Vivo', 'Custom'];

  /** Payment assets available in the asset picker when buying a credit. */
  readonly paymentAssets = [
    { label: 'XLM', type: 'native' as const, address: null },
    {
      label: 'USDC',
      type: 'asset' as const,
      address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    },
    {
      label: 'EURC',
      type: 'asset' as const,
      address: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP',
    },
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
  /** The offer shown in the modal dialog. */
  readonly selectedOffer = signal<Offer | null>(null);

  private nextCursor: string | null = null;

  private readonly offerDialog = viewChild<ElementRef<HTMLElement>>('offerDialog');
  /** Focus returns here when the dialog closes. */
  private lastFocused: HTMLElement | null = null;

  readonly hasMore = computed(() => this.nextCursor !== null);

  readonly hasActiveFilters = computed(() => {
    const f = this.filters;
    return !!(f.methodology || f.geography || f.vintageYear || f.minTonnes || f.maxTonnes);
  });

  /**
   * Issue #958 — the project whose price history is shown: the one owning the
   * first listing, or the watched key with the most history. Null when there is
   * nothing worth charting yet.
   */
  readonly historyKey = computed(() => {
    const first = this.visibleOffers()[0];
    return first ? defaultOfferKey(first) : null;
  });

  async ngOnInit(): Promise<void> {
    if (this.auth.isAuthenticated()) {
      await this.load();
      void this.eventsStore.load();
    }
  }

  onOfferSelected(offer: Offer): void {
    this.lastFocused = document.activeElement as HTMLElement | null;
    this.selectedOffer.set(offer);
    // Issue #963: move focus into the dialog so keyboard users are not stranded.
    queueMicrotask(() => this.focusFirstInDialog());
  }

  onAlertSelected(alert: { key: string; offer: Offer }): void {
    this.lastFocused = document.activeElement as HTMLElement | null;
    this.selectedOffer.set(alert.offer);
    queueMicrotask(() => this.focusFirstInDialog());
  }

  /**
   * Issue #963 — Escape closes the dialog and Tab cycles inside it. Implemented
   * as a `(keydown)` handler on the dialog element rather than a document
   * listener so the trap only exists while the dialog is open.
   */
  onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeOffer();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = this.dialogFocusable();
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !this.dialogContains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  closeOffer(): void {
    this.selectedOffer.set(null);
    // Issue #963: return focus to whatever opened the dialog.
    this.lastFocused?.focus();
    this.lastFocused = null;
  }

  private focusFirstInDialog(): void {
    this.dialogFocusable()[0]?.focus();
  }

  private dialogFocusable(): HTMLElement[] {
    const host = this.offerDialog()?.nativeElement;
    if (!host) return [];
    return [...host.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  private dialogContains(el: Element | null): boolean {
    return !!el && !!this.offerDialog()?.nativeElement.contains(el);
  }

  onBuyComplete(offer: Offer): void {
    this.closeOffer();
    // Reload listings after a successful purchase
    const pk = this.wallet.publicKey();
    if (pk) void this.store.loadOffersBySeller(pk);
  }

  onCancelled(offer: Offer): void {
    this.closeOffer();
    // Reload listings after cancellation
    const pk = this.wallet.publicKey();
    if (pk) void this.store.loadOffersBySeller(pk);
  }

  /** Load (or reload) the first page of results, resetting state. */
  async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    this.nextCursor = null;
    this.visibleOffers.set([]);

    try {
      const result = await firstValueFrom(this.api.getListingsCursor(this.buildParams()));
      this.visibleOffers.set(result.data);
      this.nextCursor = result.next_cursor ?? null;
      // Issue #958: re-run watchlist alerts against the fresh listings.
      this.watchlist.evaluate(result.data);
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
      this.watchlist.evaluate(this.visibleOffers());
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

  /** Issue #958 — add/remove a project from the local watchlist. */
  toggleWatch(key: string): void {
    if (this.watchlist.isWatching(key)) {
      this.watchlist.unwatch(key);
    } else {
      this.watchlist.watch(key, key);
      this.watchlist.evaluate(this.visibleOffers());
    }
  }

  projectOf(offer: Offer): string {
    return (offer as { project_id?: string }).project_id ?? '—';
  }

  async buy(offer: Offer): Promise<void> {
    const pk = this.wallet.publicKey();
    if (!pk) {
      this.toast.show('Please connect your wallet first.', 'error');
      return;
    }

    this.buying.set(offer.id);
    try {
      // The buy flow: the offer-detail dialog builds the XDR client-side and
      // has the wallet sign it (see OfferDetailComponent.executeBuy).
      await firstValueFrom(this.api.buyOffer(Number(offer.id), this.auth.token() ?? ''));
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
    if (offer.price_amount !== undefined) {
      const amount = Number(offer.price_amount) / 10_000_000;
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
