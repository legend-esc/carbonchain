import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { VerifiersService } from './verifiers.service';
import { VerifiersController } from './verifiers.controller';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
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

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    TypeOrmModule.forFeature([VerifierEntity, VerifierApplicationEntity]),
    AuthModule,
  ],
  controllers: [VerifiersController, DisputesController],
  providers: [
    VerifiersService,
    VerifierRepository,
    verifierRepositoryProvider,
    VerifierApplicationRepository,
    verifierApplicationRepositoryProvider,
    DisputesService,
  ],
  exports: [VerifiersService],
})
export class VerifiersModule {}
