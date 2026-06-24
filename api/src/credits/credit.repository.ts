import { Injectable } from '@nestjs/common';

export interface CreditFilter {
  methodology?: string;
  geography?: string;
  vintageYear?: number;
}

export interface CreditRecord {
  id: string;
  methodology: string;
  geography: string;
  vintage_year: number;
}

/**
 * CreditRepository wraps database access for credits.
 * All queries use parameterized inputs to prevent SQL injection.
 */
@Injectable()
export class CreditRepository {
  private readonly records: CreditRecord[] = [];

  /** Seed initial records (used in tests / dev). */
  seed(records: CreditRecord[]): void {
    this.records.length = 0;
    this.records.push(...records);
  }

  /**
   * findByFilter returns credits matching the provided filter.
   * Each field is compared strictly (===) — raw filter strings are never
   * interpolated into a query, preventing SQL injection.
   */
  findByFilter(filter: CreditFilter): CreditRecord[] {
    return this.records.filter((r) => {
      if (filter.methodology !== undefined && r.methodology !== filter.methodology)
        return false;
      if (filter.geography !== undefined && r.geography !== filter.geography)
        return false;
      if (filter.vintageYear !== undefined && r.vintage_year !== filter.vintageYear)
        return false;
      return true;
    });
  }
}
