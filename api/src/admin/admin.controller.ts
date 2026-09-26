import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminGuard } from './admin.guard';
import { AdminService, AdminStats, AuditContext } from './admin.service';
import type { VerifierCapabilities, AuditQueryOptions } from './admin.service';
import { AdminAuditEntity } from './admin-audit.entity';
import { CreditStatus } from '../../../shared';

/** Pull IP + UA + request-id from the Express request for audit context. */
function buildAuditCtx(
  req: {
    user?: { account?: string; publicKey?: string };
    headers?: Record<string, string | string[] | undefined>;
    ip?: string;
    socket?: { remoteAddress?: string };
  },
): AuditContext {
  const actor =
    (req.user as { account?: string; publicKey?: string } | undefined)
      ?.account ??
    (req.user as { account?: string; publicKey?: string } | undefined)
      ?.publicKey ??
    'unknown';

  const rawIp =
    (req.headers?.['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    req.ip ??
    req.socket?.remoteAddress ??
    null;

  return {
    actor,
    ipAddress: rawIp ?? undefined,
    userAgent: (req.headers?.['user-agent'] as string | undefined) ?? undefined,
    requestId:
      (req.headers?.['x-request-id'] as string | undefined) ?? undefined,
  };
}

@ApiTags('admin')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @ApiOperation({ summary: 'Get admin stats' })
  @ApiResponse({ status: 200, description: 'Admin statistics' })
  @Get('stats')
  getStats(): Promise<AdminStats> {
    return this.adminService.getStats();
  }

  // ─── Audit log ──────────────────────────────────────────────────────────

  /**
   * GET /admin/audit — Issue #934
   * Paginated + filterable audit log of all admin mutations.
   */
  @ApiOperation({ summary: 'Get paginated admin audit log (Issue #934)' })
  @ApiResponse({ status: 200, description: 'Audit log rows' })
  @ApiQuery({ name: 'actor', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO 8601 date' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO 8601 date' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @Get('audit')
  getAuditLog(
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ rows: AdminAuditEntity[]; total: number }> {
    const opts: AuditQueryOptions = {
      actor,
      action,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    };
    return this.adminService.getAuditLog(opts);
  }

  // ─── Verifier management ────────────────────────────────────────────────

  @ApiOperation({ summary: 'Register a new verifier' })
  @ApiResponse({ status: 201, description: 'Verifier registered' })
  @Post('verifiers/register')
  registerVerifier(
    @Body() body: { address: string },
    @Request() req: object,
  ): Promise<{ registered: boolean; address: string }> {
    return this.adminService.registerVerifier(body.address, buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]));
  }

  @ApiOperation({ summary: 'Suspend a verifier' })
  @ApiResponse({ status: 200, description: 'Verifier suspended' })
  @Post('verifiers/:id/suspend')
  suspendVerifier(
    @Param('id') id: string,
    @Request() req: object,
  ): Promise<{ suspended: boolean }> {
    return this.adminService.suspendVerifier(id, buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]));
  }

  @ApiOperation({ summary: 'Configure verifier capabilities' })
  @ApiResponse({ status: 200, description: 'Verifier configured' })
  @Post('verifiers/:id/configure')
  configureVerifier(
    @Param('id') id: string,
    @Body() body: VerifierCapabilities,
    @Request() req: object,
  ): Promise<{ configured: boolean; verifierId: string }> {
    return this.adminService.configureVerifier(id, body, buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]));
  }

  @ApiOperation({ summary: 'Flag a credit for review' })
  @ApiResponse({ status: 200, description: 'Credit flagged' })
  @Post('credits/:id/flag')
  flagCredit(
    @Param('id') id: string,
    @Request() req: object,
  ): Promise<{ flagged: boolean; creditId: string; status: CreditStatus }> {
    return this.adminService.flagCredit(id, buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]));
  }

  /**
   * POST /admin/methodologies — register a new carbon credit methodology.
   */
  @Post('methodologies')
  registerMethodology(
    @Body() body: { name: string; description: string },
    @Request() req: object,
  ): { registered: boolean; name: string; description: string } {
    return this.adminService.registerMethodology(
      body.name,
      body.description,
      buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]),
    );
  }

  /**
   * GET /admin/nonce/:address — fetch the current replay-protection nonce.
   */
  @Get('nonce/:address')
  getNonce(
    @Param('address') address: string,
  ): Promise<{ address: string; nonce: number }> {
    return this.adminService.getNonce(address);
  }

  /**
   * POST /admin/required-approvals — set the minimum verifier approvals threshold.
   */
  @Post('required-approvals')
  setRequiredApprovals(
    @Body() body: { threshold: number },
    @Request() req: object,
  ): Promise<{ requiredApprovals: number }> {
    return this.adminService.setRequiredApprovals(
      body.threshold,
      buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]),
    );
  }

  /**
   * POST /admin/pause — pause all contract operations.
   */
  @Post('pause')
  pause(@Request() req: object): Promise<{ paused: boolean }> {
    return this.adminService.pauseContract(buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]));
  }

  /**
   * POST /admin/unpause — resume all contract operations.
   */
  @Post('unpause')
  unpause(@Request() req: object): Promise<{ paused: boolean }> {
    return this.adminService.unpauseContract(buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]));
  }

  @ApiOperation({ summary: 'Set minimum verifier stake requirement' })
  @ApiResponse({ status: 200, description: 'Updated minimum stake' })
  @Post('min-stake')
  setMinStake(
    @Body() body: { amount: string; nonce: string },
    @Request() req: object,
  ): Promise<{ minStake: string }> {
    return this.adminService.setMinStake(
      body.amount,
      body.nonce,
      buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]),
    );
  }

  @ApiOperation({
    summary: 'Slash a verifier stake (penalty for fraudulent approval)',
  })
  @ApiResponse({ status: 200, description: 'Slash applied' })
  @ApiResponse({ status: 404, description: 'Verifier not found or no stake' })
  @Post('verifiers/:address/slash')
  slashVerifier(
    @Param('address') address: string,
    @Body() body: { creditId: string; nonce: string },
    @Request() req: object,
  ): Promise<{ slashed: boolean; verifier: string; creditId: string }> {
    return this.adminService.slashVerifier(
      address,
      body.creditId,
      body.nonce,
      buildAuditCtx(req as Parameters<typeof buildAuditCtx>[0]),
    );
  }
}
