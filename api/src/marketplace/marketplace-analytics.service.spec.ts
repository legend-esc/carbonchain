/**
 * #1304 — MarketplaceAnalyticsService unit tests.
 *
 * Verifies OHLCV aggregation on mock trade histories, gap-filling logic,
 * cache hit/miss behaviour, and timeframe validation.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import {
  MarketplaceAnalyticsService,
  OhlcvCandle,
  Timeframe,
} from './marketplace-analytics.service';
import { CacheService } from '../common/cache.service';

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockDataSource = { query: jest.fn() };
const mockCacheService: jest.Mocked<Partial<CacheService>> = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
};

// ── Sample DB rows ─────────────────────────────────────────────────────────────

function makeDbRow(
  time: number,
  open = '100',
  high = '110',
  low = '90',
  close = '105',
  volume = '1000',
  tradeCount = 2,
) {
  return {
    time: String(time),
    open,
    high,
    low,
    close,
    volume,
    trade_count: String(tradeCount),
  };
}

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('MarketplaceAnalyticsService', () => {
  let service: MarketplaceAnalyticsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCacheService.get = jest.fn().mockResolvedValue(null);
    mockCacheService.set = jest.fn().mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceAnalyticsService,
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<MarketplaceAnalyticsService>(
      MarketplaceAnalyticsService,
    );
  });

  // ── getCandles — cache miss path ───────────────────────────────────────────

  describe('getCandles — cache miss', () => {
    it('returns OHLCV rows from the database', async () => {
      const now = Math.floor(Date.now() / 1000);
      const bucket = now - 86400;
      mockDataSource.query.mockResolvedValueOnce([
        makeDbRow(bucket, '100', '120', '90', '115', '5000', 3),
      ]);

      const result = await service.getCandles({
        timeframe: '1d',
        from: bucket - 10,
        to: bucket + 100,
      });

      const real = result.find((c) => c.tradeCount > 0);
      expect(real).toBeDefined();
      expect(real!.open).toBe('100');
      expect(real!.high).toBe('120');
      expect(real!.low).toBe('90');
      expect(real!.close).toBe('115');
      expect(real!.tradeCount).toBe(3);
    });

    it('writes the result to the cache with 300 s TTL', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      await service.getCandles({ timeframe: '1d' });
      expect(mockCacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('candles:1d'),
        expect.any(Array),
        300,
      );
    });
  });

  // ── getCandles — cache hit path ────────────────────────────────────────────

  describe('getCandles — cache hit', () => {
    it('returns cached data without hitting the DB', async () => {
      const cached: OhlcvCandle[] = [
        {
          time: 1700000000,
          open: '50',
          high: '60',
          low: '45',
          close: '55',
          volume: '2000',
          tradeCount: 1,
        },
      ];
      mockCacheService.get = jest.fn().mockResolvedValue(cached);

      const result = await service.getCandles({ timeframe: '1d' });

      expect(result).toEqual(cached);
      expect(mockDataSource.query).not.toHaveBeenCalled();
    });
  });

  // ── fillGaps ───────────────────────────────────────────────────────────────

  describe('fillGaps', () => {
    const ONE_DAY = 86400;

    it('inserts zero-volume gap candles between real candles', () => {
      const t0 =
        Math.floor(Date.now() / 1000 / ONE_DAY) * ONE_DAY - 3 * ONE_DAY;
      const t1 = t0 + 2 * ONE_DAY; // skip one day

      const real: OhlcvCandle[] = [
        {
          time: t0,
          open: '10',
          high: '15',
          low: '8',
          close: '12',
          volume: '500',
          tradeCount: 1,
        },
        {
          time: t1,
          open: '12',
          high: '20',
          low: '11',
          close: '18',
          volume: '800',
          tradeCount: 2,
        },
      ];

      const filled = service.fillGaps(real, '1d', t0, t1);

      // Should have 3 candles: t0, t0+1d (gap), t1
      const gap = filled.find((c) => c.time === t0 + ONE_DAY);
      expect(gap).toBeDefined();
      expect(gap!.volume).toBe('0');
      expect(gap!.tradeCount).toBe(0);
      // Forward-fill: gap open/close should equal previous close
      expect(gap!.open).toBe('12');
      expect(gap!.close).toBe('12');
    });

    it('returns only the original candles when there are no gaps', () => {
      const t0 = 1700000000;
      const t1 = t0 + ONE_DAY;

      const real: OhlcvCandle[] = [
        {
          time: t0,
          open: '10',
          high: '12',
          low: '9',
          close: '11',
          volume: '100',
          tradeCount: 1,
        },
        {
          time: t1,
          open: '11',
          high: '13',
          low: '10',
          close: '12',
          volume: '200',
          tradeCount: 1,
        },
      ];

      const filled = service.fillGaps(real, '1d', t0, t1);
      const realCount = filled.filter((c) => c.tradeCount > 0).length;
      expect(realCount).toBe(2);
    });

    it('returns a single zero-volume candle for a range with no trades', () => {
      const t0 = 1700000000;
      const filled = service.fillGaps([], '1d', t0, t0);
      expect(filled).toHaveLength(1);
      expect(filled[0].volume).toBe('0');
      expect(filled[0].tradeCount).toBe(0);
    });
  });

  // ── Timeframe validation ───────────────────────────────────────────────────

  describe('timeframe validation', () => {
    it('accepts 1h', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      await expect(
        service.getCandles({ timeframe: '1h' }),
      ).resolves.toBeDefined();
    });

    it('accepts 1d', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      await expect(
        service.getCandles({ timeframe: '1d' }),
      ).resolves.toBeDefined();
    });

    it('accepts 1w', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      await expect(
        service.getCandles({ timeframe: '1w' }),
      ).resolves.toBeDefined();
    });

    it('throws BadRequestException for an unsupported timeframe', async () => {
      await expect(
        service.getCandles({ timeframe: '5m' as Timeframe }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── Date range validation ──────────────────────────────────────────────────

  describe('date range validation', () => {
    it('throws BadRequestException when from > to', async () => {
      const now = Math.floor(Date.now() / 1000);
      await expect(
        service.getCandles({ from: now + 1000, to: now }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── creditId filter ────────────────────────────────────────────────────────

  describe('creditId filter', () => {
    it('passes creditId as a SQL parameter', async () => {
      mockDataSource.query.mockResolvedValueOnce([]);
      await service.getCandles({ creditId: 'abc123', timeframe: '1d' });
      const [sql, params] = mockDataSource.query.mock.calls[0];
      expect(sql).toContain('credit_id');
      expect(params).toContain('abc123');
    });
  });
});
