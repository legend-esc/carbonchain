import { Injectable } from '@nestjs/common';
import { ProjectEntity, ProjectStatus } from './project.entity';

export interface PageResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface IProjectRepository {
  save(project: ProjectEntity): Promise<ProjectEntity>;
  findById(id: string): Promise<ProjectEntity | undefined>;
  findAll(page: number, limit: number): Promise<PageResult<ProjectEntity>>;
  findByStatus(
    status: ProjectStatus,
    page: number,
    limit: number,
  ): Promise<PageResult<ProjectEntity>>;
  /**
   * Find all projects with `pending` status for reconciliation.
   * These are projects where IPFS upload succeeded but contract call failed or hung.
   */
  findPendingProjects(page: number, limit: number): Promise<PageResult<ProjectEntity>>;
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

  async findAll(
    page: number,
    limit: number,
  ): Promise<PageResult<ProjectEntity>> {
    return this.paginate(Array.from(this.store.values()), page, limit);
  }

  async findByStatus(
    status: ProjectStatus,
    page: number,
    limit: number,
  ): Promise<PageResult<ProjectEntity>> {
    const all = Array.from(this.store.values()).filter(
      (p) => p.status === status,
    );
    return this.paginate(all, page, limit);
  }

  async findPendingProjects(
    page: number,
    limit: number,
  ): Promise<PageResult<ProjectEntity>> {
    return this.findByStatus(ProjectStatus.Pending, page, limit);
  }

  private paginate(
    items: ProjectEntity[],
    page: number,
    limit: number,
  ): PageResult<ProjectEntity> {
    const offset = (page - 1) * limit;
    return {
      data: items.slice(offset, offset + limit),
      total: items.length,
      page,
      limit,
    };
  }
}
