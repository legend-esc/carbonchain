import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { Offer } from '../../../shared';

describe('MarketplaceController', () => {
  let controller: MarketplaceController;

  const mockMarketplaceService = {
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

  // === getListings — query parsing & clamping

  describe('getListings', () => {
    const pageResult = { data: [], total: 0, page: 1, pageSize: 20 };

    it('applies default page=1 / pageSize=20 when unset', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings();
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        methodology: undefined,
        minPrice: undefined,
        maxPrice: undefined,
      });
    });

    it('clamps pageSize above 100 down to 100', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings('2', '9999');
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, pageSize: 100 }),
      );
    });

    it('clamps pageSize of 0 up to 1', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings('1', '0');
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ pageSize: 1 }),
      );
    });

    it('clamps a negative page up to 1', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings('-5', '20');
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });

    it('falls back to 1 for a non-numeric page', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings('abc', '20');
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1 }),
      );
    });

    it('passes filters through as numbers only when provided', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings('1', '20', 'VCS', '100', '500');
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        methodology: 'VCS',
        minPrice: 100,
        maxPrice: 500,
      });
    });

    it('leaves price filters undefined when omitted', async () => {
      mockMarketplaceService.getListingsPaginated.mockResolvedValueOnce(
        pageResult,
      );
      await controller.getListings('1', '20', 'VCS');
      expect(mockMarketplaceService.getListingsPaginated).toHaveBeenCalledWith(
        expect.objectContaining({ minPrice: undefined, maxPrice: undefined }),
      );
    });

    it('propagates errors from the service', async () => {
      mockMarketplaceService.getListingsPaginated.mockRejectedValueOnce(
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
