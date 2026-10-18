import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { Offer } from '../../../shared';

describe('MarketplaceController', () => {
  let controller: MarketplaceController;

  const mockMarketplaceService = {
    getListingsKeyset: jest.fn(),
    getListingsPaginated: jest.fn(),
    createOffer: jest.fn(),
    getOffer: jest.fn(),
    getOffersBySeller: jest.fn(),
    cancelOffer: jest.fn(),
    buyOffer: jest.fn(),
  };

  const VALID_SELLER =
    'GBSOK5REZRYMHX5ZJNDZUPUKLDVSAXTJ6D5OKXWOEENUTLZHOP2TWZDY';
  const OTHER_SELLER =
    'GOTHER5REZRYMHX5ZJNDZUPUKLDVSAXTJ6D5OKXWOEENUTLZHOP2XYZ';

  const mockReq = { user: { account: VALID_SELLER } } as any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MarketplaceController],
      providers: [
        { provide: MarketplaceService, useValue: mockMarketplaceService },
      ],
    }).compile();

    controller = module.get<MarketplaceController>(MarketplaceController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // === #930 getListings — keyset pagination

  describe('getListings (#930 keyset)', () => {
    const keysetResult = { data: [], count: 0 };

    it('calls getListingsKeyset with no cursor/limit for first page', async () => {
      mockMarketplaceService.getListingsKeyset.mockResolvedValueOnce(
        keysetResult,
      );
      await controller.getListings();
      expect(mockMarketplaceService.getListingsKeyset).toHaveBeenCalledWith({
        cursor: undefined,
        limit: undefined,
        methodology: undefined,
        minPrice: undefined,
        maxPrice: undefined,
      });
    });

    it('passes cursor through to getListingsKeyset', async () => {
      mockMarketplaceService.getListingsKeyset.mockResolvedValueOnce(
        keysetResult,
      );
      const cursor = Buffer.from(JSON.stringify({ offset: 50 })).toString(
        'base64url',
      );
      await controller.getListings(cursor, '50');
      expect(mockMarketplaceService.getListingsKeyset).toHaveBeenCalledWith(
        expect.objectContaining({ cursor, limit: 50 }),
      );
    });

    it('passes filters through as numbers only when provided', async () => {
      mockMarketplaceService.getListingsKeyset.mockResolvedValueOnce(
        keysetResult,
      );
      await controller.getListings(undefined, '20', 'VCS', '100', '500');
      expect(mockMarketplaceService.getListingsKeyset).toHaveBeenCalledWith({
        cursor: undefined,
        limit: 20,
        methodology: 'VCS',
        minPrice: 100,
        maxPrice: 500,
      });
    });

    it('leaves price filters undefined when omitted', async () => {
      mockMarketplaceService.getListingsKeyset.mockResolvedValueOnce(
        keysetResult,
      );
      await controller.getListings(undefined, '20', 'VCS');
      expect(mockMarketplaceService.getListingsKeyset).toHaveBeenCalledWith(
        expect.objectContaining({ minPrice: undefined, maxPrice: undefined }),
      );
    });

    it('propagates errors from the service', async () => {
      mockMarketplaceService.getListingsKeyset.mockRejectedValueOnce(
        new Error('read failed'),
      );
      await expect(controller.getListings()).rejects.toThrow('read failed');
    });
  });

  // === createOffer — seller overridden from authenticated user

  describe('createOffer', () => {
    const dto: CreateOfferDto = {
      sellerPublicKey: OTHER_SELLER,
      creditId: '037176a1',
      priceXlm: '10000000',
      tonnes: '1000000',
    };

    it('overrides sellerPublicKey with the authenticated account', async () => {
      mockMarketplaceService.createOffer.mockResolvedValueOnce({
        offerId: '7',
      });
      const result = await controller.createOffer(dto, mockReq);
      expect(mockMarketplaceService.createOffer).toHaveBeenCalledWith({
        ...dto,
        sellerPublicKey: VALID_SELLER,
      });
      expect(result).toEqual({ offerId: '7' });
    });

    it('propagates service errors', async () => {
      mockMarketplaceService.createOffer.mockRejectedValueOnce(
        new Error('contract rejected'),
      );
      await expect(controller.createOffer(dto, mockReq)).rejects.toThrow(
        'contract rejected',
      );
    });
  });

  // === getOffer — passes parsed id

  describe('getOffer', () => {
    it('delegates to the service with the numeric id', async () => {
      const offer = { id: '42' } as Offer;
      mockMarketplaceService.getOffer.mockResolvedValueOnce(offer);
      const result = await controller.getOffer(42);
      expect(mockMarketplaceService.getOffer).toHaveBeenCalledWith(42);
      expect(result).toBe(offer);
    });

    it('propagates NotFoundException', async () => {
      mockMarketplaceService.getOffer.mockRejectedValueOnce(
        new NotFoundException('Offer 42 not found'),
      );
      await expect(controller.getOffer(42)).rejects.toThrow(NotFoundException);
    });
  });

  // === getOffersBySeller

  describe('getOffersBySeller', () => {
    it('delegates to the service with the address', async () => {
      mockMarketplaceService.getOffersBySeller.mockResolvedValueOnce([
        '1',
        '2',
      ]);
      const result = await controller.getOffersBySeller(VALID_SELLER);
      expect(mockMarketplaceService.getOffersBySeller).toHaveBeenCalledWith(
        VALID_SELLER,
      );
      expect(result).toEqual(['1', '2']);
    });
  });

  // === cancelOffer — ownership from authenticated user

  describe('cancelOffer', () => {
    it('delegates to the service with the caller account and id', async () => {
      mockMarketplaceService.cancelOffer.mockResolvedValueOnce(undefined);
      await controller.cancelOffer(42, mockReq);
      expect(mockMarketplaceService.cancelOffer).toHaveBeenCalledWith(
        VALID_SELLER,
        42,
      );
    });

    it('propagates service errors', async () => {
      mockMarketplaceService.cancelOffer.mockRejectedValueOnce(
        new Error('not owner'),
      );
      await expect(controller.cancelOffer(42, mockReq)).rejects.toThrow(
        'not owner',
      );
    });
  });

  // === buyOffer — buyer from authenticated user

  describe('buyOffer', () => {
    it('delegates to the service with the caller account and id', async () => {
      mockMarketplaceService.buyOffer.mockResolvedValueOnce(undefined);
      await controller.buyOffer(42, mockReq);
      expect(mockMarketplaceService.buyOffer).toHaveBeenCalledWith(
        VALID_SELLER,
        42,
      );
    });

    it('propagates service errors (e.g. expired offer)', async () => {
      mockMarketplaceService.buyOffer.mockRejectedValueOnce(new Error('gone'));
      await expect(controller.buyOffer(42, mockReq)).rejects.toThrow('gone');
    });
  });
});
