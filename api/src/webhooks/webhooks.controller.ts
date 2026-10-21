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
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import type {
  Webhook,
  WebhookDelivery,
  WebhookRegistrationResult,
  WebhookMetrics,
} from './webhooks.service';
import { WebhooksService } from './webhooks.service';
import { WebhookIpAllowlistGuard } from './webhook-ip-allowlist.guard';
import { AdminGuard } from '../auth/admin.guard';
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
    description:
      'Invalid or SSRF-blocked URL. Failures include: unparseable URL, non-https ' +
      'scheme in production, disallowed scheme, or a hostname resolving to a ' +
      'private/loopback/link-local or cloud-metadata address.',
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

  @ApiOperation({
    summary: 'List webhook deliveries with optional filters and pagination',
  })
  @ApiQuery({
    name: 'webhookId',
    required: false,
    description: 'Filter deliveries by webhook ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by delivery status (e.g. success, failed, pending)',
  })
  @ApiQuery({
    name: 'eventType',
    required: false,
    description: 'Filter by event type',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO 8601 lower bound (inclusive) on delivery timestamp',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO 8601 upper bound (inclusive) on delivery timestamp',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (1-based, defaults to 1)',
  })
  @ApiQuery({
    name: 'pageSize',
    required: false,
    description: 'Page size (defaults to 20, max 100)',
  })
  @ApiResponse({
    status: 200,
    description:
      'Paginated list of deliveries. Each outbound delivery request is signed ' +
      'with HMAC-SHA256 and carries the `x-carbonchain-signature: sha256=<hex>` ' +
      'and `x-carbonchain-timestamp` headers; `x-carbonchain-retry` indicates the ' +
      'attempt number (1 on first attempt, 2+ on retries).',
  })
  @ApiResponse({ status: 400, description: 'Invalid query parameters' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @Get('deliveries')
  async getFilteredDeliveries(@Query() query: Record<string, unknown>): Promise<{
    data: WebhookDelivery[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const filters: {
      webhookId?: string;
      status?: string;
      eventType?: string;
      from?: Date;
      to?: Date;
      page?: number;
      pageSize?: number;
    } = {};

    if (query.webhookId !== undefined && query.webhookId !== '') {
      if (typeof query.webhookId !== 'string') {
        throw new BadRequestException('webhookId must be a string');
      }
      filters.webhookId = query.webhookId;
    }

    if (query.status !== undefined && query.status !== '') {
      if (typeof query.status !== 'string') {
        throw new BadRequestException('status must be a string');
      }
      filters.status = query.status;
    }

    if (query.eventType !== undefined && query.eventType !== '') {
      if (typeof query.eventType !== 'string') {
        throw new BadRequestException('eventType must be a string');
      }
      filters.eventType = query.eventType;
    }

    if (query.from !== undefined && query.from !== '') {
      if (typeof query.from !== 'string') {
        throw new BadRequestException('from must be an ISO 8601 date string');
      }
      const from = new Date(query.from);
      if (Number.isNaN(from.getTime())) {
        throw new BadRequestException('from must be a valid ISO 8601 date');
      }
      filters.from = from;
    }

    if (query.to !== undefined && query.to !== '') {
      if (typeof query.to !== 'string') {
        throw new BadRequestException('to must be an ISO 8601 date string');
      }
      const to = new Date(query.to);
      if (Number.isNaN(to.getTime())) {
        throw new BadRequestException('to must be a valid ISO 8601 date');
      }
      filters.to = to;
    }

    if (filters.from && filters.to && filters.from > filters.to) {
      throw new BadRequestException('from must be before or equal to to');
    }

    if (query.page !== undefined && query.page !== '') {
      const page = Number(query.page);
      if (!Number.isInteger(page) || page < 1) {
        throw new BadRequestException('page must be a positive integer');
      }
      filters.page = page;
    }

    if (query.pageSize !== undefined && query.pageSize !== '') {
      const pageSize = Number(query.pageSize);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        throw new BadRequestException(
          'pageSize must be an integer between 1 and 100',
        );
      }
      filters.pageSize = pageSize;
    }

    return this.webhooksService.getDeliveries(filters);
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
      'Failed deliveries requeued for retry; deactivated webhooks reactivated. ' +
      'Retried deliveries are re-signed with HMAC-SHA256 (`x-carbonchain-signature: ` +
      'sha256=<hex>`) and carry `x-carbonchain-timestamp` and `x-carbonchain-retry` headers.',
  })
  @ApiResponse({ status: 400, description: 'Bad request or invalid webhook ID' })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized or client IP not in allowlist',
  })
  @ApiResponse({ status: 403, description: 'Admin privileges required' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
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
