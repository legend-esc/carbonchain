import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import axios from 'axios';
import { createHmac } from 'crypto';
import { WebhooksService } from './webhooks.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ── Fake DataSource ────────────────────────────────────────────────────────────

/**
 * In-memory store that mimics the SQL executed by WebhooksService so we can
 * verify all four issues without a real database.
 */
function buildMockDataSource() {
  const webhooks: Record<
    string,
    {
      id: string;
      url: string;
      events: string[];
      active: boolean;
      secret: string;
      failure_count: number;
      created_at: Date;
      last_triggered_at: Date | null;
    }
  > = {};

  const deliveries: Record<
    string,
    {
      id: string;
      webhook_id: string;
      event_id: string;
      event_type: string;
      payload_json: string;
      status: string;
      attempts: number;
      last_attempt_at: Date | null;
      next_retry_at: Date;
      created_at: Date;
    }
  > = {};

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // INSERT webhook
    if (s.startsWith('INSERT INTO webhooks')) {
      const [id, url, events, secret] = params as [
        string,
        string,
        string[],
        string,
      ];
      webhooks[id] = {
        id,
        url,
        events,
        active: true,
        secret,
        failure_count: 0,
        created_at: new Date(),
        last_triggered_at: null,
      };
      return [];
    }

    // SELECT webhooks list
    if (
      s.includes('FROM webhooks') &&
      s.includes('ORDER BY created_at DESC') &&
      !s.includes('WHERE')
    ) {
      return Object.values(webhooks);
    }

    // SELECT single webhook by id
    if (s.includes('FROM webhooks') && s.includes('WHERE id = $1')) {
      const id = (params as string[])[0];
      return webhooks[id] ? [webhooks[id]] : [];
    }

    // SELECT webhook for delivery (id + url + secret)
    if (
      s.includes('FROM webhooks') &&
      s.includes('WHERE id = $1') &&
      s.includes('secret')
    ) {
      const id = (params as string[])[0];
      return webhooks[id] ? [webhooks[id]] : [];
    }

    // DELETE webhook
    if (s.startsWith('DELETE FROM webhooks')) {
      const id = (params as string[])[0];
      const existed = !!webhooks[id];
      if (existed) delete webhooks[id];
      return [[], existed ? 1 : 0];
    }

    // SELECT active webhooks for event trigger
    if (
      s.includes('FROM webhooks') &&
      s.includes('active = TRUE') &&
      s.includes('ANY(events)')
    ) {
      const eventType = (params as string[])[0];
      return Object.values(webhooks).filter(
        (w) => w.active && w.events.includes(eventType),
      );
    }

    // INSERT delivery
    if (s.startsWith('INSERT INTO webhook_deliveries')) {
      const [id, webhook_id, event_id, event_type, payload_json] =
        params as string[];
      deliveries[id] = {
        id,
        webhook_id,
        event_id,
        event_type,
        payload_json,
        status: 'pending',
        attempts: 0,
        last_attempt_at: null,
        next_retry_at: new Date(),
        created_at: new Date(),
      };
      return [];
    }

    // SELECT pending deliveries (processQueue)
    if (
      s.includes('FROM webhook_deliveries') &&
      s.includes("status = 'pending'") &&
      s.includes('FOR UPDATE SKIP LOCKED')
    ) {
      return Object.values(deliveries).filter(
        (d) => d.status === 'pending' && d.next_retry_at <= new Date(),
      );
    }

    // SELECT deliveries list
    if (
      s.includes('FROM webhook_deliveries') &&
      !s.includes('FOR UPDATE SKIP LOCKED')
    ) {
      const webhookId = params?.[0] as string | undefined;
      const all = Object.values(deliveries);
      return webhookId ? all.filter((d) => d.webhook_id === webhookId) : all;
    }

    // UPDATE delivery status
    if (s.startsWith('UPDATE webhook_deliveries')) {
      const id = (params as string[])[0];
      if (deliveries[id]) {
        if (s.includes("status = 'success'")) {
          deliveries[id].status = 'success';
          deliveries[id].attempts = (params as [string, number])[1];
        } else if (s.includes("status = 'failed'")) {
          deliveries[id].status = 'failed';
          deliveries[id].attempts = (params as [string, number])[1];
        } else if (s.includes("status = 'pending'")) {
          deliveries[id].status = 'pending';
          deliveries[id].attempts = (params as [string, number, Date])[1];
          deliveries[id].next_retry_at = (
            params as [string, number, Date]
          )[2];
        }
      }
      return [];
    }

    // UPDATE webhook (success path)
    if (
      s.startsWith('UPDATE webhooks') &&
      s.includes('failure_count = 0')
    ) {
      const id = (params as string[])[0];
      if (webhooks[id]) {
        webhooks[id].failure_count = 0;
        webhooks[id].last_triggered_at = new Date();
      }
      return [];
    }

    // UPDATE webhook (failure path — deactivate)
    if (s.startsWith('UPDATE webhooks') && s.includes('active = FALSE')) {
      const [id, failureCount] = params as [string, number];
      if (webhooks[id]) {
        webhooks[id].failure_count = failureCount;
        webhooks[id].active = false;
      }
      return [];
    }

    return [];
  });

  return { query, _store: { webhooks, deliveries } };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'NODE_ENV') return 'test';
    return def;
  }),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhooksService', () => {
  let service: WebhooksService;
  let mockDs: ReturnType<typeof buildMockDataSource>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDs = buildMockDataSource();
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getDataSourceToken(), useValue: mockDs },
      ],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── #912 — SSRF protection ──────────────────────────────────────────────────

  describe('#912 SSRF protection', () => {
    it('rejects loopback address (127.0.0.1)', async () => {
      await expect(
        service.validateWebhookUrl('http://127.0.0.1/hook'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects private RFC-1918 address (192.168.1.1)', async () => {
      await expect(
        service.validateWebhookUrl('http://192.168.1.1/hook'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects link-local (169.254.169.254 — AWS metadata)', async () => {
      await expect(
        service.validateWebhookUrl('http://169.254.169.254/latest/meta-data'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-http/https scheme', async () => {
      await expect(
        service.validateWebhookUrl('ftp://example.com/hook'),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects malformed URL', async () => {
      await expect(service.validateWebhookUrl('not-a-url')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('accepts https public URL (DNS resolves to public address)', async () => {
      // Patch DNS to return a public address.
      jest
        .spyOn(
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('dns'),
          'lookup',
        )
        .mockImplementation(
          (
            _host: string,
            cb: (
              err: NodeJS.ErrnoException | null,
              address: string,
              family: number,
            ) => void,
          ) => {
            cb(null, '93.184.216.34', 4); // example.com
          },
        );

      await expect(
        service.validateWebhookUrl('https://example.com/hook'),
      ).resolves.toBeUndefined();
    });
  });

  // ── #911 — Postgres persistence ─────────────────────────────────────────────

  describe('#911 Postgres registry', () => {
    it('registerWebhook inserts into webhooks table', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValueOnce(undefined);

      const result = await service.registerWebhook(
        'https://example.com/hook',
        ['credit_submitted'],
      );

      expect(result.id).toMatch(/^webhook_/);
      expect(result.url).toBe('https://example.com/hook');
      expect(result.events).toContain('credit_submitted');
    });

    it('getWebhooks returns rows from Postgres', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      await service.registerWebhook('https://example.com/hook', [
        'credit_submitted',
      ]);

      const list = await service.getWebhooks();
      expect(list.length).toBe(1);
    });

    it('deleteWebhook removes the webhook', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      const wh = await service.registerWebhook(
        'https://example.com/hook',
        ['credit_submitted'],
      );

      const ok = await service.deleteWebhook(wh.id);
      expect(ok).toBe(true);

      const list = await service.getWebhooks();
      expect(list.length).toBe(0);
    });
  });

  // ── #910 — Original payload on retry ────────────────────────────────────────

  describe('#910 Original payload preserved on retry', () => {
    it('retry delivers identical body to first attempt', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      await service.registerWebhook('https://example.com/hook', [
        'credit_submitted',
      ]);

      const eventData = { id: 'evt-1', type: 'credit_submitted', foo: 'bar' };
      await service.triggerWebhooks('credit_submitted', eventData);

      // Simulate first attempt — fail so it retries
      mockedAxios.post = jest
        .fn()
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValueOnce({ status: 200 });

      await service.processQueue();
      await service.processQueue();

      const calls = (mockedAxios.post as jest.Mock).mock.calls as [
        string,
        unknown,
        unknown,
      ][];
      // Both calls should carry identical bodies
      expect(calls.length).toBe(2);
      const body1 = JSON.stringify(calls[0][1]);
      const body2 = JSON.stringify(calls[1][1]);
      expect(body1).toBe(body2);
    });

    it('x-carbonchain-retry header increments on each attempt', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      await service.registerWebhook('https://example.com/hook', [
        'credit_submitted',
      ]);

      await service.triggerWebhooks('credit_submitted', { id: 'evt-2' });

      mockedAxios.post = jest
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ status: 200 });

      await service.processQueue();
      await service.processQueue();

      const calls = (mockedAxios.post as jest.Mock).mock.calls as [
        string,
        unknown,
        { headers: Record<string, string> },
      ][];
      expect(calls[0][2].headers['x-carbonchain-retry']).toBe('1');
      expect(calls[1][2].headers['x-carbonchain-retry']).toBe('2');
    });
  });

  // ── #913 — HMAC signature on every delivery ──────────────────────────────────

  describe('#913 HMAC signing', () => {
    it('every delivery carries x-carbonchain-signature', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      await service.registerWebhook('https://example.com/hook', [
        'credit_submitted',
      ]);

      await service.triggerWebhooks('credit_submitted', { id: 'evt-3' });

      await service.processQueue();

      const calls = (mockedAxios.post as jest.Mock).mock.calls as [
        string,
        unknown,
        { headers: Record<string, string> },
      ][];
      expect(calls.length).toBe(1);
      expect(calls[0][2].headers['x-carbonchain-signature']).toMatch(
        /^sha256=[a-f0-9]{64}$/,
      );
    });

    it('signature is verifiable using the registered secret', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      const registration = await service.registerWebhook(
        'https://example.com/hook',
        ['credit_submitted'],
      );
      const secret = registration.secret;

      await service.triggerWebhooks('credit_submitted', { id: 'evt-4' });
      await service.processQueue();

      const calls = (mockedAxios.post as jest.Mock).mock.calls as [
        string,
        unknown,
        { headers: Record<string, string> },
      ][];
      expect(calls.length).toBe(1);

      const sigHeader = calls[0][2].headers['x-carbonchain-signature'];
      const timestamp = calls[0][2].headers['x-carbonchain-timestamp'];
      const rawBody = JSON.stringify(calls[0][1]);
      const signingInput = `${timestamp}.${rawBody}`;
      const expected = `sha256=${createHmac('sha256', secret).update(signingInput).digest('hex')}`;

      expect(sigHeader).toBe(expected);
    });

    it('wrong secret produces a different signature', async () => {
      jest
        .spyOn(service, 'validateWebhookUrl')
        .mockResolvedValue(undefined);

      await service.registerWebhook('https://example.com/hook', [
        'credit_submitted',
      ]);

      await service.triggerWebhooks('credit_submitted', { id: 'evt-5' });
      await service.processQueue();

      const calls = (mockedAxios.post as jest.Mock).mock.calls as [
        string,
        unknown,
        { headers: Record<string, string> },
      ][];
      const sigHeader = calls[0][2].headers['x-carbonchain-signature'];
      const timestamp = calls[0][2].headers['x-carbonchain-timestamp'];
      const rawBody = JSON.stringify(calls[0][1]);
      const signingInput = `${timestamp}.${rawBody}`;
      const wrongSecret = `sha256=${createHmac('sha256', 'wrong-secret').update(signingInput).digest('hex')}`;

      expect(sigHeader).not.toBe(wrongSecret);
    });
  });

  // ── Backward compat ─────────────────────────────────────────────────────────

  describe('generateSignature helper', () => {
    it('produces a consistent hex string', () => {
      const sig1 = service.generateSignature('payload', 'secret');
      const sig2 = service.generateSignature('payload', 'secret');
      expect(sig1).toBe(sig2);
      expect(sig1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('getSignatureHeaderName returns x-carbonchain-signature', () => {
      expect(service.getSignatureHeaderName()).toBe('x-carbonchain-signature');
    });
  });
});
