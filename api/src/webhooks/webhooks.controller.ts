import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
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
import { AdminGuard } from '../admin/admin.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @Post()
  async registerWebhook(
    @Body() body: { url: string; events: string[] },
  ): Promise<WebhookRegistrationResult> {
    return this.webhooksService.registerWebhook(body.url, body.events);
  }

  @ApiOperation({ summary: 'List all registered webhooks' })
  @ApiResponse({ status: 200, description: 'List of webhooks' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @Get()
  async getWebhooks(): Promise<Webhook[]> {
    return this.webhooksService.getWebhooks();
  }

  @ApiOperation({ summary: 'Get webhook by ID' })
  @ApiResponse({ status: 200, description: 'Webhook details' })
  @ApiResponse({ status: 400, description: 'Bad request or invalid webhook ID' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
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
  @ApiResponse({ status: 400, description: 'Bad request or invalid webhook ID' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @Delete(':id')
  async deleteWebhook(@Param('id') id: string): Promise<{ success: boolean }> {
    const success = await this.webhooksService.deleteWebhook(id);
    return { success };
  }

  /**
   * #1183 — Rotate the signing secret for a webhook.
   *
   * A fresh 32-byte secret is generated and persisted; the previous secret is
   * invalidated immediately.  The new secret is returned exactly once in this
   * response and is not retrievable via any subsequent GET endpoint.
   */
  @ApiOperation({ summary: 'Rotate a webhook signing secret (admin)' })
  @ApiResponse({
    status: 201,
    description:
      'Secret rotated. The new `secret` is returned only in this response; the old secret is invalidated immediately.',
  })
  @ApiResponse({ status: 400, description: 'Bad request or invalid webhook ID' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post(':id/rotate-secret')
  async rotateWebhookSecret(
    @Param('id') id: string,
  ): Promise<WebhookRegistrationResult> {
    const result = await this.webhooksService.rotateWebhookSecret(id);
    if (!result) {
      throw new NotFoundException(`Webhook ${id} not found`);
    }
    return result;
  }

  /**
   * #1185 — Replay failed (dead-lettered) webhook deliveries.
   *
   * Resets failed deliveries back to `pending` with `next_retry_at = NOW()`
   * and reactivates the owning webhook if it was deactivated.  Can be scoped
   * to a single webhook via `webhookId` (body or query) or run globally.
   */
  @ApiOperation({
    summary: 'Retry failed webhook deliveries from the DLQ (admin)',
  })
  @ApiResponse({
    status: 201,
    description:
      'Failed deliveries requeued for retry; deactivated webhooks reactivated.',
  })
  @ApiResponse({ status: 400, description: 'Bad request or invalid webhook ID' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('retry-failed')
  async retryFailedDeliveries(
    @Body() body: { webhookId?: string } = {},
    @Query('webhookId') queryWebhookId?: string,
  ): Promise<{ retried: number; webhooksReactivated: number }> {
    const webhookId = body?.webhookId ?? queryWebhookId;
    return this.webhooksService.retryFailedDeliveries(webhookId);
  }

  @ApiOperation({ summary: 'List deliveries, optionally filtered by webhook' })
  @ApiResponse({ status: 200, description: 'List of deliveries' })
  @ApiResponse({ status: 400, description: 'Bad request or invalid webhook ID' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  @Get(':id/deliveries')
  async getDeliveries(@Param('id') id: string): Promise<WebhookDelivery[]> {
    return this.webhooksService.getDeliveries(id);
  }
}
