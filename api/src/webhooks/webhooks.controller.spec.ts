import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'WEBHOOK_SIGNATURE_HEADER') return 'x-mrv-signature';
    if (key === 'WEBHOOK_SIGNATURE_ALGO') return 'sha256';
    return def;
  }),
};

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let service: WebhooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
    service = module.get<WebhooksService>(WebhooksService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerWebhook', () => {
    it('should register a webhook', () => {
      const result = controller.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['credit_submitted'],
      });

      expect(result).toBeDefined();
      expect(result.url).toBe('https://example.com/webhook');
    });
  });

  describe('getWebhooks', () => {
    it('should return all webhooks', () => {
      controller.registerWebhook({
        url: 'https://example.com/webhook1',
        events: ['credit_submitted'],
      });

      const webhooks = controller.getWebhooks();
      expect(webhooks.length).toBeGreaterThan(0);
    });
  });

  describe('deleteWebhook', () => {
    it('should delete a webhook', () => {
      const webhook = controller.registerWebhook({
        url: 'https://example.com/webhook',
        events: ['credit_submitted'],
      });

      const result = controller.deleteWebhook(webhook.id);
      expect(result.success).toBe(true);
    });
  });
});
