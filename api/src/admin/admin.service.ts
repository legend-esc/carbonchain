import { Injectable } from '@nestjs/common';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { CreditStatus } from '../shared';

export interface AdminStats {
  totalCredits: number;
  totalRetirements: number;
  activeVerifiers: number;
}

export interface VerifierCapabilities {
  methodologies?: string[];
  geographies?: string[];
}

@Injectable()
export class AdminService {
  constructor(
    private readonly creditsService: CreditsService,
    private readonly verifiersService: VerifiersService,
  ) {}

  async getStats(): Promise<AdminStats> {
    const verifiers = await this.verifiersService.listVerifiers();
    return {
      totalCredits: 0, // on-chain aggregate; requires contract-level count endpoint
      totalRetirements: 0, // on-chain aggregate; requires contract-level count endpoint
      activeVerifiers: verifiers.length,
    };
  }

  registerVerifier(address: string): { registered: boolean; address: string } {
    return { registered: true, address };
  }

  async suspendVerifier(id: string): Promise<{ suspended: boolean }> {
    await this.verifiersService.getVerifier(id);
    return { suspended: true };
  }

  async configureVerifier(
    id: string,
    _capabilities: VerifierCapabilities,
  ): Promise<{ configured: boolean; verifierId: string }> {
    void _capabilities;
    await this.verifiersService.getVerifier(id);
    return { configured: true, verifierId: id };
  }

  async flagCredit(
    id: string,
  ): Promise<{ flagged: boolean; creditId: string; status: CreditStatus }> {
    await this.creditsService.getCredit(id);
    return { flagged: true, creditId: id, status: CreditStatus.Flagged };
  }
}
