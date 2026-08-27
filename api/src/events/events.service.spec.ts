import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventsService } from './events.service';
import { StellarService } from '../stellar/stellar.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CacheService } from '../common/cache.service';
import { EventEntity } from './event.entity';

describe('EventsService', () => {
  let service: EventsService;
  let stellarService: StellarService;
  let webhooksService: WebhooksService;
  let cacheService: CacheService;
  const mockRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    count: jest.fn(),
    delete: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        {
          provide: getRepositoryToken(EventEntity),
          useValue: mockRepository,
        },
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
              if (key === 'CREDIT_REGISTRY_CONTRACT_ID') return 'C1';
              return def;
            }),
          },
        },
        {
          provide: WebhooksService,
          useValue: {
            triggerWebhooks: jest.fn().mockResolvedValue(undefined),
            processQueue: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CacheService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            del: jest.fn().mockResolvedValue(undefined),
            delPattern: jest.fn().mockResolvedValue(undefined),
            invalidateTag: jest.fn().mockResolvedValue(undefined),
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
    it('should load last synced ledger per contract from DB', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'e1',
        contractId: 'C1',
        eventType: 'CreditMinted',
        ledger: '500',
        timestamp: '1700000000',
        data: {},
      });
      await service.onModuleInit();
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { contractId: 'C1' },
        order: { ledger: 'DESC' },
      });
      expect((service as any).lastLedgerCache.get('C1')).toBe(500);
    });

    it('handles missing last event', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      await service.onModuleInit();
      expect((service as any).lastLedgerCache.get('C1')).toBeUndefined();
    });
  });

  describe('getEvents', () => {
    it('should return events from the repository', async () => {
      mockRepository.find.mockResolvedValue([
        {
          id: 'e1',
          contractId: 'C1',
          eventType: 'CreditMinted',
          ledger: '10',
          timestamp: '1700000000',
          data: { value: {} },
        },
      ]);
      const events = await service.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: 'e1',
        type: 'CreditMinted',
        contractId: 'C1',
        ledger: 10,
      });
    });

    it('should return empty array when repository has no events', async () => {
      mockRepository.find.mockResolvedValue([]);
      const events = await service.getEvents();
      expect(events).toEqual([]);
    });

    it('should cap take at 200', async () => {
      mockRepository.find.mockResolvedValue([]);
      await service.getEvents(undefined, undefined, 999, 0);
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 200 }),
      );
    });

    it('should pass contractId and eventType filters', async () => {
      mockRepository.find.mockResolvedValue([]);
      await service.getEvents('C1', 'CreditMinted');
      expect(mockRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { contractId: 'C1', eventType: 'CreditMinted' },
        }),
      );
    });
  });

  describe('getEventById', () => {
    it('should return undefined when event is not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      const event = await service.getEventById('nope');
      expect(event).toBeUndefined();
    });

    it('should return the mapped event', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'e1',
        contractId: 'C1',
        eventType: 'CreditMinted',
        ledger: '10',
        timestamp: '1700000000',
        data: { value: {} },
      });
      const event = await service.getEventById('e1');
      expect(event).toMatchObject({ id: 'e1', type: 'CreditMinted' });
    });
  });

  describe('indexEvents', () => {
    it('should skip if previous run is still in progress', async () => {
      (service as any).isIndexing = true;
      const debugSpy = jest
        .spyOn(service['logger'], 'debug')
        .mockImplementation();
      await service.indexEvents();
      expect(debugSpy).toHaveBeenCalledWith(
        'Skipping indexEvents — previous run still in progress',
      );
    });

    it('should index new events and trigger webhooks', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockImplementation((e) => e);
      mockRepository.save.mockResolvedValue(undefined);
      mockRepository.count.mockResolvedValue(0);

      (stellarService.getContractEvents as jest.Mock).mockResolvedValue([
        {
          id: 'abc',
          contractId: 'C1',
          ledger: 42,
          txHash: 'tx1',
          topic: ['CreditMinted'],
          value: {},
        },
      ]);

      (service as any).lastLedgerCache.set('C1', 41);

      await (service as any).indexContractEvents('C1');

      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'C1-42-abc' }),
      );
      expect(webhooksService.triggerWebhooks).toHaveBeenCalledWith(
        'CreditMinted',
        expect.objectContaining({ id: 'C1-42-abc', ledger: 42 }),
      );
      expect((service as any).lastLedgerCache.get('C1')).toBe(42);
    });

    it('should skip events that already exist (idempotency)', async () => {
      mockRepository.findOne.mockResolvedValue({ id: 'C1-42-abc' });

      (stellarService.getContractEvents as jest.Mock).mockResolvedValue([
        {
          id: 'abc',
          contractId: 'C1',
          ledger: 42,
          txHash: 'tx1',
          topic: [],
          value: {},
        },
      ]);

      await (service as any).indexContractEvents('C1');

      expect(mockRepository.save).not.toHaveBeenCalled();
      expect(webhooksService.triggerWebhooks).not.toHaveBeenCalled();
    });

    it('should invalidate cache on credit status change events', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockImplementation((e) => e);
      mockRepository.save.mockResolvedValue(undefined);
      mockRepository.count.mockResolvedValue(0);

      (stellarService.getContractEvents as jest.Mock).mockResolvedValue([
        {
          id: 'abc',
          contractId: 'C1',
          ledger: 42,
          txHash: 'tx1',
          topic: ['CreditMinted'],
          value: {},
        },
      ]);

      await (service as any).indexContractEvents('C1');

      expect(cacheService.invalidateTag).toHaveBeenCalledWith('credits:list');
    });

    it('should trim the event store when it exceeds the max size', async () => {
      mockRepository.findOne.mockResolvedValue(null);
      mockRepository.create.mockImplementation((e) => e);
      mockRepository.save.mockResolvedValue(undefined);
      mockRepository.count.mockResolvedValue(1001);
      mockRepository.find.mockResolvedValue([{ id: 'C1-1-aaa' }]);
      mockRepository.delete.mockResolvedValue(undefined);

      (stellarService.getContractEvents as jest.Mock).mockResolvedValue([
        {
          id: 'abc',
          contractId: 'C1',
          ledger: 42,
          txHash: 'tx1',
          topic: [],
          value: {},
        },
      ]);

      await (service as any).indexContractEvents('C1');

      expect(mockRepository.count).toHaveBeenCalled();
      expect(mockRepository.delete).toHaveBeenCalledWith(['C1-1-aaa']);
    });
  });

  describe('handleReorg', () => {
    it('should delete events from the reverted ledger and update last ledger', async () => {
      mockRepository.delete.mockResolvedValue(undefined);
      mockRepository.findOne.mockResolvedValue({
        id: 'e1',
        contractId: 'C1',
        eventType: 'CreditMinted',
        ledger: '40',
        timestamp: '1700000000',
        data: {},
      });

      (service as any).lastLedgerCache.set('C1', 42);

      await service.handleReorg('C1', 41);

      expect(mockRepository.delete).toHaveBeenCalledWith({
        contractId: 'C1',
        ledger: 41,
      });
      expect((service as any).lastLedgerCache.get('C1')).toBe(40);
    });
  });
});
