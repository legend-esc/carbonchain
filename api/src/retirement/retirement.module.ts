import { Module, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitter } from 'events';
import { RetirementService, EVENT_EMITTER } from './retirement.service';
import { RetirementController } from './retirement.controller';
import { CreditRetirementController } from './credit-retirement.controller';
import { CertificatesController } from './certificates.controller';
import { BadgeController } from './badge.controller';
import { CertificateService } from './certificate.service';
import { CalculatorService } from './calculator.service';
import { CertHashReconciler } from './cert-hash-reconciler.service';
import { RetireTxService } from './retire-tx.service';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';
import { CreditsModule } from '../credits/credits.module';
import {
  InMemoryRetirementRepository,
  RETIREMENT_REPOSITORY,
} from './retirement.repository';
import { NonceService } from '../common/nonce.service';

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    AuthModule,
    // Required for @InjectDataSource() used by OpenSearchService fallback.
    TypeOrmModule.forFeature([]),
    forwardRef(() => CreditsModule),
  ],
  controllers: [
    RetirementController,
    CreditRetirementController,
    CertificatesController,
    // #1306 — SVG badge endpoint
    BadgeController,
  ],
  providers: [
    RetirementService,
    CertificateService,
    CalculatorService,
    CertHashReconciler,
    RetireTxService,
    NonceService,
    { provide: RETIREMENT_REPOSITORY, useClass: InMemoryRetirementRepository },
    {
      provide: EVENT_EMITTER,
      useValue: new EventEmitter(),
    },
  ],
  exports: [RetirementService, CertHashReconciler],
})
export class RetirementModule implements OnApplicationBootstrap {
  constructor(private readonly nonceService: NonceService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.nonceService.connect();
  }
}
