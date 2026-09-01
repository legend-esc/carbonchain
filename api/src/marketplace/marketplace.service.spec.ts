import {
  NotFoundException,
  GoneException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  BadGatewayException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MarketplaceService } from './marketplace.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';

// === Helpers

/** Builds an error whose message contains a Soroban contract error pattern. */
function contractError(code: number): Error {
  return new Error(`transaction simulation failed: Error(Contract, #${code})`);
}

// A real Stellar ed25519 public key required by nativeToScVal type:'address'.
const VALID_BUYER = 'GBSOK5REZRYMHX5ZJNDZUPUKLDVSAXTJ6D5OKXWOEENUTLZHOP2TWZDY';

// === Mocks

const mockStellarService = {
  invokeContract: jest.fn(),
  readContract: jest.fn(),
};

const mockKeypairService = {
  getAdminKeypair: jest.fn().mockReturnValue({ publicKey: () => 'GADMIN' }),
};

const mockConfigService = {
  get: jest.fn().mockImplementation((key: string, def: string) => {
    if (key === 'MARKETPLACE_CONTRACT_ID')
      return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    // NATIVE_TOKEN_CONTRACT_ID must be a valid Stellar contract address (C + 55 base32 chars).
    if (key === 'NATIVE_TOKEN_CONTRACT_ID')
      return 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
    return def;
  }),
};

// === Tests

describe('MarketplaceService — mapMarketplaceError', () => {
  let service: MarketplaceService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketplaceService,
        { provide: StellarService, useValue: mockStellarService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<MarketplaceService>(MarketplaceService);
  });

  afterEach(() => jest.clearAllMocks());

  // === getOffer — exercises the catch branch in getOffer

  describe('getOffer', () => {
    it('throws NotFoundException for code 300 (OfferNotFound)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(300));
      await expect(service.getOffer(1)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for code 301 (Unauthorized)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(301));
      await expect(service.getOffer(1)).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException for code 302 (InvalidPrice)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(302));
      await expect(service.getOffer(1)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for code 303 (InvalidTonnes)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(303));
      await expect(service.getOffer(1)).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException for code 304 (AlreadyClosed)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(304));
      await expect(service.getOffer(1)).rejects.toThrow(ConflictException);
    });

    it('throws BadRequestException for code 305 (CreditNotActive)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(305));
      await expect(service.getOffer(1)).rejects.toThrow(BadRequestException);
    });

    it('throws ServiceUnavailableException for code 306 (NotInitialized)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(306));
      await expect(service.getOffer(1)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws ServiceUnavailableException for code 307 (ContractPaused)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(307));
      await expect(service.getOffer(1)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('throws UnprocessableEntityException for code 308 (InvalidNonce)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(308));
      await expect(service.getOffer(1)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('throws GoneException for code 309 (OfferExpired)', async () => {
      mockStellarService.readContract.mockRejectedValueOnce(contractError(309));
      await expect(service.getOffer(1)).rejects.toThrow(GoneException);
    });

    it('re-throws unrecognized errors unchanged', async () => {
      const rawErr = new Error('network connection refused');
      mockStellarService.readContract.mockRejectedValueOnce(rawErr);
      await expect(service.getOffer(1)).rejects.toThrow(
        'network connection refused',
      );
    });

    it('does NOT throw GoneException for a message containing "123" without the contract pattern', async () => {
      // Previously the substring match on "123" would have triggered GoneException.
      const err = new Error('session 123 timed out');
      mockStellarService.readContract.mockRejectedValueOnce(err);
      await expect(service.getOffer(1)).rejects.not.toThrow(GoneException);
    });

    it('does NOT throw GoneException for a message containing "expired" without the contract pattern', async () => {
      const err = new Error('token expired');
      mockStellarService.readContract.mockRejectedValueOnce(err);
      await expect(service.getOffer(1)).rejects.not.toThrow(GoneException);
    });

    it('preserves the NotFoundException when readContract returns null (offer not in db)', async () => {
      mockStellarService.readContract.mockResolvedValueOnce(null);
      await expect(service.getOffer(42)).rejects.toThrow(NotFoundException);
    });
  });

  // === buyOffer — exercises the catch branch in buyOffer

  describe('buyOffer', () => {
    it('throws GoneException for code 309 (OfferExpired)', async () => {
      mockStellarService.invokeContract.mockRejectedValueOnce(
        contractError(309),
      );
      await expect(service.buyOffer(VALID_BUYER, 1)).rejects.toThrow(
        GoneException,
      );
    });

    it('throws BadGatewayException for code 313 (EscrowFailed)', async () => {
      mockStellarService.invokeContract.mockRejectedValueOnce(
        contractError(313),
      );
      await expect(service.buyOffer(VALID_BUYER, 1)).rejects.toThrow(
        BadGatewayException,
      );
    });

    it('re-throws unknown errors from buyOffer', async () => {
      const rawErr = new Error('rpc unavailable');
      mockStellarService.invokeContract.mockRejectedValueOnce(rawErr);
      await expect(service.buyOffer(VALID_BUYER, 1)).rejects.toThrow(
        'rpc unavailable',
      );
    });
  });
});
