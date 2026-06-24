import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { VerifiersService, VerifierInfo } from './verifiers.service';
import { CreditMetadata } from '../shared';

@Controller('verifiers')
export class VerifiersController {
  constructor(private readonly verifiersService: VerifiersService) {}

  @Get()
  listVerifiers(): Promise<VerifierInfo[]> {
    return this.verifiersService.listVerifiers();
  }

  @Get(':address')
  getVerifier(@Param('address') address: string): Promise<VerifierInfo> {
    return this.verifiersService.getVerifier(address);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id/pending')
  async getPendingCredits(
    @Param('id') verifierId: string,
  ): Promise<CreditMetadata[]> {
    return this.verifiersService.getPendingCredits(verifierId);
  }

  @UseGuards(AuthGuard('jwt'))
  @Get(':id/history')
  async getApprovalHistory(
    @Param('id') verifierId: string,
  ): Promise<CreditMetadata[]> {
    return this.verifiersService.getApprovalHistory(verifierId);
  }
}
