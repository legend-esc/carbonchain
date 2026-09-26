import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Offer } from '@shared';
import { ApiService } from '../services/api.service';

export type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

export interface MarketplaceFilters {
  methodology?: string;
  minPrice?: number;
  maxPrice?: number;
}

@Injectable({ providedIn: 'root' })
export class MarketplaceStore {
  private readonly api = inject(ApiService);

  readonly pageSize = 20;

  private readonly _offers = signal<Offer[]>([]);
  private readonly _state = signal<LoadingState>('idle');
  private readonly _error = signal<string | null>(null);
  private readonly _page = signal(1);
  private readonly _total = signal(0);
  private readonly _filters = signal<MarketplaceFilters>({});

  readonly offers = this._offers.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly page = this._page.asReadonly();
  readonly total = this._total.asReadonly();
  readonly filters = this._filters.asReadonly();
  readonly isLoading = computed(() => this._state() === 'loading');
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this._total() / this.pageSize)));
  readonly totalActiveOffers = computed(() => this._total());
  // activeOffers is the current page's offers (already server-filtered)
  readonly activeOffers = this._offers.asReadonly();

  async loadListings(page = 1, filters?: MarketplaceFilters): Promise<void> {
    this._state.set('loading');
    this._error.set(null);
    if (filters) this._filters.set(filters);
    try {
      const result = await firstValueFrom(
        this.api.getListings({
          page,
          pageSize: this.pageSize,
          ...this._filters(),
        }),
      );
      this._offers.set(result.data);
      this._total.set(result.total);
      this._page.set(result.page);
      this._state.set('loaded');
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Failed to load listings.');
      this._state.set('error');
    }
  }

  async loadOffersBySeller(seller: string): Promise<void> {
    this._state.set('loading');
    this._error.set(null);
    try {
      const ids = await firstValueFrom(this.api.getOffersBySeller(seller));
      const offers = await Promise.all(
        ids.map((id) => firstValueFrom(this.api.getOffer(Number(id)))),
      );
      this._offers.set(offers);
      this._total.set(offers.length);
      this._state.set('loaded');
      this._page.set(1);
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'Failed to load offers.');
      this._state.set('error');
    }
  }

  async loadOffer(id: number): Promise<void> {
    this._state.set('loading');
    this._error.set(null);
    try {
      const offer = await firstValueFrom(this.api.getOffer(id));
      this._offers.update((list) => {
        const idx = list.findIndex((o) => o.id === String(id));
        return idx >= 0 ? [...list.slice(0, idx), offer, ...list.slice(idx + 1)] : [...list, offer];
      });
      this._state.set('loaded');
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : `Failed to load offer ${id}.`);
      this._state.set('error');
    }
  }

  async applyFilters(filters: MarketplaceFilters): Promise<void> {
    return this.loadListings(1, filters);
  }

  async nextPage(): Promise<void> {
    if (this._page() < this.totalPages()) {
      return this.loadListings(this._page() + 1);
    }
  }

  async prevPage(): Promise<void> {
    if (this._page() > 1) {
      return this.loadListings(this._page() - 1);
    }
  }

  reset(): void {
    this._offers.set([]);
    this._state.set('idle');
    this._error.set(null);
    this._page.set(1);
    this._total.set(0);
    this._filters.set({});
  }
}
