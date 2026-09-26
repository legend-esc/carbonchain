/**
 * CertHashReconciler — issue #921
 *
 * Writes the IPFS certificate hash on-chain after a successful retirement.
 * Failures leave an auditable `certHashStatus = 'pending'` state that this
 * service retries with exponential back-off up to MAX_RETRIES attempts.
 *
 * A daily reconciliation scan finds any retirement records with
 * certHashStatus = 'none' | 'pending' and retries them.
 *
 * Relevant contract function: retirement contract `set_certificate_hash`
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { nativeToScVal, rpc, Keypair } from '@stellar/stellar-sdk';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { RetirementEntity, CertificateHashStatus } from './retirement.entity';
import type { IRetirementRepository } from './retirement.repository';
import { RETIREMENT_REPOSITORY } from './retirement.repository';
import { mapContractError } from '../stellar/contract-error-mapper';

/** Maximum number of write attempts before marking a record as 'failure'. */
export const CERT_HASH_MAX_RETRIES = 5;

/** Base delay (ms) for exponential backoff between retry attempts. */
export const CERT_HASH_BASE_DELAY_MS = 1_000;

@Injectable()
export class CertHashReconciler {
  private readonly logger = new Logger(CertHashReconciler.name);
  private readonly retirementContractId: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    private readonly configService: ConfigService,
    @Inject(RETIREMENT_REPOSITORY)
    private readonly retirementRepo: IRetirementRepository,
  ) {
    this.retirementContractId = this.configService.get<string>(
      'RETIREMENT_CONTRACT_ID',
      '',
    );
  }

  /**
   * Write the certificate IPFS hash on-chain for a given retirement.
   *
   * Updates `certHashStatus` on the entity:
   *   none / pending → onchain  (success)
   *   pending        → failure  (after MAX_RETRIES exhausted)
   *
   * Caller is expected to have already generated and pinned the IPFS hash.
   */
  async writeCertificateHash(
    retirementId: string,
    ipfsHash: string,
    signer?: Keypair,
  ): Promise<void> {
    const entity = await this.retirementRepo.findById(retirementId);
    if (!entity) {
      this.logger.warn(
        `writeCertificateHash: retirement ${retirementId} not found — skipping`,
      );
      return;
    }

    if (entity.certHashStatus === 'onchain') {
      this.logger.debug(
        `Cert hash already on-chain for retirement ${retirementId} — no-op`,
      );
      return;
    }

    // Mark as pending before the first attempt so a crash still leaves an
    // auditable state rather than silent nothing.
    entity.certHashStatus = 'pending';
    entity.certificateIpfsHash = ipfsHash;
    await this.retirementRepo.save(entity);

    await this.attemptWriteWithRetry(entity, ipfsHash, signer);
  }

  /**
   * Daily reconciler scan — finds retirements with certHashStatus = 'none' or
   * 'pending' (and retries < MAX_RETRIES) and re-attempts the on-chain write.
   *
   * Intended to be called by a cron / scheduler.  Processes up to `batchLimit`
   * records per invocation to prevent memory spikes.
   */
  async reconcile(batchLimit = 50): Promise<{
    attempted: number;
    resolved: number;
    stillPending: number;
  }> {
    this.logger.log('CertHashReconciler: starting reconciliation scan');

    const pending = await this.retirementRepo.findPendingCertHash(batchLimit);

    let resolved = 0;
    let stillPending = 0;

    for (const entity of pending) {
      if (entity.certHashRetries >= CERT_HASH_MAX_RETRIES) {
        if (entity.certHashStatus !== 'failure') {
          entity.certHashStatus = 'failure';
          await this.retirementRepo.save(entity);
        }
        stillPending++;
        continue;
      }

      const ipfsHash = entity.certificateIpfsHash;
      if (!ipfsHash) {
        this.logger.warn(
          `Reconciler: retirement ${entity.id} has certHashStatus=${entity.certHashStatus} but no IPFS hash stored — cannot reconcile`,
        );
        stillPending++;
        continue;
      }

      try {
        await this.attemptWriteWithRetry(entity, ipfsHash);
        if (entity.certHashStatus === 'onchain') resolved++;
        else stillPending++;
      } catch {
        stillPending++;
      }
    }

    this.logger.log(
      `CertHashReconciler: done — attempted=${pending.length} resolved=${resolved} stillPending=${stillPending}`,
    );

    return { attempted: pending.length, resolved, stillPending };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async attemptWriteWithRetry(
    entity: RetirementEntity,
    ipfsHash: string,
    signer?: Keypair,
  ): Promise<void> {
    const key = signer ?? this.keypairService.getAdminKeypair();

    for (let attempt = 0; attempt < CERT_HASH_MAX_RETRIES; attempt++) {
      try {
        await this.writeHashOnChain(entity.id, ipfsHash, key);

        entity.certHashStatus = 'onchain';
        entity.certHashRetries = entity.certHashRetries + attempt + 1;
        await this.retirementRepo.save(entity);

        this.logger.log(
          `Cert hash written on-chain for retirement ${entity.id} (attempt ${attempt + 1})`,
        );
        return;
      } catch (error: unknown) {
        const attemptNumber = attempt + 1;
        entity.certHashRetries = entity.certHashRetries + 1;

        this.logger.warn(
          `Cert hash write attempt ${attemptNumber}/${CERT_HASH_MAX_RETRIES} failed for ` +
            `retirement ${entity.id}: ${(error as Error).message}`,
        );

        if (attemptNumber >= CERT_HASH_MAX_RETRIES) {
          entity.certHashStatus = 'failure';
          await this.retirementRepo.save(entity);
          this.logger.error(
            `Cert hash write permanently failed for retirement ${entity.id} after ${CERT_HASH_MAX_RETRIES} attempts`,
          );
          return;
        }

        // Save intermediate retry count
        await this.retirementRepo.save(entity);

        // Exponential backoff: 1 s, 2 s, 4 s, 8 s, …
        const delay = CERT_HASH_BASE_DELAY_MS * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async writeHashOnChain(
    retirementId: string,
    ipfsHash: string,
    signer: Keypair,
  ): Promise<void> {
    const args = [
      nativeToScVal(Buffer.from(retirementId, 'hex'), { type: 'bytes' }),
      nativeToScVal(ipfsHash, { type: 'string' }),
    ];

    let response: rpc.Api.GetTransactionResponse;
    try {
      response = await this.stellarService.invokeContract(
        this.retirementContractId,
        'set_certificate_hash',
        args,
        signer,
      );
    } catch (error: unknown) {
      // Map contract errors via ContractErrorMapper (#919)
      mapContractError(error, 'retirement');
    }

    // Confirm finality (#918) — the hash write must also reach SUCCESS
    const txHash =
      (response! as unknown as Record<string, unknown>).hash as string ?? '';
    if (txHash) {
      const confirmation = await this.stellarService.confirmTransaction(txHash);
      if (confirmation.status !== 'SUCCESS') {
        throw new Error(
          `set_certificate_hash tx ${txHash.slice(0, 16)}... closed as ${confirmation.status}: ` +
            `${confirmation.errorMessage ?? ''}`,
        );
      }
    }
  }
}
