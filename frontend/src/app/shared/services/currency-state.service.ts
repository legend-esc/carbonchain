/**
 * Issue #1334 — CurrencyStateService
 *
 * Manages the user's preferred display currency via an Angular signal.
 * Exchange rates are fetched once at startup from a public API; a hard-coded
 * fallback table is used if the fetch fails (e.g. offline or rate-limited).
 *
 * Rate resolution:
 *   - XLM prices are stored in Stellar stroops (1 XLM = 10 000 000 stroops).
 *   - To convert to a fiat/token amount: (stroops / 1e7) × ratePerXlm
 *
 * Supported currencies: XLM (identity), USD, USDC, EUR.
 */
import { Injectable, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type SupportedCurrency = 'XLM' | 'USD' | 'USDC' | 'EUR';

export const SUPPORTED_CURRENCIES: SupportedCurrency[] = ['XLM', 'USD', 'USDC', 'EUR'];

/** Rates express how many units of each currency equal 1 XLM. */
export interface ExchangeRates {
  USD: number;
  USDC: number;
  EUR: number;
}

/** Hard-coded fallback rates used when the network request fails. */
export const FALLBACK_RATES: ExchangeRates = {
  USD: 0.11,
  USDC: 0.11,
  EUR: 0.1,
};

/** Coinbase /exchange-rates endpoint shape (public, no auth required). */
interface CoinbaseRateResponse {
  data: {
    currency: string;
    rates: Record<string, string>;
  };
}

/** URL used for live rate lookups — can be overridden in tests. */
export const COINBASE_RATES_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=XLM';

@Injectable({ providedIn: 'root' })
export class CurrencyStateService {
  private readonly http = inject(HttpClient);

  private readonly _currency = signal<SupportedCurrency>('XLM');
  private readonly _rates = signal<ExchangeRates>(FALLBACK_RATES);
  private readonly _ratesLoaded = signal(false);

  /** Currently selected display currency. */
  readonly currency = this._currency.asReadonly();

  /** Live (or fallback) exchange rates relative to 1 XLM. */
  readonly rates = this._rates.asReadonly();

  /** True once the first rate-fetch attempt has completed (success or failure). */
  readonly ratesLoaded = this._ratesLoaded.asReadonly();

  /** Switch the active display currency. */
  setCurrency(currency: SupportedCurrency): void {
    this._currency.set(currency);
  }

  /**
   * Fetch live rates from Coinbase.  Falls back to FALLBACK_RATES on any
   * error.  Call this once from APP_INITIALIZER or the root component.
   */
  async loadRates(): Promise<void> {
    try {
      const resp = await firstValueFrom(this.http.get<CoinbaseRateResponse>(COINBASE_RATES_URL));
      const r = resp.data.rates;
      this._rates.set({
        USD: parseFloat(r['USD'] ?? String(FALLBACK_RATES.USD)),
        USDC: parseFloat(r['USDC'] ?? r['USD'] ?? String(FALLBACK_RATES.USDC)),
        EUR: parseFloat(r['EUR'] ?? String(FALLBACK_RATES.EUR)),
      });
    } catch {
      // Network unavailable — keep fallback rates already set
    } finally {
      this._ratesLoaded.set(true);
    }
  }
}
