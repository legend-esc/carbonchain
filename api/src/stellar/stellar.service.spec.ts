import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';
import { SequenceNumberManager } from './sequence-number-manager.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadAccount = jest.fn();
const mockSubmitTransaction = jest.fn();
const mockFeeStats = jest.fn();

const mockHorizonServer = {
  loadAccount: mockLoadAccount,
  submitTransaction: mockSubmitTransaction,
  feeStats: mockFeeStats,
};

const mockSimulateTransaction = jest.fn();
const mockSendTransaction = jest.fn();
const mockGetTransaction = jest.fn();
const mockGetLedgerEntries = jest.fn();
const mockGetEvents = jest.fn();

const mockSorobanRpcServer = {
  simulateTransaction: mockSimulateTransaction,
  sendTransaction: mockSendTransaction,
  getTransaction: mockGetTransaction,
  getLedgerEntries: mockGetLedgerEntries,
  getEvents: mockGetEvents,
};

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn(() => mockHorizonServer),
    },
    rpc: {
      ...actual.rpc,
      Server: jest.fn(() => mockSorobanRpcServer),
      Api: actual.rpc.Api,
      // assembleTransaction returns a builder whose setBaseFee().build() echoes
      // back the original transaction so the service can sign and submit it.
      assembleTransaction: jest.fn((tx: unknown) => ({
        setBaseFee: jest.fn().mockReturnValue({ build: () => tx }),
        build: () => tx,
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModule(
  extraConfig?: Record<string, string>,
): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      StellarService,
      SequenceNumberManager,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, def?: unknown) => {
            if (extraConfig && key in extraConfig) return extraConfig[key];
            if (key === 'HORIZON_URL') {
              return 'https://horizon-testnet.stellar.org';
            }
            if (key === 'SOROBAN_RPC_URL') {
              return 'https://soroban-testnet.stellar.org';
            }
            if (key === 'STELLAR_NETWORK') return 'TESTNET';
            return def;
          }),
        },
      },
    ],
  }).compile();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StellarService - sequence number integration', () => {
  let service: StellarService;
  let seqNoManager: SequenceNumberManager;
  let signerKeypair: Keypair;

  const CONTRACT_ID =
    'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

  beforeAll(() => {
    signerKeypair = Keypair.random();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Default: feeStats returns a p50 fee
    mockFeeStats.mockResolvedValue({ fee_charged: { p50: '200' } });
    const module = await buildModule();
    service = module.get<StellarService>(StellarService);
    seqNoManager = module.get<SequenceNumberManager>(SequenceNumberManager);
    seqNoManager.clear();
    service.onModuleInit();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── getNextSequenceNumber ──────────────────────────────────────────────────

  describe('getNextSequenceNumber (private via invokeContract)', () => {
    it('fetches from Horizon on first call and caches the result', async () => {
      mockLoadAccount.mockResolvedValue({
        sequenceNumber: '42',
        accountId: () => signerKeypair.publicKey(),
      });
      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '800',
        result: { retval: 'test' },
      });
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'abc123',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'SUCCESS',
        hash: 'abc123',
      });

      await service.invokeContract(
        CONTRACT_ID,
        'test_method',
        [],
        signerKeypair,
      );

      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
      expect(
        seqNoManager.getNextSequenceNumber(signerKeypair.publicKey()),
      ).toBe(43);
    });

    it('uses cached sequence without loading from Horizon on subsequent calls', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 100);

      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '500',
        result: { retval: 'test' },
      });
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'txn001',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'SUCCESS',
        hash: 'txn001',
      });

      await service.invokeContract(CONTRACT_ID, 'method_a', [], signerKeypair);
      expect(mockLoadAccount).not.toHaveBeenCalled();

      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'txn002',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'SUCCESS',
        hash: 'txn002',
      });

      await service.invokeContract(CONTRACT_ID, 'method_b', [], signerKeypair);
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });
  });

  // ── tx_bad_seq retry ───────────────────────────────────────────────────────

  describe('tx_bad_seq retry', () => {
    it('resets cache and retries invokeContract on tx_bad_seq after 200ms delay', async () => {
      jest.useFakeTimers();
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 50);

      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '300',
        result: { retval: 'test' },
      });

      const badSeqError = new Error('tx_bad_seq');
      mockSendTransaction.mockRejectedValueOnce(badSeqError);
      mockSendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'retry-txn',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'SUCCESS',
        hash: 'retry-txn',
      });
      mockLoadAccount.mockResolvedValue({
        sequenceNumber: '51',
        accountId: () => signerKeypair.publicKey(),
      });

      const resultPromise = service.invokeContract(
        CONTRACT_ID,
        'test_method',
        [],
        signerKeypair,
      );

      // Let microtasks run until the 200ms delay
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.status).toBe('SUCCESS');
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it('does not retry on non-sequence errors', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 50);

      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '300',
        result: { retval: 'test' },
      });

      const otherError = new Error('insufficient funds');
      mockSendTransaction.mockRejectedValue(otherError);

      await expect(
        service.invokeContract(CONTRACT_ID, 'test_method', [], signerKeypair),
      ).rejects.toThrow('insufficient funds');

      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── buildAndSubmit ─────────────────────────────────────────────────────────

  describe('buildAndSubmit sequence number integration', () => {
    it('uses cached sequence and retries on tx_bad_seq from Horizon', async () => {
      jest.useFakeTimers();
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 30);

      const mockOp = Operation.bumpSequence({ bumpTo: '99' });

      const badSeqError = new Error('Horizon error') as any;
      badSeqError.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_bad_seq',
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValueOnce(badSeqError);
      mockSubmitTransaction.mockResolvedValueOnce({
        hash: 'retry-hash',
        successful: true,
      });
      mockLoadAccount.mockResolvedValue({
        sequenceNumber: '31',
        accountId: () => signerKeypair.publicKey(),
      });

      const resultPromise = service.buildAndSubmit([mockOp], signerKeypair);
      await jest.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.successful).toBe(true);
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it('passes through non-tx_bad_seq Horizon errors', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 30);

      const mockOp = Operation.bumpSequence({ bumpTo: '99' });

      const otherError = new Error('Horizon error') as any;
      otherError.response = {
        data: {
          extras: {
            result_codes: {
              transaction: 'tx_insufficient_fee',
            },
          },
        },
      };
      mockSubmitTransaction.mockRejectedValue(otherError);

      await expect(
        service.buildAndSubmit([mockOp], signerKeypair),
      ).rejects.toThrow('Horizon error');

      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── Bug fix: FAILED transaction status throws error ────────────────────────

  describe('FAILED transaction status handling (bug fix)', () => {
    it('throws when pollTransactionStatus returns FAILED status', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 10);

      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '500',
        result: { retval: 'test' },
      });
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'failed-hash',
      });
      // pollTransactionStatus returns a FAILED result
      mockGetTransaction.mockResolvedValue({
        status: 'FAILED',
        hash: 'failed-hash',
      });

      await expect(
        service.invokeContract(CONTRACT_ID, 'test_method', [], signerKeypair),
      ).rejects.toThrow('Transaction failed on-chain');
    });

    it('does not emit CONTRACT_INVOCATION_COMPLETED success event when transaction is FAILED', async () => {
      const { EventEmitter } =
        jest.requireActual<typeof import('events')>('events');
      const emitter = new EventEmitter();
      const emitSpy = jest.spyOn(emitter, 'emit');

      // Build a module that injects the metrics emitter
      const moduleWithEmitter = await Test.createTestingModule({
        providers: [
          StellarService,
          SequenceNumberManager,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn((key: string, def?: unknown) => {
                if (key === 'HORIZON_URL')
                  return 'https://horizon-testnet.stellar.org';
                if (key === 'SOROBAN_RPC_URL')
                  return 'https://soroban-testnet.stellar.org';
                if (key === 'STELLAR_NETWORK') return 'TESTNET';
                return def;
              }),
            },
          },
          { provide: 'METRICS_EVENT_EMITTER', useValue: emitter },
        ],
      }).compile();

      const svcWithEmitter =
        moduleWithEmitter.get<StellarService>(StellarService);
      const seqMgrWithEmitter = moduleWithEmitter.get<SequenceNumberManager>(
        SequenceNumberManager,
      );
      svcWithEmitter.onModuleInit();
      seqMgrWithEmitter.cacheSequenceNumber(signerKeypair.publicKey(), 20);

      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '500',
        result: { retval: 'test' },
      });
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'failed-emit-hash',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'FAILED',
        hash: 'failed-emit-hash',
      });

      await expect(
        svcWithEmitter.invokeContract(
          CONTRACT_ID,
          'test_method',
          [],
          signerKeypair,
        ),
      ).rejects.toThrow();

      // success event must NOT have been emitted
      const successCalls = emitSpy.mock.calls.filter(
        ([event, payload]) =>
          event === 'contract.invocation.completed' &&
          (payload as { status?: string }).status === 'success',
      );
      expect(successCalls).toHaveLength(0);

      // failure event MUST have been emitted (via the catch block)
      const failureCalls = emitSpy.mock.calls.filter(
        ([event, payload]) =>
          event === 'contract.invocation.completed' &&
          (payload as { status?: string }).status === 'failure',
      );
      expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT throw when pollTransactionStatus returns SUCCESS', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 30);

      mockSimulateTransaction.mockResolvedValue({
        transactionData: 'AAAAAA==',
        minResourceFee: '500',
        result: { retval: 'test' },
      });
      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: 'success-hash',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'SUCCESS',
        hash: 'success-hash',
      });

      const result = await service.invokeContract(
        CONTRACT_ID,
        'test_method',
        [],
        signerKeypair,
      );
      expect(result.status).toBe('SUCCESS');
    });
  });

  // ── Bug fix: mainnet/MAINNET network misconfiguration ──────────────────────

  describe('onModuleInit network configuration (bug fix)', () => {
    it('resolves Networks.PUBLIC when STELLAR_NETWORK is "mainnet"', async () => {
      const { Networks } = jest.requireActual<
        typeof import('@stellar/stellar-sdk')
      >('@stellar/stellar-sdk');

      const mainnetModule = await buildModule({ STELLAR_NETWORK: 'mainnet' });
      const mainnetService = mainnetModule.get<StellarService>(StellarService);
      mainnetService.onModuleInit();

      expect(mainnetService.getNetworkPassphrase()).toBe(Networks.PUBLIC);
    });

    it('resolves Networks.PUBLIC when STELLAR_NETWORK is "PUBLIC"', async () => {
      const { Networks } = jest.requireActual<
        typeof import('@stellar/stellar-sdk')
      >('@stellar/stellar-sdk');

      const publicModule = await buildModule({ STELLAR_NETWORK: 'PUBLIC' });
      const publicService = publicModule.get<StellarService>(StellarService);
      publicService.onModuleInit();

      expect(publicService.getNetworkPassphrase()).toBe(Networks.PUBLIC);
    });

    it('resolves Networks.TESTNET when STELLAR_NETWORK is "testnet"', async () => {
      const { Networks } = jest.requireActual<
        typeof import('@stellar/stellar-sdk')
      >('@stellar/stellar-sdk');

      const testnetModule = await buildModule({ STELLAR_NETWORK: 'testnet' });
      const testnetService = testnetModule.get<StellarService>(StellarService);
      testnetService.onModuleInit();

      expect(testnetService.getNetworkPassphrase()).toBe(Networks.TESTNET);
    });

    it('resolves Networks.FUTURENET when STELLAR_NETWORK is "futurenet"', async () => {
      const { Networks } = jest.requireActual<
        typeof import('@stellar/stellar-sdk')
      >('@stellar/stellar-sdk');

      const futureModule = await buildModule({ STELLAR_NETWORK: 'futurenet' });
      const futureService = futureModule.get<StellarService>(StellarService);
      futureService.onModuleInit();

      expect(futureService.getNetworkPassphrase()).toBe(Networks.FUTURENET);
    });

    it('throws a startup error for an unrecognised STELLAR_NETWORK value', async () => {
      const unknownModule = await buildModule({
        STELLAR_NETWORK: 'staging-private',
      });
      const unknownService = unknownModule.get<StellarService>(StellarService);

      expect(() => unknownService.onModuleInit()).toThrow(
        'Unknown STELLAR_NETWORK value',
      );
    });
  });

  // ── Dynamic fee estimation (#472) ──────────────────────────────────────────

  describe('dynamic fee estimation (#472)', () => {
    describe('invokeContract — Soroban minResourceFee', () => {
      it('uses simulation.minResourceFee * 1.1 (default buffer) as fee', async () => {
        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 10);

        // minResourceFee = 1000 → fee = ceil(1000 * 1.1) = 1100
        mockSimulateTransaction.mockResolvedValue({
          transactionData: 'AAAAAA==',
          minResourceFee: '1000',
          result: { retval: 'test' },
        });
        mockSendTransaction.mockResolvedValue({
          status: 'PENDING',
          hash: 'fee-test-txn',
        });
        mockGetTransaction.mockResolvedValue({
          status: 'SUCCESS',
          hash: 'fee-test-txn',
        });

        const cloneFromSpy = jest.spyOn(TransactionBuilder, 'cloneFrom');

        await service.invokeContract(
          CONTRACT_ID,
          'test_method',
          [],
          signerKeypair,
        );

        // The fee is applied via TransactionBuilder.cloneFrom after assembly:
        // ceil(1000 * 1.1) = '1100'
        const opts = cloneFromSpy.mock.calls[0]?.[1] as { fee?: string };
        expect(opts?.fee).toBe('1100');
        cloneFromSpy.mockRestore();
      });

      it('uses a custom FEE_BUFFER_MULTIPLIER from env', async () => {
        const customModule = await buildModule({
          FEE_BUFFER_MULTIPLIER: '1.5',
        });
        const customService = customModule.get<StellarService>(StellarService);
        const customSeqMgr = customModule.get<SequenceNumberManager>(
          SequenceNumberManager,
        );
        customService.onModuleInit();
        customSeqMgr.cacheSequenceNumber(signerKeypair.publicKey(), 20);

        // minResourceFee = 200 → fee = ceil(200 * 1.5) = 300
        mockSimulateTransaction.mockResolvedValue({
          transactionData: 'AAAAAA==',
          minResourceFee: '200',
          result: { retval: 'test' },
        });
        mockSendTransaction.mockResolvedValue({
          status: 'PENDING',
          hash: 'custom-fee-txn',
        });
        mockGetTransaction.mockResolvedValue({
          status: 'SUCCESS',
          hash: 'custom-fee-txn',
        });

        const cloneFromSpy = jest.spyOn(TransactionBuilder, 'cloneFrom');

        await customService.invokeContract(
          CONTRACT_ID,
          'test_method',
          [],
          signerKeypair,
        );

        const opts = cloneFromSpy.mock.calls[0]?.[1] as { fee?: string };
        expect(opts?.fee).toBe('300');
        cloneFromSpy.mockRestore();
      });

      it('uses minimum of 100 stroops when minResourceFee is 0', async () => {
        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 10);

        mockSimulateTransaction.mockResolvedValue({
          transactionData: 'AAAAAA==',
          minResourceFee: '0',
          result: { retval: 'test' },
        });
        mockSendTransaction.mockResolvedValue({
          status: 'PENDING',
          hash: 'min-fee-txn',
        });
        mockGetTransaction.mockResolvedValue({
          status: 'SUCCESS',
          hash: 'min-fee-txn',
        });

        const cloneFromSpy = jest.spyOn(TransactionBuilder, 'cloneFrom');

        await service.invokeContract(
          CONTRACT_ID,
          'test_method',
          [],
          signerKeypair,
        );

        // max(ceil(0 * 1.1), 100) = '100'
        const opts = cloneFromSpy.mock.calls[0]?.[1] as { fee?: string };
        expect(opts?.fee).toBe('100');
        cloneFromSpy.mockRestore();
      });
    });

    describe('buildAndSubmit — Horizon base fee with TTL cache', () => {
      it('fetches baseFee from Horizon and applies buffer to buildAndSubmit', async () => {
        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 5);

        // feeStats returns p50 = 150 → fee = ceil(150 * 1.1) = 165
        mockFeeStats.mockResolvedValue({ fee_charged: { p50: '150' } });
        mockSubmitTransaction.mockResolvedValue({
          hash: 'basefee-txn',
          successful: true,
        });

        const mockOp = Operation.bumpSequence({ bumpTo: '10' });
        await service.buildAndSubmit([mockOp], signerKeypair);

        expect(mockFeeStats).toHaveBeenCalledTimes(1);
        expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
      });

      it('caches the Horizon base fee for 60 seconds', async () => {
        jest.useFakeTimers();
        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 5);

        mockFeeStats.mockResolvedValue({ fee_charged: { p50: '100' } });
        mockSubmitTransaction.mockResolvedValue({
          hash: 'cache-txn',
          successful: true,
        });

        const mockOp = Operation.bumpSequence({ bumpTo: '10' });

        // First call — fetches base fee
        await service.buildAndSubmit([mockOp], signerKeypair);
        expect(mockFeeStats).toHaveBeenCalledTimes(1);

        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 6);

        // Second call within 60s — uses cache
        jest.advanceTimersByTime(59_000);
        await service.buildAndSubmit([mockOp], signerKeypair);
        expect(mockFeeStats).toHaveBeenCalledTimes(1);

        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 7);

        // Third call after 60s — re-fetches
        jest.advanceTimersByTime(2_000);
        await service.buildAndSubmit([mockOp], signerKeypair);
        expect(mockFeeStats).toHaveBeenCalledTimes(2);
      });

      it('falls back to 100 stroops when feeStats fails', async () => {
        seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 5);

        mockFeeStats.mockRejectedValue(new Error('network error'));
        mockSubmitTransaction.mockResolvedValue({
          hash: 'fallback-txn',
          successful: true,
        });

        const mockOp = Operation.bumpSequence({ bumpTo: '10' });
        // Should not throw — fallback fee is used
        const result = await service.buildAndSubmit([mockOp], signerKeypair);
        expect(result.successful).toBe(true);
      });
    });
  });
});
