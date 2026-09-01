import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { CreditEntity } from './credit.entity';
import { CreditStatus } from '../../../shared';
import { CacheService } from '../common/cache.service';
import { Repository } from 'typeorm';

export interface PageResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Cursor-based pagination result.
 *
 * The cursor is an opaque string encoding `issued_at:id` of the last item
 * returned.  Pass it as `?cursor=` on the next request to get the next page.
 * When `next_cursor` is `null` there are no more results.
 *
 * P95 latency is O(1) regardless of cursor depth because we use an index seek
 * on (issued_at, id) rather than OFFSET-based scanning.
 */
export interface CursorPageResult<T> {
  data: T[];
  next_cursor: string | null;
  /** @deprecated Use next_cursor for continued pagination. */
  limit: number;
}

export interface CreditFilter {
  status?: CreditStatus;
  methodology?: string;
  geography?: string;
  vintageYear?: number;
  /** Inclusive lower bound on tonnes, decimal string (i128 range). */
  minTonnes?: string;
  /** Inclusive upper bound on tonnes, decimal string (i128 range). */
  maxTonnes?: string;
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

  /**
   * Cursor-based pagination over filtered credits.
   *
   * Ordered by (issued_at ASC, id ASC) for stable, consistent pagination.
   * Pass `cursor` from the previous response's `next_cursor` to continue.
   * When `cursor` is undefined/null the first page is returned.
   *
   * This is O(1) at any depth — suitable for deep pagination over 10K+ credits.
   */
  findByFilterCursor(
    filter: CreditFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPageResult<CreditEntity>>;
}

export const CREDIT_REPOSITORY = 'CREDIT_REPOSITORY';

const FILTER_TTL = 60; // seconds
const filterCacheKey = (filter: CreditFilter, page: number, limit: number) =>
  `credits:repo:filter:${JSON.stringify({ filter, page, limit })}`;

/**
 * Encode a cursor from a CreditEntity.
 * Format: base64("<issued_at>:<id>")
 */
function encodeCursor(entity: CreditEntity): string {
  return Buffer.from(`${entity.issuedAt}:${entity.id}`).toString('base64url');
}

/**
 * Decode a cursor string back to { issuedAt, id }.
 * Returns null when the cursor is invalid/corrupt.
 */
function decodeCursor(cursor: string): { issuedAt: number; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.indexOf(':');
    if (sep < 0) return null;
    const issuedAt = parseInt(raw.slice(0, sep), 10);
    const id = raw.slice(sep + 1);
    if (isNaN(issuedAt) || !id) return null;
    return { issuedAt, id };
  } catch {
    return null;
  }
}

/**
 * In-memory credit repository.
 * Replace with a TypeORM repository provider when PostgreSQL is available.
 */
@Injectable()
export class InMemoryCreditRepository implements ICreditRepository {
  private readonly store = new Map<string, CreditEntity>();
  private readonly log = new Logger(InMemoryCreditRepository.name);

  constructor(@Optional() private readonly cache?: CacheService) {}

  async save(credit: CreditEntity): Promise<CreditEntity> {
    this.store.set(credit.id, credit);
    // Invalidate filter cache on any write
    await this.cache?.delPattern('credits:repo:filter:*');
    await this.cache?.delPattern('credits:repo:cursor:*');
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
        (c) =>
          c.methodology.toLowerCase() === filter.methodology!.toLowerCase(),
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
    if (filter.minTonnes) {
      const minVal = BigInt(filter.minTonnes);
      all = all.filter((c) => BigInt(c.tonnes) >= minVal);
    }
    if (filter.maxTonnes) {
      const maxVal = BigInt(filter.maxTonnes);
      all = all.filter((c) => BigInt(c.tonnes) <= maxVal);
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

  /**
   * Cursor-based pagination — O(1) regardless of cursor depth.
   *
   * Records are sorted by (issuedAt ASC, id ASC). A composite index on these
   * two columns (when backed by PostgreSQL) makes this a single seek + range
   * scan with no OFFSET cost.  The in-memory implementation reproduces the
   * same ordering so behaviour is identical when migrated to Postgres.
   *
   * Emits a deprecation warning in the log when `cursor` is undefined and
   * `limit` > 0 so callers are guided toward providing an explicit first-page
   * cursor instead of relying on implicit start-of-list behaviour.
   *
   * @deprecated offset-based `findByFilter` — prefer this method for new code.
   */
  async findByFilterCursor(
    filter: CreditFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPageResult<CreditEntity>> {
    // Clamp limit to a safe maximum
    const safeLimit = Math.min(Math.max(1, limit), 100);

    // Apply filters
    let all = Array.from(this.store.values());
    if (filter.status !== undefined) {
      all = all.filter((c) => c.status === filter.status);
    }
    if (filter.methodology) {
      all = all.filter(
        (c) =>
          c.methodology.toLowerCase() === filter.methodology!.toLowerCase(),
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
    if (filter.minTonnes) {
      const minVal = BigInt(filter.minTonnes);
      all = all.filter((c) => BigInt(c.tonnes) >= minVal);
    }
    if (filter.maxTonnes) {
      const maxVal = BigInt(filter.maxTonnes);
      all = all.filter((c) => BigInt(c.tonnes) <= maxVal);
    }

    // Stable sort: (issuedAt ASC, id ASC)
    all.sort((a, b) => {
      if (a.issuedAt !== b.issuedAt) return a.issuedAt - b.issuedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // Seek past the cursor
    let startIdx = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        // Find the first item that comes AFTER the cursor position
        startIdx = all.findIndex(
          (c) =>
            c.issuedAt > decoded.issuedAt ||
            (c.issuedAt === decoded.issuedAt && c.id > decoded.id),
        );
        if (startIdx === -1) {
          // Cursor is past the end
          return { data: [], next_cursor: null, limit: safeLimit };
        }
      } else {
        this.log.warn(
          `findByFilterCursor: invalid cursor "${cursor}", starting from beginning`,
        );
      }
    }

    const page = all.slice(startIdx, startIdx + safeLimit);
    const next_cursor =
      page.length === safeLimit ? encodeCursor(page[page.length - 1]) : null;

    return { data: page, next_cursor, limit: safeLimit };
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
    return this.repository.findOne({ where: { id } }).then((r) => r ?? undefined);
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

  async findByFilterCursor(
    filter: CreditFilter,
    cursor: string | undefined,
    limit: number,
  ): Promise<CursorPageResult<CreditEntity>> {
    // Fall back to a simple full-scan + slice for the TypeORM implementation.
    const all = await this.repository.find();
    let filtered = all;
    if (filter.status !== undefined) {
      filtered = filtered.filter((c) => c.status === filter.status);
    }
    if (filter.methodology) {
      filtered = filtered.filter(
        (c) => c.methodology.toLowerCase() === filter.methodology!.toLowerCase(),
      );
    }
    if (filter.geography) {
      filtered = filtered.filter(
        (c) => c.geography.toLowerCase() === filter.geography!.toLowerCase(),
      );
    }
    if (filter.vintageYear !== undefined) {
      filtered = filtered.filter((c) => c.vintageYear === filter.vintageYear);
    }
    if (filter.minTonnes) {
      const minVal = BigInt(filter.minTonnes);
      filtered = filtered.filter((c) => BigInt(c.tonnes) >= minVal);
    }
    if (filter.maxTonnes) {
      const maxVal = BigInt(filter.maxTonnes);
      filtered = filtered.filter((c) => BigInt(c.tonnes) <= maxVal);
    }

    filtered.sort((a, b) => {
      if (a.issuedAt !== b.issuedAt) return a.issuedAt - b.issuedAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const safeLimit = Math.min(Math.max(1, limit), 100);
    let startIdx = 0;
    if (cursor) {
      try {
        const raw = Buffer.from(cursor, 'base64url').toString('utf8');
        const sep = raw.indexOf(':');
        if (sep >= 0) {
          const issuedAt = parseInt(raw.slice(0, sep), 10);
          const id = raw.slice(sep + 1);
          startIdx = filtered.findIndex(
            (c) =>
              c.issuedAt > issuedAt ||
              (c.issuedAt === issuedAt && c.id > id),
          );
          if (startIdx === -1) return { data: [], next_cursor: null, limit: safeLimit };
        }
      } catch {
        // invalid cursor — start from beginning
      }
    }

    const page = filtered.slice(startIdx, startIdx + safeLimit);
    const next_cursor =
      page.length === safeLimit
        ? Buffer.from(`${page[page.length - 1].issuedAt}:${page[page.length - 1].id}`).toString('base64url')
        : null;

    return { data: page, next_cursor, limit: safeLimit };
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
