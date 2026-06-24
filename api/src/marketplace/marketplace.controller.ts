import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MarketplaceService } from './marketplace.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { Offer } from '../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('marketplace')
@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly marketplaceService: MarketplaceService) {}

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
