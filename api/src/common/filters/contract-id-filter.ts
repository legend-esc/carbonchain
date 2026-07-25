export class ContractIdFilter {
  private contractIds: Set<string> = new Set();
  private excludeIds: Set<string> = new Set();
  private validateFormat: boolean = true;

  static create(): ContractIdFilter {
    return new ContractIdFilter();
  }

  include(contractId: string): this {
    this.validateContractId(contractId);
    this.contractIds.add(contractId);
    return this;
  }

  includeMany(contractIds: string[]): this {
    for (const id of contractIds) {
      this.include(id);
    }
    return this;
  }

  exclude(contractId: string): this {
    this.validateContractId(contractId);
    this.excludeIds.add(contractId);
    return this;
  }

  excludeMany(contractIds: string[]): this {
    for (const id of contractIds) {
      this.exclude(id);
    }
    return this;
  }

  onlyCreditRegistry(): this {
    return this;
  }

  onlyRetirement(): this {
    return this;
  }

  onlyMarketplace(): this {
    return this;
  }

  onlyMrvOracle(): this {
    return this;
  }

  skipValidation(): this {
    this.validateFormat = false;
    return this;
  }

  private validateContractId(contractId: string): void {
    if (!this.validateFormat) return;

    if (!contractId || typeof contractId !== 'string') {
      throw new Error('Contract ID must be a non-empty string');
    }

    const trimmed = contractId.trim();
    if (trimmed.length === 0) {
      throw new Error('Contract ID cannot be empty');
    }

    if (trimmed.length > 64) {
      throw new Error('Contract ID cannot exceed 64 characters');
    }

    if (!/^[A-Z0-9]+$/i.test(trimmed)) {
      throw new Error(
        'Contract ID must contain only alphanumeric characters',
      );
    }
  }

  isValidContractId(contractId: string): boolean {
    try {
      this.validateContractId(contractId);
      return true;
    } catch {
      return false;
    }
  }

  build(): { include: string[]; exclude: string[] } | null {
    if (this.contractIds.size === 0 && this.excludeIds.size === 0) {
      return null;
    }

    return {
      include: Array.from(this.contractIds),
      exclude: Array.from(this.excludeIds),
    };
  }

  apply<T extends { contractId: string }>(items: T[]): T[] {
    const filter = this.build();
    if (!filter) return items;

    return items.filter((item) => {
      if (filter.exclude.includes(item.contractId)) {
        return false;
      }

      if (filter.include.length > 0) {
        return filter.include.includes(item.contractId);
      }

      return true;
    });
  }
}
