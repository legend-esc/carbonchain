import { Inject, Injectable, Optional } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../../../shared';
import { CacheService } from '../common/cache.service';
import { InjectRepository } from '@nestjs/typeorm';

export interface PageResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface CreditFilter {
  status?: CreditStatus;
  methodology?: string;
  geography?: string;
  vintageYear?: number;
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
  findByFilter(
    filter: CreditFilter,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>>;
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

const FILTER_TTL = 60; // seconds
const filterCacheKey = (filter: CreditFilter, page: number, limit: number) =>
  `credits:repo:filter:${JSON.stringify({ filter, page, limit })}`;

/**
 * In-memory credit repository.
 * Replace with a TypeORM repository provider when PostgreSQL is available.
 */
@Injectable()
export class InMemoryCreditRepository implements ICreditRepository {
  private readonly store = new Map<string, CreditEntity>();

  constructor(@Optional() private readonly cache?: CacheService) {}

  async save(credit: CreditEntity): Promise<CreditEntity> {
    this.store.set(credit.id, credit);
    // Invalidate filter cache on any write
    await this.cache?.delPattern('credits:repo:filter:*');
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

  async findByFilter(
    filter: CreditFilter,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>> {
    const key = filterCacheKey(filter, page, limit);
    const cached = await this.cache?.get<PageResult<CreditEntity>>(key);
    if (cached) return cached;

    let all = Array.from(this.store.values());
    if (filter.status !== undefined) {
      all = all.filter((c) => c.status === filter.status);
    }
    if (filter.methodology) {
      all = all.filter(
        (c) => c.methodology.toLowerCase() === filter.methodology!.toLowerCase(),
      );
    }
    if (filter.geography) {
      all = all.filter(
        (c) => c.geography.toLowerCase() === filter.geography!.toLowerCase(),
      );
    }
    if (filter.vintageYear !== undefined) {
      all = all.filter((c) => c.vintageYear === filter.vintageYear);
    }

    const result = this.paginate(all, page, limit);
    await this.cache?.set(key, result, FILTER_TTL);
    return result;
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

@Injectable()
export class TypeOrmCreditRepository implements ICreditRepository {
  constructor(
    @Inject('CREDIT_ENTITY_REPOSITORY')
    private readonly repository: Repository<CreditEntity>,
  ) {}

  save(credit: CreditEntity): Promise<CreditEntity> {
    return this.repository.save(credit);
  }

  findById(id: string): Promise<CreditEntity | undefined> {
    return this.repository.findOne({ where: { id } });
  }

  async findByProject(projectId: string, page: number, limit: number) {
    return this.paginate({ projectId }, page, limit);
  }

  async findAll(page: number, limit: number) {
    return this.paginate({}, page, limit);
  }

  async findByFilter(filter: CreditFilter, page: number, limit: number) {
    const records = await this.repository.find();
    const filtered = records.filter((credit) =>
      (!filter.status || credit.status === filter.status) &&
      (!filter.methodology ||
        credit.methodology.toLowerCase() === filter.methodology.toLowerCase()) &&
      (!filter.geography ||
        credit.geography.toLowerCase() === filter.geography.toLowerCase()) &&
      (filter.vintageYear === undefined ||
        credit.vintageYear === filter.vintageYear),
    );
    return this.page(filtered, page, limit);
  }

  findByStatus(status: CreditStatus, page: number, limit: number) {
    return this.paginate({ status }, page, limit);
  }

  private async paginate(
    where: Record<string, unknown>,
    page: number,
    limit: number,
  ): Promise<PageResult<CreditEntity>> {
    const [data, total] = await this.repository.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }

  private page(items: CreditEntity[], page: number, limit: number) {
    return {
      data: items.slice((page - 1) * limit, page * limit),
      total: items.length,
      page,
      limit,
    };
  }
}
