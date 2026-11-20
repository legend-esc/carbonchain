import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ExchangeRateService } from './exchange-rate.service';

@Module({
  imports: [ConfigModule],
  providers: [ExchangeRateService],
  exports: [ExchangeRateService],
})
export class CommonModule {}
// Re-export CacheModule under the alias used by health.module and others.
export { CacheModule } from './cache.module';
