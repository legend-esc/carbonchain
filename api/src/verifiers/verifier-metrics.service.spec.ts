/**
 * #1305 — VerifierMetricsService unit tests.
 *
 * Verifies correct calculation of turnaround hours, approval rate, and
 * total tonnes reviewed across sample event histories.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  VerifierMetricsService,
  VerifierMetrics,
} from './verifier-metrics.service';
import { EventEntity } from '../events/event.entity';
import { CacheService } from '../common/cache.service';

// ── Helpers ───────────────────────────────────────────────────────────────────

const VERIFIER = 'GBCI2DH7MEKQUTCXZ7YLEVOZHDMBWPCMB6V46ZQHOUN2BHBWRWYY2JRP';

function makeEvent(
  type: string,
  creditId: string,
  timestampSeconds: number,
  extras: Record<string, unknown> = {},
): EventEntity {
  const e = new EventEntity();
  e.id = `${type}-${creditId}`;
  e.contractId = 'CCONTRACT';
  e.eventType = type;
  e.ledger = 1;
  e.txHash = null;
  e.timestamp = timestampSeconds;
  e.data = { credit_id: creditId, verifier: VERIFIER, ...extras };
  e.createdAt = new Date();
  return e;
}

// ── Mocks ──────────────────────────────────────────────────────────────────────

let inMemoryEvents: EventEntity[] = [];

const mockEventRepo = {
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest
      .fn()
      .mockImplementation(() => Promise.resolve(inMemoryEvents)),
  }),
};

const mockCacheService: jest.Mocked<Partial<CacheService>> = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(true),
};

// ── Suite ──────────────────────────────────────────────────────────────────────

describe('VerifierMetricsService', () => {
  let service: VerifierMetricsService;

  beforeEach(async () => {
    inMemoryEvents = [];
    jest.clearAllMocks();
    mockCacheService.get = jest.fn().mockResolvedValue(null);
    mockCacheService.set = jest.fn().mockResolvedValue(true);

    // Reset chain mock so each test gets a fresh one.
    mockEventRepo.createQueryBuilder.mockReturnValue({
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockImplementation(() => Promise.resolve(inMemoryEvents)),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VerifierMetricsService,
        { provide: getRepositoryToken(EventEntity), useValue: mockEventRepo },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<VerifierMetricsService>(VerifierMetricsService);
  });

  // ── Basic calculation ──────────────────────────────────────────────────────

  describe('getMetrics — basic calculation', () => {
    it('returns zeroed metrics when there are no events', async () => {
      const result = await service.getMetrics(VERIFIER);
      expect(result).toMatchObject<VerifierMetrics>({
        address: VERIFIER,
        average_turnaround_hours: 0,
        approval_rate: 0,
        total_tonnes_reviewed: '0',
        total_reviewed: 0,
      });
    });

    it('calculates turnaround hours correctly for a single approval', async () => {
      // 24 hours between submission and approval.
      const submitAt = 1700000000;
      const approveAt = submitAt + 86400; // +24 h

      inMemoryEvents = [
        makeEvent('CreditSubmitted', 'credit-1', submitAt, { tonnes: '1000' }),
        makeEvent('CreditApproved', 'credit-1', approveAt),
      ];

      const result = await service.getMetrics(VERIFIER);
      expect(result.average_turnaround_hours).toBe(24);
    });

    it('calculates approval rate across multiple credits', async () => {
      // 2 approved, 1 rejected → rate = 0.6667
      const t0 = 1700000000;

      inMemoryEvents = [
        makeEvent('CreditSubmitted', 'c1', t0),
        makeEvent('CreditApproved', 'c1', t0 + 3600),
        makeEvent('CreditSubmitted', 'c2', t0),
        makeEvent('CreditApproved', 'c2', t0 + 7200),
        makeEvent('CreditSubmitted', 'c3', t0),
        makeEvent('CreditRejected', 'c3', t0 + 1800),
      ];

      const result = await service.getMetrics(VERIFIER);
      expect(result.total_reviewed).toBe(3);
      expect(result.approval_rate).toBeCloseTo(2 / 3, 3);
    });

    it('accumulates total_tonnes_reviewed from submission events', async () => {
      const t0 = 1700000000;
      inMemoryEvents = [
        makeEvent('CreditSubmitted', 'c1', t0, { tonnes: '5000000' }),
        makeEvent('CreditApproved', 'c1', t0 + 3600),
        makeEvent('CreditSubmitted', 'c2', t0, { tonnes: '3000000' }),
        makeEvent('CreditApproved', 'c2', t0 + 3600),
      ];

      const result = await service.getMetrics(VERIFIER);
      expect(result.total_tonnes_reviewed).toBe('8000000');
    });

    it('ignores decisions made by other verifiers', async () => {
      const otherVerifier =
        'GAGMTFWZSEDGZ6GQWDDA3QOW54BQE3GEIVSIVZHY6KOHQ4WY26F7VOL7';
      const t0 = 1700000000;

      inMemoryEvents = [
        makeEvent('CreditSubmitted', 'c1', t0),
        {
          ...makeEvent('CreditApproved', 'c1', t0 + 3600),
          data: { credit_id: 'c1', verifier: otherVerifier },
        },
      ];

      const result = await service.getMetrics(VERIFIER);
      expect(result.total_reviewed).toBe(0);
    });

    it('averages turnaround across multiple credits', async () => {
      // c1: 1 h turnaround, c2: 3 h turnaround → avg = 2 h
      const t0 = 1700000000;
      inMemoryEvents = [
        makeEvent('CreditSubmitted', 'c1', t0),
        makeEvent('CreditApproved', 'c1', t0 + 3600),  // +1 h
        makeEvent('CreditSubmitted', 'c2', t0),
        makeEvent('CreditApproved', 'c2', t0 + 10800), // +3 h
      ];

      const result = await service.getMetrics(VERIFIER);
      expect(result.average_turnaround_hours).toBe(2);
    });
  });

  // ── Cache behaviour ────────────────────────────────────────────────────────

  describe('cache behaviour', () => {
    it('returns cached result without hitting the DB', async () => {
      const cached: VerifierMetrics = {
        address: VERIFIER,
        average_turnaround_hours: 12,
        approval_rate: 0.9,
        total_tonnes_reviewed: '100000',
        total_reviewed: 10,
      };
      mockCacheService.get = jest.fn().mockResolvedValue(cached);

      const result = await service.getMetrics(VERIFIER);

      expect(result).toEqual(cached);
      expect(mockEventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('writes the result to cache with 600 s TTL', async () => {
      const result = await service.getMetrics(VERIFIER);
      expect(mockCacheService.set).toHaveBeenCalledWith(
        `verifier-metrics:${VERIFIER}`,
        expect.objectContaining({ address: VERIFIER }),
        600,
      );
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('clamps negative turnaround (clock skew) to zero', async () => {
      const t0 = 1700000000;
      inMemoryEvents = [
        makeEvent('CreditSubmitted', 'c1', t0 + 3600), // submitted AFTER decision (bad data)
        makeEvent('CreditApproved', 'c1', t0),
      ];

      const result = await service.getMetrics(VERIFIER);
      expect(result.average_turnaround_hours).toBe(0);
    });

    it('skips credits with no matching submission event when computing turnaround', async () => {
      const t0 = 1700000000;
      // Only an approval — no matching submission.
      inMemoryEvents = [
        makeEvent('CreditApproved', 'orphan', t0 + 3600),
      ];

      // Should still count the review but not blow up turnaround.
      const result = await service.getMetrics(VERIFIER);
      expect(result.total_reviewed).toBe(1);
      // No submission to compute turnaround from → 0.
      expect(result.average_turnaround_hours).toBe(0);
    });
  });
});
