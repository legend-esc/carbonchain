import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter } from 'events';
import { RetirementService, EVENT_EMITTER } from './retirement.service';
import { RetirementController } from './retirement.controller';
import { CreditRetirementController } from './credit-retirement.controller';
import { CertificateService } from './certificate.service';
import { CertHashReconciler } from './cert-hash-reconciler.service';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import {
  InMemoryRetirementRepository,
  RETIREMENT_REPOSITORY,
} from './retirement.repository';

@Module({
  imports: [ConfigModule, StellarModule, AuthModule, CreditsModule],
  controllers: [RetirementController, CreditRetirementController],
  providers: [
    RetirementService,
    CertificateService,
    // #921 — bounded-retry cert hash reconciler
    CertHashReconciler,
    { provide: RETIREMENT_REPOSITORY, useClass: InMemoryRetirementRepository },
    {
      provide: EVENT_EMITTER,
      useValue: new EventEmitter(),
    },
  ],
  exports: [RetirementService, CertHashReconciler],
})
export class RetirementModule {}
