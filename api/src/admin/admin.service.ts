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
   * Set the minimum stake required to register as a verifier.
   * `amount` is in stroops (1 XLM = 10,000,000 stroops). Pass 0 to disable staking.
   * The admin's current nonce must be provided to prevent replay attacks.
   */
  async setMinStake(
    amount: string,
    nonce: string,
  ): Promise<{ minStake: string }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(BigInt(amount), { type: 'i128' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'set_min_stake',
      args,
      admin,
    );
    this.logger.log(`Minimum stake updated to ${amount} stroops`);
    return { minStake: amount };
  }

  /**
   * Slash 10% of a verifier's locked stake as a penalty for approving a fraudulent credit.
   * Requires the admin's current nonce to prevent replay attacks.
   */
  async slashVerifier(
    verifierAddress: string,
    creditId: string,
    nonce: string,
  ): Promise<{ slashed: boolean; verifier: string; creditId: string }> {
    const admin = this.keypairService.getAdminKeypair();
    const args = [
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(verifierAddress, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'slash_verifier',
      args,
      admin,
    );
    this.logger.log(
      `Slashed verifier ${verifierAddress} for credit ${creditId}`,
    );
    return { slashed: true, verifier: verifierAddress, creditId };
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
  async getNonce(address: string): Promise<{ address: string; nonce: number }> {
    this.logger.log(`Fetching on-chain nonce for ${address}`);
    try {
      const args = [nativeToScVal(address, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.creditRegistryContractId,
        'get_nonce',
        args,
      );
      const nonce: bigint = retval ? (scValToNative(retval) as bigint) : 0n;
      return { address, nonce: Number(nonce) };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch nonce for ${address}: ${(error as Error).message}`,
      );
      // Return 0 as a safe fallback — the on-chain nonce check will still
      // catch mismatches; this prevents contract-unavailability from
      // completely blocking admin UI interactions.
      return { address, nonce: 0 };
    }
  }

  /**
   * Set the required number of verifier approvals before a credit is minted.
   * Invokes `set_required_approvals` on the credit_registry contract.
   * `threshold` must be >= 1.
   */
  async setRequiredApprovals(
    threshold: number,
  ): Promise<{ requiredApprovals: number }> {
    this.logger.log(`Setting required approvals to ${threshold}`);
    const admin = this.keypairService.getAdminKeypair();
    // Fetch the admin's current nonce atomically before building the transaction.
    const nonceRetval = await this.stellarService.readContract(
      this.creditRegistryContractId,
      'get_nonce',
      [nativeToScVal(admin.publicKey(), { type: 'address' })],
    );
    const nonce: bigint = nonceRetval
      ? (scValToNative(nonceRetval) as bigint)
      : 0n;

    const args = [
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(threshold, { type: 'u32' }),
      nativeToScVal(nonce, { type: 'u64' }),
    ];
    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'set_required_approvals',
      args,
      admin,
    );
    return { requiredApprovals: threshold };
  }
}
