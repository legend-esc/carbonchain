import { Injectable } from '@nestjs/common';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../shared';

export interface PageResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ICreditRepository {
  save(credit: CreditEntity): Promise<CreditEntity>;
  findById(id: string): Promise<CreditEntity | undefined>;
  findByProject(
    projectId: string,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>>;
  findAll(page: number, limit: number): Promise<PageResult<CreditEntity>>;
  /**
   * Return a paginated list of credits whose status matches `status`.
   * When `status` is omitted the caller is responsible for applying a default.
   */
  findByStatus(
    status: CreditStatus,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>>;
}

export const CREDIT_REPOSITORY = 'CREDIT_REPOSITORY';

/**
 * In-memory credit repository.
 * Replace with a TypeORM repository provider when PostgreSQL is available.
 */
@Injectable()
export class InMemoryCreditRepository implements ICreditRepository {
  private readonly store = new Map<string, CreditEntity>();

  async save(credit: CreditEntity): Promise<CreditEntity> {
    this.store.set(credit.id, credit);
    return credit;
  }

  async findById(id: string): Promise<CreditEntity | undefined> {
    return this.store.get(id);
  }

  async findByProject(
    projectId: string,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>> {
    const all = Array.from(this.store.values()).filter(
      (c) => c.projectId === projectId,
    );
    return this.paginate(all, page, limit);
  }

  async findAll(
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>> {
    return this.paginate(Array.from(this.store.values()), page, limit);
  }

  async findByStatus(
    status: CreditStatus,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>> {
    const all = Array.from(this.store.values()).filter(
      (c) => c.status === status,
    );
    return this.paginate(all, page, limit);
  }

  private paginate(
    items: CreditEntity[],
    page: number,
    limit: number,
  ): PageResult<CreditEntity> {
    const offset = (page - 1) * limit;
    return {
      data: items.slice(offset, offset + limit),
      total: items.length,
      page,
      limit,
    };
  }
}
