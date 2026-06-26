import { Controller, Post, Get, Delete, Body, Param, UseGuards } from '@nestjs/common';
import type { Webhook } from './webhooks.service';
import { WebhooksService } from './webhooks.service';
import { WebhookIpAllowlistGuard } from './webhook-ip-allowlist.guard';

@Controller('webhooks')
@UseGuards(WebhookIpAllowlistGuard)
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @Post()
  registerWebhook(@Body() body: { url: string; events: string[] }): Webhook {
    return this.webhooksService.registerWebhook(body.url, body.events);
  }

  @Get()
  getWebhooks(): Webhook[] {
    return this.webhooksService.getWebhooks();
  }

  @Get(':id')
  getWebhook(@Param('id') id: string): Webhook | undefined {
    return this.webhooksService.getWebhook(id);
  }

  @Delete(':id')
  deleteWebhook(@Param('id') id: string): { success: boolean } {
    const success = this.webhooksService.deleteWebhook(id);
    return { success };
  }
}
