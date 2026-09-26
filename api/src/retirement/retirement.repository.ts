import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Repository } from 'typeorm';
import { RetirementEntity } from './retirement.entity';
import { PageResult } from '../credits/credit.repository';
import { InjectRepository } from '@nestjs/typeorm';

export interface IRetirementRepository {
  save(record: RetirementEntity): Promise<RetirementEntity>;
  saveAll(records: RetirementEntity[]): Promise<RetirementEntity[]>;
  findById(id: string): Promise<RetirementEntity | undefined>;
  findByBuyer(
    buyer: string,
    page: number,
    limit: number,
  ): Promise<PageResult<RetirementEntity>>;
  findAll(page: number, limit: number): Promise<PageResult<RetirementEntity>>;
  /** Issue #942 — Paginated query with optional buyer/status filters. */
  findPaginated(dto: ListRetirementsDto): Promise<[RetirementEntity[], number]>;
}

export const RETIREMENT_REPOSITORY = 'RETIREMENT_REPOSITORY';

/**
 * In-memory retirement repository.
 * Replace with a TypeORM repository provider when PostgreSQL is available.
 */
@Injectable()
export class InMemoryRetirementRepository implements IRetirementRepository {
  private readonly store = new Map<string, RetirementEntity>();

  async save(record: RetirementEntity): Promise<RetirementEntity> {
    this.store.set(record.id, record);
    return record;
  }

  async saveAll(records: RetirementEntity[]): Promise<RetirementEntity[]> {
    for (const record of records) {
      this.store.set(record.id, record);
    }
    return records;
  }

  async findById(id: string): Promise<RetirementEntity | undefined> {
    return this.store.get(id);
  }

  async findByBuyer(
    buyer: string,
    page: number,
    limit: number,
  ): Promise<PageResult<RetirementEntity>> {
    const all = Array.from(this.store.values()).filter(
      (r) => r.buyer === buyer,
    );
    return this.paginate(all, page, limit);
  }

  async findAll(
    page: number,
    limit: number,
  ): Promise<PageResult<RetirementEntity>> {
    return this.paginate(Array.from(this.store.values()), page, limit);
  }

  /**
   * Issue #942 — Paginated query compatible with the ListRetirementsDto shape.
   * Applies optional buyer/status filters, sorts by retiredAt DESC, and
   * returns a [data, total] tuple matching the TypeORM findAndCount signature.
   */
  async findPaginated(
    dto: ListRetirementsDto,
  ): Promise<[RetirementEntity[], number]> {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;

    let all = Array.from(this.store.values());

    if (dto.buyer) {
      all = all.filter((r) => r.buyer === dto.buyer);
    }
    // RetirementEntity does not yet have a `status` column; filter is a no-op
    // until the entity is extended. This keeps the interface consistent.

    // Sort by retiredAt DESC (most recent first)
    all.sort((a, b) => b.retiredAt - a.retiredAt);

    const total = all.length;
    const skip = (page - 1) * pageSize;
    const data = all.slice(skip, skip + pageSize);

    return [data, total];
  }

  private paginate(
    items: RetirementEntity[],
    page: number,
    limit: number,
  ): PageResult<RetirementEntity> {
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
export class TypeOrmRetirementRepository implements IRetirementRepository {
  constructor(
    @Inject('RETIREMENT_ENTITY_REPOSITORY')
    private readonly repository: Repository<RetirementEntity>,
  ) {}

  save(record: RetirementEntity): Promise<RetirementEntity> {
    return this.repository.save(record);
  }

  saveAll(records: RetirementEntity[]): Promise<RetirementEntity[]> {
    return this.repository.save(records);
  }

  findById(id: string): Promise<RetirementEntity | undefined> {
    return this.repository
      .findOne({ where: { id } })
      .then((record) => record ?? undefined);
  }

  async findByBuyer(buyer: string, page: number, limit: number) {
    return this.paginate({ buyer }, page, limit);
  }

  async findAll(page: number, limit: number) {
    return this.paginate({}, page, limit);
  }

  private async paginate(
    where: Record<string, unknown>,
    page: number,
    limit: number,
  ): Promise<PageResult<RetirementEntity>> {
    const [data, total] = await this.repository.findAndCount({
      where,
      skip: (page - 1) * limit,
      take: limit,
    });
    return { data, total, page, limit };
  }
}
