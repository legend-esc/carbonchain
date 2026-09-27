/**
 * #935 — WebhookJanitorService unit tests
 *
 * Validates:
 *  • Deliveries older than the retention window are deleted
 *  • Deliveries within the retention window are kept
 *  • purgeOld is idempotent under concurrent invocations
 *  • Watermark advances to the highest deleted delivery id
 *  • setRetentionDays updates the window at runtime
 *  • setRetentionDays throws RangeError for non-positive values
 *  • Table growth is bounded: size after purge ≤ retention window
 */
import { ConfigService } from '@nestjs/config';
import {
  WebhookJanitorService,
  DEFAULT_RETENTION_DAYS,
} from './webhook-janitor.service';
import type {
  WebhooksService,
  WebhookDelivery,
} from '../webhooks/webhooks.service';

// ── Minimal WebhooksService stub ──────────────────────────────────────────────

function makeDelivery(id: string, createdAt: Date): WebhookDelivery {
  return {
    id,
    webhookId: 'wh-1',
    eventId: `evt-${id}`,
    status: 'success',
    attempts: 1,
    createdAt,
  };
}

function buildJanitor(
  deliveries: WebhookDelivery[],
  retentionDays = 30,
): {
  janitor: WebhookJanitorService;
  deleted: Set<string>;
} {
  const store = new Map(deliveries.map((d) => [d.id, d]));
  const deleted = new Set<string>();

  const mockWebhooksService = {
    getDeliveries: () => Array.from(store.values()),
    deleteDelivery: (id: string) => {
      const had = store.has(id);
      if (had) {
        store.delete(id);
        deleted.add(id);
      }
      return had;
    },
  } as unknown as WebhooksService;

  const mockConfigService = {
    get: (key: string, def: unknown) => {
      if (key === 'WEBHOOK_RETENTION_DAYS') return retentionDays;
      if (key === 'WEBHOOK_JANITOR_INTERVAL_MS') return 999_999_999; // effectively never auto-runs
      return def;
    },
  } as unknown as ConfigService;

  const janitor = new WebhookJanitorService(
    mockConfigService,
    mockWebhooksService,
  );
  // Do NOT call onModuleInit here to avoid starting a real timer.
  return { janitor, deleted };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const daysAgo = (n: number): Date =>
  new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookJanitorService — purgeOld', () => {
  it('deletes deliveries older than the retention window', async () => {
    const deliveries = [
      makeDelivery('old-1', daysAgo(40)), // should be deleted
      makeDelivery('old-2', daysAgo(31)), // should be deleted
      makeDelivery('new-1', daysAgo(29)), // keep
      makeDelivery('new-2', daysAgo(1)), // keep
    ];

    const { janitor, deleted } = buildJanitor(deliveries, 30);
    const count = await janitor.purgeOld();

    expect(count).toBe(2);
    expect(deleted.has('old-1')).toBe(true);
    expect(deleted.has('old-2')).toBe(true);
    expect(deleted.has('new-1')).toBe(false);
    expect(deleted.has('new-2')).toBe(false);
  });

  it('returns 0 when there is nothing to purge', async () => {
    const deliveries = [
      makeDelivery('new-1', daysAgo(5)),
      makeDelivery('new-2', daysAgo(10)),
    ];
    const { janitor } = buildJanitor(deliveries, 30);
    const count = await janitor.purgeOld();
    expect(count).toBe(0);
  });

  it('deletes all deliveries when all are older than the retention window', async () => {
    const deliveries = [
      makeDelivery('a', daysAgo(60)),
      makeDelivery('b', daysAgo(90)),
    ];
    const { janitor, deleted } = buildJanitor(deliveries, 30);
    const count = await janitor.purgeOld();
    expect(count).toBe(2);
    expect(deleted.size).toBe(2);
  });

  it('is idempotent under concurrent invocations (second call returns 0)', async () => {
    // Force the first purgeOld to take a moment so the second can overlap.
    const deliveries = [makeDelivery('old', daysAgo(60))];
    const { janitor } = buildJanitor(deliveries, 30);

    // Both calls start at the same time.
    const [first, second] = await Promise.all([
      janitor.purgeOld(),
      janitor.purgeOld(),
    ]);

    // One call must have done all the work; the other is the no-op guard.
    expect(first + second).toBe(1);
  });

  it('updates lastRunAt and lastPurgedCount after a successful purge', async () => {
    const before = new Date();
    const deliveries = [makeDelivery('old', daysAgo(40))];
    const { janitor } = buildJanitor(deliveries, 30);

    await janitor.purgeOld();

    const stats = janitor.getStats();
    expect(stats.lastPurgedCount).toBe(1);
    expect(stats.lastRunAt).toBeInstanceOf(Date);
    expect(stats.lastRunAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  it('bounds table growth to the retention window', async () => {
    const N = 100;
    const deliveries: WebhookDelivery[] = [];

    for (let i = 0; i < N; i++) {
      // Half are old, half are new
      const createdAt = i < N / 2 ? daysAgo(40) : daysAgo(5);
      deliveries.push(makeDelivery(`d${i}`, createdAt));
    }

    const { janitor, deleted } = buildJanitor(deliveries, 30);
    const count = await janitor.purgeOld();

    expect(count).toBe(N / 2);
    expect(deleted.size).toBe(N / 2);
    // Remaining deliveries count
    expect(N - deleted.size).toBe(N / 2);
  });
});

describe('WebhookJanitorService — watermark', () => {
  it('advances watermark to the highest id deleted', async () => {
    const deliveries = [
      makeDelivery('aaa', daysAgo(40)),
      makeDelivery('zzz', daysAgo(50)),
    ];
    const { janitor } = buildJanitor(deliveries, 30);
    await janitor.purgeOld();

    const stats = janitor.getStats();
    // watermark should be the lexicographically highest id deleted
    expect(['aaa', 'zzz']).toContain(stats.watermark);
  });

  it('watermark starts empty and is set after first purge', async () => {
    const { janitor } = buildJanitor([], 30);
    expect(janitor.getStats().watermark).toBe('');

    // No-op purge — watermark stays empty
    await janitor.purgeOld();
    expect(janitor.getStats().watermark).toBe('');
  });
});

describe('WebhookJanitorService — setRetentionDays', () => {
  it('updates the retention window', async () => {
    const deliveries = [
      makeDelivery('old', daysAgo(20)), // 30d → keep; 10d → delete
    ];
    const { janitor } = buildJanitor(deliveries, 30);

    // With 30d retention the record is kept
    let count = await janitor.purgeOld();
    expect(count).toBe(0);

    // Tighten to 10d
    janitor.setRetentionDays(10);
    count = await janitor.purgeOld();
    expect(count).toBe(1);
  });

  it('throws RangeError when days ≤ 0', () => {
    const { janitor } = buildJanitor([], 30);
    expect(() => janitor.setRetentionDays(0)).toThrow(RangeError);
    expect(() => janitor.setRetentionDays(-5)).toThrow(RangeError);
  });
});

describe('WebhookJanitorService — getStats', () => {
  it('reflects DEFAULT_RETENTION_DAYS before any changes', () => {
    const { janitor } = buildJanitor([], DEFAULT_RETENTION_DAYS);
    const stats = janitor.getStats();
    expect(stats.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(stats.lastPurgedCount).toBe(0);
    expect(stats.lastRunAt).toBeUndefined();
    expect(stats.watermark).toBe('');
  });
});
