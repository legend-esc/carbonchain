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

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    TypeOrmModule.forFeature([VerifierEntity, VerifierApplicationEntity]),
    AuthModule,
  ],
  controllers: [VerifiersController],
  providers: [
    VerifiersService,
    VerifierRepository,
    verifierRepositoryProvider,
    VerifierApplicationRepository,
    verifierApplicationRepositoryProvider,
  ],
  exports: [VerifiersService],
})
export class VerifiersModule {}
