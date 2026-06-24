import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitter } from 'events';
import { RetirementService, EVENT_EMITTER } from './retirement.service';
import { RetirementController } from './retirement.controller';
import { CertificateService } from './certificate.service';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';
import {
  InMemoryRetirementRepository,
  RETIREMENT_REPOSITORY,
} from './retirement.repository';

@Module({
  imports: [ConfigModule, StellarModule, AuthModule],
  controllers: [RetirementController],
  providers: [
    RetirementService,
    CertificateService,
    { provide: RETIREMENT_REPOSITORY, useClass: InMemoryRetirementRepository },
    {
      provide: EVENT_EMITTER,
      useValue: new EventEmitter(),
    },
  ],
  exports: [RetirementService],
})
export class RetirementModule {}
