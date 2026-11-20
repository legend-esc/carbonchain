import { VerifierRepository } from './verifier.repository';
import { VerifierEntity } from './verifier.entity';
import { Repository } from 'typeorm';

function makeEntity(address: string): VerifierEntity {
  const e = new VerifierEntity();
  e.address = address;
  e.name = null;
  e.capabilities = [];
  e.reputation = { approvalCount: 0, disputeCount: 0 };
  e.registeredAt = new Date();
  return e;
}

describe('VerifierRepository', () => {
  let repo: VerifierRepository;
  let orm: jest.Mocked<Partial<Repository<VerifierEntity>>>;

  beforeEach(() => {
    orm = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    };
    repo = new VerifierRepository(orm as any);
  });

  it('findAll delegates to repo.find ordered by address', async () => {
    const list = [makeEntity('GB'), makeEntity('GA')];
    (orm.find as jest.Mock).mockResolvedValue(list);
    const result = await repo.findAll();
    expect(result).toEqual(list);
    expect(orm.find).toHaveBeenCalledWith({ order: { address: 'ASC' } });
  });

  it('findByAddress delegates to repo.findOne', async () => {
    const entity = makeEntity('GX');
    (orm.findOne as jest.Mock).mockResolvedValue(entity);
    expect(await repo.findByAddress('GX')).toBe(entity);
    expect(orm.findOne).toHaveBeenCalledWith({ where: { address: 'GX' } });
  });

  it('findByAddress returns null when not found', async () => {
    (orm.findOne as jest.Mock).mockResolvedValue(null);
    expect(await repo.findByAddress('GX')).toBeNull();
  });

  it('save persists via repo.save', async () => {
    const entity = makeEntity('GX');
    (orm.save as jest.Mock).mockResolvedValue(entity);
    expect(await repo.save(entity)).toBe(entity);
  });

  it('saveAll persists multiple via repo.save', async () => {
    const list = [makeEntity('G1'), makeEntity('G2')];
    (orm.save as jest.Mock).mockResolvedValue(list);
    expect(await repo.saveAll(list)).toBe(list);
  });

  it('upsert writes and re-reads the record', async () => {
    const entity = makeEntity('GX');
    (orm.findOne as jest.Mock).mockResolvedValue(entity);
    const result = await repo.upsert(entity);
    expect(orm.upsert).toHaveBeenCalledWith(entity, ['address']);
    expect(result).toBe(entity);
  });

  it('delete removes by address', async () => {
    await repo.delete('GX');
    expect(orm.delete).toHaveBeenCalledWith({ address: 'GX' });
  });
});
