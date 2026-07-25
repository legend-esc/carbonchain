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

/**
 * Maps a Soroban contract error code from the mrv_oracle contract to an HTTP
 * exception, using the canonical 400–410 range defined in
 * docs/features/ERROR_CODES_REFERENCE.md.
 *
 * If the error code is unrecognised the original error is re-thrown unchanged.
 */
function mapOracleContractError(error: unknown): never {
  const message = (error as Error)?.message ?? '';

  // Extract a numeric error code from Soroban error strings such as:
  //   "Error(Contract, #400)" or "contract error 400"
  const match = /(?:Error\(Contract,\s*#|contract error\s*)(\d+)/i.exec(message);
  const code = match ? parseInt(match[1], 10) : NaN;

  switch (code) {
    case 400: // NotInitialized
      throw new ServiceUnavailableException('Oracle contract is not initialized');
    case 401: // Unauthorized
      throw new UnauthorizedException('Oracle: caller is not authorized');
    case 402: // AlreadyInitialized
      throw new BadRequestException('Oracle contract is already initialized');
    case 403: // Overflow
      throw new BadRequestException('Oracle: arithmetic overflow — tonnes value too large');
    case 404: // ContractPaused
      throw new ServiceUnavailableException('Oracle contract is currently paused');
    case 405: // ProjectNotFound
      throw new NotFoundException('Oracle: project not found in registry');
    case 406: // InvalidNonce
      throw new BadRequestException('Oracle: invalid replay-protection nonce');
    case 407: // InvalidProject
      throw new BadRequestException('Oracle: project has no credits in registry');
    case 408: // InvalidTimestamp
      throw new BadRequestException('Oracle: timestamp is in the future');
    case 409: // NoPendingAdmin
      throw new BadRequestException('Oracle: no pending admin transfer to accept');
    case 410: // InvalidReading
      throw new BadRequestException('Oracle: tonnes reading must be non-negative');
    default:
      throw error;
  }
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
    let response;
    try {
      response = await this.stellarService.invokeContract(
        this.contractId,
        'update_mrv_data',
        args,
        signer,
      );
    } catch (error: unknown) {
      // Map oracle contract error codes (400–410) to HTTP exceptions.
      mapOracleContractError(error);
    }

    const rv = (response as unknown as Record<string, unknown>).returnValue;
    const anomaly = rv
      ? Boolean(scValToNative(rv as Parameters<typeof scValToNative>[0]))
      : false;

    return { anomaly };
  }
}
