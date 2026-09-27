import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { of, throwError, Subject } from 'rxjs';
import { MarketplaceListComponent } from './marketplace-list.component';
import { MarketplaceStore } from '../core/store/marketplace.store';
import { Offer } from '@shared';

const mockOffer: Offer = {
  id: '1',
  seller: 'GTEST1234567890',
  credit_id: 'abc123def456',
  price_xlm: '10000000',
  tonnes_available: '2000000',
  created_at: 1700000000,
  status: 'open',
};

function createStoreMock(offers: Offer[] = [], errorMsg: string | null = null) {
  const _offers = signal<Offer[]>(offers);
  const _error = signal<string | null>(errorMsg);
  const _loading = signal(false);
  const _page = signal(1);
  const _total = signal(offers.length);

  return {
    activeOffers: _offers.asReadonly(),
    error: _error.asReadonly(),
    isLoading: computed(() => _loading()),
    page: _page.asReadonly(),
    total: _total.asReadonly(),
    totalPages: computed(() => Math.max(1, Math.ceil(_total() / 20))),
    totalActiveOffers: computed(() => _total()),
    loadListings: vi.fn().mockResolvedValue(undefined),
    applyFilters: vi.fn().mockResolvedValue(undefined),
    nextPage: vi.fn().mockResolvedValue(undefined),
    prevPage: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
  };
}

describe('MarketplaceListComponent', () => {
  let fixture: ComponentFixture<MarketplaceListComponent>;
  let component: MarketplaceListComponent;
  let storeMock: ReturnType<typeof createStoreMock>;

  beforeEach(async () => {
    storeMock = createStoreMock();

    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [{ provide: MarketplaceStore, useValue: storeMock }],
    }).compileComponents();

    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
  });

  it('shows "No active listings" when empty', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('No active listings');
  });

  it('calls loadListings on init', async () => {
    fixture.detectChanges();
    await fixture.whenStable();

    expect(storeMock.loadListings).toHaveBeenCalledWith(1, expect.objectContaining({}));
  });

  it('renders offers in a table when store has offers', async () => {
    storeMock = createStoreMock([mockOffer]);
    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [{ provide: MarketplaceStore, useValue: storeMock }],
    }).compileComponents();

    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr') as NodeList;
    expect(rows.length).toBe(1);
  });

  it('shows error message when store has an error', async () => {
    storeMock = createStoreMock([], 'Network error');
    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [{ provide: MarketplaceStore, useValue: storeMock }],
    }).compileComponents();

    fixture = TestBed.createComponent(MarketplaceListComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Network error');
  });

  it('emits offerSelected when a row is clicked', async () => {
    storeMock = createStoreMock([mockOffer]);
    await TestBed.configureTestingModule({
      imports: [MarketplaceListComponent],
      providers: [{ provide: MarketplaceStore, useValue: storeMock }],
    }).compileComponents();

    fixture = TestBed.createComponent(MarketplaceListComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    let emitted: Offer | undefined;
    component.offerSelected.subscribe((o: Offer) => (emitted = o));

    const row = fixture.nativeElement.querySelector('tbody tr') as HTMLElement;
    row.click();

    expect(emitted).toEqual(mockOffer);
  });

  it('formats tonnes correctly', () => {
    expect(component.formatTonnes('2000000')).toBe('2 t');
  });

  it('formats price correctly for XLM', () => {
    expect(component.formatPrice({ ...mockOffer, payment_asset_code: 'XLM', price_raw: '10000000' })).toBe('1 XLM');
  });

  // #340 — pagination boundary tests
  describe('pagination boundary conditions', () => {
    it('empty state: shows "No active listings" and no table when 0 listings', async () => {
      apiSpy.getListings.mockReturnValue(of([]));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const text = fixture.nativeElement.textContent as string;
      expect(text).toContain('No active listings');
      expect(fixture.nativeElement.querySelector('table')).toBeNull();
    });

    it('last page: renders exactly the returned rows when fewer items than a full page', async () => {
      const partialPage = [mockOffer, { ...mockOffer, id: '2' }, { ...mockOffer, id: '3' }];
      apiSpy.getListings.mockReturnValue(of(partialPage));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const rows = fixture.nativeElement.querySelectorAll('tbody tr') as NodeList;
      expect(rows.length).toBe(3);
    });

    it('refresh button is disabled while loading', () => {
      // Keep isLoading true by never resolving the observable
      apiSpy.getListings.mockReturnValue(new Subject());
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement;
      expect(btn.disabled).toBeTruthy();
    });

    it('refresh button is enabled after load completes', async () => {
      apiSpy.getListings.mockReturnValue(of([mockOffer]));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();

      const btn = fixture.nativeElement.querySelector('.btn-primary') as HTMLButtonElement;
      expect(btn.disabled).toBeFalsy();
    });
  });
});
