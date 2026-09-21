import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of } from 'rxjs';

import { routes } from '../app.routes';
import { ApiService } from './services/api.service';
import { AuthService } from './services/auth.service';
import { CreditStore } from './store/credit.store';
import { OnlineStatusService } from './services/online-status.service';
import { StellarWalletService } from './services/stellar-wallet.service';
import { ToastService } from './services/toast.service';
import { TranslationService, interpolate, Locale } from './services/translation.service';

import en from '../../assets/i18n/en.json';
import es from '../../assets/i18n/es.json';
import fr from '../../assets/i18n/fr.json';

const CATALOGS: Record<Locale, Record<string, string>> = { en, es, fr };

/** Every routed component — the smoke test renders each one per locale. */
const ROUTE_CASES: { name: string; url: string }[] = [
  { name: 'connect-wallet', url: '/connect-wallet' },
  { name: 'offline', url: '/offline' },
  { name: 'dashboard', url: '/dashboard' },
  { name: 'marketplace', url: '/marketplace' },
  { name: 'retire wizard', url: '/retire' },
  { name: 'credit detail', url: '/credits/credit-001' },
  { name: 'projects list', url: '/projects' },
  { name: 'project detail', url: '/projects/proj-001' },
  { name: 'admin panel', url: '/admin' },
  { name: 'certificate', url: '/certificates/ret-001' },
];

const PUBLIC_KEY = 'GPUBKEY1234567890ABCDEF';
const MOCK_TOKEN = 'header.eyJyb2xlIjoiYWRtaW4ifQ.sig'; // role: admin

const MOCK_CREDIT = {
  id: 'credit-001',
  project_id: 'proj-001',
  issuer: 'GISSUER',
  owner: PUBLIC_KEY,
  vintage_year: 2023,
  methodology: 'VCS',
  geography: 'BR',
  tonnes: '2000000',
  ipfs_hash: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  status: 'Active',
  issued_at: 1700000000,
};

const MOCK_PROJECT = {
  id: 'proj-001',
  name: 'Amazon Reforestation',
  developer: 'GreenDev',
  location: 'BR',
  methodology: 'VCS',
  description: 'Reforestation project',
  documents_cid: null,
};

const MOCK_RETIREMENT = {
  id: 'ret-001',
  credit_id: 'credit-001',
  buyer: PUBLIC_KEY,
  tonnes_retired: '1000000',
  reason: 'Offset',
  retired_at: 1700100000,
  tx_hash: 'txhash123456',
};

function buildApiStub(): ApiService {
  const explicit: Record<string, unknown> = {
    getAdminStats: () =>
      of({ totalCredits: 0, totalRetirements: 0, activeVerifiers: 0, paused: false }),
    getMinStake: () => of({ minStake: '0' }),
    listVerifiers: () => of([]),
    getListingsCursor: () => of({ data: [], next_cursor: null }),
    getCredit: () => of(MOCK_CREDIT),
    getCreditProvenance: () => of([]),
    getProject: () => of(MOCK_PROJECT),
    listProjects: () => of([]),
    listCreditsByProject: () => of([]),
    getRetirement: () => of(MOCK_RETIREMENT),
  };
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => explicit[prop] ?? (() => of([])),
    },
  ) as unknown as ApiService;
}

function buildAuthStub(): AuthService {
  return {
    isAuthenticated: () => true,
    token: () => MOCK_TOKEN,
    authState: () => 'authenticated',
    authError: () => null,
    login: vi.fn(),
    logout: vi.fn(),
  } as unknown as AuthService;
}

function buildWalletStub(): StellarWalletService {
  return {
    publicKey: () => PUBLIC_KEY,
    isConnected: () => true,
    state: () => 'connected',
    network: () => 'testnet',
    networkMismatch: () => false,
    xlmBalance: () => null,
    error: () => null,
    isFreighterInstalled: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    startBalancePolling: vi.fn(),
    stopBalancePolling: vi.fn(),
    checkNetworkMatch: vi.fn(),
    getNetworkDetails: vi
      .fn()
      .mockResolvedValue({ networkPassphrase: 'Test SDF Network ; September 2015' }),
  } as unknown as StellarWalletService;
}

function buildStoreStub(): CreditStore {
  return {
    credits: signal([]),
    activeCredits: signal([]),
    retiredCredits: signal([]),
    totalTonnes: signal(0n),
    isLoading: signal(false),
    error: signal(null),
    selectedId: signal(null),
    selected: signal(null),
    loadByOwner: vi.fn().mockResolvedValue(undefined),
    loadByProject: vi.fn().mockResolvedValue(undefined),
    loadOne: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(),
  } as unknown as CreditStore;
}

/** Provides a TranslationService pre-seeded with the given locale's catalog. */
function buildTranslationProvider(locale: Locale) {
  const dict = CATALOGS[locale];
  return {
    provide: TranslationService,
    useValue: {
      locale: signal(locale).asReadonly(),
      locales: [],
      t: (key: string, params?: Record<string, string | number>) =>
        interpolate(dict[key] ?? key, params),
      setLocale: vi.fn(),
      init: vi.fn().mockResolvedValue(undefined),
    } as unknown as TranslationService,
  };
}

describe('locale smoke test', () => {
  it('defines the same non-empty key set in every active locale', () => {
    const canonical = Object.keys(CATALOGS.en).sort();
    for (const locale of ['es', 'fr'] as const) {
      const keys = Object.keys(CATALOGS[locale]).sort();
      expect(keys).toEqual(canonical);
      for (const key of canonical) {
        expect(CATALOGS[locale][key]).toBeTruthy();
      }
    }
  });

  for (const locale of ['en', 'es', 'fr'] as const) {
    describe(`renders routes in "${locale}"`, () => {
      beforeEach(async () => {
        await TestBed.configureTestingModule({
          providers: [
            provideRouter(routes),
            { provide: ApiService, useValue: buildApiStub() },
            { provide: AuthService, useValue: buildAuthStub() },
            { provide: StellarWalletService, useValue: buildWalletStub() },
            {
              provide: ToastService,
              useValue: {
                show: vi.fn(),
                showSuccess: vi.fn(),
                showError: vi.fn(),
                dismiss: vi.fn(),
              },
            },
            { provide: CreditStore, useValue: buildStoreStub() },
            { provide: OnlineStatusService, useValue: { online: signal(true) } },
            buildTranslationProvider(locale),
          ],
        }).compileComponents();
      });

      for (const route of ROUTE_CASES) {
        it(`${route.name} shows no raw translation keys`, async () => {
          const harness = await RouterTestingHarness.create(route.url);
          const fixture: ComponentFixture<unknown> = harness.fixture;
          await fixture.whenStable();
          fixture.detectChanges();

          const text = harness.routeNativeElement?.textContent ?? '';
          expect(text.trim().length).toBeGreaterThan(0);

          const dict = CATALOGS[locale];
          const leaked = Object.keys(dict).filter((key) => text.includes(key));
          expect(leaked).toEqual([]);
        });
      }
    });
  }
});
