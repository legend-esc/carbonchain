import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Param,
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
import { StrKey } from '@stellar/stellar-sdk';
import { VerifiersService, VerifierInfo } from './verifiers.service';
import {
  VerifierApplicationEntity,
  VerifierApplicationStatus,
} from './verifier-application.entity';
import { CreditMetadata, VerifierReputation } from '../../../shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('verifiers')
@Controller('verifiers')
export class VerifiersController {
  constructor(private readonly verifiersService: VerifiersService) {}

  @ApiOperation({ summary: 'List all registered verifiers' })
  @ApiResponse({ status: 200, description: 'List of verifiers' })
  @Get()
  listVerifiers(): Promise<VerifierInfo[]> {
    return this.verifiersService.listVerifiers();
  }

  /**
   * GET /verifiers/min-stake
   * Returns the global minimum stake (in stroops) required to register as a verifier.
   * This is a public endpoint — no auth required.
   */
  @ApiOperation({ summary: 'Get minimum verifier stake requirement' })
  @ApiResponse({
    status: 200,
    description: 'Minimum stake in stroops (1 XLM = 10,000,000 stroops)',
  })
  @Get('min-stake')
  getMinStake(): Promise<{ minStake: string }> {
    return this.verifiersService.getMinStake();
  }

  @ApiOperation({ summary: 'Get verifier by address' })
  @ApiResponse({ status: 200, description: 'Verifier info' })
  @ApiResponse({ status: 404, description: 'Verifier not found' })
  @Get(':address')
  getVerifier(@Param('address') address: string): Promise<VerifierInfo> {
    return this.verifiersService.getVerifier(address);
  }

  @ApiOperation({ summary: 'Get pending credits for a verifier' })
  @ApiResponse({ status: 200, description: 'Pending credits' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - can only view own pending credits',
  })
  @UseGuards(JwtAuthGuard)
  @Get(':address/pending')
  async getPendingCredits(
    @Param('address') address: string,
    @Request() req: any,
  ): Promise<CreditMetadata[]> {
    const caller = req.user?.account;
    if (caller !== address && req.user?.role !== 'admin') {
      throw new ForbiddenException(
        'You can only view your own pending credits',
      );
    }
    return this.verifiersService.getPendingCredits(address);
  }

  @ApiOperation({ summary: 'Get approval history for a verifier' })
  @ApiResponse({ status: 200, description: 'Approval history' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({
    status: 403,
    description: 'Forbidden - can only view own approval history',
  })
  @UseGuards(JwtAuthGuard)
  @Get(':address/history')
  async getApprovalHistory(
    @Param('address') address: string,
    @Request() req: any,
  ): Promise<CreditMetadata[]> {
    const caller = req.user?.account;
    if (caller !== address && req.user?.role !== 'admin') {
      throw new ForbiddenException(
        'You can only view your own approval history',
      );
    }
    return this.verifiersService.getApprovalHistory(address);
  }

  @ApiOperation({ summary: 'Approve a pending credit as a verifier' })
  @ApiResponse({ status: 200, description: 'Credit approved successfully' })
  @ApiResponse({
    status: 403,
    description: 'Not a registered verifier or caller mismatch',
  })
  @ApiResponse({
    status: 409,
    description: 'Verifier has already approved this credit',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post(':address/approve/:creditId')
  @HttpCode(200)
  async approveCredit(
    @Param('address') address: string,
    @Param('creditId') creditId: string,
    @Request() req: any,
  ): Promise<void> {
    return this.verifiersService.approveCredit(
      address,
      creditId,
      req.user.account,
    );
  }

  @ApiOperation({ summary: 'Get verifier reputation' })
  @ApiResponse({
    status: 200,
    description:
      'Returns { address, approvalCount, disputeCount } for the verifier.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid Stellar Ed25519 public key format.',
  })
  @ApiResponse({ status: 404, description: 'Verifier not found.' })
  @Header('Cache-Control', 'max-age=60')
  @Get(':address/reputation')
  async getReputation(
    @Param('address') address: string,
  ): Promise<VerifierReputation> {
    // Validate that the address is a valid Stellar Ed25519 public key before
    // making any downstream calls.  This prevents nonsense values from reaching
    // the Stellar SDK / contract layer and returns a clear HTTP 400 to callers.
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new BadRequestException(
        `'${address}' is not a valid Stellar Ed25519 public key.`,
      );
    }
    return this.verifiersService.getReputation(address);
  }

  // ── Staking ────────────────────────────────────────────────────────────────

  /**
   * GET /verifiers/:address/stake
   * Returns the amount currently locked by this verifier (in stroops).
   * Public endpoint — useful for dashboards and pre-registration checks.
   */
  @ApiOperation({ summary: 'Get the stake currently locked by a verifier' })
  @ApiResponse({
    status: 200,
    description: 'Stake in stroops. 0 if the verifier has no locked stake.',
  })
  @Get(':address/stake')
  async getStake(
    @Param('address') address: string,
  ): Promise<{ address: string; stake: string }> {
    if (!StrKey.isValidEd25519PublicKey(address)) {
      throw new BadRequestException(
        `'${address}' is not a valid Stellar Ed25519 public key.`,
      );
    }
    return this.verifiersService.getStake(address);
  }

  /**
   * POST /verifiers/:address/stake/deposit
   * Deposit stake on behalf of a verifier.
   *
   * Body: { tokenId: string; amount: string; nonce: string }
   *   - tokenId  — Stellar Asset Contract address for the stake token (native XLM SAC).
   *   - amount   — stroops to lock (positive integer string).
   *   - nonce    — current replay-protection nonce from GET /admin/nonce/:address.
   *
   * In production the verifier should sign this transaction themselves via Freighter.
   * The current implementation signs with the admin keypair for test-mode convenience.
   */
  @ApiOperation({
    summary: 'Deposit stake for a verifier',
    description:
      'The :address path param is informational only — the account credited is always the authenticated caller.',
  })
  @ApiResponse({ status: 200, description: 'Updated stake after deposit' })
  @ApiResponse({ status: 400, description: 'Invalid address or amount' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post(':address/stake/deposit')
  @HttpCode(200)
  async depositStake(
    @Param('address') _address: string,
    @Body() body: { tokenId: string; amount: string; nonce: string },
    @Request() req: any,
  ): Promise<{ address: string; stake: string }> {
    const account = req.user.account;
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new BadRequestException(
        `'${account}' is not a valid Stellar Ed25519 public key.`,
      );
    }
    if (!body.tokenId || !body.amount || !body.nonce) {
      throw new BadRequestException('tokenId, amount, and nonce are required');
    }
    return this.verifiersService.depositStake(
      account,
      body.tokenId,
      body.amount,
      body.nonce,
    );
  }

  /**
   * POST /verifiers/:address/stake/withdraw
   * Withdraw unbonded stake once the 30-day unbonding period has elapsed.
   *
   * Body: { tokenId: string; nonce: string }
   *   - tokenId — must match the token used for the original deposit.
   *   - nonce   — current replay-protection nonce from GET /admin/nonce/:address.
   */
  @ApiOperation({ summary: 'Withdraw unbonded stake for a verifier' })
  @ApiResponse({ status: 200, description: 'Withdrawal successful' })
  @ApiResponse({
    status: 400,
    description: 'No unbonding request or unbonding period not elapsed',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Post(':address/stake/withdraw')
  @HttpCode(200)
  async withdrawStake(
    @Param('address') _address: string,
    @Body() body: { tokenId: string; nonce: string },
    @Request() req: any,
  ): Promise<{ withdrawn: boolean; address: string }> {
    const account = req.user.account;
    if (!StrKey.isValidEd25519PublicKey(account)) {
      throw new BadRequestException(
        `'${account}' is not a valid Stellar Ed25519 public key.`,
      );
    }
    if (!body.tokenId || !body.nonce) {
      throw new BadRequestException('tokenId and nonce are required');
    }
    return this.verifiersService.withdrawStake(
      account,
      body.tokenId,
      body.nonce,
    );
  }

  // ── Applications (Issue #967) ───────────────────────────────────────────────

  @ApiOperation({ summary: 'Submit a verifier application' })
  @ApiResponse({ status: 201, description: 'Application submitted' })
  @ApiResponse({ status: 409, description: 'Application already pending' })
  @Post('applications')
  async submitApplication(
    @Body()
    body: {
      address: string;
      name: string;
      capabilities: string[];
      documentsCid: string;
      stakeToken: string;
      stakeAmount: string;
    },
  ): Promise<VerifierApplicationEntity> {
    return this.verifiersService.submitApplication(body);
  }

  @ApiOperation({ summary: 'Get verifier application status' })
  @ApiResponse({ status: 200, description: 'Application details' })
  @ApiResponse({ status: 404, description: 'No application found' })
  @Get('applications/:address')
  async getApplication(
    @Param('address') address: string,
  ): Promise<VerifierApplicationEntity | null> {
    return this.verifiersService.getApplication(address);
  }

  @ApiOperation({ summary: 'List pending verifier applications (admin)' })
  @ApiResponse({ status: 200, description: 'List of applications' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Get('admin/applications')
  async listApplications(
    @Query('status') status?: string,
  ): Promise<VerifierApplicationEntity[]> {
    const filter =
      status === VerifierApplicationStatus.Approved
        ? VerifierApplicationStatus.Approved
        : status === VerifierApplicationStatus.Rejected
          ? VerifierApplicationStatus.Rejected
          : undefined;
    return this.verifiersService.listApplications(filter);
  }

  @ApiOperation({ summary: 'Approve or reject a verifier application (admin)' })
  @ApiResponse({ status: 200, description: 'Application updated' })
  @ApiResponse({ status: 404, description: 'Application not found' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('admin/applications/:address/review')
  async reviewApplication(
    @Param('address') address: string,
    @Body() body: { status: VerifierApplicationStatus },
    @Request() req: any,
  ): Promise<VerifierApplicationEntity | null> {
    return this.verifiersService.reviewApplication(
      address,
      body.status,
      req.user.account,
    );
  }
}
