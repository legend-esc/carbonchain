import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from './marketplace.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { Offer } from '../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('marketplace')
@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

  @ApiOperation({ summary: 'List active marketplace offerings (public)' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiQuery({ name: 'methodology', required: false, type: String })
  @ApiQuery({ name: 'minPrice', required: false, type: Number })
  @ApiQuery({ name: 'maxPrice', required: false, type: Number })
  @Get('listings')
  getListings(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('methodology') methodology?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
  ) {
    return this.marketplaceService.getListingsPaginated({
      page: Math.max(1, parseInt(page, 10) || 1),
      pageSize: Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20)),
      methodology,
      minPrice: minPrice !== undefined ? Number(minPrice) : undefined,
      maxPrice: maxPrice !== undefined ? Number(maxPrice) : undefined,
    });
  }

  /** POST /marketplace/offer — protected: requires JWT */
  @UseGuards(JwtAuthGuard)
  @Post('offer')
  createOffer(@Body() dto: CreateOfferDto): Promise<{ offerId: string }> {
    return this.marketplaceService.createOffer(dto);
  }

  @ApiOperation({ summary: 'Get offer by ID' })
  @Get('offer/:id')
  getOffer(@Param('id', ParseIntPipe) id: number): Promise<Offer> {
    return this.marketplaceService.getOffer(id);
  }

  @ApiOperation({ summary: 'Get offers by seller address' })
  @Get('seller/:address')
  getOffersBySeller(@Param('address') address: string): Promise<string[]> {
    return this.marketplaceService.getOffersBySeller(address);
  }

  @ApiOperation({ summary: 'Cancel an offer' })
  @Delete('offer/:id/seller/:address')
  cancelOffer(
    @Param('address') address: string,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.marketplaceService.cancelOffer(address, id);
  }

  /** POST /marketplace/offer/:id/buy — protected: requires JWT */
  @UseGuards(JwtAuthGuard)
  @Post('offer/:id/buy')
  buyOffer(
    @Param('id', ParseIntPipe) id: number,
    @Body('buyerPublicKey') buyerPublicKey: string,
  ): Promise<void> {
    return this.marketplaceService.buyOffer(buyerPublicKey, id);
  }
}
