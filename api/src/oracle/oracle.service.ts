import {
  Injectable,
  Logger,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { StellarService } from '../stellar/stellar.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

export class MrvWebhookDto {
  oraclePublicKey: string;
  projectId: string;
  tonnesSequestered: string;
  signature: string; // HMAC-SHA256 hex of `${projectId}:${tonnesSequestered}` with ORACLE_WEBHOOK_SECRET
}

@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);
  private readonly contractId: string;
  private readonly webhookSecret: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly keypairService: StellarKeypairService,
    private readonly configService: ConfigService,
  ) {
    this.contractId = this.configService.get<string>(
      'MRV_ORACLE_CONTRACT_ID',
      '',
    );
    this.webhookSecret = this.configService.get<string>(
      'ORACLE_WEBHOOK_SECRET',
      'changeme',
    );
  }

  /**
   * Validate HMAC-SHA256 signature over `${projectId}:${tonnesSequestered}`.
   */
  private validateSignature(dto: MrvWebhookDto): void {
    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${dto.projectId}:${dto.tonnesSequestered}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(dto.signature, 'hex');

    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new UnauthorizedException('Invalid oracle signature');
    }
  }

  async ingestMrvData(dto: MrvWebhookDto): Promise<{ anomaly: boolean }> {
    this.validateSignature(dto);

    const tonnes = BigInt(dto.tonnesSequestered);
    if (tonnes <= 0n) {
      throw new BadRequestException('tonnes must be positive (greater than 0)');
    }

    this.logger.log(
      `MRV update for project ${dto.projectId} from oracle ${dto.oraclePublicKey}`,
    );

    const args = [
      nativeToScVal(dto.oraclePublicKey, { type: 'address' }),
      nativeToScVal(dto.projectId, { type: 'string' }),
      nativeToScVal(BigInt(dto.tonnesSequestered), { type: 'i128' }),
      nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: 'u64' }),
    ];

    const signer = this.keypairService.getAdminKeypair();
    const response = await this.stellarService.invokeContract(
      this.contractId,
      'update_mrv_data',
      args,
      signer,
    );

    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const anomaly = rv
      ? Boolean(scValToNative(rv as Parameters<typeof scValToNative>[0]))
      : false;

    return { anomaly };
  }

  /**
   * Set or clear a per-project anomaly threshold override.
   * Pass thresholdBps=0 to clear the override and revert to global threshold.
   */
  async setProjectAnomalyThreshold(
    projectId: string,
    thresholdBps: number,
  ): Promise<{ projectId: string; thresholdBps: number | null }> {
    if (!Number.isInteger(thresholdBps) || thresholdBps < 0 || thresholdBps > 10000) {
      throw new BadRequestException(
        'thresholdBps must be an integer between 0 and 10000',
      );
    }

    const signer = this.keypairService.getAdminKeypair();
    const nonceResponse = await this.stellarService.invokeContract(
      this.contractId,
      'get_nonce',
      [nativeToScVal(signer.publicKey(), { type: 'address' })],
      signer,
    );
    const nonce = (
      scValToNative(
        (nonceResponse as unknown as Record<string, unknown>)
          .returnValue as Parameters<typeof scValToNative>[0],
      ) as bigint
    ).toString();

    const args = [
      nativeToScVal(signer.publicKey(), { type: 'address' }),
      nativeToScVal(projectId, { type: 'string' }),
      nativeToScVal(BigInt(thresholdBps), { type: 'u32' }),
      nativeToScVal(BigInt(nonce), { type: 'u64' }),
    ];

    await this.stellarService.invokeContract(
      this.contractId,
      'set_project_anomaly_threshold',
      args,
      signer,
    );

    this.logger.log(
      `Set anomaly threshold for project ${projectId} to ${thresholdBps} bps`,
    );

    return {
      projectId,
      thresholdBps: thresholdBps === 0 ? null : thresholdBps,
    };
  }
}
