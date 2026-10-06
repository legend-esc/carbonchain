import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'NODE_ENV') return 'test';
    return def;
  }),
};

const mockWebhooksService = {
  registerWebhook: jest.fn(),
  getWebhooks: jest.fn(),
  getWebhook: jest.fn(),
  deleteWebhook: jest.fn(),
  validateWebhookUrl: jest.fn().mockResolvedValue(undefined),
};

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        { provide: WebhooksService, useValue: mockWebhooksService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<WebhooksController>(WebhooksController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('registerWebhook', () => {
    it('registers a webhook and returns the registration result with secret', async () => {
      const dto = {
        url: 'https://example.com/webhook',
        events: ['credit_submitted'],
      };
      const expectedResult = {
        id: 'webhook_123',
        url: dto.url,
        events: dto.events,
        active: true,
        failureCount: 0,
        createdAt: new Date(),
        secret: 'secret123',
      };
      mockWebhooksService.registerWebhook.mockResolvedValueOnce(expectedResult);

      const result = await controller.registerWebhook(dto);

      expect(mockWebhooksService.registerWebhook).toHaveBeenCalledWith(
        dto.url,
        dto.events,
      );
      expect(result).toEqual(expectedResult);
    });

    it('returns list of webhooks without secrets', async () => {
      const webhooks = [
        { id: '1', url: 'https://a.com', events: ['e1'], active: true },
        { id: '2', url: 'https://b.com', events: ['e2'], active: false },
      ];
      mockWebhooksService.getWebhooks.mockResolvedValueOnce(webhooks);

      const result = await controller.getWebhooks();

      expect(result).toEqual(webhooks);
    });
  });

  describe('getWebhook', () => {
    it('returns a single webhook without secret', async () => {
      const webhook = { id: '1', url: 'https://a.com', events: ['e1'], active: true };
      mockWebhooksService.getWebhook.mockResolvedValueOnce(webhook);

      const result = await controller.getWebhook('1');

      expect(result).toEqual(webhook);
    });

    it('throws NotFoundException for nonexistent webhook', async () => {
      mockWebhooksService.getWebhook.mockResolvedValueOnce(undefined);

      await expect(controller.getWebhook('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteWebhook', () => {
    it('deletes a webhook', async () => {
      mockWebhooksService.deleteWebhook.mockResolvedValueOnce(true);

      const result = await controller.deleteWebhook('webhook_123');

      expect(result.success).toBe(true);
      expect(mockWebhooksService.deleteWebhook).toHaveBeenCalledWith('webhook_123');
    });

    it('returns false for nonexistent webhook', async () => {
      mockWebhooksService.deleteWebhook.mockResolvedValueOnce(false);

      const result = await controller.deleteWebhook('nonexistent-id');

      expect(result.success).toBe(false);
    });
  });
});