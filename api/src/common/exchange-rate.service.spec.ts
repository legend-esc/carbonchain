import { ExchangeRateService } from './exchange-rate.service';
import { CacheService } from './cache.service';
import { ConfigService } from '@nestjs/config';

const makeCacheStub = (): jest.Mocked<CacheService> =>
  ({
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    delPattern: jest.fn(),
    isConnected: false,
  }) as unknown as jest.Mocked<CacheService>;

const makeConfigStub = (): jest.Mocked<ConfigService> =>
  ({
    get: jest.fn((key: string, def: unknown) => def),
  }) as unknown as jest.Mocked<ConfigService>;

const MOCK_RATES = {
  XLM_USD: 0.12,
  USDC_USD: 1.0,
  EUR_USD: 1.08,
  fetched_at: Date.now(),
};

describe('ExchangeRateService', () => {
  let service: ExchangeRateService;
  let cache: jest.Mocked<CacheService>;

  beforeEach(() => {
    cache = makeCacheStub();
    service = new ExchangeRateService(cache, makeConfigStub());
    // Seed in-memory rates to avoid real HTTP calls
    (service as any).memoryRates = MOCK_RATES;
  });

  describe('convert', () => {
    it('XLM → USD', async () => {
      cache.get.mockResolvedValue(MOCK_RATES);
      const result = await service.convert(100, 'XLM', 'USD');
      expect(result.converted).toBeCloseTo(12, 2);
      expect(result.rate).toBeCloseTo(0.12, 4);
    });

    it('USD → EUR', async () => {
      cache.get.mockResolvedValue(MOCK_RATES);
      const result = await service.convert(108, 'USD', 'EUR');
      expect(result.converted).toBeCloseTo(100, 1);
    });

    it('USD → USDC is 1:1', async () => {
      cache.get.mockResolvedValue(MOCK_RATES);
      const result = await service.convert(50, 'USD', 'USDC');
      expect(result.converted).toBeCloseTo(50, 4);
    });

    it('USDC → XLM', async () => {
      cache.get.mockResolvedValue(MOCK_RATES);
      const result = await service.convert(1, 'USDC', 'XLM');
      // 1 USD / 0.12 ≈ 8.33 XLM
      expect(result.converted).toBeCloseTo(8.33, 1);
    });

    it('throws on negative amount', async () => {
      cache.get.mockResolvedValue(MOCK_RATES);
      await expect(service.convert(-1, 'USD', 'EUR')).rejects.toThrow();
    });

    it('falls back to in-memory rates when cache misses', async () => {
      cache.get.mockResolvedValue(null);
      const result = await service.convert(100, 'XLM', 'USD');
      expect(result.converted).toBeCloseTo(12, 2);
    });
  });

  describe('getCurrentRates', () => {
    it('returns cached rates when available', async () => {
      cache.get.mockResolvedValue(MOCK_RATES);
      const rates = await service.getCurrentRates();
      expect(rates.XLM_USD).toBe(0.12);
    });

    it('falls back to in-memory rates when cache is empty', async () => {
      cache.get.mockResolvedValue(null);
      const rates = await service.getCurrentRates();
      expect(rates).toBe(MOCK_RATES);
    });
  });
});
