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
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import {
  WebhookIpAllowlistService,
  AllowlistEntry,
} from './webhook-ip-allowlist.service';

/**
 * WebhookIpAllowlistController — Admin endpoints for managing the webhook
 * IP allowlist (Issue #1170).
 *
 * All endpoints require JWT auth + admin guard.
 */
@ApiTags('oracle')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('oracle/webhook/allowlist')
export class WebhookIpAllowlistController {
  constructor(private readonly allowlistService: WebhookIpAllowlistService) {}

  @ApiOperation({
    summary: 'Add an IP/CIDR to the webhook allowlist (Issue #1170)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        cidr: {
          type: 'string',
          description:
            'IP address or CIDR range to allow (e.g. "10.0.0.1" or "192.168.0.0/24")',
          example: '192.168.0.0/24',
        },
      },
      required: ['cidr'],
    },
  })
  @ApiResponse({ status: 201, description: 'IP/CIDR added to the allowlist' })
  @ApiResponse({ status: 400, description: 'Invalid IP/CIDR format' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin only' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async addEntry(@Body() body: { cidr: string }): Promise<AllowlistEntry> {
    if (!body?.cidr) {
      throw new BadRequestException('cidr is required');
    }
    return this.allowlistService.addEntry(body.cidr);
  }

  @ApiOperation({
    summary: 'List all webhook IP allowlist entries (Issue #1170)',
  })
  @ApiResponse({
    status: 200,
    description: 'List of allowlist entries',
    type: Array,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin only' })
  @Get()
  async listEntries(): Promise<AllowlistEntry[]> {
    return this.allowlistService.listEntries();
  }

  @ApiOperation({
    summary: 'Remove an IP/CIDR from the webhook allowlist (Issue #1170)',
  })
  @ApiParam({
    name: 'cidr',
    description: 'URL-encoded IP or CIDR to remove',
    example: '192.168.0.0%2F24',
  })
  @ApiResponse({
    status: 200,
    description: 'IP/CIDR removed from the allowlist',
  })
  @ApiResponse({ status: 404, description: 'Entry not found in the allowlist' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Admin only' })
  @Delete(':cidr')
  @HttpCode(HttpStatus.OK)
  async removeEntry(
    @Param('cidr') cidr: string,
  ): Promise<{ success: boolean }> {
    const decoded = decodeURIComponent(cidr);
    const removed = await this.allowlistService.removeEntry(decoded);
    if (!removed) {
      throw new NotFoundException(
        `IP/CIDR "${decoded}" not found in webhook allowlist`,
      );
    }
    return { success: true };
  }
}
