import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { VerifiersService, VerifierInfo } from './verifiers.service';
import { CreditMetadata } from '../../../shared';

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
}
