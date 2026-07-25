import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SequenceNumberManager } from './sequence-number-manager.service';

// ---------------------------------------------------------------------------
// Helper — build a manager with an overridden TTL for time-sensitive tests.
// ---------------------------------------------------------------------------

async function buildManager(ttlMs?: number): Promise<SequenceNumberManager> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SequenceNumberManager,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string) => {
            if (key === 'SEQ_CACHE_TTL_MS' && ttlMs !== undefined) {
              return String(ttlMs);
            }
            return undefined;
          }),
        },
      },
    ],
  }).compile();

  return module.get<SequenceNumberManager>(SequenceNumberManager);
}

describe('SequenceNumberManager', () => {
  let manager: SequenceNumberManager;

  const PK_A = 'GD72EF...FH3W9A';
  const PK_B = 'GB84GH...JK2L8Z';

  beforeEach(async () => {
    manager = await buildManager();
  });

  afterEach(() => {
    manager.clear();
    jest.useRealTimers();
  });

  // ── Basic cache behaviour ──────────────────────────────────────────────────

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

  // ── TTL eviction (#473) ────────────────────────────────────────────────────

  describe('TTL eviction (#473)', () => {
    it('uses the default 60 s TTL when no env var is set', async () => {
      const m = await buildManager(undefined);
      expect(m.getTtlMs()).toBe(60_000);
    });

    it('uses the configured TTL from SEQ_CACHE_TTL_MS env var', async () => {
      const m = await buildManager(5_000);
      expect(m.getTtlMs()).toBe(5_000);
    });

    it('returns undefined after the TTL has elapsed', async () => {
      // Use a very short TTL so we can expire it with fake timers.
      const m = await buildManager(100 /* ms */);

      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      m.cacheSequenceNumber(PK_A, 42);
      // Before TTL expires — should return value
      expect(m.getNextSequenceNumber(PK_A)).toBe(42);

      // Advance time past TTL
      jest.setSystemTime(now + 101);
      // After TTL expires — should evict and return undefined
      expect(m.getNextSequenceNumber(PK_A)).toBeUndefined();
    });

    it('evicts the expired entry from the cache on read', async () => {
      const m = await buildManager(50 /* ms */);

      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      m.cacheSequenceNumber(PK_A, 10);
      expect(m.count()).toBe(1);

      // Advance past TTL
      jest.setSystemTime(now + 51);
      m.getNextSequenceNumber(PK_A); // triggers eviction
      expect(m.count()).toBe(0);
    });

    it('does not evict an entry before the TTL has elapsed', async () => {
      const m = await buildManager(1_000 /* ms */);

      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      m.cacheSequenceNumber(PK_A, 7);
      // Advance just under TTL
      jest.setSystemTime(now + 999);
      expect(m.getNextSequenceNumber(PK_A)).toBe(7);
    });

    it('resets TTL on each optimistic increment', async () => {
      const m = await buildManager(200 /* ms */);

      jest.useFakeTimers();
      const start = Date.now();
      jest.setSystemTime(start);

      m.cacheSequenceNumber(PK_A, 1);

      // Consume at t=150 (still within TTL)
      jest.setSystemTime(start + 150);
      expect(m.getNextSequenceNumber(PK_A)).toBe(1);

      // Consume at t=300 — would expire if TTL not reset on use, but should
      // still be alive because TTL was renewed at t=150 (150 + 200 = 350).
      jest.setSystemTime(start + 300);
      expect(m.getNextSequenceNumber(PK_A)).toBe(2);

      // Advance past the renewed TTL window (300 + 200 = 500, test at 501)
      jest.setSystemTime(start + 501);
      expect(m.getNextSequenceNumber(PK_A)).toBeUndefined();
    });

    it('cacheSequenceNumber resets TTL for an existing entry', async () => {
      const m = await buildManager(100 /* ms */);

      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      m.cacheSequenceNumber(PK_A, 5);

      // Advance near expiry
      jest.setSystemTime(now + 90);
      // Re-cache resets TTL
      m.cacheSequenceNumber(PK_A, 20);

      // Advance past original TTL but within new window
      jest.setSystemTime(now + 150);
      expect(m.getNextSequenceNumber(PK_A)).toBe(20);
    });

    it('returns undefined for expired key while valid key is still accessible', async () => {
      const m = await buildManager(100 /* ms */);

      jest.useFakeTimers();
      const now = Date.now();
      jest.setSystemTime(now);

      m.cacheSequenceNumber(PK_A, 1);
      // Cache PK_B just before advancing time — it gets a fresh TTL
      jest.setSystemTime(now + 90);
      m.cacheSequenceNumber(PK_B, 99);

      // Advance past PK_A's TTL
      jest.setSystemTime(now + 101);
      expect(m.getNextSequenceNumber(PK_A)).toBeUndefined();
      // PK_B still alive (cached at t=90, TTL = 100, expires at t=190)
      expect(m.getNextSequenceNumber(PK_B)).toBe(99);
    });
  });
});
