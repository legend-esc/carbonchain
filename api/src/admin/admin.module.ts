import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminGuard } from './admin.guard';
import { CreditsModule } from '../credits/credits.module';
import { VerifiersModule } from '../verifiers/verifiers.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [CreditsModule, VerifiersModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
