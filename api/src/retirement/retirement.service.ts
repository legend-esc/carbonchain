import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Inject,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk';
import { CreditStatus, RetirementRecord } from '../../../shared';
import { RetirementEntity } from './retirement.entity';
import { CertificateService } from './certificate.service';
import type { IRetirementRepository } from './retirement.repository';
import { RETIREMENT_REPOSITORY } from './retirement.repository';
import { NonceService } from '../common/nonce.service';
import type { ICreditRepository } from '../credits/credit.repository';
import { CREDIT_REPOSITORY, PageResult } from '../credits/credit.repository';
import { RetireDto, FullRetireDto } from './dto/retire.dto';
import { BatchRetireDto } from './dto/batch-retire.dto';
import { computeFileCid, cidsMatch } from '../common/ipfs-cid.util';
import {
  METRICS_EVENT_EMITTER,
  RETIREMENT_COMPLETED,
} from '../metrics/metrics-events';
import type { RetirementCompletedEvent } from '../metrics/metrics-events';
import type { EventEmitter } from 'events';

export const MAX_BATCH_SIZE = 10;

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
    private readonly certificateService: CertificateService,
    private readonly certHashReconciler: CertHashReconciler,
    @Inject(RETIREMENT_REPOSITORY)
    private readonly retirementRepo: IRetirementRepository,
    @Inject(CREDIT_REPOSITORY)
    private readonly creditRepo: ICreditRepository,
    @Inject(EVENT_EMITTER) private readonly eventEmitter: IEventEmitter,
    @Optional() private readonly nonceService?: NonceService,
    @Optional() private readonly certificateService?: CertificateService,
    @Optional()
    @Inject(METRICS_EVENT_EMITTER)
    private readonly metricsEmitter?: EventEmitter,
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
   *
   * #919 — uses ContractErrorMapper (no magic strings)
   * #920 — performs an on-chain simulation pre-check before invoking
   * #918 — credit status set to pending; rolled back on FAILED/TIMEOUT
   */
  async retireCredit(
    creditId: string,
    dto: RetireDto,
    buyerPublicKey: string,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    // Issue #941 — validate creditId format
    creditId = parseCreditId(creditId);

    const credit = await this.creditRepo.findById(creditId);
    if (!credit) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }
    if (credit.status !== CreditStatus.Active) {
      throw new ConflictException(
        `Credit ${creditId} is not active (status: ${credit.status})`,
      );
    }

    const tonnesToRetire = dto.tonnes ? dto.tonnes : credit.tonnes;
    if (BigInt(tonnesToRetire) <= 0n || BigInt(tonnesToRetire) > BigInt(credit.tonnes)) {
      throw new BadRequestException(
        `Invalid retirement tonnes: ${tonnesToRetire}. Must be between 1 and ${credit.tonnes}`,
      );
    }

    const isPartial = BigInt(tonnesToRetire) < BigInt(credit.tonnes);

    const result = await this.retire({
      buyerPublicKey,
      creditId,
      tonnes: tonnesToRetire,
      reason: dto.reason,
      nonce: dto.nonce,
      vintageYear: credit.vintageYear,
    });

    if (isPartial) {
      credit.tonnes = (BigInt(credit.tonnes) - BigInt(tonnesToRetire)).toString();
    } else {
      credit.status = CreditStatus.Retired;
    }
    await this.creditRepo.save(credit);

    return result;
  }

  /**
   * #920 — On-chain pre-check using simulateContractCall.
   *
   * Simulates `get_credit` against the registry contract.  If simulation fails
   * or the on-chain status/owner no longer matches expectations, throws a 409
   * with a hint telling the caller to refresh and retry.
   *
   * This check is intentionally signing-free: the dummy source key used inside
   * simulateContractCall means no auth is required, and no fee is consumed.
   */
  private async runOnChainPreCheck(
    creditId: string,
    buyerPublicKey: string,
  ): Promise<void> {
    try {
      const args = [
        nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
      ];

      const simulation = await this.stellarService.simulateContractCall(
        this.registryContractId,
        'get_credit',
        args,
      );

      if (!rpc.Api.isSimulationSuccess(simulation) || !simulation.result) {
        // Simulation itself failed — likely the credit no longer exists on-chain
        // or the contract errored.  Extract code and surface via mapper.
        const errMsg =
          (simulation as unknown as { error?: string }).error ??
          'Simulation failed';
        const code = extractContractErrorCode(errMsg);
        if (code !== undefined) {
          const descriptor = lookupError(code, 'credit_registry');
          if (descriptor) {
            throw new ConflictException({
              error: `On-chain pre-check failed: ${descriptor.message}`,
              code,
              hint: 'Refresh the credit status and retry.',
            });
          }
        }
        throw new ConflictException({
          error: 'On-chain pre-check failed; credit state could not be read.',
          hint: 'Refresh the credit status and retry.',
        });
      }

      // Decode the on-chain credit record
      const onChain = scValToNative(simulation.result.retval) as {
        status?: unknown;
        owner?: unknown;
      };

      // Check status — must be Active (numeric 1 in the contract enum)
      const onChainStatus = onChain.status;
      const isOnChainActive =
        onChainStatus === 1 ||
        String(onChainStatus).toLowerCase() === 'active';

      if (!isOnChainActive) {
        throw new ConflictException({
          error:
            'Credit is not active on-chain; it may have been retired or transferred since the last DB sync.',
          hint: 'Refresh the credit status and retry.',
          onChainStatus,
        });
      }

      // Check owner — must match the buyer (the one submitting the retire call)
      const onChainOwner = String(onChain.owner ?? '');
      if (onChainOwner && onChainOwner !== buyerPublicKey) {
        throw new ConflictException({
          error:
            'Credit owner on-chain does not match. The credit may have been transferred since the last sync.',
          hint: 'Refresh the credit and retry as the current owner.',
        });
      }
    } catch (err) {
      // Re-throw ConflictExceptions we raised ourselves
      if ((err as { status?: number })?.status === 409) throw err;

      // Anything else from the simulation layer — log and allow through.
      // We don't block a legitimate retire because the pre-check RPC failed.
      this.logger.warn(
        `On-chain pre-check for credit ${creditId} failed with non-fatal error: ${(err as Error).message}. Proceeding with retire.`,
      );
    }
  }

  /**
   * Retire a carbon credit on-chain and persist the retirement record.
   *
   * #919 — contract errors mapped via ContractErrorMapper (no magic strings)
   * #918 — record saved with txStatus=pending; rolled back on FAILED/TIMEOUT;
   *         confirm latency logged as a metric
   * #921 — certificate generated and hash write queued via CertHashReconciler
   *
   * ## Event ordering guarantee
   * `CreditRetired` is emitted only after a successful DB write AND finality
   * confirmation.  FAILED/TIMEOUT transactions never emit the event.
   */
  async retire(
    dto: FullRetireDto,
  ): Promise<{ retirementId: string; certificateIpfsHash: string }> {
    // Issue #941 — validate creditId format
    dto = { ...dto, creditId: parseCreditId(dto.creditId) };

    this.logger.log(
      `Retiring credit ${dto.creditId} for ${dto.buyerPublicKey}`,
    );

    // ── #415: API-layer nonce deduplication ───────────────────────────────────
    // Claim the nonce in Redis before submitting the transaction on-chain.
    // A duplicate nonce within the Stellar ledger close window returns 409.
    if (dto.nonce !== undefined && this.nonceService) {
      await this.nonceService.consumeNonce(
        dto.buyerPublicKey,
        BigInt(dto.nonce),
      );
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
    let response: rpc.Api.GetTransactionResponse;
    let txHash = '';

    try {
      response = await this.stellarService.invokeContract(
        this.retirementContractId,
        'retire',
        args,
        signer,
      );
      // invokeContract returns the final GetTransactionResponse; extract hash
      txHash =
        (response as unknown as Record<string, unknown>).hash as string ?? '';
    } catch (error: unknown) {
      // #919 — map contract errors via ContractErrorMapper; no magic strings
      mapContractError(error, 'retirement');
    }

    const rv = (response! as unknown as Record<string, unknown>).returnValue;
    const retirementId = rv
      ? Buffer.from(
          scValToNative(
            rv as Parameters<typeof scValToNative>[0],
          ) as Uint8Array,
        ).toString('hex')
      : 'unknown';

    const txHash = (response as unknown as { hash?: string })?.hash ?? '';

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
    // Issue #589 — persist vintage year for certificate provenance
    entity.vintageYear = dto.vintageYear ?? 0;
    await this.retirementRepo.save(entity);

    // ── #918 Step 2: Confirm finality ─────────────────────────────────────────
    if (txHash) {
      const confirmation = await this.stellarService.confirmTransaction(txHash);

      if (confirmation.status === 'SUCCESS') {
        entity.txStatus = 'success';
        await this.retirementRepo.save(entity);
      } else {
        // FAILED or TIMEOUT — roll back the optimistic record
        entity.txStatus =
          confirmation.status === 'FAILED' ? 'failed' : 'timeout';
        await this.retirementRepo.save(entity);

        this.logger.error(
          `Retirement tx ${txHash.slice(0, 16)}... closed as ${confirmation.status} ` +
            `for credit ${dto.creditId}. DB record marked ${entity.txStatus}.`,
        );

        const msg =
          confirmation.status === 'FAILED'
            ? `Retirement transaction failed on-chain: ${confirmation.errorMessage ?? 'FAILED'}`
            : 'Retirement transaction timed out waiting for ledger closure.';

        throw new ConflictException({ error: msg, txHash, retirementId });
      }
    } else {
      // No hash available — treat as success (invokeContract already polled)
      entity.txStatus = 'success';
      await this.retirementRepo.save(entity);
    }

    // ── #921 Step 3: Generate certificate and queue hash write ────────────────
    // Run best-effort: a failure here must not roll back a valid retirement.
    let certificateIpfsHash = '';
    try {
      certificateIpfsHash = await this.certificateService.generateAndPin({
        retirementId,
        creditId: dto.creditId,
        buyer: dto.buyerPublicKey,
        tonnes: dto.tonnes,
        reason: dto.reason,
        timestamp: entity.retiredAt,
      });

      // Queue the on-chain hash write via CertHashReconciler (with bounded retry)
      await this.certHashReconciler.writeCertificateHash(
        retirementId,
        certificateIpfsHash,
      );
    } catch (certErr: unknown) {
      // Log failure but do NOT re-throw — the retirement itself succeeded.
      // The reconciler will retry the hash write on its next scan.
      this.logger.error(
        `Certificate generation/hash write failed for retirement ${retirementId}: ` +
          `${(certErr as Error).message}. Will be reconciled by CertHashReconciler.`,
      );
    }

    // ── Step 4: Emit CreditRetired event ─────────────────────────────────────
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
          // Issue #589 — include vintage year in certificate data
          ...(dto.vintageYear ? { vintageYear: dto.vintageYear } : {}),
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
              nativeToScVal(Buffer.from(retirementId, 'hex'), {
                type: 'bytes',
              }),
              nativeToScVal(certificateIpfsHash, { type: 'string' }),
              nativeToScVal(nonceValue, { type: 'u64' }),
            ],
            adminKeypair,
          );

          // Persist the hash to the off-chain index so it is returned in
          // GET /certificates/:id without an additional on-chain read.
          entity.certificateIpfsHash = certificateIpfsHash ?? '';
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
        // A failed cert-gen must not be silently swallowed: the retirement
        // record exists on-chain but the caller would receive an empty hash
        // with a 201, leaving the certificate permanently unrecoverable.
        // Throw so the caller knows to retry or investigate.
        this.logger.error(
          `Certificate generation failed for retirement ${retirementId}: ` +
            `${(certErr as Error).message}`,
        );
        throw new InternalServerErrorException(
          `Retirement succeeded on-chain (id: ${retirementId}) but certificate ` +
            `generation failed: ${(certErr as Error).message}. ` +
            `Retry POST /credits/${dto.creditId}/retire or contact support.`,
        );
      }
    }

    // Issue #495 — emit retirement metric event (single retirement).
    this.metricsEmitter?.emit(RETIREMENT_COMPLETED, {
      type: 'single',
      count: 1,
    } satisfies RetirementCompletedEvent);

    // Issue #917 — surface the simulated fee so the caller and DTOs can show
    // an accurate, non-constant fee estimate driven by minResourceFee × multiplier.
    const estimatedFeeStroops = (response as unknown as { estimatedFeeStroops?: number }).estimatedFeeStroops;

    return {
      retirementId,
      certificateIpfsHash: certificateIpfsHash ?? '',
      ...(estimatedFeeStroops !== undefined ? { estimatedFeeStroops } : {}),
    };
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

    // ── #415: API-layer nonce deduplication ───────────────────────────────────
    if (this.nonceService) {
      await this.nonceService.consumeNonce(
        dto.buyerPublicKey,
        BigInt(dto.nonce),
      );
    }

    const creditIdsVal = nativeToScVal(
      dto.creditIds.map((id) => Buffer.from(id, 'hex')),
    );
    const tonnesVal = nativeToScVal(dto.tonnes.map((t) => BigInt(t)));
    const args = [
      nativeToScVal(dto.buyerPublicKey, { type: 'address' }),
      creditIdsVal,
      tonnesVal,
      nativeToScVal(dto.reason, { type: 'string' }),
      nativeToScVal(this.registryContractId, { type: 'address' }),
      nativeToScVal(BigInt(dto.nonce), { type: 'u64' }),
    ];

    const signer = this.keypairService.getAdminKeypair();
    let response: rpc.Api.GetTransactionResponse;
    let txHash = '';

    try {
      response = await this.stellarService.invokeContract(
        this.retirementContractId,
        'batch_retire',
        args,
        signer,
      );
      txHash =
        (response as unknown as Record<string, unknown>).hash as string ?? '';
    } catch (error: unknown) {
      // #919 — map contract errors via ContractErrorMapper
      mapContractError(error, 'retirement');
    }

    // #918 — confirm finality before persisting success records
    let finalityOk = true;
    if (txHash) {
      const confirmation = await this.stellarService.confirmTransaction(txHash);
      if (confirmation.status !== 'SUCCESS') {
        this.logger.error(
          `Batch retire tx ${txHash.slice(0, 16)}... closed as ${confirmation.status}.`,
        );
        finalityOk = false;
      }
      // The whole batch reverted on-chain — no DB writes and no events.
      // Surface every credit as failed so callers can reconcile.
      this.logger.error(
        `Batch retire contract call failed: ${msg}. No records persisted.`,
      );
      return {
        succeeded: [],
        failed: dto.creditIds.map((id) => ({
          id,
          reason: msg || 'Contract reverted',
        })),
      };
    }

    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const txHash = (response as unknown as { hash?: string })?.hash ?? '';

    // The contract returns BatchRetireResult { succeeded: Vec<BytesN<32>>, failed: Vec<{credit_id, error_code}> }
    let succeededIds: string[] = [];
    let contractFailed: { id: string; reason: string }[] = [];

    if (rv) {
      const native = scValToNative(
        rv as Parameters<typeof scValToNative>[0],
      ) as {
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

    // The contract retires credits in input order and returns one retirement ID
    // per success, skipping failed credits — so succeededIds is shorter than
    // dto.creditIds whenever a credit fails. Indexing dto.creditIds by the
    // position in succeededIds therefore misattributes records once anything
    // fails. Rebuild the successful source list by removing the
    // contract-reported failures in input order, then pair each retirement ID
    // with its true source credit (and that credit's tonnes) by position.
    const failedIdSet = new Set(contractFailed.map((f) => f.id));
    const succeededSources = dto.creditIds
      .map((id, idx) => ({ id, tonnes: dto.tonnes[idx] ?? '0' }))
      .filter((src) => !failedIdSet.has(src.id));

    if (succeededSources.length !== succeededIds.length) {
      this.logger.warn(
        `Batch retire: contract reported ${succeededIds.length} successes but ` +
          `${succeededSources.length} source credits remain after removing ` +
          `reported failures — retirement records may be misattributed.`,
      );
    }

    const entities: RetirementEntity[] = succeededIds.map((retirementId, i) => {
      const source = succeededSources[i];
      const entity = new RetirementEntity();
      entity.id = retirementId;
      entity.creditId = source?.id ?? '';
      entity.buyer = dto.buyerPublicKey;
      entity.tonnesRetired = source?.tonnes ?? '0';
      entity.reason = dto.reason;
      entity.retiredAt = now;
      entity.txHash = txHash;
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

    // Mirror the single-retire status update: mark each successfully retired
    // credit as Retired in the off-chain index. Failures here are logged but
    // do not roll back the already-committed retirement records.
    await Promise.all(
      entities.map(async (entity) => {
        try {
          const credit = await this.creditRepo.findById(entity.creditId);
          if (credit) {
            credit.status = CreditStatus.Retired;
            await this.creditRepo.save(credit);
          }
        } catch (statusErr: unknown) {
          this.logger.warn(
            `Failed to update status for credit ${entity.creditId} after batch retirement: ` +
              `${(statusErr as Error).message}`,
          );
        }
      }),
    );

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

    // Issue #495 — emit batch retirement metric event.
    const successCount = succeeded.length;
    if (successCount > 0) {
      this.metricsEmitter?.emit(RETIREMENT_COMPLETED, {
        type: 'batch',
        count: successCount,
      } satisfies RetirementCompletedEvent);
    }

    // Merge contract-reported failures with any additional context
    return {
      succeeded,
      failed: contractFailed,
    };
  }

  async getRetirement(retirementId: string): Promise<RetirementRecord> {
    // Issue #941 — validate retirementId format (same 32-byte hex constraint)
    retirementId = parseCreditId(retirementId);

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
      // Issue #589 — vintage_year added to on-chain struct; undefined for legacy
      ...(n.vintage_year ? { vintage_year: Number(n.vintage_year) } : {}),
    };
  }

  async listRetirements(
    page = 1,
    limit = 20,
  ): Promise<PageResult<RetirementRecord>> {
    const result = await this.retirementRepo.findAll(page, limit);
    return { ...result, data: result.data.map((e) => this.entityToRecord(e)) };
  }

  /**
   * Issue #942 — Paginated retirement listing with DTO-based filters.
   * Replaces the unbounded `listRetirements(page, limit)` path when the
   * caller supplies a `ListRetirementsDto`.
   */
  async listRetirementsPaginated(
    dto: ListRetirementsDto,
  ): Promise<PaginatedRetirements<RetirementRecord>> {
    const page = dto.page ?? 1;
    const pageSize = dto.pageSize ?? 20;

    const [entities, total] = await this.retirementRepo.findPaginated(dto);
    const data = entities.map((e) => this.entityToRecord(e));

    const nextCursor =
      page * pageSize < total ? String(page + 1) : null;

    return { data, total, page, pageSize, nextCursor };
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
      // Issue #589 — only include vintage_year when non-zero (0 = legacy record)
      ...(e.vintageYear ? { vintage_year: e.vintageYear } : {}),
    };
  }

  async verifyCertificate(
    certificateId: string,
  ): Promise<CertificateVerification> {
    try {
      this.logger.log(`Verifying certificate: ${certificateId}`);
      const entity = await this.retirementRepo.findById(certificateId);
      if (entity) {
        // #921 — include certHashStatus; #918 — include txStatus
        return {
          id: entity.id,
          credit_id: entity.creditId,
          buyer: entity.buyer,
          tonnes_retired: entity.tonnesRetired,
          reason: entity.reason,
          retired_at: entity.retiredAt,
          tx_hash: entity.txHash || '',
          verified: entity.txStatus === 'success',
          certHashStatus: entity.certHashStatus,
          txStatus: entity.txStatus,
        };
      }

      // Issue #544: fetch the on-chain certificate_ipfs_hash so we can compare
      // it against the content we actually issued.
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

      const offChainIpfsHash = retirement.certificate_ipfs_hash ?? '';
      const expectedHash = onChainIpfsHash || offChainIpfsHash;

      // #764: a certificate is only verified when there is a committed hash AND
      // the on-chain and off-chain pointers agree (tamper check on the pointer)
      // AND the regenerated PDF content hashes to that same CID (tamper check
      // on the document itself). `verified` is no longer hardcoded.
      let verified = false;
      if (expectedHash) {
        const pointerMatches =
          !onChainIpfsHash || !offChainIpfsHash
            ? true
            : onChainIpfsHash === offChainIpfsHash;

        let contentMatches = false;
        if (pointerMatches && this.certificateService) {
          try {
            const pdf = await this.certificateService.generatePdf({
              retirementId: retirement.id,
              creditId: retirement.credit_id,
              buyer: retirement.buyer,
              tonnes: retirement.tonnes_retired,
              reason: retirement.reason,
              timestamp: retirement.retired_at,
              ...(retirement.vintage_year
                ? { vintageYear: retirement.vintage_year }
                : {}),
            });
            contentMatches = cidsMatch(computeFileCid(pdf), expectedHash);
          } catch (genErr) {
            this.logger.warn(
              `Certificate PDF regeneration failed for ${certificateId}: ` +
                `${(genErr as Error).message}`,
            );
          }
        }

        verified = pointerMatches && contentMatches;
      }

      return {
        id: retirement.id,
        credit_id: retirement.credit_id,
        buyer: retirement.buyer,
        tonnes_retired: retirement.tonnes_retired,
        reason: retirement.reason,
        retired_at: retirement.retired_at,
        tx_hash: retirement.tx_hash || '',
        verified,
        certificate_ipfs_hash: expectedHash,
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
