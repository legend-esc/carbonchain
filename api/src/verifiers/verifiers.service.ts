import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { scValToNative, nativeToScVal } from '@stellar/stellar-sdk';
import { CreditMetadata, CreditStatus } from '../shared';

export interface VerifierInfo {
  address: string;
}

@Injectable()
export class VerifiersService {
  private readonly logger = new Logger(VerifiersService.name);
  private readonly contractId: string;

  constructor(
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
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
}
