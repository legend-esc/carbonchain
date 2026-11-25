import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { ReportsService } from './reports.service';
import { AdminAuditEntity } from './admin-audit.entity';
import { CreditsModule } from '../credits/credits.module';
import { VerifiersModule } from '../verifiers/verifiers.module';
import { AuthModule } from '../auth/auth.module';
import { RetirementModule } from '../retirement/retirement.module';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AdminAuditEntity]),
    CreditsModule,
    VerifiersModule,
    AuthModule,
    RetirementModule,
    StellarModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard, ReportsService],
  exports: [AdminService],
})
export class AdminModule {}
