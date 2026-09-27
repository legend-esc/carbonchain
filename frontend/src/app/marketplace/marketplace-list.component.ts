import { Component, inject, OnInit, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Offer } from '@shared';
import { MarketplaceStore } from '../core/store/marketplace.store';

@Component({
  selector: 'app-marketplace-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="listings">
      <div class="listings__toolbar">
        <h2>Active Listings</h2>
        <button class="btn btn-primary" (click)="load()" [disabled]="store.isLoading()">
          {{ store.isLoading() ? 'Loading…' : 'Refresh' }}
        </button>
      </div>

      <div class="filters">
        <select [(ngModel)]="filterMethodology" (change)="applyFilters()" aria-label="Filter by methodology">
          <option value="">All Methodologies</option>
          <option value="REDD+">REDD+</option>
          <option value="VCS">VCS</option>
          <option value="Gold Standard">Gold Standard</option>
          <option value="CDM">CDM</option>
          <option value="Plan Vivo">Plan Vivo</option>
        </select>
        <input type="number" [(ngModel)]="filterMinPrice" placeholder="Min price" (change)="applyFilters()" aria-label="Min price" />
        <input type="number" [(ngModel)]="filterMaxPrice" placeholder="Max price" (change)="applyFilters()" aria-label="Max price" />
      </div>

      @if (store.error()) {
        <p class="error" role="alert">{{ store.error() }}</p>
      } @else if (store.isLoading()) {
        <p class="status">Loading listings…</p>
      } @else if (store.activeOffers().length === 0) {
        <p class="status">No active listings.</p>
      } @else {
        <table class="offer-table" aria-label="Active marketplace listings">
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Credit</th>
              <th scope="col">Seller</th>
              <th scope="col">Tonnes</th>
              <th scope="col">Price</th>
              <th scope="col">Asset</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            @for (offer of store.activeOffers(); track offer.id) {
              <tr class="offer-row" (click)="offerSelected.emit(offer)" style="cursor:pointer">
                <td class="mono">{{ offer.id }}</td>
                <td class="mono">{{ offer.credit_id | slice: 0 : 12 }}…</td>
                <td class="mono">{{ offer.seller | slice: 0 : 8 }}…</td>
                <td>{{ formatTonnes(offer.tonnes_available) }}</td>
                <td>{{ formatPrice(offer) }}</td>
                <td>{{ offer.payment_asset_code ?? 'XLM' }}</td>
                <td>
                  <button class="btn btn-sm btn-primary" (click)="$event.stopPropagation(); offerSelected.emit(offer)">View</button>
                </td>
              </tr>
            }
          </tbody>
        </table>

        <div class="pagination">
          <button class="btn btn-outline" (click)="prevPage()" [disabled]="store.page() <= 1">← Prev</button>
          <span class="page-info">Page {{ store.page() }} of {{ store.totalPages() }} · {{ store.totalActiveOffers() }} listings</span>
          <button class="btn btn-outline" (click)="nextPage()" [disabled]="store.page() >= store.totalPages()">Next →</button>
        </div>
      }
    </div>
  `,
  styles: [`
    .listings { width: 100%; }
    .listings__toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
    h2 { margin: 0; }
    .filters { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
    .filters select, .filters input { padding: 0.4rem 0.6rem; border: 1px solid #ccc; border-radius: 6px; font-size: 0.85rem; }
    .status { color: #888; }
    .error { color: #e53935; }
    .offer-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .offer-table th, .offer-table td { padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; text-align: left; }
    .offer-table th { background: #f5f5f5; font-weight: 600; }
    .offer-row:hover { background: #f9f9f9; }
    .mono { font-family: monospace; }
    .pagination { display: flex; align-items: center; gap: 1rem; margin-top: 1rem; justify-content: center; }
    .page-info { font-size: 0.85rem; color: #666; }
    .btn { padding: 0.4rem 1rem; border-radius: 6px; cursor: pointer; border: none; font-size: 0.85rem; }
    .btn-primary { background: #4caf50; color: #fff; }
    .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-outline { background: transparent; border: 1px solid #ccc; }
    .btn-outline:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-sm { padding: 0.25rem 0.6rem; font-size: 0.8rem; }
  `],
})
export class MarketplaceListComponent implements OnInit {
  protected readonly store = inject(MarketplaceStore);
  readonly offerSelected = output<Offer>();

  filterMethodology = '';
  filterMinPrice: number | undefined;
  filterMaxPrice: number | undefined;

  ngOnInit(): void {
    void this.load();
  }

  async load(): Promise<void> {
    await this.store.loadListings(1, {
      methodology: this.filterMethodology || undefined,
      minPrice: this.filterMinPrice,
      maxPrice: this.filterMaxPrice,
    });
  }

  async applyFilters(): Promise<void> {
    await this.store.applyFilters({
      methodology: this.filterMethodology || undefined,
      minPrice: this.filterMinPrice,
      maxPrice: this.filterMaxPrice,
    });
  }

  async nextPage(): Promise<void> {
    await this.store.nextPage();
  }

  async prevPage(): Promise<void> {
    await this.store.prevPage();
  }

  formatTonnes(raw: string): string {
    return (Number(raw) / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' t';
  }

  formatPrice(offer: Offer): string {
    const raw = offer.price_raw ?? offer.price_xlm;
    const code = offer.payment_asset_code ?? 'XLM';
    return (Number(raw) / 10_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ` ${code}`;
  }
}
