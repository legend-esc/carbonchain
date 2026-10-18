import axe from 'axe-core';
import type { ElementContext, RunOptions } from 'axe-core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { signal } from '@angular/core';

import { OfflineComponent } from '../offline/offline.component';
import { LocaleSwitcherComponent } from '../core/components/locale-switcher.component';
import { NetworkIndicatorComponent } from '../core/components/network-indicator.component';
import { OnlineStatusService } from '../core/services/online-status.service';
import { TranslationService } from '../core/services/translation.service';
import { StellarWalletService } from '../core/services/stellar-wallet.service';

/**
 * Basic accessibility test suite using axe-core in Vitest / Karma.
 * Validates baseline WCAG 2.1 AA conformance across core utility and UI components.
 */

const WCAG_AA_OPTIONS: RunOptions = {
  runOnly: {
    type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
  },
  rules: {
    // Color contrast measurement in simulated JSDOM requires browser layout engine
    'color-contrast': { enabled: false },
  },
};

/** Helper asserting zero critical or serious axe accessibility violations */
async function expectNoViolations(fixture: ComponentFixture<unknown>): Promise<void> {
  const results = await axe.run(fixture.nativeElement as ElementContext, WCAG_AA_OPTIONS);
  const blocking = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  const summary = blocking
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s) — ${v.help}`)
    .join('\n');
  expect(summary).toBe('');
}

describe('Basic A11y Suite — Core Components (axe-core, WCAG 2.1 AA)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  describe('OfflineComponent', () => {
    let mockRouter: { navigate: ReturnType<typeof vi.fn> };
    let onlineSignal: ReturnType<typeof signal<boolean>>;

    beforeEach(() => {
      mockRouter = { navigate: vi.fn() };
      onlineSignal = signal(false);

      TestBed.configureTestingModule({
        imports: [OfflineComponent],
        providers: [
          { provide: Router, useValue: mockRouter },
          {
            provide: OnlineStatusService,
            useValue: {
              online: onlineSignal.asReadonly(),
            },
          },
        ],
      });
    });

    it('has no critical or serious accessibility violations', async () => {
      const fixture = TestBed.createComponent(OfflineComponent);
      fixture.detectChanges();
      await expectNoViolations(fixture);
    });

    it('contains semantic main landmark and heading structure', () => {
      const fixture = TestBed.createComponent(OfflineComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;

      const main = el.querySelector('main');
      const h1 = el.querySelector('h1');
      const button = el.querySelector('button');

      expect(main).toBeTruthy();
      expect(h1).toBeTruthy();
      expect(h1?.textContent).toContain("You're offline");
      expect(button).toBeTruthy();
      expect(button?.textContent?.trim()).toBe('Retry');
    });
  });

  describe('LocaleSwitcherComponent', () => {
    let localeSignal: ReturnType<typeof signal<'en' | 'es' | 'fr'>>;

    beforeEach(() => {
      localeSignal = signal<'en' | 'es' | 'fr'>('en');

      TestBed.configureTestingModule({
        imports: [LocaleSwitcherComponent],
        providers: [
          {
            provide: TranslationService,
            useValue: {
              locale: localeSignal.asReadonly(),
              locales: [
                { code: 'en', label: 'EN' },
                { code: 'es', label: 'ES' },
                { code: 'fr', label: 'FR' },
              ],
              setLocale: vi.fn((l: 'en' | 'es' | 'fr') => localeSignal.set(l)),
            },
          },
        ],
      });
    });

    it('has no critical or serious accessibility violations', async () => {
      const fixture = TestBed.createComponent(LocaleSwitcherComponent);
      fixture.detectChanges();
      await expectNoViolations(fixture);
    });

    it('exposes aria-pressed for active locale button', () => {
      const fixture = TestBed.createComponent(LocaleSwitcherComponent);
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;

      const buttons = el.querySelectorAll('button');
      expect(buttons.length).toBe(3);

      const enBtn = buttons[0];
      const esBtn = buttons[1];

      expect(enBtn.getAttribute('aria-pressed')).toBe('true');
      expect(esBtn.getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('NetworkIndicatorComponent', () => {
    let networkSignal: ReturnType<typeof signal<'mainnet' | 'testnet' | null>>;
    let mismatchSignal: ReturnType<typeof signal<boolean>>;

    beforeEach(() => {
      networkSignal = signal<'mainnet' | 'testnet' | null>('testnet');
      mismatchSignal = signal(false);

      TestBed.configureTestingModule({
        imports: [NetworkIndicatorComponent],
        providers: [
          {
            provide: StellarWalletService,
            useValue: {
              network: networkSignal.asReadonly(),
              networkMismatch: mismatchSignal.asReadonly(),
              session: signal({ network: 'testnet' }).asReadonly(),
              recheckNetwork: vi.fn(),
            },
          },
        ],
      });
    });

    it('has no critical or serious accessibility violations for network badge', async () => {
      const fixture = TestBed.createComponent(NetworkIndicatorComponent);
      fixture.detectChanges();
      await expectNoViolations(fixture);
    });

    it('renders network mismatch modal with accessible alertdialog role', async () => {
      mismatchSignal.set(true);
      const fixture = TestBed.createComponent(NetworkIndicatorComponent);
      fixture.detectChanges();

      const el = fixture.nativeElement as HTMLElement;
      const dialog = el.querySelector('[role="alertdialog"]');
      expect(dialog).toBeTruthy();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');

      await expectNoViolations(fixture);
    });
  });
});
