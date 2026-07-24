/**
 * Unit tests for RetirementService — focusing on the event-ordering guarantee
 * described in issue #162:
 *
 *   The `CreditRetired` event MUST only be emitted after the retirement record
 *   has been successfully persisted to the repository.  If the repository write
 *   fails the event must NOT be emitted.
 */
import {
  RetirementService,
  RetireDto,
  CreditRetiredEvent,
  EVENT_EMITTER,
  IEventEmitter,
} from './retirement.service';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  InMemoryRetirementRepository,
  RETIREMENT_REPOSITORY,
} from './retirement.repository';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

const mockStellarService = {
  invokeContract: jest.fn().mockResolvedValue({ returnValue: null }),
  readContract: jest.fn(),
  getContractEvents: jest.fn().mockResolvedValue([]),
};

const mockKeypairService = {
  getAdminKeypair: jest.fn().mockReturnValue({}),
};

const VALID_CONTRACT_ID =
  'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX';

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'RETIREMENT_CONTRACT_ID') return VALID_CONTRACT_ID;
    if (key === 'CREDIT_REGISTRY_CONTRACT_ID') return VALID_CONTRACT_ID;
    return def ?? '';
  }),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDto(overrides: Partial<RetireDto> = {}): RetireDto {
  return {
    buyerPublicKey: 'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    creditId: 'aabbccdd',
    tonnes: '1000000',
    reason: '2024 Scope 3 offset',
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RetirementService — event ordering (issue #162)', () => {
  let service: RetirementService;
  let repo: InMemoryRetirementRepository;
  let emittedEvents: Array<{ event: string; payload: unknown }>;
  let eventEmitter: IEventEmitter;

  beforeEach(async () => {
    emittedEvents = [];
    eventEmitter = {
      emit(event: string, payload: unknown): boolean {
        emittedEvents.push({ event, payload });
        return true;
      },
    };

    repo = new InMemoryRetirementRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetirementService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RETIREMENT_REPOSITORY, useValue: repo },
        { provide: EVENT_EMITTER, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<RetirementService>(RetirementService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('persists the retirement record before emitting CreditRetired', async () => {
    const order: string[] = [];

    // Spy on repo.save to record when the write happens
    const originalSave = repo.save.bind(repo);
    repo.save = jest.fn().mockImplementation(async (entity) => {
      const result = await originalSave(entity);
      order.push('save');
      return result;
    });

    // Replace emitter to record when the event fires
    eventEmitter.emit = jest
      .fn()
      .mockImplementation((event: string, payload: unknown) => {
        emittedEvents.push({ event, payload });
        order.push('emit');
        return true;
      });

    await service.retire(makeDto());

    expect(order).toEqual(['save', 'emit']);
  });

  it('record exists in repository when CreditRetired event is emitted', async () => {
    let recordExistedAtEmitTime = false;

    eventEmitter.emit = jest.fn().mockImplementation(async (event: string) => {
      if (event === 'CreditRetired') {
        // At the moment the event fires, the record must already be in the repo
        const all = await repo.findAll(1, 100);
        recordExistedAtEmitTime = all.total > 0;
      }
      return true;
    });

    await service.retire(makeDto());

    expect(recordExistedAtEmitTime).toBe(true);
  });

  it('does NOT emit CreditRetired when the repository write fails', async () => {
    repo.save = jest.fn().mockRejectedValue(new Error('DB write failed'));

    await expect(service.retire(makeDto())).rejects.toThrow('DB write failed');

    const creditRetiredEvents = emittedEvents.filter(
      (e) => e.event === 'CreditRetired',
    );
    expect(creditRetiredEvents).toHaveLength(0);
  });

  it('emits exactly one CreditRetired event per retire call', async () => {
    await service.retire(makeDto());

    const creditRetiredEvents = emittedEvents.filter(
      (e) => e.event === 'CreditRetired',
    );
    expect(creditRetiredEvents).toHaveLength(1);
  });

  it('CreditRetired event payload contains the correct retirement data', async () => {
    const dto = makeDto({
      creditId: 'deadbeef',
      tonnes: '500000',
      buyerPublicKey:
        'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    });

    await service.retire(dto);

    const event = emittedEvents.find((e) => e.event === 'CreditRetired');
    expect(event).toBeDefined();
    const payload = event!.payload as CreditRetiredEvent;
    expect(payload.creditId).toBe('deadbeef');
    expect(payload.tonnesRetired).toBe('500000');
    expect(payload.buyer).toBe(
      'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    );
    expect(typeof payload.retiredAt).toBe('number');
    expect(payload.retiredAt).toBeGreaterThan(0);
  });

  it('retirement record is retrievable from repo after retire completes', async () => {
    const { retirementId } = await service.retire(makeDto());

    const record = await repo.findById(retirementId);
    expect(record).toBeDefined();
    expect(record!.creditId).toBe('aabbccdd');
    expect(record!.buyer).toBe(
      'GCRZUKNU2J5GLSYTZR4OLO7OBJJVHSMVBGG7IVUZU5FXMFHUDCLDGQJX',
    );
    expect(record!.tonnesRetired).toBe('1000000');
  });
});

describe('RetirementService — contract error handling (issue #258)', () => {
  let service: RetirementService;
  let repo: InMemoryRetirementRepository;
  let eventEmitter: IEventEmitter;

  beforeEach(async () => {
    eventEmitter = {
      emit(event: string, payload: unknown): boolean {
        return true;
      },
    };

    repo = new InMemoryRetirementRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RetirementService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RETIREMENT_REPOSITORY, useValue: repo },
        { provide: EVENT_EMITTER, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<RetirementService>(RetirementService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('throws ServiceUnavailableException when contract returns error code 123', async () => {
    mockStellarService.invokeContract.mockRejectedValueOnce(
      new Error('Contract error code 123: paused'),
    );

    await expect(service.retire(makeDto())).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('returns 503 response with correct error message for paused contract', async () => {
    mockStellarService.invokeContract.mockRejectedValueOnce(
      new Error('Soroban error code 123'),
    );

    try {
      await service.retire(makeDto());
      fail('Should have thrown ServiceUnavailableException');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const response = (error as ServiceUnavailableException).getResponse();
      expect(response).toEqual({ error: 'Contract is currently paused' });
    }
  });

  it('does not emit CreditRetired event when contract is paused', async () => {
    let eventEmitted = false;
    eventEmitter.emit = jest.fn().mockImplementation((event: string) => {
      if (event === 'CreditRetired') {
        eventEmitted = true;
      }
      return true;
    });

    mockStellarService.invokeContract.mockRejectedValueOnce(
      new Error('Contract error 123'),
    );

    await expect(service.retire(makeDto())).rejects.toThrow();
    expect(eventEmitted).toBe(false);
  });

  it('re-throws other contract errors unchanged', async () => {
    mockStellarService.invokeContract.mockRejectedValueOnce(
      new Error('Some other contract error'),
    );

    await expect(service.retire(makeDto())).rejects.toThrow(
      'Some other contract error',
    );
  });
});
