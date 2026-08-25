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

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    TypeOrmModule.forFeature([VerifierEntity]),
  ],
  controllers: [VerifiersController],
  providers: [VerifiersService, VerifierRepository, verifierRepositoryProvider],
  exports: [VerifiersService],
})
export class VerifiersModule {}
