import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Request,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from './marketplace.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { Offer } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UseReplicaForRead } from '../common/use-replica-for-read.decorator';

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
  @UseReplicaForRead()
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

  @ApiOperation({ summary: 'Create a new marketplace offer' })
  @ApiResponse({ status: 201, description: 'Offer created' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post('offer')
  createOffer(
    @Body() dto: CreateOfferDto,
    @Request() req: any,
  ): Promise<{ offerId: string }> {
    return this.marketplaceService.createOffer({
      ...dto,
      sellerPublicKey: req.user.account,
    });
  }

  @ApiOperation({ summary: 'Get offer by ID' })
  @UseReplicaForRead()
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
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Caller is not the offer owner' })
  @UseGuards(JwtAuthGuard)
  @Delete('offer/:id/seller/:address')
  cancelOffer(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: any,
  ): Promise<void> {
    return this.marketplaceService.cancelOffer(req.user.account, id);
  }

  @ApiOperation({ summary: 'Buy an offer from the marketplace' })
  @ApiResponse({ status: 200, description: 'Offer purchased' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 410, description: 'Offer has expired' })
  @UseGuards(JwtAuthGuard)
  @Post('offer/:id/buy')
  buyOffer(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: any,
  ): Promise<void> {
    return this.marketplaceService.buyOffer(req.user.account, id);
  }
}
