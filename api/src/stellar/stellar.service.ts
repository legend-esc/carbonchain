import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Account,
  Horizon,
  Networks,
  Transaction,
  TransactionBuilder,
  Keypair,
  Operation,
  xdr,
  Address,
  rpc,
} from '@stellar/stellar-sdk';

@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);
  private horizonServer: Horizon.Server;
  private sorobanRpcServer: rpc.Server;
  private networkPassphrase: string;

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const horizonUrl =
      this.configService.get<string>('HORIZON_URL') ||
      'https://horizon-testnet.stellar.org';
    const sorobanRpcUrl =
      this.configService.get<string>('SOROBAN_RPC_URL') ||
      'https://soroban-testnet.stellar.org';
    const network = this.configService.get<string>(
      'STELLAR_NETWORK',
      'TESTNET',
    );

    this.horizonServer = new Horizon.Server(horizonUrl);
    this.sorobanRpcServer = new rpc.Server(sorobanRpcUrl);

    switch (network.toUpperCase()) {
      case 'PUBLIC':
        this.networkPassphrase = Networks.PUBLIC;
        break;
      case 'FUTURENET':
        this.networkPassphrase = Networks.FUTURENET;
        break;
      case 'TESTNET':
      default:
        this.networkPassphrase = Networks.TESTNET;
        break;
    }

    this.logger.log(`StellarService initialized for ${network} network`);
  }

  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    signerKeypair: Keypair,
  ): Promise<rpc.Api.GetTransactionResponse> {
    const account = await this.horizonServer.loadAccount(
      signerKeypair.publicKey(),
    );

    const tx = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: method,
              args: args,
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.simulateTransaction(tx);

    if (rpc.Api.isSimulationSuccess(simulation)) {
      const preparedTx = rpc.assembleTransaction(tx, simulation).build();
      preparedTx.sign(signerKeypair);

      const response = await this.submitTransactionWithRetry(() =>
        this.sorobanRpcServer.sendTransaction(preparedTx),
      );

      if ((response.status as any) === 'PENDING') {
        return this.pollTransactionStatus(response.hash);
      }
      throw new Error(`Transaction failed with status: ${response.status}`);
    } else {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation)}`);
    }
  }

  async buildAndSubmit(
    operations: Operation[],
    signerKeypair: Keypair,
  ): Promise<any> {
    const account = await this.horizonServer.loadAccount(
      signerKeypair.publicKey(),
    );

    const txBuilder = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    });

    for (const op of operations) {
      txBuilder.addOperation(op as any);
    }

    const tx = txBuilder.setTimeout(30).build();
    tx.sign(signerKeypair);

    return this.submitTransactionWithRetry(() =>
      this.horizonServer.submitTransaction(tx),
    );
  }

  async getContractData(
    contractId: string,
    key: xdr.ScVal,
    durability: xdr.ContractDataDurability = xdr.ContractDataDurability.persistent(),
  ): Promise<xdr.ScVal | null> {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key,
        durability,
      }),
    );

    const response = await this.sorobanRpcServer.getLedgerEntries(ledgerKey);
    if (response.entries && response.entries.length > 0) {
      const entry = response.entries[0];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const entryXdr = (entry as any).xdr as string;
      const contractData = xdr.LedgerEntryData.fromXDR(
        entryXdr,
        'base64',
      ).contractData();
      return contractData.val();
    }
    return null;
  }

  async simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.sorobanRpcServer.simulateTransaction(tx);
  }

  private async pollTransactionStatus(
    hash: string,
    maxRetries = 10,
    delayMs = 2000,
  ): Promise<rpc.Api.GetTransactionResponse> {
    for (let i = 0; i < maxRetries; i++) {
      const response = await this.sorobanRpcServer.getTransaction(hash);
      if (
        response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND &&
        (response.status as any) !== 'PENDING'
      ) {
        return response;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Transaction polling timed out for hash: ${hash}`);
  }

  /**
   * Issue #253 — Submit transaction with exponential backoff retry logic.
   * Retries up to 3 times for transient errors (429, 503).
   * Fails immediately for non-retryable errors (400, 404).
   */
  private async submitTransactionWithRetry<T>(
    submitFn: () => Promise<T>,
    maxRetries = 3,
    initialDelayMs = 100,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await submitFn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Extract status code from error response
        const statusCode = error?.response?.status;

        // Fail immediately on non-retryable errors
        if (statusCode === 400 || statusCode === 404) {
          throw error;
        }

        // Only retry on transient errors (429, 503)
        if (statusCode !== 429 && statusCode !== 503) {
          throw error;
        }

        // Don't retry after max attempts
        if (attempt === maxRetries) {
          break;
        }

        // Exponential backoff with jitter
        const exponentialDelay = initialDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * exponentialDelay * 0.1; // 10% jitter
        const delayMs = exponentialDelay + jitter;

        this.logger.warn(
          `Transaction submission failed with ${statusCode}, retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})`,
        );

        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    throw lastError || new Error('Transaction submission failed');
  }

  async readContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<xdr.ScVal | undefined> {
    const tx = new TransactionBuilder(
      new Account(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '0',
      ),
      {
        fee: '100',
        networkPassphrase: this.networkPassphrase,
      },
    )
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(contractId).toScAddress(),
              functionName: method,
              args: args,
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();

    const simulation = await this.simulateTransaction(tx);
    if (rpc.Api.isSimulationSuccess(simulation) && simulation.result) {
      return simulation.result.retval;
    }
    return undefined;
  }

  getHorizonServer(): Horizon.Server {
    return this.horizonServer;
  }

  getSorobanRpcServer(): rpc.Server {
    return this.sorobanRpcServer;
  }

  getNetworkPassphrase(): string {
    return this.networkPassphrase;
  }

  async getContractEvents(
    contractId: string,
    startLedger = 0,
  ): Promise<rpc.Api.EventResponse[]> {
    try {
      const response = await this.sorobanRpcServer.getEvents({
        filters: [
          {
            type: 'contract',
            contractIds: [contractId],
          },
        ],
        startLedger,
        limit: 100,
      });
      return response.events || [];
    } catch (error) {
      this.logger.error(
        `Failed to fetch events for contract ${contractId}: ${(error as Error).message}`,
      );
      return [];
    }
  }
}
