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

  async approveCredit(
    address: string,
    creditId: string,
    caller: string,
  ): Promise<void> {
    if (caller !== address) {
      throw new ForbiddenException('Caller does not match the verifier address');
    }

    await this.getVerifier(address);

    this.logger.log(`Verifier ${address} approving credit ${creditId}`);
    const args = [
      nativeToScVal(address, { type: 'address' }),
      nativeToScVal(Buffer.from(creditId, 'hex'), { type: 'bytes' }),
    ];
    const signer = this.keypairService.getAdminKeypair();
    try {
      await this.stellarService.invokeContract(
        this.contractId,
        'approve_credit',
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
