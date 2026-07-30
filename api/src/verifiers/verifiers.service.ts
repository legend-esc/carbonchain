import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import { CreditMetadata, CreditStatus, VerifierReputation } from '../../../shared';
import { CacheService } from '../common/cache.service';

export interface VerifierInfo {
  address: string;
}

const REPUTATION_KEY = (address: string) => `verifiers:reputation:${address}`;
const REPUTATION_TTL = 60;

@Injectable()
export class VerifiersService {
  private readonly logger = new Logger(VerifiersService.name);
  private readonly contractId: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly keypairService: StellarKeypairService,
    private readonly cache: CacheService,
  ) {
    this.contractId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
      '',
    );
  }

  async listVerifiers(): Promise<VerifierInfo[]> {
    try {
      const retval = await this.stellarService.readContract(
        this.contractId,
        'list_verifiers',
      );
      if (!retval) return [];
      const native = scValToNative(retval) as string[];
      return native.map((address) => ({ address }));
    } catch (err: unknown) {
      this.logger.error(`Failed to list verifiers: ${(err as Error).message}`);
      return [];
    }
  }

  async getVerifier(address: string): Promise<VerifierInfo> {
    const verifiers = await this.listVerifiers();
    const found = verifiers.find((v) => v.address === address);
    if (!found) throw new NotFoundException(`Verifier ${address} not found`);
    return found;
  }

  async getPendingCredits(verifierId: string): Promise<CreditMetadata[]> {
    try {
      this.logger.log(`Fetching pending credits for verifier: ${verifierId}`);
      const args = [nativeToScVal(verifierId, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_pending_credits',
        args,
      );
      if (!retval) return [];

      const native = scValToNative(retval) as Array<{
        id: Uint8Array;
        project_id: string;
        issuer: string;
        vintage_year: number;
        methodology: string;
        geography: string;
        tonnes: bigint;
        ipfs_hash: string;
        status: string;
        issued_at: number;
      }>;

      return native.map((credit) => ({
        id: Buffer.from(credit.id).toString('hex'),
        project_id: credit.project_id,
        issuer: credit.issuer,
        owner: credit.issuer,
        vintage_year: credit.vintage_year,
        methodology: credit.methodology,
        geography: credit.geography,
        tonnes: String(credit.tonnes),
        ipfs_hash: credit.ipfs_hash,
        status: credit.status as CreditStatus,
        issued_at: credit.issued_at,
      }));
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch pending credits for verifier ${verifierId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  async getApprovalHistory(verifierId: string): Promise<CreditMetadata[]> {
    try {
      this.logger.log(`Fetching approval history for verifier: ${verifierId}`);
      const args = [nativeToScVal(verifierId, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_approval_history',
        args,
      );
      if (!retval) return [];

      const native = scValToNative(retval) as Array<{
        id: Uint8Array;
        project_id: string;
        issuer: string;
        vintage_year: number;
        methodology: string;
        geography: string;
        tonnes: bigint;
        ipfs_hash: string;
        status: string;
        issued_at: number;
      }>;

      return native.map((credit) => ({
        id: Buffer.from(credit.id).toString('hex'),
        project_id: credit.project_id,
        issuer: credit.issuer,
        owner: credit.issuer,
        vintage_year: credit.vintage_year,
        methodology: credit.methodology,
        geography: credit.geography,
        tonnes: String(credit.tonnes),
        ipfs_hash: credit.ipfs_hash,
        status: credit.status as CreditStatus,
        issued_at: credit.issued_at,
      }));
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch approval history for verifier ${verifierId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Approve a pending credit on behalf of a registered verifier.
   *
   * ## Signing Model
   *
   * The credit registry contract's `approve_and_mint` function invokes
   * `verifier.require_auth()`, which means the transaction **must** be signed
   * by the verifier's own Stellar keypair — the admin keypair alone is
   * insufficient for a properly configured network.
   *
   * **Current behaviour (temporary / test-mode):**
   * The API signs the transaction with the admin keypair and submits it
   * directly. This works in local / testnet environments where the contract
   * is deployed with `mock_all_auths()` or equivalent auth bypass, but it
   * will **fail** on a production network that enforces real authorisation.
   *
   * **Planned production flow (TODO):**
   * 1. The API builds the transaction envelope, simulates it, and returns
   *    the unsigned XDR to the verifier's frontend (e.g. Freighter / Albedo).
   * 2. The verifier signs the XDR client-side using their wallet.
   * 3. The signed XDR is posted back to the API for submission.
   *
   * This two-phase submit flow ensures that the verifier's secret key never
   * leaves their wallet while still allowing the API to manage nonce
   * fetching, contract address resolution, and response handling.
   *
   * @see {@link https://github.com/stellar/freighter | Freighter} for
   *      browser-based Stellar signing.
   */
  async approveCredit(
    address: string,
    creditId: string,
    caller: string,
  ): Promise<void> {
    if (caller !== address) {
      throw new ForbiddenException('Caller does not match the verifier address');
    }

    await this.getVerifier(address);

    // Fetch the verifier's current replay-protection nonce from the contract.
    // This must be done atomically with the transaction build to avoid
    // TOCTOU races — the nonce is consumed inside `approve_and_mint`.
    const nonceRetval = await this.stellarService.readContract(
      this.contractId,
      'get_nonce',
      [nativeToScVal(address, { type: 'address' })],
    );
    if (!nonceRetval) {
      throw new Error(`Failed to fetch nonce for verifier ${address}: contract returned no value`);
    }
    const nonce = scValToNative(nonceRetval) as bigint;

    this.logger.log(`Verifier ${address} approving credit ${creditId} (nonce=${nonce})`);

    const args = [
      nativeToScVal(address, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(nonce, { type: 'u64' }),
    ];

    // NOTE: Signing with the admin keypair is a test-mode convenience.
    // In production the verifier MUST sign this transaction themselves.
    // See the class-level JSDoc for the planned Freighter signing flow.
    const signer = this.keypairService.getAdminKeypair();
    try {
      await this.stellarService.invokeContract(
        this.contractId,
        'approve_and_mint',
        args,
        signer,
      );
    } catch (error: unknown) {
      const msg = (error as Error).message ?? '';
      if (
        msg.includes('AlreadyApproved') ||
        msg.includes('Error(125)') ||
        msg.includes('status: 125')
      ) {
        throw new ConflictException('Verifier has already approved this credit');
      }
      throw error;
    }
  }

  async getReputation(address: string): Promise<VerifierReputation> {
    await this.getVerifier(address);

    const cached = await this.cache.get<VerifierReputation>(
      REPUTATION_KEY(address),
    );
    if (cached) {
      this.logger.debug(`Cache HIT for reputation ${address}`);
      return cached;
    }

    this.logger.log(`Fetching reputation for verifier ${address}`);
    try {
      const args = [nativeToScVal(address, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_verifier_reputation',
        args,
      );
      if (!retval) {
        return { address, approvalCount: 0, disputeCount: 0 };
      }
      const native = scValToNative(retval) as {
        approval_count: number;
        dispute_count: number;
      };
      const reputation: VerifierReputation = {
        address,
        approvalCount: Number(native.approval_count),
        disputeCount: Number(native.dispute_count),
      };
      await this.cache.set(REPUTATION_KEY(address), reputation, REPUTATION_TTL);
      return reputation;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch reputation for verifier ${address}: ${(error as Error).message}`,
      );
      return { address, approvalCount: 0, disputeCount: 0 };
    }
  }
}
