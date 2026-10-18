import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookIpGuard } from './webhook-ip.guard';
import { WebhookIpAllowlistGuard } from './webhook-ip-allowlist.guard';
import { WebhookIpAllowlistService } from './webhook-ip-allowlist.service';
import { WebhookIpAllowlistController } from './webhook-ip-allowlist.controller';
import { WebhookJanitorService } from '../common/webhook-janitor.service';
import { AuthModule } from '../auth/auth.module';
import { StellarModule } from '../stellar/stellar.module';
import { AdminGuard } from '../admin/admin.guard';

/**
 * WebhooksModule
 *
 * Fixes #911 — imports TypeOrmModule so that @InjectDataSource() in
 * WebhooksService resolves to the shared Postgres DataSource configured in
 * AppModule.  The service no longer depends on the in-memory Map + Redis
 * TTL cache for its registry or delivery queue.
 *
 * Issue #1170 — Registers WebhookIpAllowlistService and the admin
 * WebhookIpAllowlistController for dynamic IP allowlist management.
 * Imports AuthModule for JwtAuthGuard and StellarModule for AdminGuard's
 * on-chain admin verification.
 */
@Module({
  imports: [
    ConfigModule,
    // Required for @InjectDataSource() in WebhooksService (#911)
    TypeOrmModule.forFeature([]),
    // Issue #1170 — JwtAuthGuard for the admin allowlist controller
    AuthModule,
    // Issue #1170 — AdminGuard needs StellarService for on-chain admin verification
    StellarModule,
  ],
  providers: [
    WebhooksService,
    WebhookJanitorService,
    WebhookIpGuard,
    WebhookIpAllowlistGuard,
    WebhookIpAllowlistService,
    // Issue #1170 — AdminGuard needed by WebhookIpAllowlistController
    AdminGuard,
  ],
  controllers: [WebhooksController, WebhookIpAllowlistController],
  exports: [
    WebhooksService,
    WebhookJanitorService,
    WebhookIpAllowlistService,
  ],
})
export class WebhooksModule {}
