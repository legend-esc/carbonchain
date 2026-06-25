import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { StellarService } from './stellar.service';
import { SequenceNumberManager } from './sequence-number-manager.service';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLoadAccount = jest.fn();
const mockSubmitTransaction = jest.fn();

const mockHorizonServer = {
  loadAccount: mockLoadAccount,
  submitTransaction: mockSubmitTransaction,
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
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildModule(): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      StellarService,
      SequenceNumberManager,
      {
        provide: ConfigService,
        useValue: {
          get: jest.fn((key: string, def?: unknown) => {
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
    'CDLZFC3SYJYDZT7K4VW4KH2FJ7UKYBJN6HYJ6J3H7KQI33QIDJTF5JHQ';

  beforeAll(() => {
    signerKeypair = Keypair.random();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await buildModule();
    service = module.get<StellarService>(StellarService);
    seqNoManager = module.get<SequenceNumberManager>(SequenceNumberManager);
    seqNoManager.clear();
    service.onModuleInit();
  });

  // ── getNextSequenceNumber ──────────────────────────────────────────────────

  describe('getNextSequenceNumber (private via invokeContract)', () => {
    it('fetches from Horizon on first call and caches the result', async () => {
      mockLoadAccount.mockResolvedValue({
        sequenceNumber: '42',
        accountId: () => signerKeypair.publicKey(),
      });
      // Simulate a successful simulation + transaction
      mockSimulateTransaction.mockResolvedValue({
        status: 'SIMULATION_SUCCESS' as any,
        result: { retval: 'test' },
        footprint: 'AAAAAA==',
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
      // Seed the cache as if a previous call fetched seq 100
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 100);

      mockSimulateTransaction.mockResolvedValue({
        status: 'SIMULATION_SUCCESS' as any,
        result: { retval: 'test' },
        footprint: 'AAAAAA==',
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

      // Second call uses the next cached sequence
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
    it('resets cache and retries invokeContract on tx_bad_seq', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 50);

      mockSimulateTransaction.mockResolvedValue({
        status: 'SIMULATION_SUCCESS' as any,
        result: { retval: 'test' },
        footprint: 'AAAAAA==',
      });

      // First submission fails with tx_bad_seq
      const badSeqError = new Error('tx_bad_seq');
      mockSendTransaction.mockRejectedValueOnce(badSeqError);

      // Retry succeeds
      mockSendTransaction.mockResolvedValueOnce({
        status: 'PENDING',
        hash: 'retry-txn',
      });
      mockGetTransaction.mockResolvedValue({
        status: 'SUCCESS',
        hash: 'retry-txn',
      });

      // Load account is called during retry to get fresh sequence
      mockLoadAccount.mockResolvedValue({
        sequenceNumber: '51',
        accountId: () => signerKeypair.publicKey(),
      });

      const result = await service.invokeContract(
        CONTRACT_ID,
        'test_method',
        [],
        signerKeypair,
      );

      expect(result.status).toBe('SUCCESS');
      // Cache should have been reset and re-seeded
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it('does not retry on non-sequence errors', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 50);

      mockSimulateTransaction.mockResolvedValue({
        status: 'SIMULATION_SUCCESS' as any,
        result: { retval: 'test' },
        footprint: 'AAAAAA==',
      });

      const otherError = new Error('insufficient funds');
      mockSendTransaction.mockRejectedValue(otherError);

      await expect(
        service.invokeContract(CONTRACT_ID, 'test_method', [], signerKeypair),
      ).rejects.toThrow('insufficient funds');

      // Only one sendTransaction call
      expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── buildAndSubmit ─────────────────────────────────────────────────────────

  describe('buildAndSubmit sequence number integration', () => {
    it('uses cached sequence and retries on tx_bad_seq from Horizon', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 30);

      const mockOp = { type: 'payment' } as any;

      // First submission fails with tx_bad_seq via Horizon error structure
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

      // Retry succeeds
      mockSubmitTransaction.mockResolvedValueOnce({
        hash: 'retry-hash',
        successful: true,
      });

      mockLoadAccount.mockResolvedValue({
        sequenceNumber: '31',
        accountId: () => signerKeypair.publicKey(),
      });

      const result = await service.buildAndSubmit([mockOp], signerKeypair);

      expect(result.successful).toBe(true);
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it('passes through non-tx_bad_seq Horizon errors', async () => {
      seqNoManager.cacheSequenceNumber(signerKeypair.publicKey(), 30);

      const mockOp = { type: 'payment' } as any;

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
});
