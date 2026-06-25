import { Test, TestingModule } from '@nestjs/testing';
import { SequenceNumberManager } from './sequence-number-manager.service';

describe('SequenceNumberManager', () => {
  let manager: SequenceNumberManager;

  const PK_A = 'GD72EF...FH3W9A';
  const PK_B = 'GB84GH...JK2L8Z';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SequenceNumberManager],
    }).compile();

    manager = module.get<SequenceNumberManager>(SequenceNumberManager);
  });

  afterEach(() => {
    manager.clear();
  });

  it('returns undefined on cache miss', () => {
    expect(manager.getNextSequenceNumber(PK_A)).toBeUndefined();
  });

  it('returns cached value and increments optimistically', () => {
    manager.cacheSequenceNumber(PK_A, 100);
    expect(manager.getNextSequenceNumber(PK_A)).toBe(100);
    expect(manager.getNextSequenceNumber(PK_A)).toBe(101);
    expect(manager.getNextSequenceNumber(PK_A)).toBe(102);
  });

  it('isolates sequence numbers per public key', () => {
    manager.cacheSequenceNumber(PK_A, 10);
    manager.cacheSequenceNumber(PK_B, 200);

    expect(manager.getNextSequenceNumber(PK_A)).toBe(10);
    expect(manager.getNextSequenceNumber(PK_B)).toBe(200);
    expect(manager.getNextSequenceNumber(PK_A)).toBe(11);
    expect(manager.getNextSequenceNumber(PK_B)).toBe(201);
  });

  it('clears cached entry after reset', () => {
    manager.cacheSequenceNumber(PK_A, 5);
    manager.getNextSequenceNumber(PK_A);
    manager.reset(PK_A);
    expect(manager.getNextSequenceNumber(PK_A)).toBeUndefined();
  });

  it('reset only clears the targeted key', () => {
    manager.cacheSequenceNumber(PK_A, 1);
    manager.cacheSequenceNumber(PK_B, 2);
    manager.reset(PK_A);
    expect(manager.getNextSequenceNumber(PK_A)).toBeUndefined();
    expect(manager.getNextSequenceNumber(PK_B)).toBe(2);
  });

  it('count returns number of cached keys', () => {
    expect(manager.count()).toBe(0);
    manager.cacheSequenceNumber(PK_A, 1);
    expect(manager.count()).toBe(1);
    manager.cacheSequenceNumber(PK_B, 2);
    expect(manager.count()).toBe(2);
  });

  it('clear removes all entries', () => {
    manager.cacheSequenceNumber(PK_A, 1);
    manager.cacheSequenceNumber(PK_B, 2);
    manager.clear();
    expect(manager.count()).toBe(0);
  });

  it('produces strictly increasing sequence numbers under concurrent load', () => {
    const CONCURRENCY = 10;
    const startSeq = 50;
    manager.cacheSequenceNumber(PK_A, startSeq);

    const results = Array.from(
      { length: CONCURRENCY },
      () => manager.getNextSequenceNumber(PK_A)!,
    );

    const sorted = [...results].sort((a, b) => a - b);
    expect(sorted).toEqual(results);
    expect(sorted[0]).toBe(startSeq);
    expect(sorted[sorted.length - 1]).toBe(startSeq + CONCURRENCY - 1);

    expect(manager.getNextSequenceNumber(PK_A)).toBe(startSeq + CONCURRENCY);
  });

  it('handles concurrent cache-miss for the same key gracefully', () => {
    const CONCURRENCY = 5;

    manager.cacheSequenceNumber(PK_A, 100);

    const calls = Array.from(
      { length: CONCURRENCY },
      () => manager.getNextSequenceNumber(PK_A)!,
    );

    const unique = new Set(calls);
    expect(unique.size).toBe(CONCURRENCY);

    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]).toBe(calls[i - 1] + 1);
    }

    expect(manager.getNextSequenceNumber(PK_A)).toBe(100 + CONCURRENCY);
  });

  it('does not share sequences across different keys under concurrent access', () => {
    manager.cacheSequenceNumber(PK_A, 1);
    manager.cacheSequenceNumber(PK_B, 100);

    const r0 = manager.getNextSequenceNumber(PK_A)!;
    const r1 = manager.getNextSequenceNumber(PK_B)!;
    const r2 = manager.getNextSequenceNumber(PK_A)!;
    const r3 = manager.getNextSequenceNumber(PK_B)!;

    expect(r0).toBe(1);
    expect(r1).toBe(100);
    expect(r2).toBe(2);
    expect(r3).toBe(101);
  });
});
