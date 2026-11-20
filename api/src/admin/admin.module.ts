import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { ReportsService } from './reports.service';
import { CreditsModule } from '../credits/credits.module';
import { VerifiersModule } from '../verifiers/verifiers.module';
import { RetirementModule } from '../retirement/retirement.module';

@Module({
  imports: [CreditsModule, VerifiersModule, RetirementModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, ReportsService],
})
export class AdminModule {}
