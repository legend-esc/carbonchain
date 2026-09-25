import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import type { Webhook } from './webhooks.service';
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
  constructor(
    private webhooksService: WebhooksService,
    private janitorService: WebhookJanitorService,
  ) {}

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

  // ── #935: Delivery GC janitor endpoints ─────────────────────────────────

  /**
   * GET /webhooks/retention
   * Returns the current janitor stats: retention window, last purge count,
   * last run timestamp, and the delivery-id watermark.
   */
  @ApiOperation({ summary: 'Get webhook delivery retention stats (janitor)' })
  @ApiResponse({ status: 200, description: 'Janitor stats' })
  @Get('retention')
  getRetentionStats(): JanitorStats {
    return this.janitorService.getStats();
  }

  /**
   * POST /webhooks/retention
   * Update the retention window without restarting the service.
   * Body: { days: number }
   */
  @ApiOperation({
    summary: 'Update webhook delivery retention window (janitor)',
  })
  @ApiBody({ schema: { properties: { days: { type: 'number', minimum: 1 } } } })
  @ApiResponse({ status: 200, description: 'Retention updated' })
  @Post('retention')
  @HttpCode(HttpStatus.OK)
  setRetentionDays(@Body() body: { days: number }): { retentionDays: number } {
    if (!body?.days || body.days <= 0 || !Number.isFinite(body.days)) {
      throw new BadRequestException('days must be a positive finite number');
    }
    this.janitorService.setRetentionDays(Math.floor(body.days));
    return { retentionDays: Math.floor(body.days) };
  }

  /**
   * POST /webhooks/retention/purge
   * Trigger an immediate garbage-collection run outside the scheduled interval.
   * Returns the number of delivery records deleted.
   */
  @ApiOperation({ summary: 'Trigger immediate delivery GC purge' })
  @ApiResponse({ status: 200, description: 'Purge result' })
  @Post('retention/purge')
  @HttpCode(HttpStatus.OK)
  async triggerPurge(): Promise<{ deleted: number }> {
    const deleted = await this.janitorService.purgeOld();
    return { deleted };
  }
}
