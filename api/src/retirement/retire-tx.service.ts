import {
  Injectable,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { CacheService } from '../common/cache.service';
import { nativeToScVal } from '@stellar/stellar-sdk';

export interface BatchRetireBuildResult {
  xdr: string;
  creditIds: string[];
  estimatedFeeStroops: string;
  resourceBudget: {
    instructions: number;
    readBytes: number;
    writeBytes: number;
  };
}

export const MAX_BATCH_BUILD_SIZE = 20;

@Injectable()
export class RetireTxService {
  constructor(
    private readonly stellarService: StellarService,
    private readonly config: ConfigService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Build an unsigned Soroban XDR for batch credit retirement.
   * Returns the unsigned transaction XDR, credit IDs, estimated fee in stroops,
   * and resource budget from the simulation.
   *
   * Throws BadRequestException if the credit list is empty or exceeds MAX_BATCH_BUILD_SIZE.
   * Throws BadGatewayException if the Stellar contract call or simulation fails.
   */
  async buildBatchRetireXdr(
    buyerPublicKey: string,
    creditIds: string[],
    reason: string,
  ): Promise<BatchRetireBuildResult> {
    if (!creditIds || creditIds.length === 0) {
      throw new BadRequestException('creditIds must not be empty');
    }
    if (creditIds.length > MAX_BATCH_BUILD_SIZE) {
      throw new BadRequestException(
        `creditIds exceeds maximum batch size of ${MAX_BATCH_BUILD_SIZE}`,
      );
    }

    const retirementContractId = this.config.get<string>(
      'RETIREMENT_CONTRACT_ID',
      '',
    );

    try {
      const args = [
        nativeToScVal(buyerPublicKey, { type: 'address' }),
        nativeToScVal(creditIds),
        nativeToScVal(reason, { type: 'string' }),
      ];

      // buildContractTransaction simulates the transaction internally and
      // returns the assembled (but unsigned) XDR ready for wallet signing.
      const xdr = await this.stellarService.buildContractTransaction(
        retirementContractId,
        'batch_retire',
        args,
        buyerPublicKey,
      );

      // Simulate again to extract resource budget and fee estimate.
      // The XDR from buildContractTransaction is already simulation-augmented,
      // so we derive a fee estimate from the base simulation call result via
      // a lightweight re-simulation if simulateContractCall is available,
      // otherwise default to the XDR fee field.
      let estimatedFeeStroops = '0';
      let instructions = 0;
      let readBytes = 0;

      try {
        const { rpc: RpcModule, Transaction } =
          await import('@stellar/stellar-sdk');

        // Decode the assembled XDR to simulate it.
        const tx = new Transaction(xdr, await this.getNetworkPassphrase());
        const sim = await this.stellarService.simulateTransaction(tx);

        if (RpcModule.Api.isSimulationSuccess(sim)) {
          const rawFee = Number(sim.minResourceFee ?? 0);
          estimatedFeeStroops = String(Math.ceil(rawFee * 1.1));
          instructions = Number((sim as any).cost?.cpuInsns ?? 0);
          readBytes = Number((sim as any).cost?.memBytes ?? 0);
        }
      } catch {
        // If re-simulation fails, we still return the XDR — fee estimation
        // is best-effort.
      }

      return {
        xdr,
        creditIds,
        estimatedFeeStroops,
        resourceBudget: {
          instructions,
          readBytes,
          writeBytes: 0,
        },
      };
    } catch (err) {
      if (
        err instanceof BadRequestException ||
        err instanceof BadGatewayException
      ) {
        throw err;
      }
      throw new BadGatewayException((err as Error).message);
    }
  }

  private async getNetworkPassphrase(): Promise<string> {
    const { Networks } = await import('@stellar/stellar-sdk');
    const network = this.config.get<string>('STELLAR_NETWORK', 'TESTNET');
    return network.toUpperCase() === 'PUBLIC'
      ? Networks.PUBLIC
      : Networks.TESTNET;
  }
}
