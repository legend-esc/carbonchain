import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  UseGuards,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ComplianceService, KycStatus, KycRecord } from './compliance.service';
import { JwtAuthGuard } from './jwt-auth.guard';

const VALID_STATUSES: KycStatus[] = ['PENDING', 'VERIFIED', 'REJECTED'];
const VALID_TIERS = [1, 2, 3] as const;

@ApiTags('compliance')
@Controller('compliance')
export class ComplianceController {
  constructor(
    private readonly complianceService: ComplianceService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * POST /compliance/kyc-webhook
   *
   * Receives a KYC status update from the upstream compliance provider.
   * Validates the HMAC-SHA256 signature when present, then stores the record.
   *
   * Note: To receive the raw body for HMAC verification, configure a
   * RawBodyMiddleware or use NestJS rawBody: true option in main.ts so that
   * `rawBody` is populated on the request. The @Body() Buffer approach requires
   * the NestJS app to be bootstrapped with `rawBody: true`.
   */
  @ApiOperation({ summary: 'Receive KYC status webhook from compliance provider' })
  @ApiResponse({ status: 201, description: 'KYC record updated' })
  @ApiResponse({ status: 400, description: 'Invalid payload' })
  @ApiResponse({ status: 401, description: 'Invalid webhook signature' })
  @Post('kyc-webhook')
  async receiveKycWebhook(
    @Body() rawBody: Buffer,
    @Headers('x-signature-256') signature: string,
  ): Promise<{ success: true; record: KycRecord }> {
    const secret = this.configService.get<string>('KYC_WEBHOOK_SECRET', '');

    if (signature) {
      const valid = this.complianceService.verifyWebhookSignature(
        rawBody,
        signature,
        secret,
      );
      if (!valid) {
        throw new UnauthorizedException('Invalid webhook signature');
      }
    }

    let parsed: { userId?: unknown; status?: unknown; tier?: unknown };
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as {
        userId?: unknown;
        status?: unknown;
        tier?: unknown;
      };
    } catch {
      throw new BadRequestException('Request body must be valid JSON');
    }

    const { userId, status, tier } = parsed;

    if (typeof userId !== 'string' || !userId) {
      throw new BadRequestException('userId is required and must be a string');
    }

    if (!VALID_STATUSES.includes(status as KycStatus)) {
      throw new BadRequestException(
        `status must be one of: ${VALID_STATUSES.join(', ')}`,
      );
    }

    const tierNum = Number(tier);
    if (!VALID_TIERS.includes(tierNum as 1 | 2 | 3)) {
      throw new BadRequestException('tier must be 1, 2, or 3');
    }

    const record = await this.complianceService.updateKycStatus(
      userId,
      status as KycStatus,
      tierNum as 1 | 2 | 3,
    );

    return { success: true, record };
  }

  /**
   * GET /compliance/kyc/:userId
   *
   * Returns the KYC record for a user. Requires JWT authentication.
   */
  @ApiOperation({ summary: 'Get KYC record for a user' })
  @ApiResponse({ status: 200, description: 'KYC record' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'KYC record not found' })
  @UseGuards(JwtAuthGuard)
  @Get('kyc/:userId')
  async getKycRecord(
    @Param('userId') userId: string,
  ): Promise<KycRecord> {
    const record = await this.complianceService.getKycRecord(userId);
    if (!record) {
      throw new NotFoundException(`KYC record not found for user ${userId}`);
    }
    return record;
  }
}
