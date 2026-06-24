import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let service: WebhooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [WebhooksService],
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
