import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookIpGuard } from './webhook-ip.guard';
import { WebhookJanitorService } from '../common/webhook-janitor.service';

@Module({
  imports: [ConfigModule],
  providers: [WebhooksService, WebhookIpGuard, WebhookJanitorService],
  controllers: [WebhooksController],
  exports: [WebhooksService, WebhookJanitorService],
})
export class WebhooksModule {}
