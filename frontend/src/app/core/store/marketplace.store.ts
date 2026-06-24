import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { Offer } from '@shared';
import { ApiService } from '../services/api.service';

export type LoadingState = 'idle' | 'loading' | 'loaded' | 'error';

@Injectable({ providedIn: 'root' })
export class MarketplaceStore {
  private readonly api = inject(ApiService);

  readonly pageSize = 10;

  private readonly _offers = signal<Offer[]>([]);
  private readonly _state = signal<LoadingState>('idle');
  private readonly _error = signal<string | null>(null);
  private readonly _page = signal(0);

  readonly offers = this._offers.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly page = this._page.asReadonly();
  readonly isLoading = computed(() => this._state() === 'loading');

  private readonly _allActiveOffers = computed(() => this._offers().filter((o) => o.status === 'open'));
  readonly totalActiveOffers = computed(() => this._allActiveOffers().length);
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.totalActiveOffers() / this.pageSize)));
  readonly activeOffers = computed(() => {
    const start = this._page() * this.pageSize;
    return this._allActiveOffers().slice(start, start + this.pageSize);
  });

  async loadOffersBySeller(seller: string): Promise<void> {
    this._state.set('loading');
    this._error.set(null);
    try {
      const ids = await firstValueFrom(this.api.getOffersBySeller(seller));
      const offers = await Promise.all(
        ids.map((id) => firstValueFrom(this.api.getOffer(Number(id)))),
      );
      this._offers.set(offers);
      this._state.set('loaded');
      this._page.set(0);
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

  nextPage(): void {
    if (this._page() < this.totalPages() - 1) this._page.update((p) => p + 1);
  }

  prevPage(): void {
    if (this._page() > 0) this._page.update((p) => p - 1);
  }

  reset(): void {
    this._offers.set([]);
    this._state.set('idle');
    this._error.set(null);
    this._page.set(0);
  }
}
