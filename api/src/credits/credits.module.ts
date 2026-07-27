import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CreditsService } from './credits.service';
import { CreditsController } from './credits.controller';
import { StellarModule } from '../stellar/stellar.module';
import { AuthModule } from '../auth/auth.module';
import {
  InMemoryCreditRepository,
  CREDIT_REPOSITORY,
} from './credit.repository';
import { NonceService } from '../common/nonce.service';

@Module({
  imports: [ConfigModule, StellarModule, AuthModule],
  controllers: [CreditsController],
  providers: [
    CreditsService,
    NonceService,
    { provide: CREDIT_REPOSITORY, useClass: InMemoryCreditRepository },
  ],
  exports: [CreditsService],
})
export class CreditsModule implements OnApplicationBootstrap {
  constructor(private readonly nonceService: NonceService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.nonceService.connect();
  }
}
