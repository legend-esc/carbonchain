import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CreditStatus, type CreditMetadata } from '@shared';

import { CreditStore } from './credit.store';
import { MarketplaceStore } from './marketplace.store';
import { ApiService } from '../services/api.service';
import { ToastService } from '../services/toast.service';
import { StellarWalletService } from '../services/stellar-wallet.service';
import { networkSignal, walletAddressSignal } from '../services/wallet-state.signals';
import { EMPTY_SCOPE_KEY, activeScopeKey, walletScopeKey } from './wallet-scope';

/**
 * Issue #965 — store cache leaks across (network, address) boundaries.
 *
 * Acceptance criterion: "user A loads the portfolio → switch to B → no A rows
 * remain." These tests drive the real wallet service (the source of the
 * address/network signals) and assert on the store contents that a component
 * would render.
 */

const USER_A = 'GAAAAAAAACCEPTANCE1';
const USER_B = 'GBBBBBBBBBBBBBBBBB';
const PROJECT = 'proj-1';

function credit(id: string, owner: string): CreditMetadata {
  return {
    id,
    project_id: PROJECT,
    issuer: 'GISSUER',
    owner,
    vintage_year: 2024,
    methodology: 'VCS',
    geography: 'NG',
    tonnes: '1000000',
    ipfs_hash: 'bafy',
    status: CreditStatus.Active,
    issued_at: 1700000000,
  };
}

const CREDITS: Record<string, CreditMetadata> = {
  'credit-a1': credit('credit-a1', USER_A),
  'credit-a2': credit('credit-a2', USER_A),
  'credit-b1': credit('credit-b1', USER_B),
};

const OFFERS = {
  a: { id: 'offer-a', seller: USER_A, credit_id: 'credit-a1', price_xlm: '10000000', status: 'open' },
  b: { id: 'offer-b', seller: USER_B, credit_id: 'credit-b1', price_xlm: '20000000', status: 'open' },
} as never;

describe('Issue #965 — cache keyed by (network, address)', () => {
  let wallet: StellarWalletService;
  let api: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    localStorage.clear();
    walletAddressSignal.set(null);
    networkSignal.set(null);

    api = {
      listCreditsByProject: vi.fn().mockReturnValue(of([])),
      listCreditsByOwner: vi
        .fn()
        .mockImplementation((owner: string) => of({ data: Object.keys(CREDITS).filter((id) => CREDITS[id as keyof typeof CREDITS].owner === owner), offset: 0, limit: 50 })),
      getCredit: vi.fn().mockImplementation((id: string) => of(CREDITS[id as keyof typeof CREDITS])),
      getListings: vi.fn().mockReturnValue(of({ data: [], total: 0, page: 1, pageSize: 20 })),
      getOffersBySeller: vi
        .fn()
        .mockImplementation((seller: string) => of(seller === USER_A ? ['1'] : ['2'])),
      getOffer: vi.fn().mockImplementation((id: number) => of(id === 1 ? OFFERS.a : OFFERS.b)),
    };

    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: ToastService, useValue: { showError: vi.fn(), showSuccess: vi.fn() } },
      ],
    });
    wallet = TestBed.inject(StellarWalletService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    delete (window as { freighter?: unknown }).freighter;
  });

  /** Simulate the user switching the connected account inside the wallet. */
  function mockWallet(address: string, network: 'testnet' | 'mainnet' = 'testnet') {
    (window as { freighter?: unknown }).freighter = {
      isConnected: async () => true,
      getPublicKey: async () => address,
      getNetworkDetails: async () => ({
        network: network === 'mainnet' ? 'PUBLIC' : 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
      }),
    };
  }

  async function connect(address: string, network: 'testnet' | 'mainnet' = 'testnet') {
    mockWallet(address, network);
    await wallet.connect();
  }

  it('derives a stable, injective key from the (network, address) pair', () => {
    expect(walletScopeKey('testnet', USER_A)).toBe(`testnet:${USER_A}`);
    expect(walletScopeKey('mainnet', USER_A)).not.toBe(walletScopeKey('testnet', USER_A));
    expect(walletScopeKey(null, USER_A)).toBe(EMPTY_SCOPE_KEY);
    expect(walletScopeKey('testnet', null)).toBe(EMPTY_SCOPE_KEY);
  });

  it('publishes the active scope from the wallet address and network', async () => {
    expect(activeScopeKey()).toBe(EMPTY_SCOPE_KEY);
    await connect(USER_A, 'testnet');
    expect(activeScopeKey()).toBe(`testnet:${USER_A}`);
    await connect(USER_A, 'mainnet');
    expect(activeScopeKey()).toBe(`mainnet:${USER_A}`);
  });

  it('emits scopeChanged$ when the account changes', async () => {
    const seen: string[] = [];
    const sub = wallet.scopeChanged$.subscribe((k) => seen.push(k));
    await connect(USER_A);
    await connect(USER_B);
    sub.unsubscribe();
    expect(seen).toEqual([`testnet:${USER_A}`, `testnet:${USER_B}`]);
  });

  it('emits addressChanged$ when the account changes', async () => {
    const seen: (string | null)[] = [];
    const sub = wallet.addressChanged$.subscribe((a) => seen.push(a));
    await connect(USER_A);
    await connect(USER_B);
    sub.unsubscribe();
    expect(seen).toEqual([USER_A, USER_B]);
  });

  it('emits networkChanged$ when the network changes for the same account', async () => {
    const seen: (string | null)[] = [];
    const sub = wallet.networkChanged$.subscribe((n) => seen.push(n));
    await connect(USER_A, 'testnet');
    await connect(USER_A, 'mainnet');
    sub.unsubscribe();
    expect(seen).toEqual(['testnet', 'mainnet']);
  });

  // ── The acceptance criterion ───────────────────────────────────────────────

  it('credit store: user A loads the portfolio, switches to B, no A rows remain', async () => {
    await connect(USER_A);
    const store = TestBed.runInInjectionContext(() => TestBed.inject(CreditStore));

    await TestBed.runInInjectionContext(() => store.loadByOwner(USER_A));
    expect(store.credits().map((c) => c.id)).toEqual(['credit-a1', 'credit-a2']);
    expect(store.cacheKey()).toBe(`testnet:${USER_A}`);

    await connect(USER_B);

    // Before the reload resolves, the previous account's rows are already gone.
    expect(store.credits()).toEqual([]);
    expect(store.cacheKey()).toBeNull();

    await TestBed.runInInjectionContext(() => store.loadByOwner(USER_B));
    expect(store.credits().map((c) => c.id)).toEqual(['credit-b1']);
    expect(store.credits().every((c) => c.owner === USER_B)).toBe(true);
  });

  it('credit store: switching network for the same account also clears the cache', async () => {
    await connect(USER_A, 'testnet');
    const store = TestBed.runInInjectionContext(() => TestBed.inject(CreditStore));
    await TestBed.runInInjectionContext(() => store.loadByOwner(USER_A));
    expect(store.credits().length).toBe(2);

    await connect(USER_A, 'mainnet');

    expect(store.credits()).toEqual([]);
  });

  it('credit store: disconnecting clears the cache', async () => {
    await connect(USER_A);
    const store = TestBed.runInInjectionContext(() => TestBed.inject(CreditStore));
    await TestBed.runInInjectionContext(() => store.loadByOwner(USER_A));
    expect(store.credits().length).toBe(2);

    wallet.disconnect();

    expect(store.credits()).toEqual([]);
    expect(store.cacheKey()).toBeNull();
  });

  it('marketplace store: no seller rows leak across an account switch', async () => {
    await connect(USER_A);
    const store = TestBed.runInInjectionContext(() => TestBed.inject(MarketplaceStore));

    await TestBed.runInInjectionContext(() => store.loadOffersBySeller(USER_A));
    expect(store.offers().map((o) => o.id)).toEqual(['offer-a']);

    await connect(USER_B);
    expect(store.offers()).toEqual([]);

    await TestBed.runInInjectionContext(() => store.loadOffersBySeller(USER_B));
    expect(store.offers().map((o) => o.id)).toEqual(['offer-b']);
    expect(store.offers().every((o) => o.seller === USER_B)).toBe(true);
  });

  it('drops a response that lands after the account changed mid-flight', async () => {
    await connect(USER_A);
    const store = TestBed.runInInjectionContext(() => TestBed.inject(CreditStore));

    // Start A's request, then switch to B before the response is consumed.
    const pending = TestBed.runInInjectionContext(() => store.loadByOwner(USER_A));
    await connect(USER_B);
    await pending;

    // A's data arrived too late and must not be published under B's scope.
    expect(store.credits()).toEqual([]);
    expect(store.cacheKey()).toBeNull();
  });

  it('never files another account\'s rows even if the API returns them', async () => {
    await connect(USER_A);
    // A misbehaving API hands back B's credit under A's request.
    api.getCredit.mockImplementation((id: string) => of(CREDITS['credit-b1']));
    api.listCreditsByOwner.mockReturnValue(of({ data: ['credit-b1'], offset: 0, limit: 50 }));

    const store = TestBed.runInInjectionContext(() => TestBed.inject(CreditStore));
    await TestBed.runInInjectionContext(() => store.loadByOwner(USER_A));

    expect(store.credits()).toEqual([]);
  });
});
