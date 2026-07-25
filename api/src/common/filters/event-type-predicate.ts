export type EventPredicate = (eventType: string) => boolean;

export class EventTypePredicate {
  private predicates: EventPredicate[] = [];

  static create(): EventTypePredicate {
    return new EventTypePredicate();
  }

  equals(eventType: string): this {
    this.predicates.push((type) => type === eventType);
    return this;
  }

  equalsAny(...eventTypes: string[]): this {
    const typeSet = new Set(eventTypes);
    this.predicates.push((type) => typeSet.has(type));
    return this;
  }

  notEquals(eventType: string): this {
    this.predicates.push((type) => type !== eventType);
    return this;
  }

  startsWith(prefix: string): this {
    this.predicates.push((type) => type.startsWith(prefix));
    return this;
  }

  endsWith(suffix: string): this {
    this.predicates.push((type) => type.endsWith(suffix));
    return this;
  }

  includes(substring: string): this {
    this.predicates.push((type) => type.includes(substring));
    return this;
  }

  matches(regex: RegExp): this {
    this.predicates.push((type) => regex.test(type));
    return this;
  }

  isCreditMinted(): this {
    return this.equals('CreditMinted');
  }

  isCreditRetired(): this {
    return this.equals('CreditRetired');
  }

  isCreditFlagged(): this {
    return this.equals('CreditFlagged');
  }

  isCreditRevoked(): this {
    return this.equals('CreditRevoked');
  }

  isCreditStatusChange(): this {
    return this.equalsAny(
      'CreditMinted',
      'CreditRetired',
      'CreditFlagged',
      'CreditRevoked',
    );
  }

  isMarketplaceEvent(): this {
    return this.startsWith('Marketplace');
  }

  isOfferCreated(): this {
    return this.equals('OfferCreated');
  }

  isOfferAccepted(): this {
    return this.equals('OfferAccepted');
  }

  isOfferCancelled(): this {
    return this.equals('OfferCancelled');
  }

  isMrvEvent(): this {
    return this.startsWith('MRV');
  }

  isVerificationEvent(): this {
    return this.equalsAny('MRVDataSubmitted', 'MRVDataVerified');
  }

  not(predicates: EventPredicate[]): this {
    this.predicates.push((type) => !predicates.some((p) => p(type)));
    return this;
  }

  combine(predicates: EventPredicate[], mode: 'and' | 'or' = 'and'): this {
    if (mode === 'and') {
      this.predicates.push((type) => predicates.every((p) => p(type)));
    } else {
      this.predicates.push((type) => predicates.some((p) => p(type)));
    }
    return this;
  }

  build(): EventPredicate {
    return (eventType: string) => {
      if (this.predicates.length === 0) return true;
      return this.predicates.every((predicate) => predicate(eventType));
    };
  }

  apply<T extends { type: string }>(items: T[]): T[] {
    const predicate = this.build();
    return items.filter((item) => predicate(item.type));
  }
}
