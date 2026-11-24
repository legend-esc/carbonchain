import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VerifiersService } from './verifiers.service';
import { VerifiersController } from './verifiers.controller';
import { StellarModule } from '../stellar/stellar.module';
import { VerifierEntity } from './verifier.entity';
import {
  VerifierRepository,
  verifierRepositoryProvider,
} from './verifier.repository';
import { AuthModule } from '../auth/auth.module';
import { VerifierApplicationEntity } from './verifier-application.entity';
import {
  VerifierApplicationRepository,
  verifierApplicationRepositoryProvider,
} from './verifier-application.repository';
// #1305 — SLA / turnaround metrics service.
import { VerifierMetricsService } from './verifier-metrics.service';
import { EventEntity } from '../events/event.entity';

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    TypeOrmModule.forFeature([VerifierEntity, VerifierApplicationEntity, EventEntity]),
    AuthModule,
  ],
  controllers: [VerifiersController],
  providers: [
    VerifiersService,
    VerifierRepository,
    verifierRepositoryProvider,
    VerifierApplicationRepository,
    verifierApplicationRepositoryProvider,
    // #1305
    VerifierMetricsService,
  ],
  exports: [VerifiersService, VerifierMetricsService],
})
export class VerifiersModule {}
