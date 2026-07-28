import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { MarketplaceComponent } from './marketplace.component';
import { ApiService } from '../core/services/api.service';
import { AuthService } from '../core/services/auth.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';
import { ToastService } from '../core/services/toast.service';
import { Offer } from '@shared';

const makeOffer = (overrides: Partial<Offer> = {}): Offer => ({
  id: '1',
  seller: 'GSELLER1234567890',
  credit_id: 'abc123def456789',
  price_xlm: '10000000',
  tonnes_available: '2000000',
  created_at: 1700000000,
  status: 'open',
  methodology: 'VCS',
  ...overrides,
});

const MOCK_OFFERS: Offer[] = [
  makeOffer({ id: '1', credit_id: 'cred1abc', methodology: 'VCS' }),
  makeOffer({ id: '2', credit_id: 'cred2def', methodology: 'REDD+', tonnes_available: '500000' }),
  makeOffer({ id: '3', credit_id: 'cred3ghi', methodology: 'VCS', status: 'filled' }),
];

describe('MarketplaceComponent', () => {
  let fixture: ComponentFixture<MarketplaceComponent>;
  let component: MarketplaceComponent;
  let apiMock: ReturnType<typeof buildApiMock>;
  let toastMock: { show: ReturnType<typeof vi.fn> };

  function buildApiMock() {
    return {
      getListings: vi.fn().mockReturnValue(of(MOCK_OFFERS)),
      createOffer: vi.fn().mockReturnValue(of({ offerId: 'new-offer' })),
    };
  }

  const authMock = {
    isAuthenticated: signal(true).asReadonly(),
    token: signal('jwt-token').asReadonly(),
  };

  const walletMock = {
    publicKey: signal<string | null>('GPUBKEY').asReadonly(),
    getNetworkDetails: vi.fn().mockResolvedValue({ networkPassphrase: 'Test SDF Network ; September 2015' }),
  };

  beforeEach(async () => {
    apiMock = buildApiMock();
    toastMock = { show: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [MarketplaceComponent],
      providers: [
        provideRouter([]),
        { provide: ApiService, useValue: apiMock },
        { provide: AuthService, useValue: authMock },
        { provide: StellarWalletService, useValue: walletMock },
        { provide: ToastService, useValue: toastMock },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(MarketplaceComponent);
    component = fixture.componentInstance;
  });

  it('creates the component', () => {
    expect(component).toBeTruthy();
  });

  it('loads listings on init', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(apiMock.getListings).toHaveBeenCalledTimes(1);
  });

  it('renders only open offers in the table', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr') as NodeListOf<HTMLTableRowElement>;
    // MOCK_OFFERS has 2 open and 1 filled; filter shows only open
    expect(rows.length).toBe(2);
  });

  it('shows all required columns in the header', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const headerText = (fixture.nativeElement.querySelector('thead') as HTMLElement).textContent ?? '';
    expect(headerText).toContain('Credit ID');
    expect(headerText).toContain('Project');
    expect(headerText).toContain('Vintage');
    expect(headerText).toContain('Methodology');
    expect(headerText).toContain('Tonnes');
    expect(headerText).toContain('Price');
    expect(headerText).toContain('Status');
    expect(headerText).toContain('Action');
  });

  it('shows loading skeleton while fetching', () => {
    // Keep loading true by returning a never-resolving observable wrapper
    let resolve!: (v: Offer[]) => void;
    const pending = new Promise<Offer[]>((r) => (resolve = r));
    apiMock.getListings.mockReturnValue({ subscribe: (obs: any) => { pending.then((v) => obs.next(v)).catch(() => {}); return { unsubscribe: () => {} }; } });

    // Don't wait — just check during loading
    component.isLoading.set(true);
    fixture.detectChanges();

    const skeleton = fixture.nativeElement.querySelector('.skeleton-wrapper') as HTMLElement;
    expect(skeleton).toBeTruthy();
    resolve([]); // cleanup
  });

  it('shows error toast and message on API failure', async () => {
    apiMock.getListings.mockReturnValue(throwError(() => new Error('Network error')));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(toastMock.show).toHaveBeenCalledWith('Network error', 'error');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Network error');
  });

  it('filters by methodology', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.filters.methodology = 'REDD+';
    component.applyFilters();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('tbody tr') as NodeListOf<HTMLTableRowElement>;
    expect(rows.length).toBe(1);
  });

  it('resets filters correctly', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.filters.methodology = 'REDD+';
    component.applyFilters();
    fixture.detectChanges();
    expect(component.filteredOffers().length).toBe(1);

    component.resetFilters();
    fixture.detectChanges();
    expect(component.filteredOffers().length).toBe(2); // 2 open offers
  });

  it('hasActiveFilters returns true when filters are set', () => {
    component.filters.methodology = 'VCS';
    component.applyFilters();
    expect(component.hasActiveFilters()).toBe(true);
  });

  it('hasActiveFilters returns false when no filters are set', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.hasActiveFilters()).toBe(false);
  });

  it('pagination: nextPage and prevPage update currentPage', async () => {
    // Create 12 open offers to get 2 pages
    const manyOffers = Array.from({ length: 12 }, (_, i) => makeOffer({ id: String(i) }));
    apiMock.getListings.mockReturnValue(of(manyOffers));

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.currentPage()).toBe(0);
    component.nextPage();
    expect(component.currentPage()).toBe(1);
    component.prevPage();
    expect(component.currentPage()).toBe(0);
  });

  it('prevPage does not go below 0', () => {
    expect(component.currentPage()).toBe(0);
    component.prevPage();
    expect(component.currentPage()).toBe(0);
  });

  it('nextPage does not exceed totalPages - 1', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    const total = component.totalPages();
    component.currentPage.set(total - 1);
    component.nextPage();
    expect(component.currentPage()).toBe(total - 1);
  });

  it('buy() calls createOffer and shows success toast', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const offer = MOCK_OFFERS[0];
    await component.buy(offer);

    expect(apiMock.createOffer).toHaveBeenCalled();
    expect(toastMock.show).toHaveBeenCalledWith('Purchase submitted successfully!', 'success');
  });

  it('buy() shows error toast on failure', async () => {
    apiMock.createOffer.mockReturnValue(throwError(() => new Error('Insufficient funds')));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await component.buy(MOCK_OFFERS[0]);

    expect(toastMock.show).toHaveBeenCalledWith('Insufficient funds', 'error');
  });

  it('buy() shows error toast when wallet not connected', async () => {
    const noWalletMock = {
      publicKey: signal<string | null>(null).asReadonly(),
      getNetworkDetails: vi.fn(),
    };
    TestBed.overrideProvider(StellarWalletService, { useValue: noWalletMock });

    fixture = TestBed.createComponent(MarketplaceComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    await fixture.whenStable();

    await component.buy(MOCK_OFFERS[0]);
    expect(toastMock.show).toHaveBeenCalledWith('Please connect your wallet first.', 'error');
  });

  it('formatTonnes converts correctly', () => {
    expect(component.formatTonnes('2000000')).toBe('2 t');
  });

  it('formatXlm converts correctly', () => {
    expect(component.formatXlm('10000000')).toBe('1 XLM');
  });

  it('shows auth prompt when not authenticated', () => {
    TestBed.overrideProvider(AuthService, {
      useValue: { isAuthenticated: signal(false), token: signal(null) },
    });
    fixture = TestBed.createComponent(MarketplaceComponent);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Credit ID');
  });
});
