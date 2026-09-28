import { Injectable, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ApiService, type SorobanEvent } from '../services/api.service';
import { WalletScopedStore } from './wallet-scope';

/**
 * Issue #958 — price history for the secondary market.
 *
 * Listing and price-change events already land in the indexed event log
 * (issue #52); nothing consumed them. This store turns that log into a
 * per-project price series, cached for a short TTL so flipping between the
 * marketplace and a project page doesn't re-fetch on every render.
 *
 * The cache is keyed by the active (network, address) like the other stores, so
 * a history assembled on one network can never be shown on another.
 */

/** Event topics that carry a price for a listed offer. */
const PRICE_EVENT_TYPES = [
  'OfferListed',
  'OfferPriceChanged',
  'OfferFilled',
  'OfferCancelled',
] as const;

/** How long a fetched history stays usable before it is refetched. */
export const PRICE_HISTORY_TTL_MS = 60_000;

/** Page size requested from the event index (server max is 200). */
const PAGE_SIZE = 200;

/** One point on the price line. */
export interface PricePoint {
  /** Unix seconds. */
  timestamp: number;
  /** Price per tonne, in the payment asset's base units, as a number. */
  price: number;
  /** Human label for the asset, when the event states one. */
  asset?: string;
  /** Raw event that produced the point. */
  event: SorobanEvent;
}

export type PriceHistoryState = 'idle' | 'loading' | 'loaded' | 'error';

@Injectable({ providedIn: 'root' })
export class MarketEventsStore extends WalletScopedStore {
  private readonly api = inject(ApiService);

  private readonly _events = signal<SorobanEvent[]>([]);
  private readonly _state = signal<PriceHistoryState>('idle');
  private readonly _error = signal<string | null>(null);
  /** Series keyed by project (or credit id when the event carries no project). */
  private readonly _history = signal<Record<string, PricePoint[]>>({});
  private fetchedAt = 0;

  constructor() {
    super();
    this.watchScope(() => this.reset());
  }

  readonly events = this._events.asReadonly();
  readonly state = this._state.asReadonly();
  readonly error = this._error.asReadonly();
  readonly isLoading = computed(() => this._state() === 'loading');
  readonly isStale = computed(
    () => this._state() === 'loaded' && Date.now() - this.fetchedAt > PRICE_HISTORY_TTL_MS,
  );

  /**
   * Load the price-carrying events, skipping the request when the cached copy is
   * still within its TTL. `force` bypasses the TTL (used by an explicit refresh).
   */
  async load(force = false): Promise<void> {
    if (!force && this._state() === 'loaded' && !this.isStale()) return;

    const scope = this.beginWrite();
    this._state.set('loading');
    this._error.set(null);

    try {
      const pages = await Promise.all(
        PRICE_EVENT_TYPES.map((eventType) =>
          firstValueFrom(this.api.getEvents({ eventType, limit: PAGE_SIZE })),
        ),
      );
      const events = pages.flatMap((p) => p.events ?? []);

      if (!this.commitWrite(`events=${events.length}`, scope)) {
        this._state.set('idle');
        return;
      }

      this._events.set(events);
      this._history.set(buildHistory(events));
      this.fetchedAt = Date.now();
      this._state.set('loaded');
    } catch (err) {
      this.discardWrite();
      this._error.set(err instanceof Error ? err.message : 'Failed to load price history.');
      this._state.set('error');
    }
  }

  /** Price series for a project, oldest first. Empty when nothing is known. */
  historyFor(projectId: string): PricePoint[] {
    return this._history()[projectId] ?? [];
  }

  /** Reactive accessor for template use. */
  readonly history = computed(() => this._history());

  /** Latest known price per project, used to badge watchlist rows. */
  readonly latestPrice = computed(() => {
    const out: Record<string, number> = {};
    for (const [key, points] of Object.entries(this._history())) {
      const last = points[points.length - 1];
      if (last) out[key] = last.price;
    }
    return out;
  });

  reset(): void {
    this._events.set([]);
    this._state.set('idle');
    this._error.set(null);
    this._history.set({});
    this.fetchedAt = 0;
    this.clearCacheKey();
  }
}

/**
 * Extract a price series from raw events.
 *
 * Event payloads are contract-defined maps, so several field spellings are
 * accepted (`price_xlm`, `priceAmount`, `price`, …) and a missing price simply
 * yields no point rather than a bogus zero. Exported for direct unit testing.
 */
export function buildHistory(events: readonly SorobanEvent[]): Record<string, PricePoint[]> {
  const series: Record<string, PricePoint[]> = {};

  for (const event of events) {
    const price = readPrice(event.data);
    if (price === null) continue;

    const key = readProjectKey(event.data);
    const point: PricePoint = {
      timestamp: event.timestamp,
      price,
      asset: readAsset(event.data),
      event,
    };
    (series[key] ??= []).push(point);
  }

  // Newest-first from the API; flip to chronological so a chart can plot it left
  // to right and the "latest" price is the last element.
  for (const key of Object.keys(series)) {
    series[key].sort((a, b) => a.timestamp - b.timestamp);
  }
  return series;
}

function firstString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function readPrice(data: Record<string, unknown>): number | null {
  const raw = data['price_xlm'] ?? data['priceAmount'] ?? data['price_amount'] ?? data['price'];
  if (typeof raw === 'string' || typeof raw === 'number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function readProjectKey(data: Record<string, unknown>): string {
  return (
    firstString(data, ['project_id', 'projectId', 'project']) ??
    firstString(data, ['credit_id', 'creditId']) ??
    'market'
  );
}

function readAsset(data: Record<string, unknown>): string | undefined {
  return (
    firstString(data, ['price_asset_code', 'asset_code', 'assetCode', 'paymentAssetCode']) ?? undefined
  );
}
