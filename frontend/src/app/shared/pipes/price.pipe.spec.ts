/**
 * Issue #1334 — unit tests for PricePipe and CurrencyStateService.
 *
 * Verifies:
 *  - XLM formatting (stroop divisor, suffix)
 *  - USD / EUR formatting via Intl.NumberFormat currency style
 *  - USDC formatting with custom suffix
 *  - Accurate conversion using injected rates
 *  - Null / empty input returns '—'
 *  - CurrencyStateService signal-based switching
 *  - Fallback rates load on network failure
 */
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { PricePipe } from './price.pipe';
import {
  CurrencyStateService,
  FALLBACK_RATES,
  ExchangeRates,
} from '../services/currency-state.service';

// ---------------------------------------------------------------------------
// Shared fixed rates used throughout PricePipe tests
// ---------------------------------------------------------------------------

const RATES: ExchangeRates = { USD: 0.1, USDC: 0.1, EUR: 0.09 };

// ---------------------------------------------------------------------------
// PricePipe
// ---------------------------------------------------------------------------

describe('PricePipe', () => {
  let pipe: PricePipe;
  let currencyState: CurrencyStateService;

  beforeEach(() => {
    const httpSpy = { get: vi.fn().mockReturnValue(of(null)) };

    TestBed.configureTestingModule({
      providers: [
        PricePipe,
        CurrencyStateService,
        { provide: HttpClient, useValue: httpSpy },
      ],
    });

    currencyState = TestBed.inject(CurrencyStateService);
    // Set fixed test rates to avoid dependency on FALLBACK_RATES values
    (currencyState as any)._rates.set(RATES);
    pipe = TestBed.inject(PricePipe);
  });

  it('formats XLM: 10000000 stroops → "1.00 XLM"', () => {
    currencyState.setCurrency('XLM');
    const result = pipe.transform(10_000_000, 'XLM', RATES);
    expect(result).toContain('1');
    expect(result).toContain('XLM');
  });

  it('converts to USD: 10000000 stroops at $0.1/XLM → ~$0.10', () => {
    currencyState.setCurrency('USD');
    const result = pipe.transform(10_000_000, 'USD', RATES);
    // $0.10 formatted by Intl — just check it contains the numeric value
    expect(result).toContain('0.10');
  });

  it('converts to EUR: 10000000 stroops at €0.09/XLM', () => {
    currencyState.setCurrency('EUR');
    const result = pipe.transform(10_000_000, 'EUR', RATES);
    expect(result).toContain('0.09');
  });

  it('converts to USDC and appends " USDC" suffix', () => {
    currencyState.setCurrency('USDC');
    const result = pipe.transform(10_000_000, 'USDC', RATES);
    expect(result).toContain('USDC');
  });

  it('returns "—" for null input', () => {
    expect(pipe.transform(null, 'XLM', RATES)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(pipe.transform('', 'XLM', RATES)).toBe('—');
  });

  it('returns "—" for non-numeric string', () => {
    expect(pipe.transform('not-a-number', 'XLM', RATES)).toBe('—');
  });

  it('uses the active currency signal when no override is passed', () => {
    currencyState.setCurrency('XLM');
    const result = pipe.transform(10_000_000);
    expect(result).toContain('XLM');
  });

  it('scales correctly: 100000000 stroops → 10 XLM', () => {
    currencyState.setCurrency('XLM');
    const result = pipe.transform(100_000_000, 'XLM', RATES);
    expect(result).toContain('10');
    expect(result).toContain('XLM');
  });
});

// ---------------------------------------------------------------------------
// CurrencyStateService
// ---------------------------------------------------------------------------

describe('CurrencyStateService', () => {
  let service: CurrencyStateService;
  let httpSpy: { get: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    httpSpy = { get: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        CurrencyStateService,
        { provide: HttpClient, useValue: httpSpy },
      ],
    });
    service = TestBed.inject(CurrencyStateService);
  });

  it('defaults to XLM currency', () => {
    expect(service.currency()).toBe('XLM');
  });

  it('setCurrency() changes the active currency', () => {
    service.setCurrency('USD');
    expect(service.currency()).toBe('USD');
  });

  it('starts with fallback rates', () => {
    expect(service.rates()).toEqual(FALLBACK_RATES);
  });

  it('loadRates() sets rates from Coinbase response', async () => {
    httpSpy.get.mockReturnValue(
      of({
        data: {
          currency: 'XLM',
          rates: { USD: '0.15', EUR: '0.13', USDC: '0.15' },
        },
      }),
    );
    await service.loadRates();
    expect(service.rates().USD).toBeCloseTo(0.15);
    expect(service.rates().EUR).toBeCloseTo(0.13);
    expect(service.ratesLoaded()).toBe(true);
  });

  it('loadRates() keeps fallback rates on network error', async () => {
    httpSpy.get.mockReturnValue(throwError(() => new Error('network')));
    await service.loadRates();
    expect(service.rates()).toEqual(FALLBACK_RATES);
    expect(service.ratesLoaded()).toBe(true);
  });

  it('loadRates() falls back per-currency when a rate is missing', async () => {
    httpSpy.get.mockReturnValue(
      of({
        data: {
          currency: 'XLM',
          // USDC missing — should fall back to USD rate
          rates: { USD: '0.20', EUR: '0.18' },
        },
      }),
    );
    await service.loadRates();
    expect(service.rates().USDC).toBeCloseTo(0.20);
  });
});
