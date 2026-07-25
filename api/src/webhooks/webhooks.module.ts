import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';
import { WebhooksController } from './webhooks.controller';
import { WebhookIpGuard } from './webhook-ip.guard';

@Module({
  imports: [ConfigModule],
  providers: [WebhooksService, WebhookIpGuard],
  controllers: [WebhooksController],
  exports: [WebhooksService],
})
export class WebhooksModule {}
