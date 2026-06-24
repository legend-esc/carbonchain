import { CacheService } from '../common/cache.service';
import { InMemoryCreditRepository } from './credit.repository';
import { CreditsService } from './credits.service';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../shared';

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
