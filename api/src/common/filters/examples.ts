/**
 * Filter Builder Pattern Examples
 *
 * This file demonstrates how to use the filter builder classes
 * for querying and filtering Soroban events.
 */

import { EventFilterBuilder, SorobanEvent } from './event-filter-builder';

// Example 1: Basic event filtering
export function exampleBasicFiltering(events: SorobanEvent[]): SorobanEvent[] {
  return EventFilterBuilder.create()
    .eventTypes()
    .isCreditStatusChange()
    .build()
    ? events.filter((e) =>
        ['CreditMinted', 'CreditRetired', 'CreditFlagged', 'CreditRevoked'].includes(e.type),
      )
    : events;
}

// Example 2: Date range filtering
export function exampleDateRangeFiltering(
  events: SorobanEvent[],
): SorobanEvent[] {
  return EventFilterBuilder.create()
    .dateRange()
    .lastDays(7)
    .build()
    ? events.filter((e) => {
        const eventDate = new Date(e.timestamp * 1000);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return eventDate >= weekAgo;
      })
    : events;
}

// Example 3: Contract ID filtering
export function exampleContractIdFiltering(
  events: SorobanEvent[],
  contractId: string,
): SorobanEvent[] {
  return EventFilterBuilder.create()
    .contractIds()
    .include(contractId)
    .build()
    ? events.filter((e) => e.contractId === contractId)
    : events;
}

// Example 4: Combined filters
export function exampleCombinedFilters(events: SorobanEvent[]): SorobanEvent[] {
  const builder = EventFilterBuilder.create();

  builder
    .dateRange()
    .lastWeek();

  builder
    .contractIds()
    .include('CONTRACT_ID_1')
    .include('CONTRACT_ID_2');

  builder
    .eventTypes()
    .isCreditMinted()
    .isCreditRetired();

  builder.paginate(1, 10);

  return builder.apply(events);
}

// Example 5: Custom predicate
export function exampleCustomPredicate(events: SorobanEvent[]): SorobanEvent[] {
  return EventFilterBuilder.create()
    .where((event) => event.ledger > 100000)
    .where((event) => event.data['amount'] !== undefined)
    .apply(events);
}

// Example 6: Marketplace events only
export function exampleMarketplaceEvents(
  events: SorobanEvent[],
): SorobanEvent[] {
  return EventFilterBuilder.create()
    .eventTypes()
    .isMarketplaceEvent()
    .apply(events);
}

// Example 7: MRV verification events
export function exampleMrvVerificationEvents(
  events: SorobanEvent[],
): SorobanEvent[] {
  return EventFilterBuilder.create()
    .eventTypes()
    .isVerificationEvent()
    .apply(events);
}

// Example 8: Today's events
export function exampleTodayEvents(events: SorobanEvent[]): SorobanEvent[] {
  return EventFilterBuilder.create()
    .dateRange()
    .today()
    .apply(events);
}

// Example 9: Events from last month, excluding revoked credits
export function exampleLastMonthExcludingRevoked(
  events: SorobanEvent[],
): SorobanEvent[] {
  return EventFilterBuilder.create()
    .dateRange()
    .lastMonth()
    .eventTypes()
    .notEquals('CreditRevoked')
    .apply(events);
}

// Example 10: Complex query with multiple conditions
export function exampleComplexQuery(events: SorobanEvent[]): SorobanEvent[] {
  return EventFilterBuilder.create()
    .dateRange()
    .lastDays(30)
    .contractIds()
    .include('CREDIT_REGISTRY_ID')
    .include('RETIREMENT_ID')
    .eventTypes()
    .isCreditStatusChange()
    .where((event) => event.ledger > 200000)
    .paginate(1, 20)
    .apply(events);
}
