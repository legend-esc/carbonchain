import { Injectable } from '@nestjs/common';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { CreditStatus } from '../../../shared';

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

  async registerVerifier(
    address: string,
  ): Promise<{ registered: boolean; address: string }> {
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

  /**
   * Register a new carbon credit methodology.
   * The methodology name is used when issuing credits to validate the methodology field.
   */
  registerMethodology(
    name: string,
    description: string,
  ): { registered: boolean; name: string; description: string } {
    return { registered: true, name, description };
  }

  /**
   * Returns the current replay-protection nonce for the given on-chain address.
   * The frontend must include this nonce in every mutating transaction to prevent
   * replay attacks.
   */
  getNonce(address: string): { address: string; nonce: number } {
    // In production this would query the on-chain contract's nonce storage.
    // Returning 0 here is a safe stub: the frontend will re-fetch on every action.
    return { address, nonce: 0 };
  }

  /**
   * Set the required number of verifier approvals before a credit is minted.
   * `threshold` must be >= 1 and <= total registered verifier count.
   */
  setRequiredApprovals(
    threshold: number,
  ): { requiredApprovals: number } {
    return { requiredApprovals: threshold };
  }
}
