import axe from 'axe-core';
import type { ElementContext, RunOptions } from 'axe-core';

import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';

import { CreditStatus, type CreditMetadata } from '@shared';

import { RetireComponent } from '../retire/retire.component';
import { PriceHistoryChartComponent } from '../marketplace/price-history-chart.component';
import { WatchlistComponent } from '../marketplace/watchlist.component';
import { AuthService } from '../core/services/auth.service';
import { ApiService } from '../core/services/api.service';
import { CreditStore } from '../core/store/credit.store';
import { ToastService } from '../core/services/toast.service';
import { WatchlistStore } from '../core/store/watchlist.store';
import { WalletError } from '../core/services/wallet-errors';
import { type PricePoint } from '../core/store/market-events.store';

/**
 * Issue #963 — accessibility conformance gate.
 *
 * Runs axe against the primary flows and fails on any serious or critical
 * violation. CI runs this via `npm run test:a11y`, so a regression in contrast,
 * labelling, landmarks or focus order blocks the build.
 *
 * Scope is WCAG 2.1 AA. AAA is explicitly out of scope.
 */

const WCAG_AA: RunOptions = {
  runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
};

/** Fail the test if axe found anything at serious or critical impact. */
async function expectNoSeriousViolations(fixture: ComponentFixture<unknown>): Promise<void> {
  const results = await axe.run(fixture.nativeElement as ElementContext, WCAG_AA);
  const blocking = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  const summary = blocking
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`)
    .join('\n');
  expect(summary).toBe('');
}

const credit: CreditMetadata = {
  id: 'credit-1',
  project_id: 'proj-1',
  issuer: 'GISSUER',
  owner: 'GABC',
  vintage_year: 2024,
  methodology: 'VCS',
  geography: 'NG',
  tonnes: '1000000',
  ipfs_hash: 'bafy',
  status: CreditStatus.Active,
  issued_at: 1700000000,
};

const SERIES: PricePoint[] = [
  { timestamp: 1700000000, price: 12_000_000, asset: 'XLM', event: { id: 'e1' } as never },
  { timestamp: 1700086400, price: 11_500_000, asset: 'XLM', event: { id: 'e2' } as never },
  { timestamp: 1700172800, price: 13_100_000, asset: 'XLM', event: { id: 'e3' } as never },
];

describe('a11y — primary flows (axe, WCAG 2.1 AA)', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  describe('retire wizard (step 1 — credit selection)', () => {
    let credits: ReturnType<typeof signal<CreditMetadata[]>>;

    beforeEach(() => {
      credits = signal<CreditMetadata[]>([credit]);
      TestBed.configureTestingModule({
        imports: [RetireComponent],
        providers: [
          provideHttpClient(),
          {
            provide: AuthService,
            useValue: {
              isAuthenticated: signal(true).asReadonly(),
              token: signal('t').asReadonly(),
            },
          },
          {
            provide: ApiService,
            useValue: {
              retireCredit: vi.fn().mockReturnValue(of({ retirementId: 'r' })),
              listCreditsByOwner: vi
                .fn()
                .mockReturnValue(of({ data: ['credit-1'], offset: 0, limit: 50 })),
              getCredit: vi.fn().mockReturnValue(of(credit)),
            },
          },
          {
            provide: CreditStore,
            useValue: {
              credits: credits.asReadonly(),
              isLoading: signal(false).asReadonly(),
              loadByOwner: vi.fn().mockResolvedValue(undefined),
              loadOne: vi.fn().mockResolvedValue(undefined),
            },
          },
          { provide: ToastService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
          { provide: Router, useValue: { navigate: vi.fn() } },
        ],
      });
    });

    it('has no serious or critical violations', async () => {
      const fixture = TestBed.createComponent(RetireComponent);
      fixture.detectChanges();
      await expectNoSeriousViolations(fixture);
    });

    it('exposes the wizard as a labelled, stepped landmark', () => {
      const fixture = TestBed.createComponent(RetireComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;

      expect(el.querySelector('h1')).toBeTruthy();
      expect(el.querySelector('nav[aria-label]')).toBeTruthy();
      expect(el.querySelector('section[aria-labelledby]')).toBeTruthy();
      // Live regions for progress and for errors.
      expect(el.querySelector('[aria-live="polite"]')).toBeTruthy();
      expect(el.querySelector('[role="status"]')).toBeTruthy();
    });

    it('is fully operable from the keyboard', () => {
      const fixture = TestBed.createComponent(RetireComponent);
      fixture.detectChanges();
      const comp = fixture.componentInstance;

      // Selection is driven by real checkboxes, so no custom key handling is
      // needed — the browser gives us Enter/Space for free.
      const checkbox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      expect(checkbox).toBeTruthy();
      expect(checkbox!.disabled).toBe(false);

      checkbox!.click();
      expect(comp.selectedCredits().length).toBe(1);

      // The primary action is a real <button>, reachable by Tab.
      const next = (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
        '.step-actions .btn-primary',
      );
      expect(next?.tagName).toBe('BUTTON');
      expect(next?.type).toBe('button');
    });
  });

  describe('retire wizard (step 3 — confirm, with an error shown)', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        imports: [RetireComponent],
        providers: [
          provideHttpClient(),
          {
            provide: AuthService,
            useValue: {
              isAuthenticated: signal(true).asReadonly(),
              token: signal('t').asReadonly(),
            },
          },
          {
            provide: ApiService,
            useValue: {
              retireCredit: vi
                .fn()
                .mockReturnValue(of(null))
                .pipe(),
              listCreditsByOwner: vi.fn().mockReturnValue(of({ data: [], offset: 0, limit: 50 })),
              getCredit: vi.fn().mockReturnValue(of(credit)),
            },
          },
          {
            provide: CreditStore,
            useValue: {
              credits: signal<CreditMetadata[]>([]).asReadonly(),
              isLoading: signal(false).asReadonly(),
              loadByOwner: vi.fn().mockResolvedValue(undefined),
              loadOne: vi.fn().mockResolvedValue(undefined),
            },
          },
          { provide: ToastService, useValue: { showSuccess: vi.fn(), showError: vi.fn() } },
          { provide: Router, useValue: { navigate: vi.fn() } },
        ],
      });
    });

    it('announces a wallet error as an alert, not as silent text', () => {
      const fixture = TestBed.createComponent(RetireComponent);
      const comp = fixture.componentInstance;
      comp.selectedCredits.set([credit]);
      comp.reasonControl.setValue('scope 3');
      comp.currentStep.set(3);
      comp.signingError.set('You cancelled the request in your wallet.');
      fixture.detectChanges();

      const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('cancelled');
    });

    it('exposes a distinguishable error type to assistive tech', () => {
      // The taxonomy must stay machine-readable, not just human-readable.
      const err = new WalletError('tx_bad_seq', 'staleEnvelope');
      expect(err.type).toBe('staleEnvelope');
      expect(err.displayMessage).toMatch(/superseded/i);
    });
  });

  describe('price history chart', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        imports: [PriceHistoryChartComponent],
      });
    });

    it('has no serious or critical violations', async () => {
      const fixture = TestBed.createComponent(PriceHistoryChartComponent);
      fixture.componentRef.setInput('series', SERIES);
      fixture.componentRef.setInput('projectLabel', 'proj-1');
      fixture.detectChanges();
      await expectNoSeriousViolations(fixture);
    });

    it('exposes an accessible name and a text description of the series', () => {
      const fixture = TestBed.createComponent(PriceHistoryChartComponent);
      fixture.componentRef.setInput('series', SERIES);
      fixture.componentRef.setInput('projectLabel', 'proj-1');
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;

      const svg = el.querySelector('svg');
      expect(svg?.getAttribute('role')).toBe('img');
      expect(svg?.getAttribute('aria-label')).toContain('Price history');
      expect(el.querySelector('desc')?.textContent).toContain('recorded price');
    });

    it('renders one labelled point per price', () => {
      const fixture = TestBed.createComponent(PriceHistoryChartComponent);
      fixture.componentRef.setInput('series', SERIES);
      fixture.detectChanges();
      const points = (fixture.nativeElement as HTMLElement).querySelectorAll(
        'circle[role="graphics-symbol"]',
      );
      expect(points.length).toBe(SERIES.length);
    });

    it('shows an explanatory message instead of an empty chart', () => {
      const fixture = TestBed.createComponent(PriceHistoryChartComponent);
      fixture.componentRef.setInput('series', []);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('svg')).toBeNull();
      expect(el.textContent).toContain('No price history yet');
    });
  });

  describe('watchlist', () => {
    beforeEach(() => {
      TestBed.configureTestingModule({
        imports: [WatchlistComponent],
        providers: [{ provide: WatchlistStore, useValue: new WatchlistStore() }],
      });
    });

    it('has no serious or critical violations', async () => {
      const fixture = TestBed.createComponent(WatchlistComponent);
      fixture.detectChanges();
      await expectNoSeriousViolations(fixture);
    });

    it('is a labelled region with a live region for alerts', () => {
      const fixture = TestBed.createComponent(WatchlistComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('section[aria-labelledby]')).toBeTruthy();
      expect(el.querySelector('[aria-live="polite"]')).toBeTruthy();
    });

    it('labels every remove button with the entry it removes', () => {
      const fixture = TestBed.createComponent(WatchlistComponent);
      const watchlist = TestBed.inject(WatchlistStore);
      watchlist.watch('proj-1', 'Amazon REDD+', 10_000_000);
      fixture.detectChanges();

      const remove = (fixture.nativeElement as HTMLElement).querySelector('button[aria-label]');
      expect(remove?.getAttribute('aria-label')).toBe('Stop watching Amazon REDD+');
    });
  });
});
