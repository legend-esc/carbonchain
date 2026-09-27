/**
 * #927 — ReconciliationService unit tests
 *
 * Seeds a drifted credit row (DB says Active, chain says Retired), runs
 * reconcileIds(), and asserts the row is corrected plus a drift record is
 * returned.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ReconciliationService } from './reconciliation.service';
import { CreditEntity } from '../credits/credit.entity';
import { StellarService } from '../stellar/stellar.service';
import { CreditStatus } from '../../../shared';

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

// In-memory repository mock
let inMemoryCredits: CreditEntity[] = [];

const mockCreditRepo = {
  find: jest.fn().mockImplementation(({ skip = 0, take = 100 }) =>
    Promise.resolve(inMemoryCredits.slice(skip, skip + take)),
  ),
  findOne: jest.fn().mockImplementation(({ where: { id } }) =>
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: getRepositoryToken(CreditEntity), useValue: mockCreditRepo },
        { provide: StellarService, useValue: mockStellarService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ReconciliationService>(ReconciliationService);
  });

  describe('reconcileIds — direct-chain mutation simulation', () => {
    it('detects and corrects a drifted credit (DB=Active, chain=retired)', async () => {
      const creditId = 'deadbeef';
      inMemoryCredits.push(makeCredit(creditId, CreditStatus.Active));

      // Simulate on-chain status = retired (direct contract call bypassed API).
      mockStellarService.readContract.mockResolvedValueOnce({
        // scValToNative is mocked via the module — we need the raw pre-parsed value.
        // ReconciliationService calls scValToNative(retval) and reads native['status'].
        // Since we can't import scVal types easily in tests, we fake the return by
        // having fetchChainStatus return 'retired' — we test that path via a spy.
      });

      // Spy on fetchChainStatus to inject the chain response directly.
      jest
        .spyOn(service, 'fetchChainStatus')
        .mockResolvedValueOnce('retired');

      const drifts = await service.reconcileIds([creditId]);

      expect(drifts).toHaveLength(1);
      expect(drifts[0]).toMatchObject({
        creditId,
        dbStatus: CreditStatus.Active,
        chainStatus: 'retired',
      });

      // DB row should be corrected.
      expect(mockCreditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: creditId, status: 'retired' }),
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

  describe('runNightlyReconciliation', () => {
    it('runs without throwing when there are no credits', async () => {
      await expect(service.runNightlyReconciliation()).resolves.not.toThrow();
    });

    it('corrects drifted rows across a full DB scan', async () => {
      inMemoryCredits.push(
        makeCredit('aa', CreditStatus.Active),
        makeCredit('bb', CreditStatus.Active),
      );

      jest
        .spyOn(service, 'fetchChainStatus')
        .mockResolvedValueOnce('retired')  // aa drifted
        .mockResolvedValueOnce(CreditStatus.Active); // bb ok

      await service.runNightlyReconciliation();

      // Only credit 'aa' should have been saved.
      expect(mockCreditRepo.save).toHaveBeenCalledTimes(1);
      expect(mockCreditRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'aa', status: 'retired' }),
      );
    });
  });
});
