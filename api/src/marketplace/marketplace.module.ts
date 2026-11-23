import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MarketplaceService } from './marketplace.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceGateway } from './marketplace.gateway';
import { StaleOfferSyncTask } from './stale-offer-sync.task';
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
    // EventEmitterModule required by MarketplaceGateway.
    EventEmitterModule.forRoot(),
    // Note: ScheduleModule.forRoot() is already registered globally in AppModule.
    // Registering it a second time here would cause scheduler conflicts.
  ],
  controllers: [MarketplaceController],
  providers: [
    MarketplaceService,
    WashTradingDetectorService,
    // #1308 — WebSocket gateway (broadcasts offer.expired events).
    MarketplaceGateway,
    // #1308 — Cron task that marks stale offers EXPIRED every 10 minutes.
    StaleOfferSyncTask,
  ],
  exports: [MarketplaceService, WashTradingDetectorService, MarketplaceGateway],
})
export class MarketplaceModule {}
