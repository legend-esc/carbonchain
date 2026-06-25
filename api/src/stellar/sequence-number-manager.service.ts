import { Injectable } from '@nestjs/common';

@Injectable()
export class SequenceNumberManager {
  private cache = new Map<string, number>();

  getNextSequenceNumber(publicKey: string): number | undefined {
    const cached = this.cache.get(publicKey);
    if (cached !== undefined) {
      this.cache.set(publicKey, cached + 1);
      return cached;
    }
    return undefined;
  }

  cacheSequenceNumber(publicKey: string, seq: number): void {
    this.cache.set(publicKey, seq);
  }

  reset(publicKey: string): void {
    this.cache.delete(publicKey);
  }

  clear(): void {
    this.cache.clear();
  }

  count(): number {
    return this.cache.size;
  }
}
