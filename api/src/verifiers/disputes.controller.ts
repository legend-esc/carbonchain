import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';
import { DisputesService, DisputeRecord } from './disputes.service';

@ApiTags('disputes')
@ApiBearerAuth()
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  /**
   * POST /disputes
   *
   * File a new dispute against a credit.  The calling verifier's Stellar
   * address is extracted from the JWT `sub` claim.
   *
   * Body: { creditId, reason, evidenceUrls, bondTxHash }
   */
  @ApiOperation({ summary: 'File a dispute for a credit' })
  @ApiResponse({ status: 201, description: 'Dispute filed successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post()
  fileDispute(
    @Body()
    body: {
      creditId: string;
      reason: string;
      evidenceUrls: string[];
      bondTxHash: string;
    },
    @Request() req: { user: { sub: string } },
  ): DisputeRecord {
    const verifierAddress = req.user.sub;
    return this.disputesService.fileDispute(
      body.creditId,
      verifierAddress,
      body.reason,
      body.evidenceUrls,
      body.bondTxHash,
    );
  }

  /**
   * GET /disputes
   *
   * List all disputes.  Optional `?status=` query parameter filters by status
   * (Pending | Resolved | Rejected).
   *
   * Requires JWT + AdminGuard — only admins may view the full dispute list.
   */
  @ApiOperation({ summary: 'List all disputes (admin)' })
  @ApiResponse({ status: 200, description: 'List of disputes' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get()
  listDisputes(
    @Query('status') status?: string,
  ): DisputeRecord[] {
    return this.disputesService.listDisputes(status);
  }

  /**
   * PATCH /disputes/:id/resolve
   *
   * Resolve or reject a pending dispute.
   *
   * Body: { resolution: string, status: 'Resolved' | 'Rejected' }
   *
   * Requires JWT + AdminGuard — only admins may resolve disputes.
   */
  @ApiOperation({ summary: 'Resolve or reject a dispute (admin)' })
  @ApiResponse({ status: 200, description: 'Dispute updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiResponse({ status: 404, description: 'Dispute not found' })
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Patch(':id/resolve')
  @HttpCode(200)
  resolveDispute(
    @Param('id') id: string,
    @Body() body: { resolution: string; status: 'Resolved' | 'Rejected' },
  ): DisputeRecord {
    return this.disputesService.resolveDispute(id, body.resolution, body.status);
  }
}
