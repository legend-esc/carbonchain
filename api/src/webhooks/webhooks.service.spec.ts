import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { WebhooksService } from './webhooks.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'WEBHOOK_SIGNATURE_HEADER') return 'x-mrv-signature';
    if (key === 'WEBHOOK_SIGNATURE_ALGO') return 'sha256';
    return def;
  }),
};

describe('WebhooksService', () => {
  let service: WebhooksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedAxios.post = jest.fn().mockResolvedValue({ status: 200 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhooksService,
        { provide: ConfigService, useValue: mockConfigService },
      ],
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

  describe('signature configuration', () => {
    it('should generate signature with configured algorithm', () => {
      const payload = 'test-payload';
      const secret = 'test-secret';
      const signature = service.generateSignature(payload, secret);

      expect(signature).toBeDefined();
      expect(typeof signature).toBe('string');
      expect(signature.length).toBeGreaterThan(0);
    });

    it('should return configured signature header name', () => {
      const headerName = service.getSignatureHeaderName();
      expect(headerName).toBe('x-mrv-signature');
    });

    it('should return configured signature algorithm', () => {
      const algorithm = service.getSignatureAlgorithm();
      expect(algorithm).toBe('sha256');
    });

    it('should generate consistent signatures', () => {
      const payload = 'test-payload';
      const secret = 'test-secret';
      const sig1 = service.generateSignature(payload, secret);
      const sig2 = service.generateSignature(payload, secret);

      expect(sig1).toBe(sig2);
    });
  });
});
