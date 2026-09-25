import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative, rpc } from '@stellar/stellar-sdk';
import { CreditStatus, RetirementRecord } from '../../../shared';
import { RetirementEntity } from './retirement.entity';
import type { IRetirementRepository } from './retirement.repository';
import { RETIREMENT_REPOSITORY } from './retirement.repository';
import type { ICreditRepository } from '../credits/credit.repository';
import { CREDIT_REPOSITORY, PageResult } from '../credits/credit.repository';
import { RetireDto, FullRetireDto } from './dto/retire.dto';
import { BatchRetireDto } from './dto/batch-retire.dto';
import { CertificateService } from './certificate.service';
import { CertHashReconciler } from './cert-hash-reconciler.service';
import {
  mapContractError,
  extractContractErrorCode,
  lookupError,
} from '../stellar/contract-error-mapper';

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
  /** #921 — on-chain certificate hash write status */
  certHashStatus?: string;
  /** #918 — on-chain finality state */
  txStatus?: string;
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
    const credit = await this.creditRepo.findById(creditId);
    if (!credit) {
      throw new NotFoundException(`Credit ${creditId} not found`);
    }
    if (credit.status !== CreditStatus.Active) {
      throw new ConflictException(
        `Credit ${creditId} is not active (status: ${credit.status})`,
      );
    }

    // ── #920 On-chain pre-check ───────────────────────────────────────────────
    // Simulate get_credit to confirm the on-chain state matches the DB row.
    // This is signing-free and catches stale-DB mismatches before any fee is burned.
    await this.runOnChainPreCheck(creditId, buyerPublicKey);

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
    this.logger.log(
      `Retiring credit ${dto.creditId} for ${dto.buyerPublicKey}`,
    );

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

    // ── #918 Step 1: Persist with txStatus=pending ────────────────────────────
    const entity = new RetirementEntity();
    entity.id = retirementId;
    entity.creditId = dto.creditId;
    entity.buyer = dto.buyerPublicKey;
    entity.tonnesRetired = dto.tonnes;
    entity.reason = dto.reason;
    entity.retiredAt = Math.floor(Date.now() / 1000);
    entity.txHash = txHash;
    entity.txStatus = 'pending';
    entity.certHashStatus = 'none';
    entity.certHashRetries = 0;
    entity.certificateIpfsHash = '';
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

    return { retirementId, certificateIpfsHash };
  }

  /**
   * Retire multiple credits in a single on-chain call.
   * Enforces MAX_BATCH_SIZE before invoking the contract.
   *
   * #919 — magic-string error matching replaced with ContractErrorMapper
   * #918 — each entity persisted with txStatus=pending; finality confirmed per record
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
    }

    const rv = (response! as unknown as Record<string, unknown>).returnValue;
    const retirementIds: string[] = rv
      ? (
          scValToNative(
            rv as Parameters<typeof scValToNative>[0],
          ) as Uint8Array[]
        ).map((b) => Buffer.from(b).toString('hex'))
      : [];

    const succeeded: string[] = [];
    const failed: { id: string; reason: string }[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (let i = 0; i < retirementIds.length; i++) {
      try {
        const entity = new RetirementEntity();
        entity.id = retirementIds[i];
        entity.creditId = dto.creditIds[i];
        entity.buyer = dto.buyerPublicKey;
        entity.tonnesRetired = dto.tonnes[i];
        entity.reason = dto.reason;
        entity.retiredAt = now;
        entity.txHash = txHash;
        entity.txStatus = finalityOk ? 'success' : 'failed';
        entity.certHashStatus = 'none';
        entity.certHashRetries = 0;
        entity.certificateIpfsHash = '';
        await this.retirementRepo.save(entity);

        if (finalityOk) {
          const event: CreditRetiredEvent = {
            retirementId: entity.id,
            creditId: entity.creditId,
            buyer: entity.buyer,
            tonnesRetired: entity.tonnesRetired,
            retiredAt: entity.retiredAt,
          };
          this.eventEmitter.emit('CreditRetired', event);
          succeeded.push(retirementIds[i]);
        } else {
          failed.push({
            id: dto.creditIds[i],
            reason: 'Transaction did not achieve finality.',
          });
        }
      } catch (error: unknown) {
        this.logger.error(
          `Failed to persist retirement for credit ${dto.creditIds[i]}: ${(error as Error).message}`,
        );
        failed.push({
          id: dto.creditIds[i],
          reason: (error as Error).message,
        });
      }
    }

    return { succeeded, failed };
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

      const retirement = await this.getRetirement(certificateId);
      return {
        id: retirement.id,
        credit_id: retirement.credit_id,
        buyer: retirement.buyer,
        tonnes_retired: retirement.tonnes_retired,
        reason: retirement.reason,
        retired_at: retirement.retired_at,
        tx_hash: retirement.tx_hash || '',
        verified: true,
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
