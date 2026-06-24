import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EventsService } from './events.service';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CacheService } from '../common/cache.service';

describe('EventsService', () => {
  let service: EventsService;
  let stellarService: StellarService;
  let webhooksService: WebhooksService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: StellarService,
          useValue: {
            getContractEvents: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: WebhooksService,
          useValue: {
            triggerWebhooks: jest.fn(),
            retryFailedDeliveries: jest.fn(),
          },
        },
        {
          provide: CacheService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
            delPattern: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
    stellarService = module.get<StellarService>(StellarService);
    webhooksService = module.get<WebhooksService>(WebhooksService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getEvents', () => {
    it('should return empty array initially', () => {
      const events = service.getEvents();
      expect(events).toEqual([]);
    });
  });

  describe('clearEvents', () => {
    it('should clear all events', () => {
      service.clearEvents();
      const events = service.getEvents();
      expect(events).toEqual([]);
    });
  });
});
