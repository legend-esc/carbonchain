import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookIpGuard } from './webhook-ip.guard';
import { WebhookIpAllowlistGuard } from './webhook-ip-allowlist.guard';

/**
 * WebhooksModule
 *
 * Fixes #911 — imports TypeOrmModule so that @InjectDataSource() in
 * WebhooksService resolves to the shared Postgres DataSource configured in
 * AppModule.  The service no longer depends on the in-memory Map + Redis
 * TTL cache for its registry or delivery queue.
 */
@Module({
  imports: [
    ConfigModule,
    // Required for @InjectDataSource() in WebhooksService (#911)
    TypeOrmModule.forFeature([]),
  ],
  providers: [WebhooksService, WebhookIpGuard, WebhookIpAllowlistGuard],
  controllers: [WebhooksController],
  exports: [WebhooksService],
})
export class WebhooksModule {}
