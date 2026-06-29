import { Controller, Post, Get, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type { Webhook } from './webhooks.service';
import { WebhooksService } from './webhooks.service';
import { WebhookIpAllowlistGuard } from './webhook-ip-allowlist.guard';

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(WebhookIpAllowlistGuard)
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

  @ApiOperation({ summary: 'Register a new webhook' })
  @ApiResponse({ status: 201, description: 'Webhook registered' })
  @Post()
  registerWebhook(@Body() body: { url: string; events: string[] }): Webhook {
    return this.webhooksService.registerWebhook(body.url, body.events);
  }

  @ApiOperation({ summary: 'List all registered webhooks' })
  @ApiResponse({ status: 200, description: 'List of webhooks' })
  @Get()
  getWebhooks(): Webhook[] {
    return this.webhooksService.getWebhooks();
  }

  @ApiOperation({ summary: 'Get webhook by ID' })
  @ApiResponse({ status: 200, description: 'Webhook details' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @Get(':id')
  getWebhook(@Param('id') id: string): Webhook | undefined {
    return this.webhooksService.getWebhook(id);
  }

  @ApiOperation({ summary: 'Delete a webhook' })
  @ApiResponse({ status: 200, description: 'Webhook deleted' })
  @Delete(':id')
  deleteWebhook(@Param('id') id: string): { success: boolean } {
    const success = this.webhooksService.deleteWebhook(id);
    return { success };
  }
}
