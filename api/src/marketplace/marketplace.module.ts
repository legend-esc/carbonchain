import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceController } from './marketplace.controller';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';
import { CreditEntity } from '../credits/credit.entity';
import { RetirementEntity } from '../retirement/retirement.entity';
import { WashTradingDetectorService } from './wash-trading-detector.service';

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    AuthModule,
    // Issue #1321 — provide TypeORM repositories needed by WashTradingDetectorService.
    TypeOrmModule.forFeature([CreditEntity, RetirementEntity]),
    // Note: ScheduleModule.forRoot() is already registered globally in AppModule.
    // Registering it a second time here would cause scheduler conflicts.
  ],
  controllers: [MarketplaceController],
  providers: [MarketplaceService, WashTradingDetectorService],
  exports: [MarketplaceService, WashTradingDetectorService],
})
export class MarketplaceModule {}
