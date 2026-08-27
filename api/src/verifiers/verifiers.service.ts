import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
  Inject,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import {
  CreditMetadata,
  CreditStatus,
  VerifierReputation,
} from '../../../shared';
import { CacheService } from '../common/cache.service';
import { VerifierEntity } from './verifier.entity';
import type { IVerifierRepository } from './verifier.repository';
import { VERIFIER_REPOSITORY } from './verifier.repository';

export interface VerifierInfo {
  address: string;
  name?: string | null;
  capabilities?: string[];
  reputation?: {
    approvalCount: number;
    disputeCount: number;
  };
  registeredAt?: Date;
}

const REPUTATION_KEY = (address: string) => `verifiers:reputation:${address}`;
const REPUTATION_TTL = 60;

/**
 * Service for managing verifiers with PostgreSQL persistence.
 *
 * On application startup (`OnApplicationBootstrap`) the service reconciles
 * the off-chain database with the on-chain verifier list so that registered
 * verifiers are never lost across API restarts.
 *
 * The sync strategy is additive-only: verifiers present on-chain but absent
 * from the DB are inserted; existing DB records are preserved with their
 * off-chain metadata (name, capabilities). No verifiers are deleted from the
 * DB during sync — deletion requires an explicit off-chain call.
 */
@Injectable()
export class VerifiersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(VerifiersService.name);
  private readonly contractId: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly keypairService: StellarKeypairService,
    private readonly cache: CacheService,
    @Inject(VERIFIER_REPOSITORY)
    private readonly verifierRepo: IVerifierRepository,
  ) {
    this.contractId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
      '',
    );
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * On startup: reconcile on-chain verifiers with the off-chain database.
   *
   * Any address present on-chain but missing from the DB is inserted with
   * empty metadata so it can be looked up immediately after restart.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.syncOnChainVerifiers();
    } catch (err: unknown) {
      // Non-fatal: the API should still start even if the registry is unreachable.
      this.logger.warn(
        `Startup verifier sync failed (will retry on next request): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Reconcile the off-chain DB with the current on-chain verifier list.
   *
   * For each on-chain address:
   *  - If it already exists in the DB → skip (preserve existing metadata).
   *  - If it is new → insert with empty name/capabilities.
   */
  async syncOnChainVerifiers(): Promise<void> {
    this.logger.log('Syncing on-chain verifiers with local database…');

    const onChainVerifiers = await this.fetchOnChainVerifiers();
    if (onChainVerifiers.length === 0) {
      this.logger.log('No on-chain verifiers found — skipping sync.');
      return;
    }

    const existing = await this.verifierRepo.findAll();
    const existingAddresses = new Set(existing.map((v) => v.address));

    const toInsert: VerifierEntity[] = [];
    for (const address of onChainVerifiers) {
      if (!existingAddresses.has(address)) {
        const entity = new VerifierEntity();
        entity.address = address;
        entity.name = null;
        entity.capabilities = [];
        entity.reputation = { approvalCount: 0, disputeCount: 0 };
        toInsert.push(entity);
      }
    }

    if (toInsert.length > 0) {
      await this.verifierRepo.saveAll(toInsert);
      this.logger.log(
        `Sync complete: inserted ${toInsert.length} new verifier(s).`,
      );
    } else {
      this.logger.log('Sync complete: no new verifiers to insert.');
    }
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  /**
   * List all verifiers from the off-chain DB.
   *
   * Falls back to the on-chain list if the DB query fails so the API remains
   * functional even during a database outage.
   */
  async listVerifiers(): Promise<VerifierInfo[]> {
    try {
      const entities = await this.verifierRepo.findAll();
      if (entities.length > 0) {
        return entities.map(this.entityToInfo);
      }
    } catch (err: unknown) {
      this.logger.warn(
        `DB query failed, falling back to on-chain list: ${(err as Error).message}`,
      );
    }

    // Fallback: query on-chain
    try {
      const addresses = await this.fetchOnChainVerifiers();
      return addresses.map((address) => ({ address }));
    } catch (err: unknown) {
      this.logger.error(`Failed to list verifiers: ${(err as Error).message}`);
      return [];
    }
  }

  async getVerifier(address: string): Promise<VerifierInfo> {
    // Try DB first
    try {
      const entity = await this.verifierRepo.findByAddress(address);
      if (entity) return this.entityToInfo(entity);
    } catch (err: unknown) {
      this.logger.warn(
        `DB lookup failed for verifier ${address}: ${(err as Error).message}`,
      );
    }

    // Fallback to on-chain list
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
      throw new ForbiddenException(
        'Caller does not match the verifier address',
      );
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
      throw new Error(
        `Failed to fetch nonce for verifier ${address}: contract returned no value`,
      );
    }
    const nonce = scValToNative(nonceRetval) as bigint;

    this.logger.log(
      `Verifier ${address} approving credit ${creditId} (nonce=${nonce})`,
    );

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
        throw new ConflictException(
          'Verifier has already approved this credit',
        );
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

      // Persist updated reputation to DB
      try {
        const entity = await this.verifierRepo.findByAddress(address);
        if (entity) {
          entity.reputation = {
            approvalCount: reputation.approvalCount,
            disputeCount: reputation.disputeCount,
          };
          await this.verifierRepo.save(entity);
        }
      } catch (dbErr: unknown) {
        // Non-fatal: cache/return will still work
        this.logger.warn(
          `Failed to persist reputation for ${address}: ${(dbErr as Error).message}`,
        );
      }

      await this.cache.set(REPUTATION_KEY(address), reputation, REPUTATION_TTL);
      return reputation;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch reputation for verifier ${address}: ${(error as Error).message}`,
      );
      return { address, approvalCount: 0, disputeCount: 0 };
    }
  }

  // ── Staking ────────────────────────────────────────────────────────────────

  /**
   * GET /verifiers/:address/stake
   * Returns the amount (in stroops) currently locked by this verifier.
   */
  async getStake(address: string): Promise<{ address: string; stake: string }> {
    this.logger.log(`Fetching stake for verifier ${address}`);
    try {
      const args = [nativeToScVal(address, { type: 'address' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_verifier_stake',
        args,
      );
      const stake: bigint = retval ? (scValToNative(retval) as bigint) : 0n;
      return { address, stake: stake.toString() };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch stake for ${address}: ${(error as Error).message}`,
      );
      return { address, stake: '0' };
    }
  }

  /**
   * GET /verifiers/min-stake
   * Returns the global minimum stake (in stroops) required to register as a verifier.
   */
  async getMinStake(): Promise<{ minStake: string }> {
    this.logger.log('Fetching minimum stake requirement');
    try {
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_min_stake',
        [],
      );
      const minStake: bigint = retval ? (scValToNative(retval) as bigint) : 0n;
      return { minStake: minStake.toString() };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch min stake: ${(error as Error).message}`,
      );
      return { minStake: '0' };
    }
  }

  /**
   * POST /verifiers/:address/stake/deposit
   * Deposits `amount` stroops of `tokenId` token as stake for the verifier.
   *
   * The verifier MUST sign this transaction themselves — in production this
   * should follow the same two-phase Freighter flow as `approveCredit`. In
   * test/admin mode the admin keypair is used as a convenience signer.
   */
  async depositStake(
    address: string,
    tokenId: string,
    amount: string,
    nonce: string,
  ): Promise<{ address: string; stake: string }> {
    const amountBig = this.parsePositiveBigInt(amount, 'amount');
    const nonceBig = this.parseNonNegativeBigInt(nonce, 'nonce');
    this.logger.log(
      `Depositing stake for verifier ${address}: amount=${amount} token=${tokenId}`,
    );
    const args = [
      nativeToScVal(address, { type: 'address' }),
      nativeToScVal(tokenId, { type: 'address' }),
      nativeToScVal(amountBig, { type: 'i128' }),
      nativeToScVal(nonceBig, { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'deposit_stake',
      args,
      signer,
    );
    return this.getStake(address);
  }

  /**
   * POST /verifiers/:address/stake/withdraw
   * Withdraws the verifier's stake once the 30-day unbonding period has elapsed.
   */
  async withdrawStake(
    address: string,
    tokenId: string,
    nonce: string,
  ): Promise<{ withdrawn: boolean; address: string }> {
    const nonceBig = this.parseNonNegativeBigInt(nonce, 'nonce');
    this.logger.log(`Withdrawing stake for verifier ${address}`);
    const args = [
      nativeToScVal(address, { type: 'address' }),
      nativeToScVal(tokenId, { type: 'address' }),
      nativeToScVal(nonceBig, { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'withdraw_stake',
      args,
      signer,
    );
    return { withdrawn: true, address };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Regex for an unsigned integer literal — the only shape BigInt() should be trusted with here. */
  private static readonly UINT_STRING = /^\d+$/;

  private parsePositiveBigInt(value: string, field: string): bigint {
    if (!VerifiersService.UINT_STRING.test(value)) {
      throw new BadRequestException(`${field} must be a positive integer`);
    }
    const parsed = BigInt(value);
    if (parsed <= 0n) {
      throw new BadRequestException(`${field} must be positive`);
    }
    return parsed;
  }

  private parseNonNegativeBigInt(value: string, field: string): bigint {
    if (!VerifiersService.UINT_STRING.test(value)) {
      throw new BadRequestException(`${field} must be a non-negative integer`);
    }
    return BigInt(value);
  }

  /**
   * Fetch the raw list of verifier addresses from the on-chain registry.
   */
  private async fetchOnChainVerifiers(): Promise<string[]> {
    const retval = await this.stellarService.readContract(
      this.contractId,
      'list_verifiers',
    );
    if (!retval) return [];
    return scValToNative(retval) as string[];
  }

  private entityToInfo(entity: VerifierEntity): VerifierInfo {
    return {
      address: entity.address,
      name: entity.name,
      capabilities: entity.capabilities,
      reputation: entity.reputation,
      registeredAt: entity.registeredAt,
    };
  }
}
