import { Test, TestingModule } from '@nestjs/testing';
import { DateRangeFilter } from './date-range-filter';
import { ContractIdFilter } from './contract-id-filter';
import { EventTypePredicate } from './event-type-predicate';
import { EventFilterBuilder, SorobanEvent } from './event-filter-builder';

describe('Filter Builder Pattern', () => {
  const mockEvents: SorobanEvent[] = [
    {
      id: '1',
      type: 'CreditMinted',
      contractId: 'CONTRACT_1',
      ledger: 100001,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
      data: { amount: 100 },
    },
    {
      id: '2',
      type: 'CreditRetired',
      contractId: 'CONTRACT_2',
      ledger: 100002,
      timestamp: Math.floor(Date.now() / 1000) - 7200,
      data: { amount: 50 },
    },
    {
      id: '3',
      type: 'OfferCreated',
      contractId: 'CONTRACT_1',
      ledger: 100003,
      timestamp: Math.floor(Date.now() / 1000) - 86400,
      data: { price: 25 },
    },
    {
      id: '4',
      type: 'MRVDataSubmitted',
      contractId: 'CONTRACT_3',
      ledger: 100004,
      timestamp: Math.floor(Date.now() / 1000) - 172800,
      data: { verified: true },
    },
  ];

  describe('DateRangeFilter', () => {
    it('should filter events by date range', () => {
      const filter = DateRangeFilter.create().lastHours(2);
      const filtered = filter.apply(mockEvents);
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.timestamp > Math.floor(Date.now() / 1000) - 7200)).toBe(true);
    });

    it('should filter events by today', () => {
      const filter = DateRangeFilter.create().today();
      const filtered = filter.apply(mockEvents);
      expect(filtered.length).toBe(3);
    });

    it('should return null when no date range is set', () => {
      const filter = DateRangeFilter.create();
      expect(filter.build()).toBeNull();
    });
  });

  describe('ContractIdFilter', () => {
    it('should filter events by contract ID', () => {
      const filter = ContractIdFilter.create().include('CONTRACT_1');
      const filtered = filter.apply(mockEvents);
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.contractId === 'CONTRACT_1')).toBe(true);
    });

    it('should exclude specific contract IDs', () => {
      const filter = ContractIdFilter.create().exclude('CONTRACT_1');
      const filtered = filter.apply(mockEvents);
      expect(filtered.length).toBe(2);
      expect(filtered.every((e) => e.contractId !== 'CONTRACT_1')).toBe(true);
    });

    it('should validate contract ID format', () => {
      const filter = ContractIdFilter.create();
      expect(() => filter.include('')).toThrow('Contract ID cannot be empty');
      expect(() => filter.include('A'.repeat(65))).toThrow(
        'Contract ID cannot exceed 64 characters',
      );
    });

    it('should skip validation when requested', () => {
      const filter = ContractIdFilter.create().skipValidation();
      expect(() => filter.include('')).not.toThrow();
    });
  });

  describe('EventTypePredicate', () => {
    it('should filter events by type', () => {
      const predicate = EventTypePredicate.create().isCreditMinted();
      const filtered = predicate.apply(mockEvents);
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('CreditMinted');
    });

    it('should filter credit status changes', () => {
      const predicate = EventTypePredicate.create().isCreditStatusChange();
      const filtered = predicate.apply(mockEvents);
      expect(filtered.length).toBe(2);
      expect(
        filtered.every((e) =>
          ['CreditMinted', 'CreditRetired'].includes(e.type),
        ),
      ).toBe(true);
    });

    it('should filter marketplace events', () => {
      const predicate = EventTypePredicate.create().isMarketplaceEvent();
      const filtered = predicate.apply(mockEvents);
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('OfferCreated');
    });

    it('should filter MRV events', () => {
      const predicate = EventTypePredicate.create().isMrvEvent();
      const filtered = predicate.apply(mockEvents);
      expect(filtered.length).toBe(1);
      expect(filtered[0].type).toBe('MRVDataSubmitted');
    });

    it('should support custom predicates', () => {
      const predicate = EventTypePredicate.create()
        .startsWith('Credit')
        .notEquals('CreditFlagged');
      const filtered = predicate.apply(mockEvents);
      expect(filtered.length).toBe(2);
      expect(
        filtered.every((e) => e.type === 'CreditMinted' || e.type === 'CreditRetired'),
      ).toBe(true);
    });
  });

  describe('EventFilterBuilder', () => {
    it('should combine multiple filters', () => {
      const builder = EventFilterBuilder.create();
      builder.contractIds().include('CONTRACT_1');
      builder.eventTypes().isCreditMinted();

      const filtered = builder.apply(mockEvents);
      expect(filtered.length).toBe(1);
      expect(filtered[0].contractId).toBe('CONTRACT_1');
      expect(filtered[0].type).toBe('CreditMinted');
    });

    it('should apply pagination', () => {
      const builder = EventFilterBuilder.create();
      builder.paginate(1, 2);

      const filtered = builder.apply(mockEvents);
      expect(filtered.length).toBe(2);
    });

    it('should support custom where clauses', () => {
      const builder = EventFilterBuilder.create();
      builder.where((e) => e.data['amount'] !== undefined);

      const filtered = builder.apply(mockEvents);
      expect(filtered.length).toBe(2);
    });

    it('should build filter config', () => {
      const builder = EventFilterBuilder.create();
      builder.contractIds().include('CONTRACT_1');
      builder.eventTypes().isCreditMinted();
      builder.paginate(1, 10);

      const config = builder.build();
      expect(config.contractIds).toBeDefined();
      expect(config.eventTypes).toBeDefined();
      expect(config.pagination).toEqual({ page: 1, limit: 10 });
    });

    it('should generate query params', () => {
      const builder = EventFilterBuilder.create();
      builder.paginate(2, 20);

      const params = builder.toQueryParams();
      expect(params.page).toBe('2');
      expect(params.limit).toBe('20');
    });
  });
});
