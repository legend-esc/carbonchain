/**
 * #1303 — ReconciliationModule
 *
 * Registers the nightly credit reconciliation worker.
 * Requires ScheduleModule.forRoot() to be registered at the app level
 * (already present in AppModule) and TypeORM entity access for CreditEntity.
 *
 * WebhooksModule is imported so ReconciliationService can fire drift-alert
 * webhooks when discrepancies are detected.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReconciliationService } from './reconciliation.service';
import { CreditEntity } from '../credits/credit.entity';
import { StellarModule } from '../stellar/stellar.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    WebhooksModule,
    TypeOrmModule.forFeature([CreditEntity]),
  ],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
