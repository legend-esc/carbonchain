import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { ExchangeRateService } from '../common/exchange-rate.service';
import type { SupportedCurrency, ExchangeRates, ConvertResult } from '../common/exchange-rate.service';

@ApiTags('rates')
@Controller('rates')
export class RatesController {
  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  /** GET /rates/current — latest exchange rates (XLM/USD, USDC/USD, EUR/USD) */
  @Get('current')
  getCurrentRates(): Promise<ExchangeRates> {
    return this.exchangeRateService.getCurrentRates();
  }

  /**
   * GET /rates/convert?amount=100&from=XLM&to=USD
   * Converts an amount between supported currencies.
   */
  @Get('convert')
  @ApiQuery({ name: 'amount', type: Number })
  @ApiQuery({ name: 'from', enum: ['XLM', 'USDC', 'EUR', 'USD'] })
  @ApiQuery({ name: 'to', enum: ['XLM', 'USDC', 'EUR', 'USD'] })
  convert(
    @Query('amount') amount: string,
    @Query('from') from: SupportedCurrency,
    @Query('to') to: SupportedCurrency,
  ): Promise<ConvertResult> {
    return this.exchangeRateService.convert(parseFloat(amount), from, to);
  }
}
