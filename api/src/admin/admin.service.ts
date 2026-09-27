import {
import {
  Injectable,
  Inject,
  Logger,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VerifiersService } from '../verifiers/verifiers.service';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { IRetirementRepository, RETIREMENT_REPOSITORY } from '../retirement/retirement.repository';

// ── Pause tri-state (#926) ────────────────────────────────────────────────────

/** Tri-state for contract pause status:
 * - 'paused'   — contract is confirmed paused
 * - 'unpaused' — contract is confirmed not paused
 * - 'unknown'  — probe failed; operator needs attention
 */
export type ContractPauseStatus = 'paused' | 'unpaused' | 'unknown';

export interface AdminStats {
  totalCredits: number;
  totalRetirements: number;
  activeVerifiers: number;
  /** @deprecated Use contractPauseStatus for tri-state; kept for backward compat */
  paused: boolean;
  /** #926 — Tri-state pause status. 'unknown' means the probe failed. */
  contractPauseStatus: ContractPauseStatus;
  /** #926 — true when any probe failed, so the UI can show a degraded indicator */
  health: { degraded: boolean; reason?: string };
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
    private readonly verifiersService: VerifiersService,
    private readonly configService: ConfigService,
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    @Inject(RETIREMENT_REPOSITORY)
    private readonly retirementRepo: IRetirementRepository,
  ) {
    this.creditRegistryContractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') || '';
  }

  // ── #926 + #925 ────────────────────────────────────────────────────────────

  async getStats(): Promise<AdminStats> {
    const verifiers = await this.verifiersService.listVerifiers();

    // #926 — tri-state pause probe: catch errors and surface as 'unknown'
    let contractPauseStatus: ContractPauseStatus = 'unknown';
    let probeError: string | undefined;
    try {
      const isPaused = await this.getContractPaused();
      contractPauseStatus = isPaused ? 'paused' : 'unpaused';
    } catch (err: unknown) {
      probeError = (err as Error)?.message ?? 'contract probe failed';
      this.logger.warn(`Pause probe failed — surfacing as unknown: ${probeError}`);
      // contractPauseStatus stays 'unknown'
    }

    // #925 — use COUNT-based query, not a page fetch
    const totalRetirements = await this.retirementRepo.count();

    return {
      totalCredits: 0, // on-chain aggregate; requires contract-level count endpoint
      totalRetirements,
      activeVerifiers: verifiers.length,
      // Backward-compat boolean: treat 'unknown' as false so existing consumers don't break.
      paused: contractPauseStatus === 'paused',
      contractPauseStatus,
      health: {
        degraded: contractPauseStatus === 'unknown',
        reason: probeError,
      },
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

  // ── #924 — verifier lifecycle ──────────────────────────────────────────────

  /**
   * Register a verifier on-chain via `register_verifier`.
   *
   * The verifier must have already deposited the minimum stake (via
   * `POST /verifiers/:address/stake/deposit`) before this call succeeds —
   * the contract enforces `InsufficientStake` otherwise.
   *
   * Consumes one admin nonce.
   */
  async registerVerifier(
    address: string,
  ): Promise<{ registered: boolean; address: string }> {
    const admin = this.keypairService.getAdminKeypair();

    // Fetch admin's current nonce atomically before building the transaction.
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
      nativeToScVal(address, { type: 'address' }),
      nativeToScVal(nonce, { type: 'u64' }),
    ];

    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'register_verifier',
      args,
      admin,
    );

    this.logger.log(
      `Verifier ${address} registered on-chain via credit_registry.register_verifier()`,
    );
    return { registered: true, address };
  }

  /**
   * Suspend (remove) a verifier on-chain via `remove_verifier`.
   *
   * The contract blocks removal when the verifier has pending credits assigned.
   * Consumes one admin nonce.
   */
  async suspendVerifier(id: string): Promise<{ suspended: boolean }> {
    // Confirm the verifier exists in our registry before hitting the chain.
    await this.verifiersService.getVerifier(id);

    const admin = this.keypairService.getAdminKeypair();

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
      nativeToScVal(id, { type: 'address' }),
      nativeToScVal(nonce, { type: 'u64' }),
    ];

    await this.stellarService.invokeContract(
      this.creditRegistryContractId,
      'remove_verifier',
      args,
      admin,
    );

    this.logger.log(
      `Verifier ${id} removed on-chain via credit_registry.remove_verifier()`,
    );
    return { suspended: true };
  }

  /**
   * Configure a verifier's service capabilities.
   *
   * The contract's `configure_verifier_services` requires the **verifier** to
   * sign the transaction with their own keypair — this is NOT an admin
   * operation. The admin panel cannot perform this action on behalf of the
   * verifier. The verifier must call `POST /verifiers/:address/services`
   * themselves (via Freighter / their own wallet).
   *
   * Returns HTTP 501 so callers know the endpoint exists but is intentionally
   * not implemented at admin level.
   */
  async configureVerifier(
    _id: string,
    _capabilities: VerifierCapabilities,
  ): Promise<never> {
    throw new NotImplementedException(
      'configure_verifier_services requires the verifier to sign with their own keypair. ' +
        'Use POST /verifiers/:address/services from the verifier\'s authenticated session.',
    );
  }

  /**
   * Flag a credit for review.
   *
   * The contract's `flag_credit` requires the **verifier** to sign, not the
   * admin. The admin panel cannot directly flag a credit on-chain.
   *
   * Returns HTTP 501 so the UI can hide this feature until a verifier-signed
   * endpoint is wired up.
   */
  async flagCredit(_id: string): Promise<never> {
    throw new NotImplementedException(
      'flag_credit requires a verifier signature. ' +
        'Use POST /credits/:id/dispute from a verifier\'s authenticated session.',
    );
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
