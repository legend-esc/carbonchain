import { InMemoryProjectRepository } from './project.repository';
import { ProjectEntity } from './project.entity';

function makeProject(id: string, name = 'Reforestation'): ProjectEntity {
  const p = new ProjectEntity();
  p.id = id;
  p.name = name;
  p.developer = 'DevCo';
  p.description = 'A sample project';
  p.location = 'NG';
  p.methodology = 'VCS';
  p.documentsCid = '';
  return p;
}

describe('InMemoryProjectRepository', () => {
  let repo: InMemoryProjectRepository;

  beforeEach(() => {
    repo = new InMemoryProjectRepository();
  });

  it('saves and retrieves a project by id', async () => {
    const project = makeProject('PROJ-1');
    await repo.save(project);
    expect(await repo.findById('PROJ-1')).toEqual(project);
  });

  it('returns undefined for an unknown id', async () => {
    expect(await repo.findById('missing')).toBeUndefined();
  });

  it('returns all saved projects via findAll', async () => {
    await repo.save(makeProject('A'));
    await repo.save(makeProject('B'));
    const all = await repo.findAll();
    expect(all.map((p) => p.id).sort()).toEqual(['A', 'B']);
  });

  it('overwrites an existing project on save (idempotent)', async () => {
    await repo.save(makeProject('A', 'First'));
    await repo.save(makeProject('A', 'Second'));
    const found = await repo.findById('A');
    expect(found?.name).toBe('Second');
    expect((await repo.findAll()).length).toBe(1);
  });
});
