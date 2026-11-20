import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExchangeRateService } from './exchange-rate.service';

@Module({
  imports: [ConfigModule],
  providers: [ExchangeRateService],
  exports: [ExchangeRateService],
})
export class CommonModule {}
