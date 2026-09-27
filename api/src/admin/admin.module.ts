import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { VerifiersModule } from '../verifiers/verifiers.module';
import { RetirementModule } from '../retirement/retirement.module';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [ConfigModule, StellarModule, VerifiersModule, RetirementModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
