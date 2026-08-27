import { Injectable } from '@nestjs/common';
import { ProjectEntity } from './project.entity';

export interface IProjectRepository {
  save(project: ProjectEntity): Promise<ProjectEntity>;
  findById(id: string): Promise<ProjectEntity | undefined>;
  findAll(): Promise<ProjectEntity[]>;
}

export const PROJECT_REPOSITORY = 'PROJECT_REPOSITORY';

/**
 * In-memory project repository.
 * Replace with a TypeORM repository provider when PostgreSQL is available.
 */
@Injectable()
export class InMemoryProjectRepository implements IProjectRepository {
  private readonly store = new Map<string, ProjectEntity>();

  async save(project: ProjectEntity): Promise<ProjectEntity> {
    this.store.set(project.id, project);
    return project;
  }

  async findById(id: string): Promise<ProjectEntity | undefined> {
    return this.store.get(id);
  }

  async findAll(): Promise<ProjectEntity[]> {
    return Array.from(this.store.values());
  }
}
