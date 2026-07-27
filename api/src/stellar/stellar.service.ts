import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
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
import { MetricsService } from '../metrics/metrics.service';

/**
 * Default fee-buffer multiplier applied on top of the simulated minResourceFee.
 * Configurable via FEE_BUFFER_MULTIPLIER environment variable.
 * e.g. 1.1 = 10% headroom above the minimum.
 */
const DEFAULT_FEE_BUFFER_MULTIPLIER = 1.1;

/** Base fee used as a fallback when Horizon fetchBaseFee fails. */
const FALLBACK_BASE_FEE = 100; // stroops

/** TTL for the Horizon base fee cache (ms). */
const BASE_FEE_CACHE_TTL_MS = 60_000;

/** Mandatory delay before re-fetching sequence number after tx_bad_seq (ms). */
const BAD_SEQ_RETRY_DELAY_MS = 200;

@Injectable()
export class StellarService implements OnModuleInit {
  private readonly logger = new Logger(StellarService.name);
  private horizonServer: Horizon.Server;
  private sorobanRpcServer: rpc.Server;
  private networkPassphrase: string;

  /** Fee buffer multiplier (default 1.1). Configurable via FEE_BUFFER_MULTIPLIER. */
  private readonly feeBufferMultiplier: number;

  /** In-process cache for account info. Key: Stellar address. */
  private readonly accountInfoCache = new Map<
    string,
    { value: Horizon.ServerApi.AccountRecord; expiresAt: number }
  >();
  private static readonly ACCOUNT_INFO_TTL_MS = 30_000;

  /**
   * Cached Horizon base fee.
   * Issue #472: fetchBaseFee() is called at most once per BASE_FEE_CACHE_TTL_MS.
   */
  private baseFeeCache: { value: number; expiresAt: number } | null = null;

  constructor(
    private configService: ConfigService,
    private seqNoManager: SequenceNumberManager,
    @Optional() private readonly metricsService?: MetricsService,
  ) {
    const rawMultiplier = configService.get<string>('FEE_BUFFER_MULTIPLIER');
    const parsed =
      rawMultiplier !== undefined ? parseFloat(rawMultiplier) : NaN;
    this.feeBufferMultiplier = Number.isFinite(parsed)
      ? parsed
      : DEFAULT_FEE_BUFFER_MULTIPLIER;
  }

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
    // Issue #510: use the per-account promise queue so concurrent callers for
    // the same account never receive the same sequence number.
    return this.seqNoManager.getNextSequenceNumberAtomic(publicKey, async () => {
      const account = await this.horizonServer.loadAccount(publicKey);
      return Number(account.sequenceNumber);
    });
  }

  /**
   * Issue #472: Fetch the Horizon network base fee with a 60-second TTL cache.
   * Falls back to FALLBACK_BASE_FEE (100 stroops) if the call fails.
   */
  private async getHorizonBaseFee(): Promise<number> {
    const now = Date.now();
    if (this.baseFeeCache && this.baseFeeCache.expiresAt > now) {
      return this.baseFeeCache.value;
    }
    try {
      const feeStats = await this.horizonServer.feeStats();
      // Use the p50 (median) accepted base fee for a reliable estimate.
      const baseFee =
        parseInt(feeStats.fee_charged?.p50 ?? String(FALLBACK_BASE_FEE), 10) ||
        FALLBACK_BASE_FEE;
      this.baseFeeCache = { value: baseFee, expiresAt: now + BASE_FEE_CACHE_TTL_MS };
      return baseFee;
    } catch (err) {
      this.logger.warn(
        `Failed to fetch Horizon base fee, using fallback ${FALLBACK_BASE_FEE}: ${(err as Error).message}`,
      );
      return FALLBACK_BASE_FEE;
    }
  }

  /**
   * Issue #472: Compute the Soroban transaction fee from the simulation result.
   * Uses `simulation.minResourceFee` with the configured buffer multiplier.
   * The fee is ceiled to the nearest integer stroop.
   *
   * Note: `rpc.assembleTransaction` sets the fee internally from the simulation,
   * but the subsequent `.build()` call can override it if a fee is passed to the
   * original TransactionBuilder. We therefore apply the fee AFTER assembleTransaction
   * by reading it back from `simulation.minResourceFee`.
   */
  private computeSorobanFee(
    simulation: rpc.Api.SimulateTransactionSuccessResponse,
  ): string {
    const minResourceFee = parseInt(
      String(simulation.minResourceFee ?? '0'),
      10,
    );
    const withBuffer = Math.ceil(minResourceFee * this.feeBufferMultiplier);
    // Ensure we always pay at least the minimum base fee (100 stroops).
    return String(Math.max(withBuffer, FALLBACK_BASE_FEE));
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

    // Issue #472: Use a placeholder fee for the simulation step.
    // The real fee is derived from simulation.minResourceFee after assembly.
    const tx = new TransactionBuilder(account, {
      fee: String(FALLBACK_BASE_FEE),
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
      // assembleTransaction sets the resource fee from the simulation.
      // We then override the fee field on the built transaction to apply our buffer.
      const assembledBuilder = rpc.assembleTransaction(tx, simulation);

      // Compute the final fee with buffer AFTER assembly so it accounts for
      // the simulation's minResourceFee recommendation.
      const fee = this.computeSorobanFee(simulation);

      // Build the transaction; assembleTransaction already set resourceFee
      // internally — we apply our fee as the base fee override.
      const preparedTx = assembledBuilder.setBaseFee(fee).build();
      preparedTx.sign(signerKeypair);

      this.logger.debug(
        `Submitting Soroban tx: method=${method} fee=${fee} hash=${preparedTx.hash().toString('hex').slice(0, 16)}...`,
      );
      this.logger.verbose(
        `Full XDR for method=${method}: ${preparedTx.toEnvelope().toXDR('base64')}`,
      );

      // Issue #546 — insufficient-fee retry loop.
      // If the submission is rejected for tx_insufficient_fee, rebuild with
      // 2× the fee and resubmit.  We allow up to 3 fee-bump retries before
      // giving up.  Each attempt logs the fee paid so operators can diagnose
      // sustained fee pressure.
      const MAX_FEE_BUMP_RETRIES = 3;
      let currentFee = parseInt(fee, 10);
      let currentTx = preparedTx;

      for (let feeAttempt = 0; feeAttempt <= MAX_FEE_BUMP_RETRIES; feeAttempt++) {
        try {
          const response = await this.submitTransactionWithRetry(() =>
            this.sorobanRpcServer.sendTransaction(currentTx),
          );

          if ((response.status as string) === 'PENDING') {
            const result = await this.pollTransactionStatus(response.hash);
            this.invalidateAccountInfoCache(pk);

            // Issue #546 — record the actual fee paid in the histogram.
            this.metricsService?.contractCallFeeStroops
              ?.labels({ contract: contractId, method })
              .observe(currentFee);
            this.logger.log(
              `[issue#546] Contract call fee paid: method=${method} fee_stroops=${currentFee}`,
            );

            return result;
          }
          throw new Error(`Transaction failed with status: ${response.status}`);
        } catch (error: unknown) {
          const errMsg = (error as Error).message?.toLowerCase() ?? '';

          // Detect insufficient-fee rejection
          const isInsufficientFee =
            errMsg.includes('tx_insufficient_fee') ||
            errMsg.includes('insufficient fee') ||
            (error as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } })
              ?.response?.data?.extras?.result_codes?.transaction === 'tx_insufficient_fee';

          if (isInsufficientFee && feeAttempt < MAX_FEE_BUMP_RETRIES) {
            currentFee = currentFee * 2;
            this.logger.warn(
              `[issue#546] tx_insufficient_fee for method=${method} (attempt ${feeAttempt + 1}/${MAX_FEE_BUMP_RETRIES}), bumping fee to ${currentFee} stroops`,
            );

            // Rebuild the transaction with the bumped fee against the same
            // account sequence number (already incremented — reuse).
            const rebuiltBuilder = rpc.assembleTransaction(tx, simulation);
            currentTx = rebuiltBuilder.setBaseFee(String(currentFee)).build();
            currentTx.sign(signerKeypair);
            continue;
          }

          // Not an insufficient-fee error, or retries exhausted — fall through
          // to the existing bad-seq retry logic.
          const isBadSeq =
            errMsg.includes('tx_bad_seq') ||
            (error as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } })
              ?.response?.data?.extras?.result_codes?.transaction === 'tx_bad_seq';

          if (isBadSeq && retries > 0) {
            this.logger.warn(
              `tx_bad_seq for ${pk} (sig:${method}), waiting ${BAD_SEQ_RETRY_DELAY_MS}ms then resetting cache and retrying`,
            );
            this.seqNoManager.reset(pk);
            await new Promise((resolve) =>
              setTimeout(resolve, BAD_SEQ_RETRY_DELAY_MS),
            );
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
      }

      // Should be unreachable — the loop either returns or throws.
      throw new Error(`Max fee bump retries (${MAX_FEE_BUMP_RETRIES}) exceeded for method=${method}`);
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

    // Issue #472: Fetch the Horizon network base fee with a 60s TTL cache.
    const baseFee = await this.getHorizonBaseFee();
    const feeWithBuffer = String(
      Math.ceil(baseFee * this.feeBufferMultiplier),
    );

    const txBuilder = new TransactionBuilder(account, {
      fee: feeWithBuffer,
      networkPassphrase: this.networkPassphrase,
    });

    for (const op of operations) {
      txBuilder.addOperation(op as any);
    }

    const tx = txBuilder.setTimeout(30).build();
    tx.sign(signerKeypair);

    this.logger.debug(
      `Submitting Horizon tx: fee=${feeWithBuffer} hash=${tx.hash().toString('hex').slice(0, 16)}...`,
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
        this.logger.warn(
          `tx_bad_seq for ${pk}, waiting ${BAD_SEQ_RETRY_DELAY_MS}ms then resetting cache and retrying`,
        );
        this.seqNoManager.reset(pk);
        // Issue #473: mandatory delay before re-fetching to allow Horizon to catch up.
        await new Promise((resolve) =>
          setTimeout(resolve, BAD_SEQ_RETRY_DELAY_MS),
        );
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
