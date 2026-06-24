import { Test, TestingModule } from '@nestjs/testing';
import { WebhooksService } from './webhooks.service';

describe('WebhooksService', () => {
  let service: WebhooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhooksService],
    }).compile();

    service = module.get<WebhooksService>(WebhooksService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('registerWebhook', () => {
    it('should register a webhook', () => {
      const webhook = service.registerWebhook('https://example.com/webhook', [
        'credit_submitted',
        'credit_minted',
      ]);

      expect(webhook).toBeDefined();
      expect(webhook.url).toBe('https://example.com/webhook');
      expect(webhook.events).toContain('credit_submitted');
      expect(webhook.active).toBe(true);
    });
  });

  describe('getWebhooks', () => {
    it('should return all registered webhooks', () => {
      service.registerWebhook('https://example.com/webhook1', [
        'credit_submitted',
      ]);
      service.registerWebhook('https://example.com/webhook2', [
        'credit_minted',
      ]);

      const webhooks = service.getWebhooks();
      expect(webhooks.length).toBe(2);
    });
  });

  describe('deleteWebhook', () => {
    it('should delete a webhook', () => {
      const webhook = service.registerWebhook('https://example.com/webhook', [
        'credit_submitted',
      ]);

      const success = service.deleteWebhook(webhook.id);
      expect(success).toBe(true);

      const webhooks = service.getWebhooks();
      expect(webhooks.length).toBe(0);
    });

    it('should return false when deleting non-existent webhook', () => {
      const success = service.deleteWebhook('non-existent-id');
      expect(success).toBe(false);
    });
  });

  describe('getDeliveries', () => {
    it('should return deliveries for a webhook', async () => {
      const webhook = service.registerWebhook('https://example.com/webhook', [
        'credit_submitted',
      ]);

      // Trigger webhook (will fail due to invalid URL, but delivery will be recorded)
      await service.triggerWebhooks('credit_submitted', {
        id: 'event-1',
        type: 'credit_submitted',
      });

      const deliveries = service.getDeliveries(webhook.id);
      expect(deliveries.length).toBeGreaterThan(0);
    });
  });
});
