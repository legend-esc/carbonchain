/**
 * #927 — ReconciliationModule
 *
 * Registers the nightly credit reconciliation worker.
 * Requires ScheduleModule.forRoot() to be registered at the app level
 * (already present in AppModule) and TypeORM entity access for CreditEntity.
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReconciliationService } from './reconciliation.service';
import { CreditEntity } from '../credits/credit.entity';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    TypeOrmModule.forFeature([CreditEntity]),
  ],
  providers: [ReconciliationService],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}
