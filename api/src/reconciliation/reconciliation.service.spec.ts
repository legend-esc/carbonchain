/**
 * #1303 — ReconciliationService unit tests
 *
 * Covers:
 *  - drift detection and correction via reconcileIds()
 *  - discrepancy logging to reconciliation_discrepancies
 *  - webhook alert fired when drift > 0 in runNightlyReconciliation()
 *  - no alert when no drift is found
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ReconciliationService } from './reconciliation.service';
import { CreditEntity } from '../credits/credit.entity';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreditStatus } from '../../../shared';
import client from 'prom-client';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCredit(
  id: string,
  status: CreditStatus = CreditStatus.Active,
): CreditEntity {
  const c = new CreditEntity();
  c.id = id;
  c.status = status;
  c.projectId = 'proj-1';
  c.issuer = 'GISSUER';
  c.owner = 'GOWNER';
  c.vintageYear = 2024;
  c.methodology = 'VCS';
  c.geography = 'NG';
  c.tonnes = '1000000';
  c.ipfsHash = 'Qm000';
  c.issuedAt = 1700000000;
  return c;
}

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockStellarService = { readContract: jest.fn() };
const mockConfigService = {
  get: jest.fn().mockReturnValue('CCREDITREGISTRY'),
};
const mockDataSource = { query: jest.fn().mockResolvedValue([]) };
const mockWebhooksService = { triggerWebhooks: jest.fn().mockResolvedValue(undefined) };

let inMemoryCredits: CreditEntity[] = [];

const mockCreditRepo = {
  find: jest
    .fn()
    .mockImplementation(({ skip = 0, take = 100 }) =>
      Promise.resolve(inMemoryCredits.slice(skip, skip + take)),
    ),
  findOne: jest
    .fn()
    .mockImplementation(({ where: { id } }) =>
      Promise.resolve(inMemoryCredits.find((c) => c.id === id) ?? null),
    ),
  save: jest.fn().mockImplementation((c: CreditEntity) => {
    const idx = inMemoryCredits.findIndex((x) => x.id === c.id);
    if (idx >= 0) inMemoryCredits[idx] = c;
    return Promise.resolve(c);
  }),
};

// ── suite ─────────────────────────────────────────────────────────────────────

describe('ReconciliationService', () => {
  let service: ReconciliationService;

  beforeEach(async () => {
    inMemoryCredits = [];
    jest.clearAllMocks();
    client.register.clear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: getRepositoryToken(CreditEntity), useValue: mockCreditRepo },
        { provide: StellarService, useValue: mockStellarService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: WebhooksService, useValue: mockWebhooksService },
      ],
    }).compile();

    service = module.get<ReconciliationService>(ReconciliationService);
  });

  // ── reconcileIds ──────────────────────────────────────────────────────────

  describe('reconcileIds — direct-chain mutation simulation', () => {
    it('detects and corrects a drifted credit (DB=Active, chain=retired)', async () => {
      const creditId = 'deadbeef';
      inMemoryCredits.push(makeCredit(creditId, CreditStatus.Active));

      jest.spyOn(service, 'fetchChainStatus').mockResolvedValueOnce('retired');

      const drifts = await service.reconcileIds([creditId]);

      expect(drifts).toHaveLength(1);
      expect(drifts[0]).toMatchObject({
        creditId,
        dbStatus: CreditStatus.Active,
        chainStatus: 'retired',
      });
      expect(mockCreditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: creditId, status: 'retired' }),
      );
    });

    it('logs a discrepancy row for each drift', async () => {
      const creditId = 'deadbeef';
      inMemoryCredits.push(makeCredit(creditId, CreditStatus.Active));

      jest.spyOn(service, 'fetchChainStatus').mockResolvedValueOnce('retired');

      await service.reconcileIds([creditId]);

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reconciliation_discrepancies'),
        expect.arrayContaining(['credit', creditId]),
      );
    });

    it('returns no drifts when DB and chain agree', async () => {
      const creditId = 'aabbccdd';
      inMemoryCredits.push(makeCredit(creditId, CreditStatus.Active));

      jest
        .spyOn(service, 'fetchChainStatus')
        .mockResolvedValueOnce(CreditStatus.Active);

      const drifts = await service.reconcileIds([creditId]);
      expect(drifts).toHaveLength(0);
      expect(mockCreditRepo.save).not.toHaveBeenCalled();
    });

    it('skips a credit whose chain status cannot be read', async () => {
      const creditId = 'ff001122';
      inMemoryCredits.push(makeCredit(creditId, CreditStatus.Active));

      jest.spyOn(service, 'fetchChainStatus').mockResolvedValueOnce(null);

      const drifts = await service.reconcileIds([creditId]);
      expect(drifts).toHaveLength(0);
    });

    it('skips a credit not found in the DB', async () => {
      jest.spyOn(service, 'fetchChainStatus').mockResolvedValueOnce('retired');
      const drifts = await service.reconcileIds(['nonexistent']);
      expect(drifts).toHaveLength(0);
    });
  });

  // ── runNightlyReconciliation ──────────────────────────────────────────────

  describe('runNightlyReconciliation', () => {
    it('runs without throwing when there are no credits', async () => {
      await expect(service.runNightlyReconciliation()).resolves.not.toThrow();
    });

    it('fires a webhook alert when drift is detected', async () => {
      inMemoryCredits.push(makeCredit('aa', CreditStatus.Active));

      jest
        .spyOn(service, 'fetchChainStatus')
        .mockResolvedValueOnce('retired');

      await service.runNightlyReconciliation();

      expect(mockWebhooksService.triggerWebhooks).toHaveBeenCalledWith(
        'reconciliation.drift_detected',
        expect.objectContaining({ driftCount: 1, correctedCount: 1 }),
      );
    });

    it('does NOT fire a webhook when there is no drift', async () => {
      inMemoryCredits.push(makeCredit('bb', CreditStatus.Active));

      jest
        .spyOn(service, 'fetchChainStatus')
        .mockResolvedValueOnce(CreditStatus.Active);

      await service.runNightlyReconciliation();

      expect(mockWebhooksService.triggerWebhooks).not.toHaveBeenCalled();
    });

    it('corrects drifted rows across a full DB scan', async () => {
      inMemoryCredits.push(
        makeCredit('aa', CreditStatus.Active),
        makeCredit('bb', CreditStatus.Active),
      );

      jest
        .spyOn(service, 'fetchChainStatus')
        .mockResolvedValueOnce('retired')
        .mockResolvedValueOnce(CreditStatus.Active);

      await service.runNightlyReconciliation();

      expect(mockCreditRepo.save).toHaveBeenCalledTimes(1);
      expect(mockCreditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'aa', status: 'retired' }),
      );
    });

    it('does not throw when webhook service fails', async () => {
      inMemoryCredits.push(makeCredit('cc', CreditStatus.Active));
      jest.spyOn(service, 'fetchChainStatus').mockResolvedValueOnce('retired');
      mockWebhooksService.triggerWebhooks.mockRejectedValueOnce(
        new Error('webhook delivery failed'),
      );

      await expect(service.runNightlyReconciliation()).resolves.not.toThrow();
    });
  });

  // ── logDiscrepancy ────────────────────────────────────────────────────────

  describe('logDiscrepancy', () => {
    it('writes an INSERT to reconciliation_discrepancies', async () => {
      await service.logDiscrepancy({
        entityType: 'credit',
        entityId: 'abc123',
        dbStatus: 'active',
        chainStatus: 'retired',
        corrected: true,
      });

      expect(mockDataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO reconciliation_discrepancies'),
        expect.arrayContaining(['credit', 'abc123', 'active', 'retired', true]),
      );
    });

    it('does not throw when the DB write fails', async () => {
      mockDataSource.query.mockRejectedValueOnce(new Error('DB unavailable'));
      await expect(
        service.logDiscrepancy({
          entityType: 'offer',
          entityId: 'offer-1',
          dbStatus: 'open',
          chainStatus: 'closed',
        }),
      ).resolves.not.toThrow();
    });
  });
});
