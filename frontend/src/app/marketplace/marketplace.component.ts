import { Component, inject, signal, computed, OnInit } from '@angular/core';
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

        <!-- Loading skeleton -->
        @if (isLoading()) {
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
        } @else if (pagedOffers().length === 0) {
          <p class="status">
            {{ filteredOffers().length === 0 && allOffers().length > 0
               ? 'No listings match your filters.'
               : 'No active listings.' }}
          </p>
        } @else {
          <table class="offer-table" aria-label="Marketplace listings">
            <thead>
              <tr>
                <th scope="col">Credit ID</th>
                <th scope="col">Project</th>
                <th scope="col">Vintage</th>
                <th scope="col">Methodology</th>
                <th scope="col">Tonnes</th>
                <th scope="col">Price (XLM)</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              @for (offer of pagedOffers(); track offer.id) {
                <tr class="offer-row">
                  <td class="mono">{{ offer.credit_id | slice: 0 : 12 }}…</td>
                  <td>{{ offer.credit_id | slice: 0 : 8 }}</td>
                  <td>—</td>
                  <td>{{ offer.methodology ?? '—' }}</td>
                  <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                  <td>{{ formatXlm(offer.price_xlm) }}</td>
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

          <!-- Pagination -->
          <nav class="pagination" aria-label="Listings pagination">
            <button
              class="btn btn-outline"
              type="button"
              (click)="prevPage()"
              [disabled]="currentPage() === 0"
              aria-label="Previous page"
            >
              ← Prev
            </button>
            <span class="page-info" aria-live="polite">
              Page {{ currentPage() + 1 }} of {{ totalPages() }}
              · {{ filteredOffers().length }} listing{{ filteredOffers().length === 1 ? '' : 's' }}
            </span>
            <button
              class="btn btn-outline"
              type="button"
              (click)="nextPage()"
              [disabled]="currentPage() >= totalPages() - 1"
              aria-label="Next page"
            >
              Next →
            </button>
          </nav>
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

      /* Pagination */
      .pagination {
        display: flex;
        align-items: center;
        gap: 1rem;
        margin-top: 1.25rem;
        justify-content: center;
      }
      .page-info { font-size: 0.9rem; color: #555; }

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
    `,
  ],
})
export class MarketplaceComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly wallet = inject(StellarWalletService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly PAGE_SIZE = 10;
  readonly skeletonRows = [1, 2, 3, 4, 5];
  readonly methodologies = ['REDD+', 'VCS', 'Gold Standard', 'CDM', 'Plan Vivo', 'Custom'];

  filters: FilterState = {
    methodology: '',
    geography: '',
    vintageYear: '',
    minTonnes: '',
    maxTonnes: '',
  };

  readonly allOffers = signal<Offer[]>([]);
  readonly isLoading = signal(false);
  readonly error = signal<string | null>(null);
  readonly buying = signal<string | null>(null);
  readonly currentPage = signal(0);
  readonly filterVersion = signal(0); // bump to trigger computed re-eval

  readonly filteredOffers = computed(() => {
    // Touch filterVersion so this recomputes when filters change
    this.filterVersion();
    const { methodology, geography, vintageYear, minTonnes, maxTonnes } = this.filters;

    return this.allOffers().filter((o) => {
      if (o.status !== 'open') return false;
      if (methodology && (o.methodology ?? '') !== methodology) return false;
      if (geography && !o.credit_id.toLowerCase().includes(geography.toLowerCase())) return false;
      if (vintageYear) {
        /* vintageYear filter is metadata we don't have on Offer directly; skip for now */
      }
      const tonnes = Number(o.tonnes_available) / 1_000_000;
      if (minTonnes && tonnes < Number(minTonnes)) return false;
      if (maxTonnes && tonnes > Number(maxTonnes)) return false;
      return true;
    });
  });

  readonly totalPages = computed(() =>
    Math.max(1, Math.ceil(this.filteredOffers().length / this.PAGE_SIZE)),
  );

  readonly pagedOffers = computed(() => {
    const start = this.currentPage() * this.PAGE_SIZE;
    return this.filteredOffers().slice(start, start + this.PAGE_SIZE);
  });

  readonly hasActiveFilters = computed(() => {
    const f = this.filters;
    return !!(f.methodology || f.geography || f.vintageYear || f.minTonnes || f.maxTonnes);
  });

  async ngOnInit(): Promise<void> {
    if (this.auth.isAuthenticated()) {
      await this.load();
    }
  }

  async load(): Promise<void> {
    this.isLoading.set(true);
    this.error.set(null);
    try {
      const listings = await firstValueFrom(this.api.getListings());
      this.allOffers.set(listings);
      this.currentPage.set(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load listings.';
      this.error.set(msg);
      this.toast.show(msg, 'error');
    } finally {
      this.isLoading.set(false);
    }
  }

  applyFilters(): void {
    this.filterVersion.update((v) => v + 1);
    this.currentPage.set(0);
  }

  resetFilters(): void {
    this.filters = {
      methodology: '',
      geography: '',
      vintageYear: '',
      minTonnes: '',
      maxTonnes: '',
    };
    this.applyFilters();
  }

  nextPage(): void {
    if (this.currentPage() < this.totalPages() - 1) {
      this.currentPage.update((p) => p + 1);
    }
  }

  prevPage(): void {
    if (this.currentPage() > 0) {
      this.currentPage.update((p) => p - 1);
    }
  }

  async buy(offer: Offer): Promise<void> {
    const pk = this.wallet.publicKey();
    if (!pk) {
      this.toast.show('Please connect your wallet first.', 'error');
      return;
    }

    this.buying.set(offer.id);
    try {
      // Trigger Freighter wallet signing — signTransaction handles the Freighter prompt
      const { networkPassphrase } = await this.wallet.getNetworkDetails();
      // The buy flow: build a transaction XDR client-side then sign via Freighter.
      // For now we call signTransaction with a placeholder; real XDR comes from the API.
      // After signing, we POST to /marketplace/offer to record the purchase.
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
}
