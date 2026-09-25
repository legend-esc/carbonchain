import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CreditsService } from './credits.service';
import { CreditsController } from './credits.controller';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';
import {
  InMemoryCreditRepository,
  CREDIT_REPOSITORY,
} from './credit.repository';
import { RetirementModule } from '../retirement/retirement.module';

@Module({
  imports: [ConfigModule, StellarModule, AuthModule, RetirementModule],
  controllers: [CreditsController],
  providers: [
    CreditsService,
    { provide: CREDIT_REPOSITORY, useClass: InMemoryCreditRepository },
  ],
  exports: [CreditsService],
})
export class CreditsModule {}
