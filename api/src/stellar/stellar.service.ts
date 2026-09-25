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
import { SequenceNumberManager } from './sequence-number-manager.service';
import { RequestContextStore } from '../common/request-context';

/**
 * Result returned by confirmTransaction (#918).
 *
 * status  — final ledger status: SUCCESS | FAILED | TIMEOUT
 * hash    — the transaction hash that was polled
 * latencyMs — time in ms from first poll call to resolution (confirm latency metric)
 * errorMessage — present when status === FAILED; contains the on-chain error
 */
export interface TransactionConfirmation {
  status: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
  hash: string;
  latencyMs: number;
  errorMessage?: string;
}

@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);
  private horizonServer: Horizon.Server;
  private sorobanRpcServer: rpc.Server;
  private networkPassphrase: string;

  /** In-process cache for account info. Key: Stellar address. */
  private readonly accountInfoCache = new Map<
    string,
    { value: Horizon.ServerApi.AccountRecord; expiresAt: number }
  >();
  private static readonly ACCOUNT_INFO_TTL_MS = 30_000;

  constructor(
    private configService: ConfigService,
    private seqNoManager: SequenceNumberManager,
  ) {}

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

  private async getNextSequenceNumber(publicKey: string): Promise<number> {
    const cached = this.seqNoManager.getNextSequenceNumber(publicKey);
    if (cached !== undefined) {
      return cached;
    }
    const account = await this.horizonServer.loadAccount(publicKey);
    const seq = Number(account.sequenceNumber);
    this.seqNoManager.cacheSequenceNumber(publicKey, seq);
    return this.seqNoManager.getNextSequenceNumber(publicKey)!;
  }

  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    signerKeypair: Keypair,
    retries = 1,
  ): Promise<rpc.Api.GetTransactionResponse> {
    const pk = signerKeypair.publicKey();
    const seq = await this.getNextSequenceNumber(pk);
    const account = new Account(pk, seq.toString());

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

      this.logger.debug(
        `Submitting Soroban tx: method=${method} hash=${preparedTx.hash().toString('hex').slice(0, 16)}...`,
      );
      this.logger.verbose(
        `Full XDR for method=${method}: ${preparedTx.toEnvelope().toXDR('base64')}`,
      );

      try {
        const response = await this.submitTransactionWithRetry(() =>
          this.sorobanRpcServer.sendTransaction(preparedTx),
        );

        if ((response.status as string) === 'PENDING') {
          const result = await this.pollTransactionStatus(response.hash);
          this.invalidateAccountInfoCache(pk);
          return result;
        }
        throw new Error(`Transaction failed with status: ${response.status}`);
      } catch (error: unknown) {
        const isBadSeq =
          (error as Error).message?.toLowerCase().includes('tx_bad_seq') ||
          (
            error as {
              response?: {
                data?: { extras?: { result_codes?: { transaction?: string } } };
              };
            }
          )?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';

        if (isBadSeq && retries > 0) {
          this.logger.warn(
            `tx_bad_seq for ${pk} (sig:${method}), resetting cache and retrying`,
          );
          this.seqNoManager.reset(pk);
          return this.invokeContract(
            contractId,
            method,
            args,
            signerKeypair,
            retries - 1,
          );
        }
        throw error;
      }
    } else {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation)}`);
    }
  }

  async buildAndSubmit(
    operations: Operation[],
    signerKeypair: Keypair,
    retries = 1,
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    const pk = signerKeypair.publicKey();
    const seq = await this.getNextSequenceNumber(pk);
    const account = new Account(pk, seq.toString());

    const txBuilder = new TransactionBuilder(account, {
      fee: '1000',
      networkPassphrase: this.networkPassphrase,
    });

    for (const op of operations) {
      txBuilder.addOperation(op as any);
    }

    const tx = txBuilder.setTimeout(30).build();
    tx.sign(signerKeypair);

    this.logger.debug(
      `Submitting Horizon tx: hash=${tx.hash().toString('hex').slice(0, 16)}...`,
    );
    this.logger.verbose(`Full XDR: ${tx.toEnvelope().toXDR('base64')}`);

    try {
      const result = await this.submitTransactionWithRetry(() =>
        this.horizonServer.submitTransaction(tx),
      );
      this.invalidateAccountInfoCache(pk);
      return result;
    } catch (error: unknown) {
      const isBadSeq =
        (
          error as {
            response?: {
              data?: { extras?: { result_codes?: { transaction?: string } } };
            };
          }
        )?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';

      if (isBadSeq && retries > 0) {
        this.logger.warn(`tx_bad_seq for ${pk}, resetting cache and retrying`);
        this.seqNoManager.reset(pk);
        return this.buildAndSubmit(operations, signerKeypair, retries - 1);
      }
      throw error;
    }
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
        const statusCode = (error as { response?: { status?: number } })
          ?.response?.status;

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
          `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] Transaction submission failed with ${statusCode}, retrying in ${Math.round(delayMs)}ms (attempt ${attempt + 1}/${maxRetries})`,
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

  /**
   * Returns Horizon account info for `publicKey`.
   * Results are cached for 30 seconds to avoid redundant Horizon calls on
   * every request. The cache entry for an address is invalidated after every
   * successful transaction submission for that address.
   */
  async getAccountInfo(
    publicKey: string,
  ): Promise<Horizon.ServerApi.AccountRecord> {
    const now = Date.now();
    const cached = this.accountInfoCache.get(publicKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const account = await this.horizonServer.loadAccount(publicKey);
    this.accountInfoCache.set(publicKey, {
      value: account as unknown as Horizon.ServerApi.AccountRecord,
      expiresAt: now + StellarService.ACCOUNT_INFO_TTL_MS,
    });
    return account as unknown as Horizon.ServerApi.AccountRecord;
  }

  /** Invalidate the account info cache entry for `publicKey`. */
  private invalidateAccountInfoCache(publicKey: string): void {
    this.accountInfoCache.delete(publicKey);
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

  /**
   * #918 — Confirm-on-finality
   *
   * Polls `getTransaction` until the transaction reaches a terminal state
   * (SUCCESS or FAILED) or until `maxPolls` × `pollIntervalMs` elapses.
   *
   * - On SUCCESS  → returns { status: 'SUCCESS', hash, latencyMs }
   * - On FAILED   → returns { status: 'FAILED',  hash, latencyMs, errorMessage }
   * - On timeout  → returns { status: 'TIMEOUT', hash, latencyMs }
   *
   * Callers are responsible for rolling back optimistic DB state on FAILED/TIMEOUT.
   */
  async confirmTransaction(
    hash: string,
    maxPolls = 20,
    pollIntervalMs = 2_000,
  ): Promise<TransactionConfirmation> {
    const start = Date.now();

    for (let i = 0; i < maxPolls; i++) {
      const response = await this.sorobanRpcServer.getTransaction(hash);

      if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const latencyMs = Date.now() - start;
        this.logger.log(
          `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] ` +
            `TX confirmed SUCCESS hash=${hash.slice(0, 16)}... latency=${latencyMs}ms`,
        );
        return { status: 'SUCCESS', hash, latencyMs };
      }

      if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
        const latencyMs = Date.now() - start;
        const errorMessage = this.extractTxErrorMessage(response);
        this.logger.warn(
          `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] ` +
            `TX FAILED hash=${hash.slice(0, 16)}... latency=${latencyMs}ms error=${errorMessage}`,
        );
        return { status: 'FAILED', hash, latencyMs, errorMessage };
      }

      // NOT_FOUND or still pending — wait before next poll
      if (i < maxPolls - 1) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }

    const latencyMs = Date.now() - start;
    this.logger.warn(
      `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] ` +
        `TX polling TIMEOUT hash=${hash.slice(0, 16)}... after ${latencyMs}ms`,
    );
    return { status: 'TIMEOUT', hash, latencyMs };
  }

  /** Extract a human-readable error string from a FAILED transaction response. */
  private extractTxErrorMessage(
    response: rpc.Api.GetTransactionResponse,
  ): string {
    try {
      // resultXdr is present on FAILED responses
      const resultXdr = (response as unknown as Record<string, unknown>)
        .resultXdr;
      if (resultXdr && typeof resultXdr === 'string') {
        const result = xdr.TransactionResult.fromXDR(resultXdr, 'base64');
        return result.result().switch().name ?? 'FAILED';
      }
    } catch {
      // ignore parse failures — we'll return the raw status
    }
    return 'FAILED';
  }

  /**
   * #920 — On-chain pre-check simulation
   *
   * Builds and simulates a contract call without signing or submitting it.
   * Use this to probe on-chain state (e.g. current credit status/owner) before
   * issuing the real invoke, so failures are caught fast with no fee burned.
   *
   * Returns the simulation result; callers inspect `rpc.Api.isSimulationSuccess`
   * and `simulation.result.retval` for the response value.
   *
   * The dummy source account (all-zeroes) is valid for simulation-only calls
   * because the RPC node does not enforce account existence during simulation.
   */
  async simulateContractCall(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<rpc.Api.SimulateTransactionResponse> {
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
              args,
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();

    return this.sorobanRpcServer.simulateTransaction(tx);
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
        `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] Failed to fetch events for contract ${contractId}: ${(error as Error).message}`,
      );
      return [];
    }
  }
}
