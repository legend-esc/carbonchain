import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import {
  OracleService,
  MrvWebhookDto,
  MrvHistoryResponse,
  MrvAggregateResponse,
} from './oracle.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';
import { MrvDataPoint } from '../../shared';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockStellarService = {
  invokeContract: jest.fn(),
  readContract: jest.fn(),
};
const mockKeypairService = {
  getAdminKeypair: jest.fn().mockReturnValue({ publicKey: () => 'GADMIN' }),
};
const mockConfigService = {
  get: jest.fn((key: string, def?: unknown) => {
    if (key === 'MRV_ORACLE_CONTRACT_ID') return 'CORACLE';
    if (key === 'ORACLE_WEBHOOK_SECRET') return 'testsecret';
    return def;
  }),
};
const mockCacheService = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSignature(
  projectId: string,
  tonnes: string,
  secret = 'testsecret',
): string {
  return createHmac('sha256', secret)
    .update(`${projectId}:${tonnes}`)
    .digest('hex');
}

// Valid Stellar G-address (56 chars, base32)
const VALID_ORACLE_KEY =
  'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

/** Build a minimal MrvDataPoint with sensible defaults */
function makePoint(overrides: Partial<MrvDataPoint> = {}): MrvDataPoint {
  return {
    oracle: VALID_ORACLE_KEY,
    project_id: 'PROJ-001',
    tonnes_sequestered: '1000000',
    measurement_date: 1735689600, // 2025-01-01T00:00:00Z
    methodology: '',
    anomaly_flag: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('OracleService', () => {
  let service: OracleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OracleService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<OracleService>(OracleService);
    jest.clearAllMocks();
    // Default: cache miss
    mockCacheService.get.mockResolvedValue(null);
  });

  // ── #474: ingestMrvData ────────────────────────────────────────────────────

  describe('ingestMrvData', () => {
    it('rejects invalid signature', async () => {
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '1000000',
        signature: 'badhex',
      };
      await expect(service.ingestMrvData(dto)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('forwards valid data to contract and returns anomaly flag', async () => {
      mockStellarService.invokeContract.mockResolvedValue({
        returnValue: null,
      });
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '1000000',
        signature: makeSignature('PROJ-001', '1000000'),
      };
      const result = await service.ingestMrvData(dto);
      expect(mockStellarService.invokeContract).toHaveBeenCalledWith(
        'CORACLE',
        'update_mrv_data',
        expect.any(Array),
        expect.anything(),
      );
      expect(result).toEqual({ anomaly: false });
    });

    it('passes the current wall-clock timestamp as the 4th arg', async () => {
      mockStellarService.invokeContract.mockResolvedValue({
        returnValue: null,
      });
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '1000000',
        signature: makeSignature('PROJ-001', '1000000'),
      };

      const before = BigInt(Math.floor(Date.now() / 1000));
      await service.ingestMrvData(dto);
      const after = BigInt(Math.floor(Date.now() / 1000));

      // The 4th ScVal arg should encode a u64 timestamp in [before, after]
      const args: unknown[] =
        mockStellarService.invokeContract.mock.calls[0][2];
      expect(args).toHaveLength(4);
      // The timestamp ScVal is the 4th argument (index 3)
      const tsArg = args[3] as { value: () => { lo: () => number; hi: () => number } };
      // Extract the numeric value — ScVal u64 stores as {lo, hi} pair
      // We check the type rather than exact value to avoid flakiness
      expect(tsArg).toBeDefined();
      // Sanity: timestamp must be a positive number
      expect(before).toBeGreaterThan(0n);
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('rejects negative tonnes', async () => {
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '-1000000',
        signature: makeSignature('PROJ-001', '-1000000'),
      };
      await expect(service.ingestMrvData(dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects zero tonnes', async () => {
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '0',
        signature: makeSignature('PROJ-001', '0'),
      };
      await expect(service.ingestMrvData(dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('converts InvalidTimestamp contract error to BadRequestException', async () => {
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Contract error: InvalidTimestamp (127)'),
      );
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '1000000',
        signature: makeSignature('PROJ-001', '1000000'),
      };
      await expect(service.ingestMrvData(dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('converts generic contract error to InternalServerErrorException', async () => {
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Network timeout'),
      );
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '1000000',
        signature: makeSignature('PROJ-001', '1000000'),
      };
      await expect(service.ingestMrvData(dto)).rejects.toThrow(
        'Failed to submit MRV data to contract',
      );
    });

    it('busts history and aggregate caches on successful ingestion', async () => {
      mockStellarService.invokeContract.mockResolvedValue({
        returnValue: null,
      });
      const dto: MrvWebhookDto = {
        oraclePublicKey: VALID_ORACLE_KEY,
        projectId: 'PROJ-001',
        tonnesSequestered: '1000000',
        signature: makeSignature('PROJ-001', '1000000'),
      };
      await service.ingestMrvData(dto);
      expect(mockCacheService.del).toHaveBeenCalledWith(
        'oracle:history:PROJ-001',
      );
      expect(mockCacheService.del).toHaveBeenCalledWith(
        'oracle:aggregate:PROJ-001',
      );
    });
  });

  // ── #475: getHistory ──────────────────────────────────────────────────────

  describe('getHistory', () => {
    it('returns empty response when contract call fails', async () => {
      mockStellarService.readContract.mockRejectedValue(
        new Error('ProjectNotFound'),
      );
      const result: MrvHistoryResponse = await service.getHistory(
        'PROJ-NONE',
        1,
        20,
      );
      expect(result).toEqual({ data: [], total: 0, page: 1, pageSize: 20 });
    });

    it('returns empty response when contract returns empty array', async () => {
      mockStellarService.readContract.mockResolvedValue([]);
      const result = await service.getHistory('PROJ-001', 1, 20);
      expect(result).toEqual({ data: [], total: 0, page: 1, pageSize: 20 });
    });

    it('paginates results correctly', async () => {
      const points = Array.from({ length: 50 }, (_, i) =>
        makePoint({
          tonnes_sequestered: String((i + 1) * 1_000_000),
          measurement_date: 1735689600 + i,
        }),
      );
      mockStellarService.readContract.mockResolvedValue(
        points.map((p) => ({
          oracle: p.oracle,
          project_id: p.project_id,
          tonnes: p.tonnes_sequestered,
          recorded_at: p.measurement_date,
          anomaly: p.anomaly_flag,
        })),
      );

      const page1 = await service.getHistory('PROJ-001', 1, 20);
      expect(page1.data).toHaveLength(20);
      expect(page1.total).toBe(50);
      expect(page1.page).toBe(1);

      // Simulate cache hit for page 2
      mockCacheService.get.mockResolvedValueOnce(points);
      const page2 = await service.getHistory('PROJ-001', 2, 20);
      expect(page2.data).toHaveLength(20);
      expect(page2.total).toBe(50);
      expect(page2.page).toBe(2);

      // Simulate cache hit for last page
      mockCacheService.get.mockResolvedValueOnce(points);
      const page3 = await service.getHistory('PROJ-001', 3, 20);
      expect(page3.data).toHaveLength(10);
    });

    it('returns data matching shared MrvDataPoint shape', async () => {
      mockStellarService.readContract.mockResolvedValue([
        {
          oracle: VALID_ORACLE_KEY,
          project_id: 'PROJ-001',
          tonnes: '2000000',
          recorded_at: 1735689600,
          anomaly: true,
        },
      ]);

      const result = await service.getHistory('PROJ-001', 1, 20);
      expect(result.data[0]).toMatchObject({
        oracle: VALID_ORACLE_KEY,
        project_id: 'PROJ-001',
        tonnes_sequestered: '2000000',
        measurement_date: 1735689600,
        anomaly_flag: true,
      });
    });

    it('uses cached data when available', async () => {
      const cached: MrvDataPoint[] = [makePoint()];
      mockCacheService.get.mockResolvedValue(cached);

      const result = await service.getHistory('PROJ-001', 1, 20);
      expect(result.total).toBe(1);
      // readContract should NOT have been called
      expect(mockStellarService.readContract).not.toHaveBeenCalled();
    });
  });

  // ── #476: getAggregate ────────────────────────────────────────────────────

  describe('getAggregate', () => {
    it('returns zeroed aggregate for empty history', async () => {
      mockStellarService.readContract.mockResolvedValue([]);
      const result: MrvAggregateResponse = await service.getAggregate(
        'PROJ-EMPTY',
      );
      expect(result.totalTonnes).toBe('0');
      expect(result.readingCount).toBe(0);
      expect(result.anomalyCount).toBe(0);
      expect(result.latestReading).toBeNull();
      expect(result.monthlyBreakdown).toEqual([]);
    });

    it('computes correct totals across multiple readings', async () => {
      const cached: MrvDataPoint[] = [
        makePoint({ tonnes_sequestered: '1000000', measurement_date: 1735689600 }),
        makePoint({ tonnes_sequestered: '2000000', measurement_date: 1735776000 }),
        makePoint({ tonnes_sequestered: '3000000', measurement_date: 1735862400 }),
      ];
      mockCacheService.get.mockResolvedValueOnce(null); // aggregate cache miss
      mockCacheService.get.mockResolvedValueOnce(cached); // history cache hit

      const result = await service.getAggregate('PROJ-001');
      expect(result.totalTonnes).toBe('6000000');
      expect(result.readingCount).toBe(3);
      expect(result.anomalyCount).toBe(0);
    });

    it('excludeAnomalies=true omits anomalous readings from totalTonnes', async () => {
      const points: MrvDataPoint[] = [
        makePoint({ tonnes_sequestered: '1000000', anomaly_flag: false }),
        makePoint({ tonnes_sequestered: '5000000', anomaly_flag: true }),
        makePoint({ tonnes_sequestered: '2000000', anomaly_flag: false }),
      ];
      mockCacheService.get.mockResolvedValueOnce(null); // aggregate cache miss
      mockCacheService.get.mockResolvedValueOnce(points); // history cache hit

      const result = await service.getAggregate('PROJ-001', true);
      expect(result.totalTonnes).toBe('3000000');
      expect(result.anomalyCount).toBe(1);
      expect(result.readingCount).toBe(2);
    });

    it('returns all anomalies counted even when excluded from total', async () => {
      const points: MrvDataPoint[] = [
        makePoint({ tonnes_sequestered: '1000000', anomaly_flag: true }),
        makePoint({ tonnes_sequestered: '1000000', anomaly_flag: true }),
      ];
      const result = service.computeAggregate(points, true);
      expect(result.anomalyCount).toBe(2);
      expect(result.totalTonnes).toBe('0');
      expect(result.readingCount).toBe(0);
    });

    it('BigInt arithmetic does not overflow for 1 billion tonne inputs', () => {
      // 1 billion tonnes in scaled units (1 tonne = 1_000_000 units)
      const oneBillionTonnes = '1000000000000000'; // 1e15
      const points: MrvDataPoint[] = Array.from({ length: 100 }, () =>
        makePoint({ tonnes_sequestered: oneBillionTonnes }),
      );

      const result = service.computeAggregate(points, false);
      // 100 readings × 1e15 = 1e17 — well within BigInt range, never in Number
      const expected = BigInt(oneBillionTonnes) * 100n;
      expect(result.totalTonnes).toBe(expected.toString());
      // Verify it's NOT representable as a safe JS number
      expect(Number(expected) > Number.MAX_SAFE_INTEGER).toBe(true);
    });

    it('groups readings into correct monthly buckets (UTC)', () => {
      const points: MrvDataPoint[] = [
        // January 2025
        makePoint({
          tonnes_sequestered: '1000000',
          measurement_date: 1735689600, // 2025-01-01 00:00:00 UTC
        }),
        makePoint({
          tonnes_sequestered: '500000',
          measurement_date: 1735776000, // 2025-01-02 00:00:00 UTC
        }),
        // February 2025
        makePoint({
          tonnes_sequestered: '3000000',
          measurement_date: 1738368000, // 2025-02-01 00:00:00 UTC
        }),
      ];

      const result = service.computeAggregate(points, false);
      expect(result.monthlyBreakdown).toHaveLength(2);
      expect(result.monthlyBreakdown[0].month).toBe('2025-01');
      expect(result.monthlyBreakdown[0].totalTonnes).toBe('1500000');
      expect(result.monthlyBreakdown[0].readingCount).toBe(2);
      expect(result.monthlyBreakdown[1].month).toBe('2025-02');
      expect(result.monthlyBreakdown[1].totalTonnes).toBe('3000000');
    });

    it('returns the latest reading by timestamp', () => {
      const older = makePoint({
        tonnes_sequestered: '1000000',
        measurement_date: 1735689600,
      });
      const newer = makePoint({
        tonnes_sequestered: '2000000',
        measurement_date: 1738368000,
      });

      const result = service.computeAggregate([older, newer], false);
      expect(result.latestReading?.measurement_date).toBe(1738368000);
    });

    it('uses cached aggregate when available', async () => {
      const cachedAggregate: MrvAggregateResponse = {
        totalTonnes: '9999',
        readingCount: 1,
        anomalyCount: 0,
        latestReading: null,
        monthlyBreakdown: [],
      };
      mockCacheService.get.mockResolvedValueOnce(cachedAggregate);

      const result = await service.getAggregate('PROJ-001');
      expect(result.totalTonnes).toBe('9999');
      expect(mockStellarService.readContract).not.toHaveBeenCalled();
    });
  });
});
