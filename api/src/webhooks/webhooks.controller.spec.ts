import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getDataSourceToken } from '@nestjs/typeorm';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'NODE_ENV') return 'test';
    return def;
  }),
};

// Minimal DataSource mock — controller tests go through the real service
// methods so we need a functioning (if in-memory) store.
function buildMockDataSource() {
  const webhooks: Record<string, Record<string, unknown>> = {};

  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    const s = sql.replace(/\s+/g, ' ').trim();

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

    if (
      s.includes('FROM webhooks') &&
      s.includes('ORDER BY created_at DESC') &&
      !s.includes('WHERE')
    ) {
      return Object.values(webhooks);
    }

    if (s.includes('FROM webhooks') && s.includes('WHERE id = $1')) {
      const id = (params as string[])[0];
      return webhooks[id] ? [webhooks[id]] : [];
    }

    if (s.startsWith('DELETE FROM webhooks')) {
      const id = (params as string[])[0];
      const existed = !!webhooks[id];
      if (existed) delete webhooks[id];
      return [[], existed ? 1 : 0];
    }

    return [];
  });

  return { query };
}

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const mockDs = buildMockDataSource();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: getDataSourceToken(), useValue: mockDs },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerWebhook', () => {
    it('registers a webhook and returns secret', async () => {
      // Bypass real DNS in controller tests
      const service = (controller as unknown as { webhooksService: WebhooksService }).webhooksService;
      jest.spyOn(service, 'validateWebhookUrl').mockResolvedValueOnce(undefined);

      const result = await controller.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['credit_submitted'],
      });

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/webhook');
      expect(result.secret).toBeDefined();
      expect(result.secret.length).toBeGreaterThan(0);
    });
  });

  describe('getWebhooks', () => {
    it('returns all webhooks', async () => {
      const service = (controller as unknown as { webhooksService: WebhooksService }).webhooksService;
      jest.spyOn(service, 'validateWebhookUrl').mockResolvedValue(undefined);

      await controller.registerWebhook({
        url: 'https://example.com/webhook1',
        events: ['credit_submitted'],
      });

      const webhooks = await controller.getWebhooks();
      expect(webhooks.length).toBeGreaterThan(0);
    });
  });

  describe('getWebhook', () => {
    it('returns 404 for unknown id', async () => {
      await expect(controller.getWebhook('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('returns webhook for known id', async () => {
      const service = (controller as unknown as { webhooksService: WebhooksService }).webhooksService;
      jest.spyOn(service, 'validateWebhookUrl').mockResolvedValue(undefined);

      const created = await controller.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['credit_submitted'],
      });

      const fetched = await controller.getWebhook(created.id);
      expect(fetched.id).toBe(created.id);
    });
  });

  describe('deleteWebhook', () => {
    it('deletes a webhook', async () => {
      const service = (controller as unknown as { webhooksService: WebhooksService }).webhooksService;
      jest.spyOn(service, 'validateWebhookUrl').mockResolvedValue(undefined);

      const created = await controller.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['credit_submitted'],
      });

      const result = await controller.deleteWebhook(created.id);
      expect(result.success).toBe(true);
    });

    it('returns false for nonexistent webhook', async () => {
      const result = await controller.deleteWebhook('nonexistent-id');
      expect(result.success).toBe(false);
    });
  });
});
