export interface DateRange {
  start: Date;
  end: Date;
}

export class DateRangeFilter {
  private startDate: Date | null = null;
  private endDate: Date | null = null;

  static create(): DateRangeFilter {
    return new DateRangeFilter();
  }

  from(date: Date | string): this {
    this.startDate = typeof date === 'string' ? new Date(date) : date;
    return this;
  }

  to(date: Date | string): this {
    this.endDate = typeof date === 'string' ? new Date(date) : date;
    return this;
  }

  fromNow( milliseconds: number): this {
    this.startDate = new Date(Date.now() - milliseconds);
    return this;
  }

  toNow(): this {
    this.endDate = new Date();
    return this;
  }

  lastHours(hours: number): this {
    this.startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    this.endDate = new Date();
    return this;
  }

  lastDays(days: number): this {
    return this.lastHours(days * 24);
  }

  lastWeek(): this {
    return this.lastDays(7);
  }

  lastMonth(): this {
    return this.lastDays(30);
  }

  today(): this {
    const now = new Date();
    this.startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    this.endDate = new Date();
    return this;
  }

  thisWeek(): this {
    const now = new Date();
    const dayOfWeek = now.getDay();
    this.startDate = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - dayOfWeek,
    );
    this.endDate = new Date();
    return this;
  }

  thisMonth(): this {
    const now = new Date();
    this.startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    this.endDate = new Date();
    return this;
  }

  build(): DateRange | null {
    if (!this.startDate && !this.endDate) {
      return null;
    }

    return {
      start: this.startDate || new Date(0),
      end: this.endDate || new Date(),
    };
  }

  apply<T extends { timestamp: number }>(
    items: T[],
    timestampField: keyof T = 'timestamp' as keyof T,
  ): T[] {
    const range = this.build();
    if (!range) {
      return items;
    }

    return items.filter((item) => {
      const timestamp = item[timestampField] as unknown as number;
      const itemDate = new Date(timestamp * 1000);
      return itemDate >= range.start && itemDate <= range.end;
    });
  }

  isValid(): boolean {
    const range = this.build();
    if (!range) return true;
    return range.start <= range.end;
  }
}
