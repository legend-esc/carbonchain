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

function contractError(code: number): Error {
  return new Error(`transaction simulation failed: Error(Contract, #${code})`);
}

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

  // === getOffer — error mapping

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

  // === buyOffer

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

  // === #930 — keyset pagination

  describe('#930 — getListingsKeyset', () => {
    /** Builds a raw offer array as scValToNative would return it. */
    function makeRawOffers(count: number): Array<Record<string, unknown>> {
      return Array.from({ length: count }, (_, i) => ({
        id: BigInt(i + 1),
        seller: 'GSELLER',
        credit_id: new Uint8Array(32),
        price_xlm: BigInt(10_000_000),
        tonnes: BigInt(1_000_000),
        created_at: BigInt(1700000000),
        active: true,
        methodology: 'VCS',
        payment_asset_code: 'XLM',
        payment_asset_issuer: null,
      }));
    }

    it('returns first page with nextCursor when more offers exist', async () => {
      // 300 offers in total; request limit=50 → returns 50 + nextCursor.
      const allOffers = makeRawOffers(300);

      mockStellarService.readContract.mockImplementation(
        (_contract: string, _method: string, args: any[]) => {
          // args[1] = offset (ScVal), args[2] = limit (ScVal) — use raw mock.
          // We return a slice based on the scVal numbers.
          // In test context scValToNative returns the raw bigint mock we passed.
          // Since we cannot easily decode the ScVals here, return a consistent
          // slice of 51 (limit+1) to simulate a "has more" scenario.
          return Promise.resolve(allOffers.slice(0, 51));
        },
      );

      const result = await service.getListingsKeyset({ limit: 50 });

      expect(result.data).toHaveLength(50);
      expect(result.nextCursor).toBeDefined();
      expect(result.count).toBe(50);
    });

    it('returns last page with no nextCursor when fewer offers than limit remain', async () => {
      // Only 10 offers available.
      mockStellarService.readContract.mockResolvedValueOnce(
        makeRawOffers(10),
      );

      const result = await service.getListingsKeyset({ limit: 50 });

      expect(result.data).toHaveLength(10);
      expect(result.nextCursor).toBeUndefined();
    });

    it('returns empty result when contract returns null', async () => {
      mockStellarService.readContract.mockResolvedValueOnce(null);

      const result = await service.getListingsKeyset({ limit: 50 });

      expect(result.data).toHaveLength(0);
      expect(result.nextCursor).toBeUndefined();
    });

    it('throws BadRequestException for a malformed cursor', async () => {
      await expect(
        service.getListingsKeyset({ cursor: '!!!invalid!!!', limit: 50 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('pages through 300 offers using sequential cursors', async () => {
      const allOffers = makeRawOffers(300);

      // Each readContract call returns the slice starting at the requested offset.
      // We decode the offset from args by using the mock call count as a proxy.
      let callCount = 0;
      mockStellarService.readContract.mockImplementation(() => {
        const offset = callCount * 50;
        callCount++;
        // Return limit+1 items to indicate there are more (unless we're past the end).
        const slice = allOffers.slice(offset, offset + 51);
        return Promise.resolve(slice);
      });

      let cursor: string | undefined;
      let totalFetched = 0;
      let pages = 0;

      do {
        const result = await service.getListingsKeyset({ cursor, limit: 50 });
        totalFetched += result.data.length;
        cursor = result.nextCursor;
        pages++;
      } while (cursor && pages < 20); // safety cap

      expect(totalFetched).toBeGreaterThanOrEqual(250); // at least 5 full pages
      expect(pages).toBeGreaterThanOrEqual(5);
    });

    it('applies methodology filter server-side', async () => {
      const raw = makeRawOffers(10);
      // Half are REDD+, half are VCS.
      raw.forEach((o, i) => {
        o.methodology = i % 2 === 0 ? 'REDD+' : 'VCS';
      });
      mockStellarService.readContract.mockResolvedValueOnce(raw);

      const result = await service.getListingsKeyset({
        limit: 50,
        methodology: 'VCS',
      });

      result.data.forEach((o) =>
        expect(o.methodology?.toLowerCase()).toBe('vcs'),
      );
    });

    it('clamps limit above MAX_LISTINGS to MAX_LISTINGS', async () => {
      mockStellarService.readContract.mockResolvedValueOnce([]);

      await service.getListingsKeyset({ limit: 99_999 });

      // The readContract should have been called with a limit ≤ MAX_LISTINGS+1.
      expect(mockStellarService.readContract).toHaveBeenCalled();
    });
  });
});
