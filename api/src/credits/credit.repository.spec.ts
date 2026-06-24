import { InMemoryCreditRepository } from './credit.repository';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../shared';

function makeCredit(
  id: string,
  projectId = 'PROJ-001',
  status = CreditStatus.Active,
): CreditEntity {
  const e = new CreditEntity();
  e.id = id;
  e.projectId = projectId;
  e.issuer = 'GISSUER';
  e.vintageYear = 2024;
  e.methodology = 'VCS';
  e.geography = 'NG';
  e.tonnes = '1000000';
  e.ipfsHash = 'baf';
  e.status = status;
  e.issuedAt = 1700000000;
  return e;
}

describe('InMemoryCreditRepository', () => {
  let repo: InMemoryCreditRepository;

  beforeEach(() => {
    repo = new InMemoryCreditRepository();
  });

  it('saves and retrieves a credit by id', async () => {
    const credit = makeCredit('abc123');
    await repo.save(credit);
    const found = await repo.findById('abc123');
    expect(found).toEqual(credit);
  });

  it('returns undefined for unknown id', async () => {
    expect(await repo.findById('nope')).toBeUndefined();
  });

  it('paginates findAll correctly', async () => {
    for (let i = 0; i < 5; i++) await repo.save(makeCredit(`id${i}`));
    const page1 = await repo.findAll(1, 3);
    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(5);
    const page2 = await repo.findAll(2, 3);
    expect(page2.data).toHaveLength(2);
  });

  it('filters by project', async () => {
    await repo.save(makeCredit('a', 'PROJ-001'));
    await repo.save(makeCredit('b', 'PROJ-002'));
    const result = await repo.findByProject('PROJ-001', 1, 10);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe('a');
  });

  // ── findByStatus — one test per CreditStatus value ───────────────────────

  it('findByStatus returns only Active credits', async () => {
    await repo.save(makeCredit('active1', 'P', CreditStatus.Active));
    await repo.save(makeCredit('active2', 'P', CreditStatus.Active));
    await repo.save(makeCredit('retired1', 'P', CreditStatus.Retired));
    await repo.save(makeCredit('flagged1', 'P', CreditStatus.Flagged));
    await repo.save(makeCredit('pending1', 'P', CreditStatus.Pending));

    const result = await repo.findByStatus(CreditStatus.Active, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.every((c) => c.status === CreditStatus.Active)).toBe(
      true,
    );
    expect(result.data.map((c) => c.id).sort()).toEqual(['active1', 'active2']);
  });

  it('findByStatus returns only Retired credits', async () => {
    await repo.save(makeCredit('active1', 'P', CreditStatus.Active));
    await repo.save(makeCredit('retired1', 'P', CreditStatus.Retired));
    await repo.save(makeCredit('retired2', 'P', CreditStatus.Retired));

    const result = await repo.findByStatus(CreditStatus.Retired, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.every((c) => c.status === CreditStatus.Retired)).toBe(
      true,
    );
    expect(result.data.map((c) => c.id).sort()).toEqual([
      'retired1',
      'retired2',
    ]);
  });

  it('findByStatus returns only Flagged credits', async () => {
    await repo.save(makeCredit('active1', 'P', CreditStatus.Active));
    await repo.save(makeCredit('flagged1', 'P', CreditStatus.Flagged));
    await repo.save(makeCredit('flagged2', 'P', CreditStatus.Flagged));

    const result = await repo.findByStatus(CreditStatus.Flagged, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.every((c) => c.status === CreditStatus.Flagged)).toBe(
      true,
    );
    expect(result.data.map((c) => c.id).sort()).toEqual([
      'flagged1',
      'flagged2',
    ]);
  });

  it('findByStatus returns only Pending credits', async () => {
    await repo.save(makeCredit('pending1', 'P', CreditStatus.Pending));
    await repo.save(makeCredit('active1', 'P', CreditStatus.Active));

    const result = await repo.findByStatus(CreditStatus.Pending, 1, 10);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('pending1');
    expect(result.data[0].status).toBe(CreditStatus.Pending);
  });

  it('findByStatus returns empty result when no credits match', async () => {
    await repo.save(makeCredit('active1', 'P', CreditStatus.Active));

    const result = await repo.findByStatus(CreditStatus.Retired, 1, 10);
    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it('findByStatus paginates correctly', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.save(makeCredit(`active${i}`, 'P', CreditStatus.Active));
    }

    const page1 = await repo.findByStatus(CreditStatus.Active, 1, 3);
    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(5);
    expect(page1.page).toBe(1);

    const page2 = await repo.findByStatus(CreditStatus.Active, 2, 3);
    expect(page2.data).toHaveLength(2);
    expect(page2.total).toBe(5);
    expect(page2.page).toBe(2);
  });
});
