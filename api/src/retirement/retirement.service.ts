import { Injectable, Logger, NotFoundException, ServiceUnavailableException, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';
import { RetirementRecord } from '../shared';
import { RetirementEntity } from './retirement.entity';
import type { IRetirementRepository } from './retirement.repository';
import { RETIREMENT_REPOSITORY } from './retirement.repository';
import { PageResult } from '../credits/credit.repository';

export class RetireDto {
  buyerPublicKey: string;
  creditId: string;
  tonnes: string;
  reason: string;
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
    dto: RetireDto,
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
    entity.txHash = '';
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

    return { retirementId, certificateIpfsHash: '' };
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
