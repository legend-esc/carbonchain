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
  Optional,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MarketplaceService, KeysetPage } from './marketplace.service';
import { CreateOfferDto } from './dto/create-offer.dto';
import { QuoteOfferDto, QuoteResult } from './dto/quote-offer.dto';
import { Offer } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UseReplicaForRead } from '../common/use-replica-for-read.decorator';
import {
  WashTradingDetectorService,
  CandleData,
  OhlcvParams,
} from './wash-trading-detector.service';
// #1304 — Full OHLCV analytics service.
import {
  MarketplaceAnalyticsService,
  OhlcvCandle,
  Timeframe,
} from './marketplace-analytics.service';

@ApiTags('marketplace')
@Controller('marketplace')
export class MarketplaceController {
  constructor(
    private readonly marketplaceService: MarketplaceService,
    private readonly washTradingDetectorService: WashTradingDetectorService,
    @Optional()
    private readonly analyticsService?: MarketplaceAnalyticsService,
  ) {}

  /**
   * #930 — Server-side keyset pagination.
   *
   * GET /marketplace/listings?cursor=<opaque>&limit=50&methodology=VCS
   *
   * Returns { data, count, nextCursor? }.  When nextCursor is absent the
   * caller has reached the last page.  The full order book is reachable
   * by following nextCursor values sequentially — there is no silent cap.
   */
  @ApiOperation({
    summary:
      'List active marketplace offerings with keyset pagination (public)',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'methodology', required: false, type: String })
  @ApiQuery({ name: 'minPrice', required: false, type: Number })
  @ApiQuery({ name: 'maxPrice', required: false, type: Number })
  @UseReplicaForRead()
  @Get('listings')
  getListings(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('methodology') methodology?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
  ): Promise<KeysetPage> {
    return this.marketplaceService.getListingsKeyset({
      cursor,
      limit:
        limit !== undefined ? Math.max(1, parseInt(limit, 10) || 1) : undefined,
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

  /** GET /marketplace/offer/:id/xdr — build unsigned buy XDR for wallet signing */
  @UseGuards(JwtAuthGuard)
  @Get('offer/:id/xdr')
  getBuyOfferXdr(
    @Param('id', ParseIntPipe) id: number,
    @Query('buyerPublicKey') buyerPublicKey: string,
  ): Promise<{ xdr: string }> {
    return this.marketplaceService
      .buildBuyOfferXdr(buyerPublicKey, id)
      .then((xdr) => ({ xdr }));
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

  /**
   * Issue #940 — Simulate a buy transaction and return a price quote.
   */
  @ApiOperation({
    summary: 'Get a price quote for buying an offer (signing-free simulation)',
  })
  @ApiResponse({ status: 200, description: 'Quote returned successfully' })
  @ApiResponse({ status: 400, description: 'Invalid offer or account ID' })
  @ApiResponse({ status: 404, description: 'Offer not found' })
  @Post('offers/:id/quote')
  quoteOffer(
    @Param('id') id: string,
    @Body() dto: QuoteOfferDto,
  ): Promise<QuoteResult> {
    return this.marketplaceService.quoteOffer(id, dto.accountId);
  }

  /**
   * #1304 — OHLCV candlestick data endpoint.
   *
   * GET /marketplace/candles?creditId=&methodology=&timeframe=1d&from=&to=
   *
   * Aggregates trade executions (retirements) into OHLCV buckets per the
   * requested timeframe, forward-fills zero-volume gaps, and caches the result
   * in Redis for 5 minutes.  Wash-traded credits are filtered out before
   * returning.
   *
   * Timeframe values: 1h, 1d (default), 1w.
   * from / to: Unix epoch seconds.
   */
  @ApiOperation({
    summary: 'Get OHLCV candlestick data for price charts (#1304)',
  })
  @ApiQuery({ name: 'creditId', required: false, type: String })
  @ApiQuery({ name: 'methodology', required: false, type: String })
  @ApiQuery({
    name: 'timeframe',
    required: false,
    enum: ['1h', '1d', '1w'],
    description: 'Candle bucket width. Defaults to 1d.',
  })
  @ApiQuery({ name: 'from', required: false, type: Number })
  @ApiQuery({ name: 'to', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'OHLCV candle array' })
  @ApiResponse({ status: 400, description: 'Invalid timeframe or date range' })
  @UseReplicaForRead()
  @Get('candles')
  async getCandles(
    @Query('creditId') creditId?: string,
    @Query('methodology') methodology?: string,
    @Query('timeframe') timeframe?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<OhlcvCandle[]> {
    if (!this.analyticsService) {
      // Fallback to wash-trading stub when analytics service is not wired
      // (e.g. in environments where the retirements table is not yet available).
      return this.washTradingDetectorService.getOhlcvCandles({
        creditId,
        from: from ? Number(from) : undefined,
        to: to ? Number(to) : undefined,
        interval: timeframe,
      }) as unknown as OhlcvCandle[];
    }

    const suspiciousIds = this.washTradingDetectorService.getSuspiciousCreditIds();
    // If a specific creditId was requested and it's flagged, return empty.
    if (creditId && suspiciousIds.includes(creditId)) {
      return [];
    }

    const candles = await this.analyticsService.getCandles({
      creditId,
      methodology,
      timeframe: timeframe as Timeframe | undefined,
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
    });

    return candles;
  }
}
