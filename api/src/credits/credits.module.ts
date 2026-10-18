import { Module, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
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
import { ETagCacheInterceptor } from './etag-cache.interceptor';
import { RetirementModule } from '../retirement/retirement.module';

@Module({
  imports: [
    ConfigModule,
    StellarModule,
    AuthModule,
    // RetirementModule depends on CreditsModule (credits repo/service) and vice
    // versa (CreditsController exposes a retire proxy), so the cycle is broken
    // with forwardRef on both sides.
    forwardRef(() => RetirementModule),
  ],
  controllers: [CreditsController],
  providers: [
    CreditsService,
    NonceService,
    { provide: CREDIT_REPOSITORY, useClass: InMemoryCreditRepository },
    ETagCacheInterceptor,
  ],
  exports: [CreditsService, CREDIT_REPOSITORY],
})
export class CreditsModule implements OnApplicationBootstrap {
  constructor(private readonly nonceService: NonceService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.nonceService.connect();
  }
}
