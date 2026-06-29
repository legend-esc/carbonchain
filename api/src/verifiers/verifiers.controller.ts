import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Request,
  HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VerifiersService, VerifierInfo } from './verifiers.service';
import { CreditMetadata, VerifierReputation } from '../../../shared';

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
  @UseGuards(AuthGuard('jwt'))
  @Get(':id/pending')
  async getPendingCredits(
    @Param('id') verifierId: string,
  ): Promise<CreditMetadata[]> {
    return this.verifiersService.getPendingCredits(verifierId);
  }

  @ApiOperation({ summary: 'Get approval history for a verifier' })
  @ApiResponse({ status: 200, description: 'Approval history' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(AuthGuard('jwt'))
  @Get(':id/history')
  async getApprovalHistory(
    @Param('id') verifierId: string,
  ): Promise<CreditMetadata[]> {
    return this.verifiersService.getApprovalHistory(verifierId);
  }

  @ApiOperation({ summary: 'Approve a pending credit as a verifier' })
  @ApiResponse({ status: 200, description: 'Credit approved successfully' })
  @ApiResponse({ status: 403, description: 'Not a registered verifier or caller mismatch' })
  @ApiResponse({ status: 409, description: 'Verifier has already approved this credit' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(AuthGuard('jwt'))
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
  @ApiResponse({ status: 200, description: 'Verifier reputation' })
  @ApiResponse({ status: 404, description: 'Verifier not found' })
  @Get(':address/reputation')
  async getReputation(
    @Param('address') address: string,
  ): Promise<VerifierReputation> {
    return this.verifiersService.getReputation(address);
  }
}
