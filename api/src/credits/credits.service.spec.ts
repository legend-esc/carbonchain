import { CacheService } from '../common/cache.service';
import { InMemoryCreditRepository } from './credit.repository';
import { CreditsService } from './credits.service';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../shared';
import { NotFoundException } from '@nestjs/common';

// Minimal ConfigService mock for CacheService and CreditsService
const mockConfig: any = { get: () => undefined };

describe('CreditsService.listCredits status filtering', () => {
  let repo: InMemoryCreditRepository;
  let cache: CacheService;
  let svc: CreditsService;

  beforeEach(async () => {
    repo = new InMemoryCreditRepository();
    cache = new CacheService(mockConfig);
    // minimal stubs for unused dependencies
    const stellar: any = {};
    const keypair: any = {};
    svc = new CreditsService(stellar, mockConfig, keypair, repo, cache);

    const now = Math.floor(Date.now() / 1000);

    const active = new CreditEntity();
    active.id = 'C-ACTIVE';
    active.projectId = 'PROJ-1';
    active.issuer = 'ISS-1';
    active.vintageYear = 2020;
    active.methodology = 'M1';
    active.geography = 'G1';
    active.tonnes = '1000000';
    active.ipfsHash = 'QmActive';
    active.status = CreditStatus.Active;
    active.issuedAt = now;

    const retired = new CreditEntity();
    retired.id = 'C-RETIRED';
    retired.projectId = 'PROJ-1';
    retired.issuer = 'ISS-1';
    retired.vintageYear = 2019;
    retired.methodology = 'M1';
    retired.geography = 'G1';
    retired.tonnes = '500000';
    retired.ipfsHash = 'QmRetired';
    retired.status = CreditStatus.Retired;
    retired.issuedAt = now - 1000;

    const flagged = new CreditEntity();
    flagged.id = 'C-FLAGGED';
    flagged.projectId = 'PROJ-2';
    flagged.issuer = 'ISS-2';
    flagged.vintageYear = 2018;
    flagged.methodology = 'M2';
    flagged.geography = 'G2';
    flagged.tonnes = '200000';
    flagged.ipfsHash = 'QmFlagged';
    flagged.status = CreditStatus.Flagged;
    flagged.issuedAt = now - 2000;

    const pending = new CreditEntity();
    pending.id = 'C-PENDING';
    pending.projectId = 'PROJ-3';
    pending.issuer = 'ISS-3';
    pending.vintageYear = 2021;
    pending.methodology = 'M3';
    pending.geography = 'G3';
    pending.tonnes = '300000';
    pending.ipfsHash = 'QmPending';
    pending.status = CreditStatus.Pending;
    pending.issuedAt = now - 3000;

    await repo.save(active);
    await repo.save(retired);
    await repo.save(flagged);
    await repo.save(pending);
  });

  it('defaults to Active when status not provided', async () => {
    const res = await svc.listCredits({ page: 1, limit: 10 });
    expect(res.data.map((d) => d.id)).toEqual(['C-ACTIVE']);
    expect(res.total).toBe(1);
  });

  it('returns Retired when status=Retired', async () => {
    const res = await svc.listCredits({
      page: 1,
      limit: 10,
      status: CreditStatus.Retired,
    });
    expect(res.data.map((d) => d.id)).toEqual(['C-RETIRED']);
    expect(res.total).toBe(1);
  });

  it('returns Flagged when status=Flagged', async () => {
    const res = await svc.listCredits({
      page: 1,
      limit: 10,
      status: CreditStatus.Flagged,
    });
    expect(res.data.map((d) => d.id)).toEqual(['C-FLAGGED']);
    expect(res.total).toBe(1);
  });

  it('returns Pending when status=Pending', async () => {
    const res = await svc.listCredits({
      page: 1,
      limit: 10,
      status: CreditStatus.Pending,
    });
    expect(res.data.map((d) => d.id)).toEqual(['C-PENDING']);
    expect(res.total).toBe(1);
  });
});

describe('CreditsService.getCreditProvenance', () => {
  let svc: CreditsService;

  beforeEach(async () => {
    const repo = new InMemoryCreditRepository();
    const cache = new CacheService(mockConfig);

    // Mock stellar service with contract events
    const mockStellarService: any = {
      getContractEvents: jest.fn().mockResolvedValue([
        {
          topic: ['CreditSubmitted'],
          value: {
            issuer: 'issuer-address',
            credit_id: 'abc123def456',
            project_id: 'PROJ-001',
            tonnes: 1000000n,
          },
          ledger: 100,
          id: '1',
          txHash: 'hash1',
          closedAt: 1000000n,
        },
        {
          topic: ['CreditMinted'],
          value: {
            verifier: 'verifier-address',
            id: 'abc123def456',
          },
          ledger: 101,
          id: '2',
          txHash: 'hash2',
          closedAt: 1000010n,
        },
        {
          topic: ['CreditTransferred'],
          value: {
            from: 'owner-address',
            to: 'buyer-address',
            credit_id: 'abc123def456',
          },
          ledger: 102,
          id: '3',
          txHash: 'hash3',
          closedAt: 1000020n,
        },
      ]),
    };

    const mockKeypair: any = {};
    svc = new CreditsService(
      mockStellarService,
      mockConfig,
      mockKeypair,
      repo,
      cache,
    );
  });

  it('should return provenance events in chronological order', async () => {
    const provenance = await svc.getCreditProvenance('abc123def456');

    expect(provenance).toHaveLength(3);
    expect(provenance[0].action).toBe('Submitted');
    expect(provenance[0].actor).toBe('issuer-address');
    expect(provenance[1].action).toBe('Approved');
    expect(provenance[1].actor).toBe('verifier-address');
    expect(provenance[2].action).toBe('Transferred');
    expect(provenance[2].actor).toBe('owner-address');
  });

  it('should include txHash in provenance records', async () => {
    const provenance = await svc.getCreditProvenance('abc123def456');

    expect(provenance[0].txHash).toBe('hash1');
    expect(provenance[1].txHash).toBe('hash2');
    expect(provenance[2].txHash).toBe('hash3');
  });

  it('should include timestamp in provenance records', async () => {
    const provenance = await svc.getCreditProvenance('abc123def456');

    provenance.forEach((event) => {
      expect(typeof event.timestamp).toBe('number');
      expect(event.timestamp).toBeGreaterThan(0);
    });
  });

  it('should throw NotFoundException for credit with no provenance events', async () => {
    const svcWithNoEvents = new CreditsService(
      { getContractEvents: jest.fn().mockResolvedValue([]) } as any,
      mockConfig,
      {} as any,
      new InMemoryCreditRepository(),
      new CacheService(mockConfig),
    );

    await expect(svcWithNoEvents.getCreditProvenance('nonexistent')).rejects.toThrow();
  });
});
