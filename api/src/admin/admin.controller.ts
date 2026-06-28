import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminGuard } from './admin.guard';
import { AdminService, AdminStats } from './admin.service';
import type { VerifierCapabilities } from './admin.service';
import { CreditStatus } from '../../../shared';

@ApiTags('admin')
@UseGuards(AuthGuard('jwt'), AdminGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @ApiOperation({ summary: 'Get admin stats' })
  @ApiResponse({ status: 200, description: 'Admin statistics' })
  @Get('stats')
  getStats(): Promise<AdminStats> {
    return this.adminService.getStats();
  }

  @ApiOperation({ summary: 'Register a new verifier' })
  @ApiResponse({ status: 201, description: 'Verifier registered' })
  @Post('verifiers/register')
  registerVerifier(
    @Body() body: { address: string },
  ): Promise<{ registered: boolean; address: string }> {
    return this.adminService.registerVerifier(body.address);
  }

  @ApiOperation({ summary: 'Suspend a verifier' })
  @ApiResponse({ status: 200, description: 'Verifier suspended' })
  @Post('verifiers/:id/suspend')
  suspendVerifier(@Param('id') id: string): Promise<{ suspended: boolean }> {
    return this.adminService.suspendVerifier(id);
  }

  @ApiOperation({ summary: 'Configure verifier capabilities' })
  @ApiResponse({ status: 200, description: 'Verifier configured' })
  @Post('verifiers/:id/configure')
  configureVerifier(
    @Param('id') id: string,
    @Body() body: VerifierCapabilities,
  ): Promise<{ configured: boolean; verifierId: string }> {
    return this.adminService.configureVerifier(id, body);
  }

  @ApiOperation({ summary: 'Flag a credit for review' })
  @ApiResponse({ status: 200, description: 'Credit flagged' })
  @Post('credits/:id/flag')
  flagCredit(
    @Param('id') id: string,
  ): Promise<{ flagged: boolean; creditId: string; status: CreditStatus }> {
    return this.adminService.flagCredit(id);
  }
}
