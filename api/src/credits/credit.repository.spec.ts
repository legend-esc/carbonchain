import { InMemoryCreditRepository } from './credit.repository';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../../../shared';
import { CacheService } from '../common/cache.service';

function makeCredit(
  id: string,
  projectId = 'PROJ-001',
  status = CreditStatus.Active,
  overrides: Partial<CreditEntity> = {},
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
  Object.assign(e, overrides);
  return e;
}

/** Minimal no-op CacheService for unit tests (no Redis). */
function makeNullCache(): CacheService {
  const c = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    delPattern: jest.fn().mockResolvedValue(undefined),
  };
  return c as unknown as CacheService;
}

describe('InMemoryCreditRepository', () => {
  let repo: InMemoryCreditRepository;

  beforeEach(() => {
    repo = new InMemoryCreditRepository(makeNullCache());
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

  // ── findByFilter — one test per filter dimension ─────────────────────────

  it('findByFilter filters by status', async () => {
    await repo.save(makeCredit('a1', 'P', CreditStatus.Active));
    await repo.save(makeCredit('r1', 'P', CreditStatus.Retired));
    await repo.save(makeCredit('f1', 'P', CreditStatus.Flagged));

    const result = await repo.findByFilter(
      { status: CreditStatus.Active },
      1,
      10,
    );
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('a1');
  });

  it('findByFilter filters by methodology', async () => {
    await repo.save(
      makeCredit('v1', 'P', CreditStatus.Active, { methodology: 'VCS' }),
    );
    await repo.save(
      makeCredit('g1', 'P', CreditStatus.Active, {
        methodology: 'Gold Standard',
      }),
    );
    await repo.save(
      makeCredit('v2', 'P', CreditStatus.Active, { methodology: 'VCS' }),
    );

    const result = await repo.findByFilter({ methodology: 'VCS' }, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.every((c) => c.methodology === 'VCS')).toBe(true);
  });

  it('findByFilter filters by geography', async () => {
    await repo.save(
      makeCredit('ng1', 'P', CreditStatus.Active, { geography: 'NG' }),
    );
    await repo.save(
      makeCredit('br1', 'P', CreditStatus.Active, { geography: 'BR' }),
    );
    await repo.save(
      makeCredit('ng2', 'P', CreditStatus.Active, { geography: 'NG' }),
    );

    const result = await repo.findByFilter({ geography: 'NG' }, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.every((c) => c.geography === 'NG')).toBe(true);
  });

  it('findByFilter filters by vintageYear', async () => {
    await repo.save(
      makeCredit('y24a', 'P', CreditStatus.Active, { vintageYear: 2024 }),
    );
    await repo.save(
      makeCredit('y23a', 'P', CreditStatus.Active, { vintageYear: 2023 }),
    );
    await repo.save(
      makeCredit('y24b', 'P', CreditStatus.Active, { vintageYear: 2024 }),
    );

    const result = await repo.findByFilter({ vintageYear: 2024 }, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.every((c) => c.vintageYear === 2024)).toBe(true);
  });

  it('findByFilter filters by minTonnes', async () => {
    await repo.save(
      makeCredit('big', 'P', CreditStatus.Active, { tonnes: '2000000' }),
    );
    await repo.save(
      makeCredit('small', 'P', CreditStatus.Active, { tonnes: '500000' }),
    );
    await repo.save(
      makeCredit('exact', 'P', CreditStatus.Active, { tonnes: '1000000' }),
    );

    const result = await repo.findByFilter({ minTonnes: '1000000' }, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.map((c) => c.id).sort()).toEqual(['big', 'exact']);
  });

  it('findByFilter filters by maxTonnes', async () => {
    await repo.save(
      makeCredit('big', 'P', CreditStatus.Active, { tonnes: '2000000' }),
    );
    await repo.save(
      makeCredit('small', 'P', CreditStatus.Active, { tonnes: '500000' }),
    );
    await repo.save(
      makeCredit('exact', 'P', CreditStatus.Active, { tonnes: '1000000' }),
    );

    const result = await repo.findByFilter({ maxTonnes: '1000000' }, 1, 10);
    expect(result.total).toBe(2);
    expect(result.data.map((c) => c.id).sort()).toEqual(['exact', 'small']);
  });

  // ── findByFilterCursor — cursor-based pagination ──────────────────────────

  it('findByFilterCursor returns first page when cursor is null', async () => {
    for (let i = 0; i < 6; i++) {
      await repo.save(makeCredit(`c${i}`, 'P', CreditStatus.Active));
    }

    const result = await repo.findByFilterCursor(
      { status: CreditStatus.Active },
      null,
      3,
    );
    expect(result.data).toHaveLength(3);
    expect(result.next_cursor).not.toBeNull();
  });

  it('findByFilterCursor returns middle page using cursor from previous page', async () => {
    for (let i = 0; i < 6; i++) {
      await repo.save(makeCredit(`d${i}`, 'P', CreditStatus.Active));
    }

    const page1 = await repo.findByFilterCursor(
      { status: CreditStatus.Active },
      null,
      2,
    );
    expect(page1.data).toHaveLength(2);
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await repo.findByFilterCursor(
      { status: CreditStatus.Active },
      page1.next_cursor,
      2,
    );
    expect(page2.data).toHaveLength(2);
    // Items on page2 must not overlap with page1
    const page1Ids = page1.data.map((c) => c.id);
    page2.data.forEach((c) => expect(page1Ids).not.toContain(c.id));
  });

  it('findByFilterCursor returns null next_cursor on last page', async () => {
    for (let i = 0; i < 4; i++) {
      await repo.save(makeCredit(`e${i}`, 'P', CreditStatus.Active));
    }

    const page1 = await repo.findByFilterCursor(
      { status: CreditStatus.Active },
      null,
      3,
    );
    expect(page1.next_cursor).not.toBeNull();

    const page2 = await repo.findByFilterCursor(
      { status: CreditStatus.Active },
      page1.next_cursor,
      3,
    );
    // Only 1 item remains
    expect(page2.data).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();
  });

  it('findByFilterCursor with cursor past end returns empty data and null next_cursor', async () => {
    await repo.save(makeCredit('only1', 'P', CreditStatus.Active));

    const result = await repo.findByFilterCursor(
      { status: CreditStatus.Active },
      Buffer.from('1700000000:only1').toString('base64url'), // cursor past the only item
      3,
    );
    expect(result.data).toHaveLength(0);
    expect(result.next_cursor).toBeNull();
  });

  // ── findByProject with pagination ─────────────────────────────────────────

  it('findByProject paginates correctly across multiple pages', async () => {
    for (let i = 0; i < 7; i++) {
      await repo.save(makeCredit(`p${i}`, 'PROJ-PAGINATE'));
    }
    // noise record in different project
    await repo.save(makeCredit('other', 'PROJ-OTHER'));

    const page1 = await repo.findByProject('PROJ-PAGINATE', 1, 3);
    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(7);

    const page3 = await repo.findByProject('PROJ-PAGINATE', 3, 3);
    expect(page3.data).toHaveLength(1);
    expect(page3.total).toBe(7);
  });

  // ── save overwrites (simulates cache invalidation) ───────────────────────

  it('save overwrites an existing credit with the same id (status update)', async () => {
    const credit = makeCredit('mutate1', 'P', CreditStatus.Active);
    await repo.save(credit);

    const updated = makeCredit('mutate1', 'P', CreditStatus.Retired);
    await repo.save(updated);

    const found = await repo.findById('mutate1');
    expect(found?.status).toBe(CreditStatus.Retired);
  });
});

describe('InMemoryCreditRepository.findByFilter', () => {
  let repo: InMemoryCreditRepository;
  let cache: CacheService;

  beforeEach(async () => {
    cache = makeNullCache();
    repo = new InMemoryCreditRepository(cache);
    await repo.save(makeCredit('a', 'P1', CreditStatus.Active));
    await repo.save(makeCredit('b', 'P1', CreditStatus.Retired));
    const c = makeCredit('c', 'P2', CreditStatus.Active);
    c.methodology = 'REDD+';
    c.geography = 'BR';
    c.vintageYear = 2022;
    await repo.save(c);
  });

  it('returns all credits with empty filter', async () => {
    const result = await repo.findByFilter({}, 1, 10);
    expect(result.total).toBe(3);
  });

  it('filters by status', async () => {
    const result = await repo.findByFilter(
      { status: CreditStatus.Retired },
      1,
      10,
    );
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('b');
  });

  it('filters by methodology (case-insensitive)', async () => {
    const result = await repo.findByFilter({ methodology: 'redd+' }, 1, 10);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('c');
  });

  it('filters by geography (case-insensitive)', async () => {
    const result = await repo.findByFilter({ geography: 'br' }, 1, 10);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('c');
  });

  it('filters by vintageYear', async () => {
    const result = await repo.findByFilter({ vintageYear: 2022 }, 1, 10);
    expect(result.total).toBe(1);
    expect(result.data[0].id).toBe('c');
  });

  it('returns cached result on second call', async () => {
    (cache.get as jest.Mock).mockResolvedValueOnce(null);
    await repo.findByFilter({}, 1, 10);
    const cachedData = { data: [], total: 0, page: 1, limit: 10 };
    (cache.get as jest.Mock).mockResolvedValueOnce(cachedData);
    const result = await repo.findByFilter({}, 1, 10);
    expect(result).toEqual(cachedData);
    expect(cache.set).toHaveBeenCalled();
  });

  it('invalidates cache on save', async () => {
    await repo.save(makeCredit('new'));
    expect(cache.delPattern).toHaveBeenCalledWith('credits:repo:filter:*');
  });
});
