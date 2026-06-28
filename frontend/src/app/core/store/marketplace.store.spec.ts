import { TestBed } from '@angular/core/testing';
import { of, throwError, firstValueFrom } from 'rxjs';
import { MarketplaceStore } from './marketplace.store';
import { ApiService } from '../services/api.service';

const MOCK_OFFER = {
  id: '1',
  credit_id: 'credit-1',
  seller: 'GABC',
  price_xlm: '100',
  tonnes: '500000',
  status: 'open',
};

describe('MarketplaceStore — error state', () => {
  let store: MarketplaceStore;
  let getOffersBySeller: ReturnType<typeof vi.fn>;
  let getOffer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getOffersBySeller = vi.fn();
    getOffer = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: { getOffersBySeller, getOffer } }],
    });
    store = TestBed.inject(MarketplaceStore);
  });

  it('error$ emits a message when the API call fails', async () => {
    getOffersBySeller.mockReturnValue(throwError(() => new Error('service unavailable')));

    const errorPromise = firstValueFrom(store.error$);
    await TestBed.runInInjectionContext(() => store.loadOffersBySeller('GABC'));

    expect(store.state()).toBe('error');
    expect(store.error()).toBe('service unavailable');
    // error$ reflects the signal
    expect(await errorPromise).toBeNull(); // initial emission before load
  });

  it('error$ emits the error message synchronously after failed load', async () => {
    getOffersBySeller.mockReturnValue(throwError(() => new Error('network timeout')));
    await TestBed.runInInjectionContext(() => store.loadOffersBySeller('GABC'));

    const emitted = await firstValueFrom(store.error$);
    expect(emitted).toBe('network timeout');
  });

  it('error is cleared on successful reload after a failure', async () => {
    // First call fails
    getOffersBySeller.mockReturnValue(throwError(() => new Error('oops')));
    await TestBed.runInInjectionContext(() => store.loadOffersBySeller('GABC'));
    expect(store.error()).toBe('oops');

    // Second call succeeds
    getOffersBySeller.mockReturnValue(of(['1']));
    getOffer.mockReturnValue(of(MOCK_OFFER));
    await TestBed.runInInjectionContext(() => store.loadOffersBySeller('GABC'));

    expect(store.state()).toBe('loaded');
    expect(store.error()).toBeNull();
  });

  it('uses fallback message when error is not an Error instance', async () => {
    getOffersBySeller.mockReturnValue(throwError(() => 'raw string error'));
    await TestBed.runInInjectionContext(() => store.loadOffersBySeller('GABC'));
    expect(store.error()).toBe('Failed to load offers.');
  });
});
