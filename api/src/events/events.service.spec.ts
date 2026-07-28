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
  let cacheService: CacheService;

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
            get: jest.fn().mockImplementation((key: string, def?: unknown) => {
              if (key === 'EVENT_STORE_MAX_SIZE') return 1000;
              return def;
            }),
          },
        },
        {
          provide: WebhooksService,
          useValue: {
            triggerWebhooks: jest.fn(),
            processQueue: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CacheService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
    stellarService = module.get<StellarService>(StellarService);
    webhooksService = module.get<WebhooksService>(WebhooksService);
    cacheService = module.get<CacheService>(CacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should load persisted ledger state from cache', async () => {
      (cacheService.get as jest.Mock).mockResolvedValueOnce(500);
      await service.onModuleInit();
      expect(cacheService.get).toHaveBeenCalledWith('events:lastLedger');
    });
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

  describe('indexEvents', () => {
    it('should skip if previous run is still in progress', async () => {
      (service as any).isIndexing = true;
      const consoleSpy = jest.spyOn(service['logger'], 'debug').mockImplementation();
      await service.indexEvents();
      expect(consoleSpy).toHaveBeenCalledWith(
        'Skipping indexEvents — previous run still in progress',
      );
    });
  });
});
