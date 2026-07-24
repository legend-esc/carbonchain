import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { scValToNative, nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { CreditMetadata, CreditStatus } from '../../../shared';
import { CreditEntity } from './credit.entity';
import type { ICreditRepository, PageResult } from './credit.repository';
import { CREDIT_REPOSITORY } from './credit.repository';
import { CacheService } from '../common/cache.service';
import { IssueCreditDto } from './dto/issue-credit.dto';

// Cache key helpers
const CREDIT_KEY = (id: string) => `credits:${id}`;
const LIST_CREDITS_KEY = (filter: string) => `credits:list:${filter}`;
const CREDIT_TTL = 120; // seconds

interface ListCreditsFilter {
  methodology?: string;
  geography?: string;
  vintageYear?: number;
  status?: string;
  minTonnes?: string;
  maxTonnes?: string;
  page: number;
  limit: number;
}

@Injectable()
export class CreditsService {
  private readonly logger = new Logger(CreditsService.name);
  private readonly contractId: string;

  constructor(
    private stellarService: StellarService,
    private configService: ConfigService,
    private keypairService: StellarKeypairService,
    @Inject(CREDIT_REPOSITORY) private readonly creditRepo: ICreditRepository,
    private readonly cache: CacheService,
  ) {
    this.contractId =
      this.configService.get<string>('CREDIT_REGISTRY_CONTRACT_ID') || '';
  }

  async issueCredit(dto: IssueCreditDto): Promise<{ creditId: string }> {
    this.logger.log(`Issuing credit for project ${dto.projectId}`);
    const args = [
      nativeToScVal(dto.issuerPublicKey, { type: 'address' }),
      nativeToScVal(dto.projectId, { type: 'string' }),
      nativeToScVal(dto.vintageYear, { type: 'u32' }),
      nativeToScVal(dto.methodology, { type: 'string' }),
      nativeToScVal(dto.geography, { type: 'string' }),
      nativeToScVal(BigInt(dto.tonnes), { type: 'i128' }),
      nativeToScVal(dto.ipfsHash, { type: 'string' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    const response = await this.stellarService.invokeContract(
      this.contractId,
      'submit_credit',
      args,
      signer,
    );
    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const creditId = rv
      ? Buffer.from(
          scValToNative(
            rv as Parameters<typeof scValToNative>[0],
          ) as Uint8Array,
        ).toString('hex')
      : 'unknown';

    // Persist to off-chain index
    const entity = new CreditEntity();
    entity.id = creditId;
    entity.projectId = dto.projectId;
    entity.issuer = dto.issuerPublicKey;
    entity.vintageYear = dto.vintageYear;
    entity.methodology = dto.methodology;
    entity.geography = dto.geography;
    entity.tonnes = dto.tonnes;
    entity.ipfsHash = dto.ipfsHash;
    entity.owner = dto.issuerPublicKey;
    entity.status = CreditStatus.Pending;
    entity.issuedAt = Math.floor(Date.now() / 1000);
    await this.creditRepo.save(entity);

    return { creditId };
  }

  async getCredit(creditId: string): Promise<CreditMetadata> {
    // 1. Try Redis cache
    const cached = await this.cache.get<CreditMetadata>(CREDIT_KEY(creditId));
    if (cached) {
      this.logger.debug(`Cache HIT for credit ${creditId}`);
      return cached;
    }

    // 2. Try off-chain index
    const indexed = await this.creditRepo.findById(creditId);
    if (indexed) {
      const metadata = this.entityToMetadata(indexed);
      await this.cache.set(CREDIT_KEY(creditId), metadata, CREDIT_TTL);
      return metadata;
    }

    // 3. Fall back to on-chain read
    try {
      this.logger.log(`Fetching credit metadata for ID: ${creditId}`);
      const args = [
        nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      ];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_credit',
        args,
      );
      if (!retval)
        throw new NotFoundException(
          `Credit with ID ${creditId} not found on-chain`,
        );
      const native = scValToNative(retval);
      const metadata = this.mapToCreditMetadata(creditId, native);
      await this.cache.set(CREDIT_KEY(creditId), metadata, CREDIT_TTL);
      return metadata;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch credit ${creditId}: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  async getBulkCredits(creditIds: string[]): Promise<CreditMetadata[]> {
    if (!creditIds || creditIds.length === 0) {
      throw new BadRequestException('Credit IDs array cannot be empty');
    }
    if (creditIds.length > 100) {
      throw new BadRequestException('Maximum 100 credits per bulk request');
    }

    this.logger.log(`Fetching ${creditIds.length} credits in bulk`);
    const results: CreditMetadata[] = [];

    for (const creditId of creditIds) {
      try {
        const credit = await this.getCredit(creditId);
        results.push(credit);
      } catch (error: unknown) {
        this.logger.warn(
          `Failed to fetch credit ${creditId}: ${(error as Error).message}`,
        );
      }
    }

    return results;
  }

  async listCredits(filter: ListCreditsFilter): Promise<{
    data: CreditMetadata[];
    total: number;
    page: number;
    limit: number;
  }> {
    // Default to Active-only when no status is requested, so Retired and Flagged
    // credits are never included unless the caller explicitly opts in.
    if (!filter.status) {
      filter.status = CreditStatus.Active;
    }

    const cacheKey = LIST_CREDITS_KEY(JSON.stringify(filter));
    const cachedResult = await this.cache.get<{
      data: CreditMetadata[];
      total: number;
      page: number;
      limit: number;
    }>(cacheKey);
    if (cachedResult) {
      this.logger.debug(`Cache HIT for list credits`);
      return cachedResult;
    }

    // Push structured filters to the repository so it can apply them at the
    // storage layer rather than fetching every record into memory first.
    const repoFilter: import('./credit.repository').CreditFilter = {
      status: filter.status as CreditStatus | undefined,
      methodology: filter.methodology,
      geography: filter.geography,
      vintageYear: filter.vintageYear,
    };

    let repoResult: PageResult<CreditEntity>;
    try {
      repoResult = await this.creditRepo.findByFilter(
        repoFilter,
        filter.page,
        filter.limit,
      );
    } catch (err) {
      this.logger.warn(
        `Failed to fetch credits from repo: ${(err as Error).message}`,
      );
      repoResult = {
        data: [],
        total: 0,
        page: filter.page,
        limit: filter.limit,
      };
    }

    // Apply tonnes range filters post-fetch (not yet part of CreditFilter interface).
    let data = repoResult.data.map((e) => this.entityToMetadata(e));

    if (filter.minTonnes) {
      const minVal = BigInt(filter.minTonnes);
      data = data.filter((c) => BigInt(c.tonnes) >= minVal);
    }

    if (filter.maxTonnes) {
      const maxVal = BigInt(filter.maxTonnes);
      data = data.filter((c) => BigInt(c.tonnes) <= maxVal);
    }

    const result = {
      data,
      total: repoResult.total,
      page: filter.page,
      limit: filter.limit,
    };
    await this.cache.set(cacheKey, result, CREDIT_TTL);
    return result;
  }

  /**
   * Get the full lifecycle/provenance of a credit including all lifecycle events.
   * Returns ordered events showing submit → approval → transfers → retirement.
   */
  async getCreditProvenance(creditId: string): Promise<
    Array<{
      action: string;
      actor: string;
      timestamp: number;
      txHash: string;
    }>
  > {
    this.logger.log(`Fetching provenance for credit ${creditId}`);

    try {
      // Fetch all events from the credit registry contract
      const events = await this.stellarService.getContractEvents(
        this.contractId,
      );

      const creditIdHex = creditId.toLowerCase();
      const provenanceEvents: Array<{
        action: string;
        actor: string;
        timestamp: number;
        txHash: string;
        ledger: number; // for sorting
      }> = [];

      for (const event of events) {
        const eventType = this.parseEventType(event);
        // Decode the event value: real events carry xdr.ScVal, test stubs may carry plain objects.
        let data: Record<string, unknown> = {};
        if (event.value) {
          try {
            data = scValToNative(event.value) as Record<string, unknown>;
          } catch {
            // Fallback for plain-object stubs (e.g. in unit tests)
            data = event.value as unknown as Record<string, unknown>;
          }
        }

        // Map events to provenance records
        if (eventType === 'CreditSubmitted') {
          const creditIdData = data.credit_id as string | undefined;
          if (
            creditIdData &&
            creditIdData.toLowerCase().includes(creditIdHex)
          ) {
            provenanceEvents.push({
              action: 'Submitted',
              actor: String(
                typeof data.issuer === 'string' ? data.issuer : 'unknown',
              ),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditMinted') {
          const creditIdData = data.id as string | undefined;
          if (
            creditIdData &&
            creditIdData.toLowerCase().includes(creditIdHex)
          ) {
            provenanceEvents.push({
              action: 'Approved',
              actor: String(
                typeof data.verifier === 'string' ? data.verifier : 'unknown',
              ),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditTransferred') {
          const creditIdData = data.credit_id as string | undefined;
          if (
            creditIdData &&
            creditIdData.toLowerCase().includes(creditIdHex)
          ) {
            provenanceEvents.push({
              action: 'Transferred',
              actor: String(
                typeof data.from === 'string' ? data.from : 'unknown',
              ),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditRetired') {
          // CreditRetired events come from retirement contract
          const creditIdData = data.credit_id as string | undefined;
          if (
            creditIdData &&
            creditIdData.toLowerCase().includes(creditIdHex)
          ) {
            provenanceEvents.push({
              action: 'Retired',
              actor: String(
                typeof data.buyer === 'string' ? data.buyer : 'unknown',
              ),
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        } else if (eventType === 'CreditFlagged') {
          const creditIdData = data.id as string | undefined;
          if (
            creditIdData &&
            creditIdData.toLowerCase().includes(creditIdHex)
          ) {
            provenanceEvents.push({
              action: 'Flagged',
              actor: 'system',
              timestamp: this.parseEventTimestamp(event),
              txHash: event.txHash || '',
              ledger: event.ledger || 0,
            });
          }
        }
      }

      // Sort by ledger (timestamp) to maintain chronological order
      provenanceEvents.sort((a, b) => a.ledger - b.ledger);

      if (provenanceEvents.length === 0) {
        throw new NotFoundException(
          `No provenance events found for credit ${creditId}`,
        );
      }

      // Remove the temporary ledger field before returning
      return provenanceEvents.map(({ ledger, ...rest }) => rest);
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch provenance for credit ${creditId}: ${(error as Error).message}`,
      );
      throw new NotFoundException(
        `Could not retrieve provenance for credit ${creditId}`,
      );
    }
  }

  /**
   * Invalidate all cached entries for a specific credit and the list cache.
   * Call this whenever a credit's status changes (approve, retire, flag).
   */
  async invalidateCreditCache(creditId: string): Promise<void> {
    await this.cache.del(CREDIT_KEY(creditId));
    await this.cache.delPattern('credits:list:*');
    this.logger.debug(`Cache invalidated for credit ${creditId}`);
  }

  async listCreditsByProject(projectId: string): Promise<string[]> {
    try {
      this.logger.log(`Listing credits for project: ${projectId}`);
      const args = [nativeToScVal(projectId, { type: 'string' })];
      const retval = await this.stellarService.readContract(
        this.contractId,
        'list_credits_by_project',
        args,
      );
      if (!retval) return [];
      const native = scValToNative(retval) as Buffer[];
      return native.map((buf) => buf.toString('hex'));
    } catch (error: unknown) {
      this.logger.error(
        `Failed to list credits for project ${projectId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  private parseEventType(event: rpc.Api.EventResponse): string {
    const topics = event.topic ?? [];
    if (topics.length > 0) {
      const firstTopic = topics[0];
      if (typeof firstTopic === 'string') {
        return firstTopic;
      }
    }
    return 'unknown';
  }

  private parseEventTimestamp(event: rpc.Api.EventResponse): number {
    // closedAt is not part of the typed interface; fall back to Date.now()
    const raw = (event as unknown as Record<string, unknown>).closedAt;
    if (typeof raw === 'number' || typeof raw === 'string') {
      return Math.floor(Number(raw) / 1000);
    }
    return Math.floor(Date.now() / 1000);
  }

  async transferCredit(
    creditId: string,
    to: string,
    caller: string,
    nonce: number,
  ): Promise<CreditMetadata> {
    this.logger.log(`Transferring credit ${creditId} to ${to} by ${caller}`);

    const credit = await this.getCredit(creditId);
    if (credit.owner !== caller) {
      throw new BadRequestException('Caller does not own this credit');
    }

    const args = [
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(to, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'transfer_credit',
      args,
      signer,
    );

    const entity = await this.creditRepo.findById(creditId);
    if (entity) {
      entity.owner = to;
      await this.creditRepo.save(entity);
    }

    await this.invalidateCreditCache(creditId);

    return this.getCredit(creditId);
  }

  async splitCredit(
    creditId: string,
    splitTonnes: string,
    caller: string,
    nonce: number,
  ): Promise<{ childCredit1: string; childCredit2: string }> {
    this.logger.log(
      `Splitting credit ${creditId} with ${splitTonnes} tonnes by ${caller}`,
    );

    const credit = await this.getCredit(creditId);
    if (credit.owner !== caller) {
      throw new BadRequestException('Caller does not own this credit');
    }

    const args = [
      nativeToScVal(caller, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(splitTonnes), { type: 'i128' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    const response = await this.stellarService.invokeContract(
      this.contractId,
      'split_credit',
      args,
      signer,
    );
    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const native = rv
      ? (scValToNative(rv as Parameters<typeof scValToNative>[0]) as {
          child1: Uint8Array;
          child2: Uint8Array;
        })
      : null;
    const childCredit1 = native
      ? Buffer.from(native.child1).toString('hex')
      : '';
    const childCredit2 = native
      ? Buffer.from(native.child2).toString('hex')
      : '';

    // Mark the original as retired in the off-chain index
    const originalEntity = await this.creditRepo.findById(creditId);
    if (originalEntity) {
      originalEntity.status = CreditStatus.Retired;
      await this.creditRepo.save(originalEntity);
    }

    // Issue #471: Read the on-chain child metadata to get the authoritative
    // owner field rather than inferring it from `caller`.
    // The contract's split_credit sets child.owner = caller, but we must not
    // assume that here — we read back from chain so the off-chain index always
    // reflects the on-chain truth.
    let child1OnChain: CreditMetadata | null = null;
    let child2OnChain: CreditMetadata | null = null;

    if (childCredit1) {
      try {
        child1OnChain = await this.getCredit(childCredit1);
      } catch {
        this.logger.warn(
          `Could not read child1 ${childCredit1} from chain, falling back to caller`,
        );
      }
    }
    if (childCredit2) {
      try {
        child2OnChain = await this.getCredit(childCredit2);
      } catch {
        this.logger.warn(
          `Could not read child2 ${childCredit2} from chain, falling back to caller`,
        );
      }
    }

    const child1Owner = child1OnChain?.owner ?? caller;
    const child2Owner = child2OnChain?.owner ?? caller;

    const child1 = new CreditEntity();
    child1.id = childCredit1;
    child1.projectId = credit.project_id;
    child1.issuer = credit.issuer;
    child1.owner = child1Owner;
    child1.vintageYear = credit.vintage_year;
    child1.methodology = credit.methodology;
    child1.geography = credit.geography;
    child1.tonnes = splitTonnes;
    child1.ipfsHash = credit.ipfs_hash;
    child1.status = CreditStatus.Active;
    child1.issuedAt = Math.floor(Date.now() / 1000);
    await this.creditRepo.save(child1);

    const remainingTonnes = String(BigInt(credit.tonnes) - BigInt(splitTonnes));
    const child2 = new CreditEntity();
    child2.id = childCredit2;
    child2.projectId = credit.project_id;
    child2.issuer = credit.issuer;
    child2.owner = child2Owner;
    child2.vintageYear = credit.vintage_year;
    child2.methodology = credit.methodology;
    child2.geography = credit.geography;
    child2.tonnes = remainingTonnes;
    child2.ipfsHash = credit.ipfs_hash;
    child2.status = CreditStatus.Active;
    child2.issuedAt = Math.floor(Date.now() / 1000);
    await this.creditRepo.save(child2);

    await this.invalidateCreditCache(creditId);
    await this.invalidateCreditCache(childCredit1);
    await this.invalidateCreditCache(childCredit2);

    return { childCredit1, childCredit2 };
  }

  // ── Issue #485: Credit expiry ─────────────────────────────────────────────

  /**
   * POST /api/v1/credits/:id/expire
   *
   * Transition an Active (or Disputed) credit to Expired on-chain by calling
   * `expire_credit` on the credit registry contract.  Only the admin may call
   * this endpoint.
   *
   * The contract enforces:
   *   - Credit must be Active or Disputed (not Retired / Flagged / already Expired).
   *   - Caller must be the registered contract admin.
   *
   * On success the off-chain index is updated and caches are invalidated.
   */
  async expireCredit(
    creditId: string,
    adminPublicKey: string,
  ): Promise<{ creditId: string; status: CreditStatus }> {
    this.logger.log(`Expiring credit ${creditId} by admin ${adminPublicKey}`);

    const args = [
      nativeToScVal(adminPublicKey, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'expire_credit',
      args,
      signer,
    );

    // Update off-chain index
    const entity = await this.creditRepo.findById(creditId);
    if (entity) {
      entity.status = CreditStatus.Expired;
      await this.creditRepo.save(entity);
    }

    await this.invalidateCreditCache(creditId);

    return { creditId, status: CreditStatus.Expired };
  }

  // ── Issue #486: Credit dispute lifecycle ──────────────────────────────────

  /**
   * POST /api/v1/credits/:id/dispute
   *
   * Transition an Active credit to Disputed on-chain and store the evidence
   * IPFS hash.  Any verifier (or the credit owner) may raise a dispute.
   *
   * Contract enforces:
   *   - Credit must not already be Retired or Disputed.
   *   - `dispute_credit` stores evidence in DataKey::Dispute(credit_id).
   *   - CreditDisputed event is emitted.
   */
  async disputeCredit(
    creditId: string,
    disputerPublicKey: string,
    evidenceIpfsHash: string,
  ): Promise<{ creditId: string; status: CreditStatus }> {
    this.logger.log(
      `Disputing credit ${creditId} by ${disputerPublicKey} with evidence ${evidenceIpfsHash}`,
    );

    const args = [
      nativeToScVal(disputerPublicKey, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(evidenceIpfsHash, { type: 'string' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'dispute_credit',
      args,
      signer,
    );

    // Update off-chain index
    const entity = await this.creditRepo.findById(creditId);
    if (entity) {
      entity.status = CreditStatus.Disputed;
      await this.creditRepo.save(entity);
    }

    await this.invalidateCreditCache(creditId);

    return { creditId, status: CreditStatus.Disputed };
  }

  /**
   * POST /api/v1/credits/:id/resolve
   *
   * Resolve a disputed credit.  Only the admin may call this.
   *
   * Outcome codes (mirror the contract):
   *   0 → Active   (dispute upheld, credit reinstated)
   *   1 → Flagged  (dispute escalated)
   *   2 → Retired  (credit revoked)
   *
   * Contract enforces:
   *   - Credit must be in Disputed status.
   *   - Caller must be the registered contract admin.
   *   - DisputeResolved event is emitted; dispute evidence entry is removed.
   */
  async resolveDispute(
    creditId: string,
    adminPublicKey: string,
    outcome: number,
  ): Promise<{ creditId: string; status: CreditStatus; outcome: number }> {
    this.logger.log(
      `Resolving dispute for credit ${creditId} with outcome ${outcome} by admin ${adminPublicKey}`,
    );

    const args = [
      nativeToScVal(adminPublicKey, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(outcome, { type: 'u32' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    await this.stellarService.invokeContract(
      this.contractId,
      'resolve_dispute',
      args,
      signer,
    );

    // Map the numeric outcome to the resulting CreditStatus for the off-chain index.
    const outcomeStatus: CreditStatus =
      outcome === 0
        ? CreditStatus.Active
        : outcome === 1
          ? CreditStatus.Flagged
          : CreditStatus.Retired;

    const entity = await this.creditRepo.findById(creditId);
    if (entity) {
      entity.status = outcomeStatus;
      await this.creditRepo.save(entity);
    }

    await this.invalidateCreditCache(creditId);

    return { creditId, status: outcomeStatus, outcome };
  }

  // ── Issue #487: Credit merging ────────────────────────────────────────────

  /**
   * POST /api/v1/credits/merge
   *
   * Merge 2–20 Active credits owned by the same caller into a single new
   * credit whose tonnes equals the sum of all inputs.  Input credits are
   * consumed (set to Retired) and a new Active credit is created.
   *
   * Contract enforces:
   *   - All inputs must be Active and owned by `callerPublicKey`.
   *   - All inputs must share project_id, vintage_year, methodology, geography.
   *   - Maximum 20 credits per call (instruction-budget).
   *   - CreditsMerged event is emitted.
   */
  async mergeCredits(
    callerPublicKey: string,
    creditIds: string[],
  ): Promise<{ mergedCreditId: string; sourceCount: number }> {
    this.logger.log(
      `Merging ${creditIds.length} credits for caller ${callerPublicKey}`,
    );

    if (creditIds.length < 2 || creditIds.length > 20) {
      throw new BadRequestException(
        'merge_credits requires between 2 and 20 credit IDs',
      );
    }

    // Build contract args: (caller: Address, credit_ids: Vec<BytesN<32>>)
    const cleanArgs = [
      nativeToScVal(callerPublicKey, { type: 'address' }),
      nativeToScVal(
        creditIds.map((id) => Buffer.from(id, 'hex')),
        { type: 'vec' },
      ),
    ];

    const signer = this.keypairService.getAdminKeypair();
    const response = await this.stellarService.invokeContract(
      this.contractId,
      'merge_credits',
      cleanArgs,
      signer,
    );

    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const mergedCreditId = rv
      ? Buffer.from(
          scValToNative(
            rv as Parameters<typeof scValToNative>[0],
          ) as Uint8Array,
        ).toString('hex')
      : 'unknown';

    // Mark all source credits as Retired in the off-chain index.
    for (const id of creditIds) {
      const entity = await this.creditRepo.findById(id);
      if (entity) {
        entity.status = CreditStatus.Retired;
        await this.creditRepo.save(entity);
      }
      await this.invalidateCreditCache(id);
    }

    // Index the new merged credit by reading it back from chain.
    if (mergedCreditId !== 'unknown') {
      try {
        const merged = await this.getCredit(mergedCreditId);
        const mergedEntity = new CreditEntity();
        mergedEntity.id = mergedCreditId;
        mergedEntity.projectId = merged.project_id;
        mergedEntity.issuer = merged.issuer;
        mergedEntity.owner = merged.owner;
        mergedEntity.vintageYear = merged.vintage_year;
        mergedEntity.methodology = merged.methodology;
        mergedEntity.geography = merged.geography;
        mergedEntity.tonnes = merged.tonnes;
        mergedEntity.ipfsHash = merged.ipfs_hash;
        mergedEntity.status = CreditStatus.Active;
        mergedEntity.issuedAt = Math.floor(Date.now() / 1000);
        await this.creditRepo.save(mergedEntity);
      } catch (err) {
        this.logger.warn(
          `Could not index merged credit ${mergedCreditId}: ${(err as Error).message}`,
        );
      }
    }

    return { mergedCreditId, sourceCount: creditIds.length };
  }

  private mapToCreditMetadata(id: string, native: any): CreditMetadata {
    return {
      id,
      project_id: String(native.project_id),
      issuer: String(native.issuer),
      owner: String(native.owner ?? native.issuer),
      vintage_year: Number(native.vintage_year),
      methodology: String(native.methodology),
      geography: String(native.geography),
      tonnes: String(native.tonnes),
      ipfs_hash: String(native.ipfs_hash),
      status: native.status as CreditStatus,
      issued_at: Number(native.issued_at),
    };
  }

  private entityToMetadata(entity: CreditEntity): CreditMetadata {
    return {
      id: entity.id,
      project_id: entity.projectId,
      issuer: entity.issuer,
      owner: entity.owner,
      vintage_year: entity.vintageYear,
      methodology: entity.methodology,
      geography: entity.geography,
      tonnes: entity.tonnes,
      ipfs_hash: entity.ipfsHash,
      status: entity.status,
      issued_at: entity.issuedAt,
    };
  }
}
