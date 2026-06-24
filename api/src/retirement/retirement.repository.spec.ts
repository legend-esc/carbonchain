import { InMemoryRetirementRepository } from './retirement.repository';
import { RetirementEntity } from './retirement.entity';

function makeRetirement(id: string, buyer = 'GBUYER'): RetirementEntity {
  const e = new RetirementEntity();
  e.id = id;
  e.creditId = 'creditabc';
  e.buyer = buyer;
  e.tonnesRetired = '500000';
  e.reason = 'Scope 3 offset';
  e.retiredAt = 1700000000;
  e.txHash = '';
  return e;
}

describe('InMemoryRetirementRepository', () => {
  let repo: InMemoryRetirementRepository;

  beforeEach(() => {
    repo = new InMemoryRetirementRepository();
  });

  it('saves and retrieves a retirement by id', async () => {
    const r = makeRetirement('ret1');
    await repo.save(r);
    expect(await repo.findById('ret1')).toEqual(r);
  });

  it('returns undefined for unknown id', async () => {
    expect(await repo.findById('nope')).toBeUndefined();
  });

  it('paginates findAll', async () => {
    for (let i = 0; i < 4; i++) await repo.save(makeRetirement(`r${i}`));
    const page = await repo.findAll(1, 2);
    expect(page.data).toHaveLength(2);
    expect(page.total).toBe(4);
  });

  it('filters by buyer', async () => {
    await repo.save(makeRetirement('r1', 'GBUYER1'));
    await repo.save(makeRetirement('r2', 'GBUYER2'));
    const result = await repo.findByBuyer('GBUYER1', 1, 10);
    expect(result.data).toHaveLength(1);
  });
});
