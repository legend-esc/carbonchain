import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheService } from './cache.service';

export type SupportedCurrency = 'XLM' | 'USDC' | 'EUR' | 'USD';

export interface ExchangeRates {
  XLM_USD: number;
  USDC_USD: number;
  EUR_USD: number;
  fetched_at: number;
}

export interface ConvertResult {
  amount: number;
  from: SupportedCurrency;
  to: SupportedCurrency;
  converted: number;
  rate: number;
  rates_fetched_at: number;
}

const RATES_CACHE_KEY = 'exchange_rates:current';
const RATES_TTL_SECONDS = 7 * 60; // 7 min — slightly longer than the 5-min poll
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class ExchangeRateService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeRateService.name);
  private readonly coingeckoUrl: string;
  /** In-process fallback when Redis is unavailable */
  private memoryRates: ExchangeRates | null = null;

  constructor(
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {
    this.coingeckoUrl = this.config.get<string>(
      'COINGECKO_API_URL',
      'https://api.coingecko.com/api/v3',
    );
  }

  async onModuleInit(): Promise<void> {
    // Warm up the cache on startup
    await this.fetchAndCacheRates();
  }

  /** Runs every 5 minutes to keep rates fresh */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledFetch(): Promise<void> {
    await this.fetchAndCacheRates();
  }

  /**
   * Returns the most recent cached rates.
   * Throws if no rates are available at all (e.g. first boot with no network).
   */
  async getCurrentRates(): Promise<ExchangeRates> {
    const cached = await this.cache.get<ExchangeRates>(RATES_CACHE_KEY);
    if (cached) return cached;
    if (this.memoryRates) return this.memoryRates;
    // Last resort: attempt a live fetch
    return this.fetchAndCacheRates();
  }

  /**
   * Converts `amount` from one currency to another using cached rates.
   * Supported: XLM, USDC, EUR, USD.
   */
  async convert(
    amount: number,
    fromCurrency: SupportedCurrency,
    toCurrency: SupportedCurrency,
  ): Promise<ConvertResult> {
    if (amount < 0) {
      throw new Error('Amount must be non-negative');
    }

    const rates = await this.getCurrentRates();
    const ratesAgeMs = Date.now() - rates.fetched_at;
    if (ratesAgeMs > STALE_THRESHOLD_MS) {
      this.logger.warn(
        `Exchange rates are ${Math.round(ratesAgeMs / 1000)}s old — may be stale`,
      );
    }

    const toUsd = this.toUsdRate(fromCurrency, rates);
    const fromUsd = this.fromUsdRate(toCurrency, rates);
    const rate = toUsd * fromUsd;
    const converted = Math.round(amount * rate * 1e6) / 1e6;

    return {
      amount,
      from: fromCurrency,
      to: toCurrency,
      converted,
      rate,
      rates_fetched_at: rates.fetched_at,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private toUsdRate(currency: SupportedCurrency, rates: ExchangeRates): number {
    switch (currency) {
      case 'USD':  return 1;
      case 'XLM':  return rates.XLM_USD;
      case 'USDC': return rates.USDC_USD;
      case 'EUR':  return rates.EUR_USD;
    }
  }

  private fromUsdRate(currency: SupportedCurrency, rates: ExchangeRates): number {
    switch (currency) {
      case 'USD':  return 1;
      case 'XLM':  return 1 / rates.XLM_USD;
      case 'USDC': return 1 / rates.USDC_USD;
      case 'EUR':  return 1 / rates.EUR_USD;
    }
  }

  private async fetchAndCacheRates(): Promise<ExchangeRates> {
    try {
      const url = `${this.coingeckoUrl}/simple/price?ids=stellar%2Cusd-coin%2Ceuros&vs_currencies=usd`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

      if (!res.ok) {
        throw new Error(`CoinGecko responded with HTTP ${res.status}`);
      }

      const data = (await res.json()) as Record<string, { usd?: number }>;

      const rates: ExchangeRates = {
        XLM_USD:  data['stellar']?.usd    ?? 0,
        USDC_USD: data['usd-coin']?.usd   ?? 1,
        EUR_USD:  data['euros']?.usd      ?? 0,
        fetched_at: Date.now(),
      };

      this.logger.log(
        `Exchange rates updated — XLM: $${rates.XLM_USD}, EUR: $${rates.EUR_USD}`,
      );

      await this.cache.set(RATES_CACHE_KEY, rates, RATES_TTL_SECONDS);
      this.memoryRates = rates;
      return rates;
    } catch (err) {
      this.logger.error(
        `Failed to fetch exchange rates: ${(err as Error).message}`,
      );
      if (this.memoryRates) {
        this.logger.warn('Using stale in-memory rates as fallback');
        return this.memoryRates;
      }
      // Return safe defaults so the app starts without crashing
      const fallback: ExchangeRates = {
        XLM_USD: 0,
        USDC_USD: 1,
        EUR_USD: 0,
        fetched_at: Date.now(),
      };
      this.memoryRates = fallback;
      return fallback;
    }
  }
}
