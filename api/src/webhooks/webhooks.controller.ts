import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import type {
  Webhook,
  WebhookDelivery,
  WebhookRegistrationResult,
} from './webhooks.service';
import { WebhooksService } from './webhooks.service';
import { WebhookIpAllowlistGuard } from './webhook-ip-allowlist.guard';
import {
  WebhookJanitorService,
  JanitorStats,
} from '../common/webhook-janitor.service';

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(WebhookIpAllowlistGuard)
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  /**
   * Register a new webhook endpoint.
   *
   * #912 — URL is validated for SSRF (scheme + DNS) before the record is created.
   * #913 — A per-webhook signing secret is generated and returned exactly once
   *         in the `secret` field.  Callers must store it; it is not retrievable
   *         via any subsequent GET endpoint.
   */
  @ApiOperation({ summary: 'Register a new webhook' })
  @ApiResponse({
    status: 201,
    description:
      'Webhook registered. The `secret` field is returned only in this response.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or SSRF-blocked URL',
  })
  @Post()
  async registerWebhook(
    @Body() body: { url: string; events: string[] },
  ): Promise<WebhookRegistrationResult> {
    return this.webhooksService.registerWebhook(body.url, body.events);
  }

  @ApiOperation({ summary: 'List all registered webhooks' })
  @ApiResponse({ status: 200, description: 'List of webhooks' })
  @Get()
  async getWebhooks(): Promise<Webhook[]> {
    return this.webhooksService.getWebhooks();
  }

  @ApiOperation({ summary: 'Get webhook by ID' })
  @ApiResponse({ status: 200, description: 'Webhook details' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @Get(':id')
  async getWebhook(@Param('id') id: string): Promise<Webhook> {
    const webhook = await this.webhooksService.getWebhook(id);
    if (!webhook) {
      throw new NotFoundException(`Webhook ${id} not found`);
    }
    return webhook;
  }

  @ApiOperation({ summary: 'Delete a webhook' })
  @ApiResponse({ status: 200, description: 'Webhook deleted' })
  @Delete(':id')
  async deleteWebhook(@Param('id') id: string): Promise<{ success: boolean }> {
    const success = await this.webhooksService.deleteWebhook(id);
    return { success };
  }

  @ApiOperation({ summary: 'List deliveries, optionally filtered by webhook' })
  @ApiResponse({ status: 200, description: 'List of deliveries' })
  @Get(':id/deliveries')
  async getDeliveries(@Param('id') id: string): Promise<WebhookDelivery[]> {
    return this.webhooksService.getDeliveries(id);
  }
}
