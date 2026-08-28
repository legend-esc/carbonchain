import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { VerifiersService } from './verifiers.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';
import { VERIFIER_REPOSITORY } from './verifier.repository';
import { Keypair, xdr } from '@stellar/stellar-sdk';

describe('VerifiersService.approveCredit', () => {
  let service: VerifiersService;
  let mockStellarService: jest.Mocked<Partial<StellarService>>;
  let mockKeypairService: jest.Mocked<Partial<StellarKeypairService>>;
  let mockCacheService: jest.Mocked<Partial<CacheService>>;

  const CONTRACT_ID = 'CABC123';
  const VERIFIER_ADDR =
    'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
  const CREDIT_ID =
    'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  const testKeypair = () => Keypair.random();

  beforeEach(async () => {
    mockStellarService = {
      readContract: jest.fn(),
      invokeContract: jest.fn(),
    };

    mockKeypairService = {
      getAdminKeypair: jest.fn(),
    };

    mockCacheService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [() => ({ CREDIT_REGISTRY_CONTRACT_ID: CONTRACT_ID })],
        }),
      ],
      providers: [
        VerifiersService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: CacheService, useValue: mockCacheService },
        {
          provide: VERIFIER_REPOSITORY,
          useValue: {
            findAll: jest.fn().mockResolvedValue([]),
            findByAddress: jest.fn().mockResolvedValue(null),
            save: jest.fn(),
            saveAll: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<VerifiersService>(VerifiersService);
  });

  /** Spy on listVerifiers so we don't need ScVal mocks for the verifier lookup. */
  const spyListVerifiers = (addrs: string[]) =>
    jest
      .spyOn(service, 'listVerifiers')
      .mockResolvedValue(addrs.map((a) => ({ address: a })));

  /** Per-method readContract mock so the new threshold reads don't collide. */
  const setReadMock = () => {
    mockStellarService.readContract.mockImplementation(
      async (_contractId: string, method: string) => {
        if (method === 'get_nonce') {
          return xdr.ScVal.scvU64(new xdr.Uint64(42n));
        }
        if (method === 'get_required_approvals') {
          // Default: a 1-of-N threshold (first approval is allowed).
          return xdr.ScVal.scvU64(new xdr.Uint64(1n));
        }
        if (method === 'get_approval_count') {
          return xdr.ScVal.scvU64(new xdr.Uint64(0n));
        }
        return null;
      },
    );
  };

  /** Setup nonce + invokeContract mocks that succeed. */
  const setupSuccess = () => {
    setReadMock();
    mockStellarService.invokeContract.mockResolvedValue({} as any);
    mockKeypairService.getAdminKeypair.mockReturnValue(testKeypair());
  };

  describe('method name and nonce', () => {
    it('should call invokeContract with approve_and_mint (not approve_credit)', async () => {
      spyListVerifiers([VERIFIER_ADDR]);
      setupSuccess();

      await service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR);

      expect(mockStellarService.invokeContract).toHaveBeenCalledTimes(1);
      const [contractId, method, args] =
        mockStellarService.invokeContract.mock.calls[0];
      expect(contractId).toBe(CONTRACT_ID);
      expect(method).toBe('approve_and_mint');
      expect(args).toHaveLength(3);
    });

    it('should include the verifier nonce as the third argument', async () => {
      spyListVerifiers([VERIFIER_ADDR]);
      setupSuccess();

      await service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR);

      const [, , args] = mockStellarService.invokeContract.mock.calls[0];
      expect(args[2].switch().name).toBe('scvU64');
    });

    it('should read the nonce with get_nonce before invoking', async () => {
      spyListVerifiers([VERIFIER_ADDR]);
      setupSuccess();

      await service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR);

      const nonceCall = mockStellarService.readContract.mock.calls.find(
        ([, method]) => method === 'get_nonce',
      );
      expect(nonceCall).toBeDefined();
      expect(nonceCall![0]).toBe(CONTRACT_ID);
    });
  });

  describe('error handling', () => {
    const setupErrorMocks = () => {
      spyListVerifiers([VERIFIER_ADDR]);
      setReadMock();
      mockKeypairService.getAdminKeypair.mockReturnValue(testKeypair());
    };

    it('should map AlreadyApproved (Error 125) to ConflictException', async () => {
      setupErrorMocks();
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Contract invocation failed: AlreadyApproved (Error(125))'),
      );

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow(ConflictException);
    });

    it('should map Error(125) to ConflictException', async () => {
      setupErrorMocks();
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Transaction failed with Error(125)'),
      );

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow(ConflictException);
    });

    it('should map status: 125 to ConflictException', async () => {
      setupErrorMocks();
      mockStellarService.invokeContract.mockRejectedValue(
        new Error('Simulation failed: status: 125'),
      );

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ForbiddenException when caller does not match verifier address', async () => {
      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, 'GDIFFERENTCALLER'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should re-throw unknown errors unchanged', async () => {
      setupErrorMocks();
      const unknownError = new Error('Network timeout');
      mockStellarService.invokeContract.mockRejectedValue(unknownError);

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow('Network timeout');
    });

    it('should throw NotFoundException when verifier is not registered', async () => {
      // listVerifiers returns no verifiers
      spyListVerifiers([]);

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('multi-sig threshold enforcement (#771)', () => {
    it('should proceed to invokeContract when approval count is below threshold', async () => {
      spyListVerifiers([VERIFIER_ADDR]);
      setReadMock();
      mockStellarService.invokeContract.mockResolvedValue({} as any);
      mockKeypairService.getAdminKeypair.mockReturnValue(testKeypair());

      await service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR);

      expect(mockStellarService.invokeContract).toHaveBeenCalledTimes(1);
    });

    it('should throw BadRequestException when threshold is unconfigured (0)', async () => {
      spyListVerifiers([VERIFIER_ADDR]);
      mockStellarService.readContract.mockImplementation(
        async (_c: string, method: string) => {
          if (method === 'get_nonce') return xdr.ScVal.scvU64(new xdr.Uint64(42n));
          if (method === 'get_required_approvals') return xdr.ScVal.scvU64(new xdr.Uint64(0n));
          if (method === 'get_approval_count') return xdr.ScVal.scvU64(new xdr.Uint64(0n));
          return null;
        },
      );

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException when approval count already meets threshold', async () => {
      spyListVerifiers([VERIFIER_ADDR]);
      mockStellarService.readContract.mockImplementation(
        async (_c: string, method: string) => {
          if (method === 'get_nonce') return xdr.ScVal.scvU64(new xdr.Uint64(42n));
          if (method === 'get_required_approvals') return xdr.ScVal.scvU64(new xdr.Uint64(2n));
          if (method === 'get_approval_count') return xdr.ScVal.scvU64(new xdr.Uint64(2n));
          return null;
        },
      );

      await expect(
        service.approveCredit(VERIFIER_ADDR, CREDIT_ID, VERIFIER_ADDR),
      ).rejects.toThrow(ConflictException);
      expect(mockStellarService.invokeContract).not.toHaveBeenCalled();
    });
  });
});
