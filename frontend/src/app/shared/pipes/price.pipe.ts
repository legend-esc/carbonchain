/**
 * Issue #1334 — PricePipe
 *
 * Converts a Stellar stroop amount (integer string or number) to the user's
 * preferred display currency and formats it via Intl.NumberFormat.
 *
 * Usage:
 *   {{ offer.price_raw | price }}                   → uses active currency signal
 *   {{ offer.price_raw | price : 'USD' }}           → forces USD
 *   {{ offer.price_raw | price : 'XLM' : rates }}   → custom rates object
 *
 * The pipe is impure so it reacts to signal changes in CurrencyStateService
 * without requiring ChangeDetectionStrategy.OnPush on every host component.
 */
import { Pipe, PipeTransform, inject } from '@angular/core';
import {
  CurrencyStateService,
  SupportedCurrency,
  ExchangeRates,
} from '../services/currency-state.service';

/** Stellar stroop scale factor: 1 XLM = 10 000 000 stroops. */
const STROOP_DIVISOR = 10_000_000;

/** Locale-aware format options per currency. */
const FORMAT_OPTIONS: Record<SupportedCurrency, Intl.NumberFormatOptions> = {
  XLM: { maximumFractionDigits: 4, minimumFractionDigits: 2 },
  USD: { style: 'currency', currency: 'USD' },
  USDC: { maximumFractionDigits: 4, minimumFractionDigits: 2 },
  EUR: { style: 'currency', currency: 'EUR' },
};

/** Currency symbols / suffixes for non-fiat currencies. */
const SUFFIX: Partial<Record<SupportedCurrency, string>> = {
  XLM: ' XLM',
  USDC: ' USDC',
};

@Pipe({ name: 'price', standalone: true, pure: false })
export class PricePipe implements PipeTransform {
  private readonly currencyState = inject(CurrencyStateService);

  /**
   * @param stroops   Raw stroop value (string or number).
   * @param currency  Override the active currency (optional).
   * @param rates     Override exchange rates (optional, useful in tests).
   */
  transform(
    stroops: string | number | null | undefined,
    currency?: SupportedCurrency,
    rates?: ExchangeRates,
  ): string {
    if (stroops == null || stroops === '') return '—';

    const raw = Number(stroops);
    if (!Number.isFinite(raw)) return '—';

    const activeCurrency = currency ?? this.currencyState.currency();
    const activeRates = rates ?? this.currencyState.rates();

    const xlm = raw / STROOP_DIVISOR;

    let amount: number;
    if (activeCurrency === 'XLM') {
      amount = xlm;
    } else {
      amount = xlm * activeRates[activeCurrency as keyof ExchangeRates];
    }

    const formatted = new Intl.NumberFormat(undefined, FORMAT_OPTIONS[activeCurrency]).format(
      amount,
    );

    // Append a suffix for non-fiat currencies that Intl doesn't handle natively.
    return SUFFIX[activeCurrency] ? formatted + SUFFIX[activeCurrency] : formatted;
  }
}
