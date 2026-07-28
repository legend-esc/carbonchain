import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { CreditStatus, RetirementRecord } from '../../../shared';
import { RetirementEntity } from './retirement.entity';
import type { IRetirementRepository } from './retirement.repository';
import { RETIREMENT_REPOSITORY } from './retirement.repository';
import { PageResult } from '../credits/credit.repository';
import { NonceService } from '../common/nonce.service';
import type { ICreditRepository } from '../credits/credit.repository';
import { CREDIT_REPOSITORY, PageResult } from '../credits/credit.repository';
import { RetireDto, FullRetireDto } from './dto/retire.dto';
import { BatchRetireDto } from './dto/batch-retire.dto';

export const MAX_BATCH_SIZE = 10;

export class RetireDto {
  buyerPublicKey: string;
  creditId: string;
  tonnes: string;
  reason: string;
  /** Optional nonce for API-layer replay-attack deduplication (#415). */
  nonce?: string;
}

export class BatchRetireDto {
  buyerPublicKey: string;
  creditIds: string[];
  tonnes: string[];
  reason: string;
export interface BatchRetireResult {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

export interface CertificateVerification {
  id: string;
  credit_id: string;
  buyer: string;
  tonnes_retired: string;
  reason: string;
  retired_at: number;
  tx_hash: string;
  verified: boolean;
  ledger_sequence?: number;
  /** Issue #544 — IPFS hash of the certificate PDF as committed on-chain. */
  certificate_ipfs_hash?: string;
}

/** Payload carried by the CreditRetired application event. */
export interface CreditRetiredEvent {
  retirementId: string;
  creditId: string;
  buyer: string;
  tonnesRetired: string;
  retiredAt: number;
}

/**
 * Minimal event-emitter interface so the service can be tested without a full
 * NestJS EventEmitter2 module.  In production the real EventEmitter2 instance
 * is injected; in tests a simple stub is used.
 */
export interface IEventEmitter {
  emit(event: string, payload: unknown): boolean;
}

export const EVENT_EMITTER = 'EVENT_EMITTER';

@Injectable()
export class RetirementService {
  private readonly logger = new Logger(RetirementService.name);
  private readonly retirementContractId: string;
  private readonly registryContractId: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    private readonly configService: ConfigService,
    @Inject(RETIREMENT_REPOSITORY)
    private readonly retirementRepo: IRetirementRepository,
    @Inject(CREDIT_REPOSITORY)
    private readonly creditRepo: ICreditRepository,
    @Inject(EVENT_EMITTER) private readonly eventEmitter: IEventEmitter,
    private readonly nonceService?: NonceService,
    @Optional() private readonly certificateService?: CertificateService,
  ) {
    this.retirementContractId = this.configService.get<string>(
      'RETIREMENT_CONTRACT_ID',
      '',
    );
    this.registryContractId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
      '',
    );
  }

  /**
   * Retire a credit via POST /credits/:id/retire.
   * Validates off-chain index state before submitting the on-chain transaction.
   */
  async retireCredit(
    creditId: string,
    dto: RetireDto,
    buyerPublicKey: string,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    const credit = await this.creditRepo.findById(creditId);
    if (!credit) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }
    if (credit.status !== CreditStatus.Active) {
      throw new ConflictException(
        `Credit ${creditId} is not active (status: ${credit.status})`,
      );
    }

    const result = await this.retire({
      buyerPublicKey,
      creditId,
      tonnes: credit.tonnes,
      reason: dto.reason,
      nonce: dto.nonce,
    });

    credit.status = CreditStatus.Retired;
    await this.creditRepo.save(credit);

    return result;
  }

  /**
   * Retire a carbon credit on-chain and persist the retirement record
   * to the off-chain index.
   *
   * ## Event ordering guarantee
   * The `CreditRetired` application event is emitted **only after** the
   * retirement record has been successfully written to the repository.
   * This prevents off-chain indexers from recording a retirement that does
   * not yet exist in storage if the write were to fail.
   *
   * Sequence:
   *   1. Invoke the on-chain `retire` contract function.
   *   2. Persist the `RetirementEntity` to the repository.
   *   3. Emit the `CreditRetired` application event.
   */
  async retire(
    dto: FullRetireDto,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    this.logger.log(
      `Retiring credit ${dto.creditId} for ${dto.buyerPublicKey}`,
    );

    // ── #415: API-layer nonce deduplication ───────────────────────────────────
    // Claim the nonce in Redis before submitting the transaction on-chain.
    // A duplicate nonce within the Stellar ledger close window returns 409.
    if (dto.nonce !== undefined && this.nonceService) {
      await this.nonceService.consumeNonce(dto.buyerPublicKey, dto.nonce);
    }

    const args = [
      nativeToScVal(dto.buyerPublicKey, { type: 'address' }),
      nativeToScVal(Buffer.from(dto.creditId, 'hex'), { type: 'bytes' }),
      nativeToScVal(BigInt(dto.tonnes), { type: 'i128' }),
      nativeToScVal(dto.reason, { type: 'string' }),
      nativeToScVal(this.registryContractId, { type: 'address' }),
      nativeToScVal(BigInt(dto.nonce ?? 0), { type: 'u64' }),
    ];

    const signer = this.keypairService.getAdminKeypair();
    let response;
    try {
      response = await this.stellarService.invokeContract(
        this.retirementContractId,
        'retire',
        args,
        signer,
      );
    } catch (error: unknown) {
      // Handle contract paused error (error code 123)
      const errorMessage = (error as Error).message || '';
      if (errorMessage.includes('123') || errorMessage.includes('paused')) {
        throw new ServiceUnavailableException({
          error: 'Contract is currently paused',
        });
      }
      throw error;
    }

    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const retirementId = rv
      ? Buffer.from(
          scValToNative(
            rv as Parameters<typeof scValToNative>[0],
          ) as Uint8Array,
        ).toString('hex')
      : 'unknown';

    const txHash = (response as rpc.Api.GetTransactionResponse).hash || '';

    // ── Step 1: Persist to off-chain index ───────────────────────────────────
    // The record MUST be written before the CreditRetired event is emitted.
    // If this write throws, the event is never emitted and the caller receives
    // an error — keeping on-chain and off-chain state consistent.
    const entity = new RetirementEntity();
    entity.id = retirementId;
    entity.creditId = dto.creditId;
    entity.buyer = dto.buyerPublicKey;
    entity.tonnesRetired = dto.tonnes;
    entity.reason = dto.reason;
    entity.retiredAt = Math.floor(Date.now() / 1000);
    entity.txHash = txHash;
    await this.retirementRepo.save(entity);

    // ── Step 2: Emit CreditRetired event ─────────────────────────────────────
    // Only reached after a successful save, so the record is guaranteed to
    // exist in storage when any listener handles this event.
    const event: CreditRetiredEvent = {
      retirementId,
      creditId: dto.creditId,
      buyer: dto.buyerPublicKey,
      tonnesRetired: dto.tonnes,
      retiredAt: entity.retiredAt,
    };
    this.eventEmitter.emit('CreditRetired', event);

    // ── Step 3: Generate certificate PDF and pin to IPFS (issue #493) ────────
    // CertificateService is optional so RetirementService remains testable
    // without it. Pinata failures are gracefully handled inside
    // generateAndPin() — the retirement succeeds even when IPFS is down.
    let certificateIpfsHash: string | null = null;
    if (this.certificateService) {
      try {
        const result = await this.certificateService.generateAndPin({
          retirementId,
          creditId: dto.creditId,
          buyer: dto.buyerPublicKey,
          tonnes: dto.tonnes,
          reason: dto.reason,
          timestamp: entity.retiredAt,
        });
        certificateIpfsHash = result.ipfsHash;

        // ── Issue #544: commit the IPFS hash on-chain ─────────────────────
        // This makes the certificate independently verifiable: anyone can
        // fetch the hash from the contract, download from IPFS, and confirm
        // the content hash matches.  We use the admin keypair and the admin's
        // current nonce.  The call is fire-and-forget with a warning on
        // failure so that a transient RPC error does not roll back the
        // retirement itself.
        try {
          const adminKeypair = this.keypairService.getAdminKeypair();
          const adminPublicKey = adminKeypair.publicKey();
          const adminNonce = await this.stellarService.readContract(
            this.retirementContractId,
            'get_nonce',
            [nativeToScVal(adminPublicKey, { type: 'address' })],
          );
          const nonceValue = adminNonce
            ? BigInt(scValToNative(adminNonce) as number | bigint)
            : 0n;

          await this.stellarService.invokeContract(
            this.retirementContractId,
            'set_certificate_hash',
            [
              nativeToScVal(adminPublicKey, { type: 'address' }),
              nativeToScVal(Buffer.from(retirementId, 'hex'), { type: 'bytes' }),
              nativeToScVal(certificateIpfsHash, { type: 'string' }),
              nativeToScVal(nonceValue, { type: 'u64' }),
            ],
            adminKeypair,
          );

          // Persist the hash to the off-chain index so it is returned in
          // GET /certificates/:id without an additional on-chain read.
          entity.certificateIpfsHash = certificateIpfsHash;
          await this.retirementRepo.save(entity);

          this.logger.log(
            `Certificate hash committed on-chain for retirement ${retirementId}: ${certificateIpfsHash}`,
          );
        } catch (onChainErr) {
          this.logger.warn(
            `Failed to commit certificate hash on-chain for retirement ${retirementId}: ` +
              `${(onChainErr as Error).message}. Hash is in IPFS but not yet on-chain.`,
          );
          // Do not rethrow — retirement already succeeded; on-chain commit can
          // be retried separately via a background job.
        }
      } catch (certErr) {
        this.logger.warn(
          `Certificate generation failed for retirement ${retirementId}: ` +
            `${(certErr as Error).message}`,
        );
        // certificateIpfsHash remains null — retirement still succeeds.
      }
    }

    return { retirementId, certificateIpfsHash: certificateIpfsHash ?? '' };
  }

  /**
   * Retire multiple credits in a single on-chain call.
   * Enforces MAX_BATCH_SIZE before invoking the contract.
   *
   * Persists one RetirementEntity per successful retirement and returns
   * a partial-success shape so callers can distinguish which credits
   * succeeded and which failed.
   *
   * All DB writes are wrapped in a single transaction via saveAll().
   * If the contract reverts, no DB writes occur. If the DB transaction
   * fails after a successful contract call, the entire batch is marked
   * as failed and no events are emitted.
   */
  async batchRetire(dto: BatchRetireDto): Promise<BatchRetireResult> {
    if (dto.creditIds.length > MAX_BATCH_SIZE) {
      throw new BadRequestException(
        `Batch size ${dto.creditIds.length} exceeds maximum allowed (${MAX_BATCH_SIZE})`,
      );
    }
    if (dto.creditIds.length !== dto.tonnes.length) {
      throw new BadRequestException(
        'creditIds and tonnes arrays must have the same length',
      );
    }

    this.logger.log(
      `Batch retiring ${dto.creditIds.length} credits for ${dto.buyerPublicKey}`,
    );

    const creditIdsVal = nativeToScVal(
      dto.creditIds.map((id) => Buffer.from(id, 'hex')),
      { type: 'vec' },
    );
    const tonnesVal = nativeToScVal(
      dto.tonnes.map((t) => BigInt(t)),
      { type: 'vec' },
    );
    const args = [
      nativeToScVal(dto.buyerPublicKey, { type: 'address' }),
      creditIdsVal,
      tonnesVal,
      nativeToScVal(dto.reason, { type: 'string' }),
      nativeToScVal(this.registryContractId, { type: 'address' }),
      nativeToScVal(BigInt(dto.nonce), { type: 'u64' }),
    ];

    const signer = this.keypairService.getAdminKeypair();
    let response;
    try {
      response = await this.stellarService.invokeContract(
        this.retirementContractId,
        'batch_retire',
        args,
        signer,
      );
    } catch (error: unknown) {
      const msg = (error as Error).message || '';
      if (msg.includes('123') || msg.includes('paused')) {
        throw new ServiceUnavailableException({
          error: 'Contract is currently paused',
        });
      }
      throw error;
    }

    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const txHash = (response as rpc.Api.GetTransactionResponse).hash || '';
    const retirementIds: string[] = rv
      ? (scValToNative(rv as Parameters<typeof scValToNative>[0]) as Uint8Array[]).map(
          (b) => Buffer.from(b).toString('hex'),
        )
      : [];

    // Persist batch retirement records with the batch transaction hash
    const now = Math.floor(Date.now() / 1000);
    for (const retirementId of retirementIds) {
      const entity = new RetirementEntity();
      entity.id = retirementId;
      entity.creditId = '';
      entity.buyer = dto.buyerPublicKey;
      entity.tonnesRetired = '';
      entity.reason = dto.reason;
      entity.retiredAt = now;
      entity.txHash = txHash;
      await this.retirementRepo.save(entity);
    }

    return { retirementIds, txHash };

    // The contract now returns BatchRetireResult { succeeded: Vec<BytesN<32>>, failed: Vec<{credit_id, error_code}> }
    let succeededIds: string[] = [];
    let contractFailed: { id: string; reason: string }[] = [];

    if (rv) {
      const native = scValToNative(rv as Parameters<typeof scValToNative>[0]) as {
        succeeded?: Uint8Array[];
        failed?: Array<{ credit_id: Uint8Array; error_code: number }>;
      };

      succeededIds = (native.succeeded ?? []).map((b) =>
        Buffer.from(b).toString('hex'),
      );

      const ERROR_CODE_MAP: Record<number, string> = {
        110: 'CreditNotActive',
        113: 'Unauthorized',
        117: 'InvalidTonnes',
        118: 'InvalidInput',
      };

      contractFailed = (native.failed ?? []).map((f) => ({
        id: Buffer.from(f.credit_id).toString('hex'),
        reason: ERROR_CODE_MAP[f.error_code] ?? `Error(${f.error_code})`,
      }));
    }

    const now = Math.floor(Date.now() / 1000);

    // Build entities only for successfully retired credits
    const entities: RetirementEntity[] = succeededIds.map((retirementId, i) => {
      // Map retirement ID back to original credit ID by index in succeeded list
      // The contract retires credits in input order, skipping failed ones
      const creditId = dto.creditIds[i] ?? '';
      const entity = new RetirementEntity();
      entity.id = retirementId;
      entity.creditId = creditId;
      entity.buyer = dto.buyerPublicKey;
      entity.tonnesRetired = dto.tonnes[i] ?? '0';
      entity.reason = dto.reason;
      entity.retiredAt = now;
      entity.txHash = '';
      return entity;
    });

    // Wrap all DB writes in a single transaction via saveAll().
    // If the saveAll() call fails, no records are persisted and no events are emitted.
    try {
      await this.retirementRepo.saveAll(entities);
    } catch (error: unknown) {
      this.logger.error(
        `Batch DB transaction failed: ${(error as Error).message}. ` +
          `On-chain transaction succeeded but ${entities.length} records were not persisted.`,
      );
      // Return all as failed — the on-chain state succeeded but off-chain state is inconsistent.
      // Callers should reconcile by re-querying on-chain state.
      return {
        succeeded: [],
        failed: [
          ...contractFailed,
          ...dto.creditIds.map((id) => ({
            id,
            reason: `DB transaction failed: ${(error as Error).message}`,
          })),
        ],
      };
    }

    // Emit events only after all records are persisted successfully.
    const succeeded: string[] = [];
    for (let i = 0; i < entities.length; i++) {
      const event: CreditRetiredEvent = {
        retirementId: entities[i].id,
        creditId: entities[i].creditId,
        buyer: entities[i].buyer,
        tonnesRetired: entities[i].tonnesRetired,
        retiredAt: entities[i].retiredAt,
      };
      this.eventEmitter.emit('CreditRetired', event);
      succeeded.push(entities[i].id);
    }

    // Merge contract-reported failures with any additional context
    return {
      succeeded,
      failed: contractFailed,
    };
  }

  async getRetirement(retirementId: string): Promise<RetirementRecord> {
    // Try off-chain index first
    const cached = await this.retirementRepo.findById(retirementId);
    if (cached) return this.entityToRecord(cached);

    // Fall back to on-chain read
    const args = [
      nativeToScVal(Buffer.from(retirementId, 'hex'), { type: 'bytes' }),
    ];
    const retval = await this.stellarService.readContract(
      this.retirementContractId,
      'get_retirement',
      args,
    );
    if (!retval)
      throw new NotFoundException(`Retirement ${retirementId} not found`);

    const n = scValToNative(retval);
    return {
      id: retirementId,
      credit_id: Buffer.from(n.credit_id as Uint8Array).toString('hex'),
      buyer: String(n.buyer),
      tonnes_retired: String(n.tonnes_retired),
      reason: String(n.reason),
      retired_at: Number(n.retired_at),
      tx_hash: '',
    };
  }

  async listRetirements(
    page = 1,
    limit = 20,
  ): Promise<PageResult<RetirementRecord>> {
    const result = await this.retirementRepo.findAll(page, limit);
    return { ...result, data: result.data.map((e) => this.entityToRecord(e)) };
  }

  async getRetirementsByAccount(
    account: string,
    page = 1,
    limit = 20,
  ): Promise<PageResult<RetirementRecord>> {
    const result = await this.retirementRepo.findByBuyer(account, page, limit);
    return { ...result, data: result.data.map((e) => this.entityToRecord(e)) };
  }

  private entityToRecord(e: RetirementEntity): RetirementRecord {
    return {
      id: e.id,
      credit_id: e.creditId,
      buyer: e.buyer,
      tonnes_retired: e.tonnesRetired,
      reason: e.reason,
      retired_at: e.retiredAt,
      tx_hash: e.txHash,
      certificate_ipfs_hash: e.certificateIpfsHash ?? '',
    };
  }

  async verifyCertificate(
    certificateId: string,
  ): Promise<CertificateVerification> {
    try {
      this.logger.log(`Verifying certificate: ${certificateId}`);
      const retirement = await this.getRetirement(certificateId);

      // Issue #544: fetch the on-chain certificate_ipfs_hash so callers can
      // independently verify the certificate PDF by comparing its content hash
      // to the IPFS CID stored in the contract.
      let onChainIpfsHash: string | undefined;
      try {
        const retval = await this.stellarService.readContract(
          this.retirementContractId,
          'get_retirement',
          [nativeToScVal(Buffer.from(certificateId, 'hex'), { type: 'bytes' })],
        );
        if (retval) {
          const native = scValToNative(retval) as Record<string, unknown>;
          onChainIpfsHash =
            typeof native.certificate_ipfs_hash === 'string'
              ? native.certificate_ipfs_hash
              : '';
        }
      } catch (onChainErr) {
        this.logger.warn(
          `Could not fetch on-chain certificate hash for ${certificateId}: ` +
            `${(onChainErr as Error).message}`,
        );
      }

      return {
        id: retirement.id,
        credit_id: retirement.credit_id,
        buyer: retirement.buyer,
        tonnes_retired: retirement.tonnes_retired,
        reason: retirement.reason,
        retired_at: retirement.retired_at,
        tx_hash: retirement.tx_hash || '',
        verified: true,
        certificate_ipfs_hash: onChainIpfsHash ?? retirement.certificate_ipfs_hash ?? '',
      };
    } catch (error: unknown) {
      this.logger.error(
        `Failed to verify certificate ${certificateId}: ${(error as Error).message}`,
      );
      throw new NotFoundException(
        `Certificate ${certificateId} not found or cannot be verified`,
      );
    }
  }
}
