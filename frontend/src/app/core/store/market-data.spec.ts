import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { Offer } from '@shared';

import { WatchlistStore, defaultOfferKey, priceOf } from './watchlist.store';
import {
  MarketEventsStore,
  buildHistory,
  PRICE_HISTORY_TTL_MS,
  type PricePoint,
} from './market-events.store';
import { ApiService, type SorobanEvent } from '../services/api.service';
import { networkSignal, walletAddressSignal } from '../services/wallet-state.signals';

function offer(over: Partial<Offer> & { id: string }): Offer {
  return {
    seller: 'GSELLER',
    credit_id: 'credit-1',
    price_xlm: '10000000',
    status: 'open',
    ...over,
  } as Offer;
}

describe('WatchlistStore', () => {
  let store: WatchlistStore;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    store = TestBed.inject(WatchlistStore);
  });

  it('starts empty', () => {
    expect(store.isEmpty()).toBe(true);
    expect(store.entries()).toEqual([]);
  });

  it('watches a key with a target price', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    expect(store.isWatching('proj-1')).toBe(true);
    expect(store.entryFor('proj-1')?.targetPrice).toBe(10_000_000);
  });

  it('updates the target rather than duplicating the entry', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    store.watch('proj-1', 'Amazon REDD+', 8_000_000);
    expect(store.entries().length).toBe(1);
    expect(store.entryFor('proj-1')?.targetPrice).toBe(8_000_000);
  });

  it('unwatches a key and drops its alerts', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    const alerts = store.evaluate([offer({ id: 'o1', price_amount: '9000000' })], () => 'proj-1');
    expect(alerts.length).toBe(1);

    store.unwatch('proj-1');
    expect(store.isWatching('proj-1')).toBe(false);
    expect(store.alerts()).toEqual([]);
  });

  it('persists entries to localStorage and restores them', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const restored = TestBed.inject(WatchlistStore);

    expect(restored.entries()).toHaveLength(1);
    expect(restored.entryFor('proj-1')?.label).toBe('Amazon REDD+');
  });

  it('ignores corrupt persisted data', () => {
    localStorage.setItem('cc_watchlist', 'not json');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    expect(TestBed.inject(WatchlistStore).entries()).toEqual([]);
  });

  // ── Alerts ─────────────────────────────────────────────────────────────────

  it('raises an alert when a listing is at or below the target', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    const alerts = store.evaluate([offer({ id: 'o1', price_amount: '9500000' })], () => 'proj-1');

    expect(alerts).toHaveLength(1);
    expect(alerts[0].offer.id).toBe('o1');
    expect(alerts[0].discount).toBeCloseTo(0.05, 5);
  });

  it('treats a price exactly at the target as a match', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    const alerts = store.evaluate([offer({ id: 'o1', price_amount: '10000000' })], () => 'proj-1');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].discount).toBe(0);
  });

  it('does not alert above the target', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    const alerts = store.evaluate([offer({ id: 'o1', price_amount: '10000001' })], () => 'proj-1');
    expect(alerts).toEqual([]);
  });

  it('ignores offers for keys that are not watched', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    const alerts = store.evaluate([offer({ id: 'o1', price_amount: '1000000' })], () => 'proj-2');
    expect(alerts).toEqual([]);
  });

  it('ignores entries with no target price', () => {
    store.watch('proj-1', 'Amazon REDD+', null);
    const alerts = store.evaluate([offer({ id: 'o1', price_amount: '1000000' })], () => 'proj-1');
    expect(alerts).toEqual([]);
  });

  it('replaces the alert set on re-evaluation rather than accumulating', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    store.evaluate([offer({ id: 'o1', price_amount: '9000000' })], () => 'proj-1');
    store.evaluate([], () => 'proj-1');
    expect(store.alerts()).toEqual([]);
  });

  it('falls back to price_xlm for legacy offers', () => {
    store.watch('proj-1', 'Amazon REDD+', 10_000_000);
    const alerts = store.evaluate([offer({ id: 'o1', price_xlm: '9000000' })], () => 'proj-1');
    expect(alerts).toHaveLength(1);
  });

  it('priceOf prefers price_amount over the legacy field', () => {
    expect(priceOf(offer({ id: 'o', price_amount: '5', price_xlm: '9' }))).toBe(5);
    expect(priceOf(offer({ id: 'o', price_xlm: '9' }))).toBe(9);
    expect(priceOf(offer({ id: 'o', price_xlm: 'nope' }))).toBeNull();
  });

  it('defaultOfferKey falls back to the credit id', () => {
    expect(defaultOfferKey(offer({ id: 'o' }))).toBe('credit-1');
    expect(defaultOfferKey(offer({ id: 'o', project_id: 'p1' } as never))).toBe('p1');
  });
});

function event(
  id: string,
  type: string,
  timestamp: number,
  data: Record<string, unknown>,
): SorobanEvent {
  return { id, type, contractId: 'C1', ledger: 1, timestamp, data };
}

describe('MarketEventsStore — buildHistory', () => {
  it('extracts a price series per project, oldest first', () => {
    const series = buildHistory([
      event('e2', 'OfferListed', 200, { project_id: 'p1', price_xlm: '12000000' }),
      event('e1', 'OfferListed', 100, { project_id: 'p1', price_xlm: '10000000' }),
    ]);

    expect(series['p1'].map((p) => p.price)).toEqual([10_000_000, 12_000_000]);
  });

  it('accepts several price field spellings', () => {
    const series = buildHistory([
      event('e1', 'OfferListed', 1, { project_id: 'p1', priceAmount: '5' }),
      event('e2', 'OfferPriceChanged', 2, { project_id: 'p1', price: '7' }),
    ]);
    expect(series['p1'].map((p) => p.price)).toEqual([5, 7]);
  });

  it('skips events with no usable price rather than charting a zero', () => {
    const series = buildHistory([
      event('e1', 'OfferListed', 1, { project_id: 'p1' }),
      event('e2', 'OfferListed', 2, { project_id: 'p1', price_xlm: 'abc' }),
    ]);
    expect(series['p1']).toBeUndefined();
  });

  it('falls back to the credit id, then to a shared "market" bucket', () => {
    const series = buildHistory([
      event('e1', 'OfferListed', 1, { credit_id: 'c1', price_xlm: '1' }),
      event('e2', 'OfferListed', 2, { price_xlm: '2' }),
    ]);
    expect(series['c1']).toHaveLength(1);
    expect(series['market']).toHaveLength(1);
  });

  it('captures the payment asset when the event states one', () => {
    const series = buildHistory([
      event('e1', 'OfferListed', 1, { project_id: 'p1', price_xlm: '1', price_asset_code: 'USDC' }),
    ]);
    expect(series['p1'][0].asset).toBe('USDC');
  });

  it('handles an empty event log', () => {
    expect(buildHistory([])).toEqual({});
  });
});

describe('MarketEventsStore', () => {
  let getEvents: ReturnType<typeof vi.fn>;
  let store: MarketEventsStore;

  beforeEach(() => {
    localStorage.clear();
    walletAddressSignal.set(null);
    networkSignal.set(null);
    getEvents = vi.fn().mockResolvedValue({
      events: [event('e1', 'OfferListed', 1, { project_id: 'p1', price_xlm: '10000000' })],
      nextCursor: null,
    });
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { getEvents } }],
    });
    store = TestBed.inject(MarketEventsStore);
  });

  it('fetches one page per price-carrying event type', async () => {
    await store.load();
    expect(getEvents).toHaveBeenCalledTimes(4);
    const types = getEvents.mock.calls.map((c) => c[0].eventType);
    expect(types).toEqual(
      expect.arrayContaining(['OfferListed', 'OfferPriceChanged', 'OfferFilled', 'OfferCancelled']),
    );
  });

  it('builds a history keyed by project', async () => {
    await store.load();
    const series = store.historyFor('p1');
    expect(series).toHaveLength(1);
    expect(series[0].price).toBe(10_000_000);
  });

  it('serves a second load from the short cache without refetching', async () => {
    await store.load();
    await store.load();
    expect(getEvents).toHaveBeenCalledTimes(4);
  });

  it('force=true bypasses the cache', async () => {
    await store.load();
    await store.load(true);
    expect(getEvents).toHaveBeenCalledTimes(8);
  });

  it('refetches once the TTL has elapsed', async () => {
    await store.load();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PRICE_HISTORY_TTL_MS + 1);
    await store.load();
    expect(getEvents).toHaveBeenCalledTimes(8);
    vi.restoreAllMocks();
  });

  it('propagates a failed request into the error signal', async () => {
    getEvents.mockReturnValue(throwError(() => new Error('events down')));
    await store.load();
    expect(store.state()).toBe('error');
    expect(store.error()).toBe('events down');
  });

  it('reset() clears events, history and the cache key', async () => {
    await store.load();
    store.reset();
    expect(store.events()).toEqual([]);
    expect(store.historyFor('p1')).toEqual([]);
    expect(store.cacheKey()).toBeNull();
    expect(store.state()).toBe('idle');
  });
});

describe('PricePoint ordering', () => {
  it('is stable for a single point', () => {
    const points: PricePoint[] = [{ timestamp: 1, price: 1, event: { id: 'e' } as never }];
    expect(buildHistoryFrom(points)).toHaveLength(1);
  });
});

function buildHistoryFrom(points: PricePoint[]): PricePoint[] {
  const events: SorobanEvent[] = points.map((p) => ({
    id: p.event.id,
    type: 'OfferListed',
    contractId: 'C1',
    ledger: 1,
    timestamp: p.timestamp,
    data: { price_xlm: String(p.price) },
  }));
  const series = buildHistory(events);
  return Object.values(series).flat();
}
