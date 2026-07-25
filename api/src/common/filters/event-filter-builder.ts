import { DateRangeFilter } from './date-range-filter';
import { ContractIdFilter } from './contract-id-filter';
import { EventTypePredicate, EventPredicate } from './event-type-predicate';

export interface SorobanEvent {
  id: string;
  type: string;
  contractId: string;
  ledger: number;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface EventFilterConfig {
  dateRange?: DateRangeFilter;
  contractIds?: ContractIdFilter;
  eventTypes?: EventTypePredicate;
  customPredicate?: (event: SorobanEvent) => boolean;
  pagination?: {
    page: number;
    limit: number;
  };
}

export class EventFilterBuilder {
  private dateRangeFilter: DateRangeFilter | null = null;
  private contractIdFilter: ContractIdFilter | null = null;
  private eventTypePredicate: EventTypePredicate | null = null;
  private customPredicates: ((event: SorobanEvent) => boolean)[] = [];
  private paginationConfig: { page: number; limit: number } | null = null;

  static create(): EventFilterBuilder {
    return new EventFilterBuilder();
  }

  dateRange(): DateRangeFilter {
    this.dateRangeFilter = DateRangeFilter.create();
    return this.dateRangeFilter;
  }

  contractIds(): ContractIdFilter {
    this.contractIdFilter = ContractIdFilter.create();
    return this.contractIdFilter;
  }

  eventTypes(): EventTypePredicate {
    this.eventTypePredicate = EventTypePredicate.create();
    return this.eventTypePredicate;
  }

  where(predicate: (event: SorobanEvent) => boolean): this {
    this.customPredicates.push(predicate);
    return this;
  }

  paginate(page: number, limit: number): this {
    this.paginationConfig = { page, limit };
    return this;
  }

  build(): EventFilterConfig {
    return {
      dateRange: this.dateRangeFilter || undefined,
      contractIds: this.contractIdFilter || undefined,
      eventTypes: this.eventTypePredicate || undefined,
      customPredicate:
        this.customPredicates.length > 0
          ? (event) => this.customPredicates.every((p) => p(event))
          : undefined,
      pagination: this.paginationConfig || undefined,
    };
  }

  apply(events: SorobanEvent[]): SorobanEvent[] {
    let filtered = [...events];

    if (this.contractIdFilter) {
      filtered = this.contractIdFilter.apply(filtered);
    }

    if (this.eventTypePredicate) {
      filtered = this.eventTypePredicate.apply(filtered);
    }

    if (this.dateRangeFilter) {
      filtered = this.dateRangeFilter.apply(filtered);
    }

    for (const predicate of this.customPredicates) {
      filtered = filtered.filter(predicate);
    }

    if (this.paginationConfig) {
      const { page, limit } = this.paginationConfig;
      const start = (page - 1) * limit;
      filtered = filtered.slice(start, start + limit);
    }

    return filtered;
  }

  toQueryParams(): Record<string, string> {
    const params: Record<string, string> = {};

    if (this.paginationConfig) {
      params.page = this.paginationConfig.page.toString();
      params.limit = this.paginationConfig.limit.toString();
    }

    return params;
  }
}
