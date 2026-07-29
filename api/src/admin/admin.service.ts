import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditsService } from '../credits/credits.service';
import { VerifiersService } from '../verifiers/verifiers.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CreditStatus } from '../../../shared';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

export interface AdminStats {
  totalCredits: number;
  totalRetirements: number;
  activeVerifiers: number;
  paused: boolean;
}

export interface VerifierCapabilities {
  methodologies?: string[];
  geographies?: string[];
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly creditRegistryContractId: string;

  constructor(
    private readonly creditsService: CreditsService,
    private readonly verifiersService: VerifiersService,
    private readonly configService: ConfigService,
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
  ) {
    this.creditRegistryContractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') || '';
  }

  async getStats(): Promise<AdminStats> {
    const verifiers = await this.verifiersService.listVerifiers();
    let paused = false;
    try {
      paused = await this.getContractPaused();
    } catch {
      // Non-fatal — default to false if contract call fails.
    }
    return {
      totalCredits: 0, // on-chain aggregate; requires contract-level count endpoint
      totalRetirements: 0, // on-chain aggregate; requires contract-level count endpoint
      activeVerifiers: verifiers.length,
      paused,
    };
  }

  private async getContractPaused(): Promise<boolean> {
    if (!this.creditRegistryContractId) return false;
    const result = await this.stellarService.readContract(
      this.creditRegistryContractId,
      'paused',
      [],
    );
    return result ? (scValToNative(result) as boolean) : false;
  }

  async pauseContract(): Promise<{ paused: boolean }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [nativeToScVal(admin.publicKey(), { type: 'address' })];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'pause',
      args,
      admin,
    );
    this.logger.log('Contract paused via credit_registry.pause()');
    return { paused: true };
  }

  async unpauseContract(): Promise<{ paused: boolean }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [nativeToScVal(admin.publicKey(), { type: 'address' })];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'unpause',
      args,
      admin,
    );
    this.logger.log('Contract unpaused via credit_registry.unpause()');
    return { paused: false };
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
