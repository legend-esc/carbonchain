import { Controller, Get, Post, Param, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AdminGuard } from './admin.guard';
import { AdminService, AdminStats } from './admin.service';
import type { VerifierCapabilities } from './admin.service';

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

  /**
   * POST /admin/verifiers/register — register a new verifier on-chain.
   *
   * The verifier must have already deposited at least the minimum stake via
   * POST /verifiers/:address/stake/deposit before calling this endpoint.
   * Consumes one admin nonce.
   */
  @ApiOperation({ summary: 'Register a new verifier on-chain' })
  @ApiResponse({ status: 201, description: 'Verifier registered on-chain' })
  @Post('verifiers/register')
  registerVerifier(
    @Body() body: { address: string },
  ): Promise<{ registered: boolean; address: string }> {
    return this.adminService.registerVerifier(body.address);
  }

  /**
   * POST /admin/verifiers/:id/suspend — remove a verifier on-chain.
   *
   * Calls `remove_verifier` on the credit_registry contract. The contract will
   * reject removal if the verifier still has pending credits assigned.
   * Consumes one admin nonce.
   */
  @ApiOperation({ summary: 'Suspend (remove) a verifier on-chain' })
  @ApiResponse({ status: 200, description: 'Verifier suspended (removed on-chain)' })
  @Post('verifiers/:id/suspend')
  suspendVerifier(@Param('id') id: string): Promise<{ suspended: boolean }> {
    return this.adminService.suspendVerifier(id);
  }

  /**
   * POST /admin/verifiers/:id/configure — NOT IMPLEMENTED.
   *
   * Configuring verifier services requires the verifier's own signature, not
   * the admin's. Verifiers must configure their own services via
   * POST /verifiers/:address/services in their own authenticated session.
   *
   * Returns 501 so the UI knows to hide this feature for admin sessions.
   */
  @ApiOperation({ summary: 'Configure verifier capabilities (NOT IMPLEMENTED — requires verifier signature)' })
  @ApiResponse({ status: 501, description: 'Not implemented — requires verifier signature, not admin' })
  @Post('verifiers/:id/configure')
  configureVerifier(
    @Param('id') id: string,
    @Body() body: VerifierCapabilities,
  ): Promise<never> {
    return this.adminService.configureVerifier(id, body);
  }

  /**
   * POST /admin/credits/:id/flag — NOT IMPLEMENTED.
   *
   * Flagging a credit on-chain requires a verifier signature. Admin cannot
   * directly flag credits. Use POST /credits/:id/dispute from a verifier
   * authenticated session.
   *
   * Returns 501 so the UI knows to hide this feature.
   */
  @ApiOperation({ summary: 'Flag a credit for review (NOT IMPLEMENTED — requires verifier signature)' })
  @ApiResponse({ status: 501, description: 'Not implemented — requires verifier signature, not admin' })
  @Post('credits/:id/flag')
  flagCredit(@Param('id') id: string): Promise<never> {
    return this.adminService.flagCredit(id);
  }

  /**
   * POST /admin/methodologies — register a new carbon credit methodology.
   * Body: { name: string; description: string }
   */
  @Post('methodologies')
  registerMethodology(@Body() body: { name: string; description: string }): {
    registered: boolean;
    name: string;
    description: string;
  } {
    return this.adminService.registerMethodology(body.name, body.description);
  }

  /**
   * GET /admin/nonce/:address — fetch the current replay-protection nonce for an address.
   * The frontend must call this before every mutating action and include the returned nonce
   * in the transaction to prevent replay attacks.
   */
  @Get('nonce/:address')
  getNonce(
    @Param('address') address: string,
  ): Promise<{ address: string; nonce: number }> {
    return this.adminService.getNonce(address);
  }

  /**
   * POST /admin/required-approvals — set the minimum number of verifier approvals
   * required to mint a credit.
   * Body: { threshold: number }
   */
  @Post('required-approvals')
  setRequiredApprovals(
    @Body() body: { threshold: number },
  ): Promise<{ requiredApprovals: number }> {
    return this.adminService.setRequiredApprovals(body.threshold);
  }

  /**
   * POST /admin/pause — pause all contract operations.
   * Only the on-chain admin may call this.
   */
  @Post('pause')
  pause(): Promise<{ paused: boolean }> {
    return this.adminService.pauseContract();
  }

  /**
   * POST /admin/unpause — resume all contract operations.
   * Only the on-chain admin may call this.
   */
  @Post('unpause')
  unpause(): Promise<{ paused: boolean }> {
    return this.adminService.unpauseContract();
  }

  /**
   * POST /admin/min-stake — update the minimum stake required to register as a verifier.
   * Body: { amount: string; nonce: string }
   *   - amount — new minimum in stroops (1 XLM = 10,000,000 stroops). Use "0" to disable.
   *   - nonce  — current admin replay-protection nonce from GET /admin/nonce/:address.
   */
  @ApiOperation({ summary: 'Set minimum verifier stake requirement' })
  @ApiResponse({ status: 200, description: 'Updated minimum stake' })
  @Post('min-stake')
  setMinStake(
    @Body() body: { amount: string; nonce: string },
  ): Promise<{ minStake: string }> {
    return this.adminService.setMinStake(body.amount, body.nonce);
  }

  /**
   * POST /admin/verifiers/:address/slash — slash 10 % of a verifier's stake as penalty
   * for approving a credit that was later found to be fraudulent.
   * Body: { creditId: string; nonce: string }
   *   - creditId — the hex credit ID that triggered the slash.
   *   - nonce    — current admin replay-protection nonce from GET /admin/nonce/:address.
   */
  @ApiOperation({
    summary: 'Slash a verifier stake (penalty for fraudulent approval)',
  })
  @ApiResponse({ status: 200, description: 'Slash applied' })
  @ApiResponse({ status: 404, description: 'Verifier not found or no stake' })
  @Post('verifiers/:address/slash')
  slashVerifier(
    @Param('address') address: string,
    @Body() body: { creditId: string; nonce: string },
  ): Promise<{ slashed: boolean; verifier: string; creditId: string }> {
    return this.adminService.slashVerifier(address, body.creditId, body.nonce);
  }
}
