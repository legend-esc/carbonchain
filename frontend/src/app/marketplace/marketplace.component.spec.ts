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
      getListingsCursor: vi.fn().mockImplementation((params: Record<string, string> = {}) => {
        const data = MOCK_OFFERS.filter(
          (o) => !params['methodology'] || o.methodology === params['methodology'],
        );
        return of({ data, next_cursor: null });
      }),
      createOffer: vi.fn().mockReturnValue(of({ offerId: 'new-offer' })),
      buyOffer: vi.fn().mockReturnValue(of(undefined)),
    };
  }

  const authMock = {
    isAuthenticated: signal(true),
    token: signal('jwt-token'),
    authState: signal('authenticated' as const),
    authError: signal<string | null>(null),
    logout: vi.fn(),
  };

  const walletMock = {
    publicKey: signal<string | null>('GPUBKEY'),
    isConnected: signal(true).asReadonly(),
    state: signal('connected' as const).asReadonly(),
    startBalancePolling: vi.fn(),
    stopBalancePolling: vi.fn(),
    getNetworkDetails: vi
      .fn()
      .mockResolvedValue({ networkPassphrase: 'Test SDF Network ; September 2015' }),
  };

  beforeEach(async () => {
    apiMock = buildApiMock();
    toastMock = { show: vi.fn() };

    TestBed.resetTestingModule();
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

    expect(apiMock.getListingsCursor).toHaveBeenCalledTimes(1);
  });

  it('renders the returned offers in the table', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll(
      'tbody tr',
    ) as NodeListOf<HTMLTableRowElement>;
    expect(rows.length).toBe(3);
  });

  it('shows all required columns in the header', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const headerText =
      (fixture.nativeElement.querySelector('thead') as HTMLElement).textContent ?? '';
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
    component.isLoading.set(true);
    fixture.detectChanges();

    const skeleton = fixture.nativeElement.querySelector('.skeleton-wrapper') as HTMLElement;
    expect(skeleton).toBeTruthy();
    component.isLoading.set(false); // cleanup
  });

  it('shows error toast and message on API failure', async () => {
    apiMock.getListingsCursor.mockReturnValue(throwError(() => new Error('Network error')));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(toastMock.show).toHaveBeenCalledWith('Network error', 'error');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Network error');
  });

  it('filters by methodology via the API', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.filters.methodology = 'REDD+';
    component.applyFilters();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(apiMock.getListingsCursor).toHaveBeenCalledWith(
      expect.objectContaining({ methodology: 'REDD+' }),
    );
    expect(component.visibleOffers().length).toBe(1);
  });

  it('resets filters correctly', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.filters.methodology = 'REDD+';
    component.applyFilters();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.visibleOffers().length).toBe(1);

    component.resetFilters();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(component.visibleOffers().length).toBe(3);
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

  it('loadMore appends the next cursor page', async () => {
    apiMock.getListingsCursor
      .mockReturnValueOnce(of({ data: MOCK_OFFERS.slice(0, 2), next_cursor: 'cursor-2' }))
      .mockReturnValueOnce(of({ data: [makeOffer({ id: '9' })], next_cursor: null }));

    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.visibleOffers().length).toBe(2);
    expect(component.hasMore()).toBe(true);

    await component.loadMore();

    expect(component.visibleOffers().length).toBe(3);
    expect(component.hasMore()).toBe(false);
    expect(apiMock.getListingsCursor).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'cursor-2' }),
    );
  });

  it('loadMore is a no-op when there is no cursor', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(component.hasMore()).toBe(false);
    await component.loadMore();

    expect(apiMock.getListingsCursor).toHaveBeenCalledTimes(1);
  });

  it('buy() calls createOffer and shows success toast', async () => {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const offer = MOCK_OFFERS[0];
    await component.buy(offer);

    expect(apiMock.buyOffer).toHaveBeenCalled();
    expect(toastMock.show).toHaveBeenCalledWith('Purchase submitted successfully!', 'success');
  });

  it('buy() shows error toast on failure', async () => {
    apiMock.buyOffer.mockReturnValue(throwError(() => new Error('Insufficient funds')));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    await component.buy(MOCK_OFFERS[0]);

    expect(toastMock.show).toHaveBeenCalledWith('Insufficient funds', 'error');
  });

  it('buy() shows error toast when wallet not connected', async () => {
    walletMock.publicKey.set(null);
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
    authMock.isAuthenticated.set(false);
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Credit ID');
  });
});
