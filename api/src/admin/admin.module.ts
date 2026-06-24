import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CreditsModule } from '../credits/credits.module';
import { VerifiersModule } from '../verifiers/verifiers.module';
import { StellarModule } from '../stellar/stellar.module';
import { CacheModule } from '../common/cache.module';

@Module({
  imports: [CreditsModule, VerifiersModule, StellarModule, CacheModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
