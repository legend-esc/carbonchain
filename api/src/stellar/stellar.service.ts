import {
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { withRetry, rpcBreaker, CircuitState } from './rpc-resilience';
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
import { RedisSequenceNumberManager } from './redis-sequence-number-manager.service';
import { RequestContextStore } from '../common/request-context';
import {
  METRICS_EVENT_EMITTER,
  CONTRACT_INVOCATION_COMPLETED,
  TX_BAD_SEQ,
} from '../metrics/metrics-events';
import type {
  ContractInvocationCompletedEvent,
  TxBadSeqEvent,
} from '../metrics/metrics-events';
import type { EventEmitter } from 'events';

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

/**
 * Issue #916 — Initial delay (ms) before the first tx_bad_seq retry.
 * Subsequent retries use exponential backoff: delay * 2^attempt.
 */
const BAD_SEQ_INITIAL_RETRY_DELAY_MS = 200;

/** Maximum number of tx_bad_seq retries per submission. */
const BAD_SEQ_MAX_RETRIES = 3;

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
  private networkTimeoutMs = 10_000;

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
    /**
     * Issue #914 — Primary sequence manager: Redis-backed for multi-replica
     * coordination. Falls back to in-memory when Redis is unavailable.
     */
    private seqNoManager: RedisSequenceNumberManager,
    /**
     * Issue #914 — In-memory fallback, kept as a named dependency so it can
     * be used directly in unit tests that do not wire Redis.
     */
    @Optional() private inMemorySeqManager?: SequenceNumberManager,
    @Optional()
    @Inject(METRICS_EVENT_EMITTER)
    private readonly metricsEmitter?: EventEmitter,
  ) {
    const rawMultiplier = configService.get<string>('FEE_BUFFER_MULTIPLIER');
    const parsed =
      rawMultiplier !== undefined ? parseFloat(rawMultiplier) : NaN;
    this.feeBufferMultiplier = Number.isFinite(parsed)
      ? parsed
      : DEFAULT_FEE_BUFFER_MULTIPLIER;
  }

  private withTimeout<T>(operation: Promise<T>, name: string): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${name} timed out`));
      }, this.networkTimeoutMs);
    });
    return Promise.race([operation, timeout]).finally(() =>
      clearTimeout(timer),
    );
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
    this.networkTimeoutMs = this.configService.get<number>(
      'STELLAR_RPC_TIMEOUT_MS',
      10_000,
    );

    this.horizonServer = new Horizon.Server(horizonUrl);
    this.sorobanRpcServer = new rpc.Server(sorobanRpcUrl);

    switch (network.toUpperCase()) {
      case 'PUBLIC':
      case 'MAINNET':
        // Bug fix: 'mainnet' (and 'MAINNET') must map to Networks.PUBLIC, not
        // fall through to TESTNET.  The canonical Stellar name for mainnet is
        // 'PUBLIC', but operators commonly write 'mainnet' in their .env files.
        this.networkPassphrase = Networks.PUBLIC;
        break;
      case 'FUTURENET':
        this.networkPassphrase = Networks.FUTURENET;
        break;
      case 'TESTNET':
        this.networkPassphrase = Networks.TESTNET;
        break;
      default:
        // Bug fix: unknown network values must cause a hard startup failure
        // rather than silently falling through to TESTNET.
        throw new Error(
          `Unknown STELLAR_NETWORK value: "${network}". ` +
            `Accepted values: testnet, mainnet, public, futurenet.`,
        );
    }

    this.logger.log(`StellarService initialized for ${network} network`);
  }

  private async getNextSequenceNumber(publicKey: string): Promise<number> {
    // Issue #914: use the Redis-backed manager for distributed sequence coordination
    // across replicas. Falls back to in-memory automatically when Redis is down.
    return this.seqNoManager.getNextSequenceNumberAtomic(
      publicKey,
      async () => {
        const account = await this.horizonServer.loadAccount(publicKey);
        return Number(account.sequenceNumber);
      },
    );
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
      this.baseFeeCache = {
        value: baseFee,
        expiresAt: now + BASE_FEE_CACHE_TTL_MS,
      };
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

  /**
   * Extract the SorobanTransactionData (resource fee footprint) from a built
   * transaction, or undefined when the envelope carries no Soroban ext.
   */
  private extractSorobanData(
    tx: Transaction,
  ): xdr.SorobanTransactionData | undefined {
    const envelope = tx.toEnvelope();
    if (envelope.type !== 'envelopeTypeTx') {
      return undefined;
    }
    const ext = envelope.v1.tx.ext;
    return ext.type === 'sorobanData' ? ext.sorobanData : undefined;
  }

  /**
   * Invoke a Soroban contract method, signing with the supplied keypair and
   * submitting the transaction to the Soroban RPC node.
   *
   * The method builds the transaction, simulates it to derive the resource
   * fee (with `FEE_BUFFER_MULTIPLIER` headroom), signs, submits, and polls
   * until the transaction reaches a terminal state.
   *
   * **Retry / throttling behavior**
   * - `tx_insufficient_fee` rejections are retried up to 3 times, doubling the
   *   fee on each attempt (issue #546).
   * - `tx_bad_seq` rejections are retried up to `retries` times with jittered
   *   exponential backoff (`BAD_SEQ_INITIAL_RETRY_DELAY_MS * 2^attempt`) and
   *   sequence-cache invalidation (issue #916).
   * - Submission itself is wrapped in `submitTransactionWithRetry`, which
   *   retries transient errors (429/5xx/timeouts) up to 3 times.
   *
   * **Error mapping** — on-chain contract errors surfaced by the simulation or
   * the final result are mapped to HTTP exceptions by `contract-error-mapper.ts`
   * (e.g. `ContractError::Unauthorized` → `ForbiddenException`). This method
   * throws raw `Error` instances; callers should route them through the mapper.
   *
   * @param contractId - Contract address (StrKey `C...`) to invoke.
   * @param method - Contract function name to call.
   * @param args - Soroban `ScVal` arguments for the function. Defaults to `[]`.
   * @param signerKeypair - Keypair used to sign and pay for the transaction.
   * @param retries - Maximum `tx_bad_seq` retries. Defaults to 3.
   * @returns The final `getTransaction` response, enriched with
   *   `estimatedFeeStroops` (the actual fee paid in stroops).
   * @throws {Error} When simulation fails, the transaction fails on-chain, or
   *   retries are exhausted.
   * @example
   * ```ts
   * const result = await stellarService.invokeContract(
   *   contractId,
   *   'transfer',
   *   [from.toScVal(), to.toScVal(), amountToScVal],
   *   adminKeypair,
   * );
   * ```
   */
  async invokeContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    signerKeypair: Keypair,
    retries = BAD_SEQ_MAX_RETRIES,
  ): Promise<
    rpc.Api.GetTransactionResponse & { estimatedFeeStroops?: number }
  > {
    const startTime = Date.now();

    try {
      return await this.invokeContractImpl(
        contractId,
        method,
        args,
        signerKeypair,
        retries,
        startTime,
      );
    } catch (error: unknown) {
      // Emit failure event for any unhandled error (simulation failure,
      // max fee bump retries, unexpected errors, etc.).
      this.metricsEmitter?.emit(CONTRACT_INVOCATION_COMPLETED, {
        contract: contractId,
        method,
        status: 'failure',
        durationMs: Date.now() - startTime,
      } satisfies ContractInvocationCompletedEvent);
      throw error;
    }
  }

  /**
   * Core implementation of invokeContract, extracted so the public method
   * can wrap it with timing and failure-event emission without interfering
   * with the recursive bad-seq retry path.
   *
   * Issue #917 — returns the response enriched with `estimatedFeeStroops` so
   * callers (and DTOs) can surface the actual fee derived from simulation.
   */
  private async invokeContractImpl(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
    signerKeypair: Keypair,
    retries = BAD_SEQ_MAX_RETRIES,
    startTime: number,
    badSeqAttempt = 0,
  ): Promise<
    rpc.Api.GetTransactionResponse & { estimatedFeeStroops?: number }
  > {
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
      // This SDK version has no TransactionBuilder.setBaseFee, so we rebuild the
      // assembled transaction via cloneFrom, preserving the sorobanData (and thus
      // the resource fee) from the assembled envelope.
      const assembledTx = rpc.assembleTransaction(tx, simulation).build();

      // Compute the final fee with buffer AFTER assembly so it accounts for
      // the simulation's minResourceFee recommendation.
      const fee = this.computeSorobanFee(simulation);

      // Build the transaction; assembleTransaction already set resourceFee
      // internally — we apply our fee as the base fee override.
      const preparedTx = TransactionBuilder.cloneFrom(assembledTx, {
        fee,
        sorobanData: this.extractSorobanData(assembledTx),
      }).build();
      preparedTx.sign(signerKeypair);

      this.logger.debug(
        `Submitting Soroban tx: method=${method} fee=${fee} hash=${Buffer.from(preparedTx.hash()).toString('hex').slice(0, 16)}...`,
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

      for (
        let feeAttempt = 0;
        feeAttempt <= MAX_FEE_BUMP_RETRIES;
        feeAttempt++
      ) {
        try {
          const response = await this.submitTransactionWithRetry(() =>
            this.sorobanRpcServer.sendTransaction(currentTx),
          );

          if ((response.status as string) === 'PENDING') {
            const result = await this.pollTransactionStatus(response.hash);
            this.invalidateAccountInfoCache(pk);

            // Bug fix: FAILED transactions must not be reported as successful.
            // Throw here so the catch block in invokeContract emits the failure
            // event and the caller receives an error rather than a FAILED result.
            if (String(result.status) === 'FAILED') {
              throw new Error(
                `Transaction failed on-chain: ${result.status} (hash: ${response.hash})`,
              );
            }

            // Issue #495 — emit success event (replaces direct MetricsService call).
            this.metricsEmitter?.emit(CONTRACT_INVOCATION_COMPLETED, {
              contract: contractId,
              method,
              status: 'success',
              durationMs: Date.now() - startTime,
              feeStroops: currentFee,
            } satisfies ContractInvocationCompletedEvent);
            this.logger.log(
              `[issue#546] Contract call fee paid: method=${method} fee_stroops=${currentFee}`,
            );

            // Issue #917 — attach the actual simulated fee so callers and
            // DTOs can surface a non-constant estimatedFeeStroops value.
            return Object.assign(result, { estimatedFeeStroops: currentFee });
          }
          throw new Error(`Transaction failed with status: ${response.status}`);
        } catch (error: unknown) {
          const errMsg = (error as Error).message?.toLowerCase() ?? '';

          // Detect insufficient-fee rejection
          const isInsufficientFee =
            errMsg.includes('tx_insufficient_fee') ||
            errMsg.includes('insufficient fee') ||
            (
              error as {
                response?: {
                  data?: {
                    extras?: { result_codes?: { transaction?: string } };
                  };
                };
              }
            )?.response?.data?.extras?.result_codes?.transaction ===
              'tx_insufficient_fee';

          if (isInsufficientFee && feeAttempt < MAX_FEE_BUMP_RETRIES) {
            currentFee = currentFee * 2;
            this.logger.warn(
              `[issue#546] tx_insufficient_fee for method=${method} (attempt ${feeAttempt + 1}/${MAX_FEE_BUMP_RETRIES}), bumping fee to ${currentFee} stroops`,
            );

            // Rebuild the transaction with the bumped fee against the same
            // account sequence number (already incremented — reuse).
            currentTx = TransactionBuilder.cloneFrom(currentTx, {
              fee: String(currentFee),
              sorobanData: this.extractSorobanData(currentTx),
            }).build();
            currentTx.sign(signerKeypair);
            continue;
          }

          // Not an insufficient-fee error, or retries exhausted — fall through
          // to the existing bad-seq retry logic.
          const isBadSeq =
            errMsg.includes('tx_bad_seq') ||
            (
              error as {
                response?: {
                  data?: {
                    extras?: { result_codes?: { transaction?: string } };
                  };
                };
              }
            )?.response?.data?.extras?.result_codes?.transaction ===
              'tx_bad_seq';

          if (isBadSeq && retries > 0) {
            // Issue #916 — exponential backoff on tx_bad_seq retries.
            // delay = BAD_SEQ_INITIAL_RETRY_DELAY_MS * 2^badSeqAttempt
            const delay =
              BAD_SEQ_INITIAL_RETRY_DELAY_MS * Math.pow(2, badSeqAttempt);

            this.logger.warn(
              `[#916] tx_bad_seq for ${pk} (method=${method}), attempt ${badSeqAttempt + 1}/${BAD_SEQ_MAX_RETRIES}, ` +
                `invalidating cache and retrying in ${delay}ms`,
            );

            // Issue #916 — emit tx_bad_seq metric so operators can track frequency.
            this.metricsEmitter?.emit(TX_BAD_SEQ, {
              publicKey: pk,
              method,
              attempt: badSeqAttempt + 1,
            } satisfies TxBadSeqEvent);

            // Invalidate both Redis and in-memory caches so the next attempt
            // re-fetches the current sequence from Horizon.
            await this.seqNoManager.reset(pk);
            await new Promise<void>((resolve) => setTimeout(resolve, delay));

            return this.invokeContractImpl(
              contractId,
              method,
              args,
              signerKeypair,
              retries - 1,
              startTime,
              badSeqAttempt + 1,
            );
          }
          throw error;
        }
      }

      // Should be unreachable — the loop either returns or throws.
      throw new Error(
        `Max fee bump retries (${MAX_FEE_BUMP_RETRIES}) exceeded for method=${method}`,
      );
    } else {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation)}`);
    }
  }

  private isBadSequenceError(error: unknown): boolean {
    if (typeof error === 'string') return error.includes('tx_bad_seq');
    if (error instanceof Error) return error.message.includes('tx_bad_seq');
    const serialized = JSON.stringify(error);
    return typeof serialized === 'string' && serialized.includes('tx_bad_seq');
  }

  /**
   * Build, sign, and submit a classic Horizon transaction containing the
   * supplied operations.
   *
   * The base fee is fetched from Horizon (cached for 60s) and multiplied by
   * `FEE_BUFFER_MULTIPLIER`. The transaction uses a 30-second timeout.
   *
   * **Retry behavior** — `tx_bad_seq` rejections are retried up to `retries`
   * times with exponential backoff and sequence-cache invalidation (issue
   * #916). Submission is wrapped in `submitTransactionWithRetry` for transient
   * 429/5xx/timeout errors.
   *
   * @param operations - Horizon operations to include in the transaction.
   * @param signerKeypair - Keypair used to sign and pay for the transaction.
   * @param retries - Maximum `tx_bad_seq` retries. Defaults to 3.
   * @param badSeqAttempt - Internal retry counter (do not set manually).
   * @returns The Horizon submit-transaction response.
   * @throws {Error} When submission fails after retries are exhausted.
   * @example
   * ```ts
   * await stellarService.buildAndSubmit(
   *   [Operation.payment({ destination, asset, amount })],
   *   keypair,
   * );
   * ```
   */
  async buildAndSubmit(
    operations: Operation[],
    signerKeypair: Keypair,
    retries = BAD_SEQ_MAX_RETRIES,
    badSeqAttempt = 0,
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    const pk = signerKeypair.publicKey();
    const seq = await this.getNextSequenceNumber(pk);
    const account = new Account(pk, seq.toString());

    // Issue #472: Fetch the Horizon network base fee with a 60s TTL cache.
    const baseFee = await this.getHorizonBaseFee();
    const feeWithBuffer = String(Math.ceil(baseFee * this.feeBufferMultiplier));

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
      `Submitting Horizon tx: fee=${feeWithBuffer} hash=${Buffer.from(tx.hash()).toString('hex').slice(0, 16)}...`,
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
        // Issue #916 — exponential backoff on tx_bad_seq retries.
        const delay =
          BAD_SEQ_INITIAL_RETRY_DELAY_MS * Math.pow(2, badSeqAttempt);

        this.logger.warn(
          `[#916] tx_bad_seq for ${pk} (Horizon), attempt ${badSeqAttempt + 1}/${BAD_SEQ_MAX_RETRIES}, ` +
            `invalidating cache and retrying in ${delay}ms`,
        );

        // Issue #916 — emit tx_bad_seq metric counter.
        this.metricsEmitter?.emit(TX_BAD_SEQ, {
          publicKey: pk,
          method: 'buildAndSubmit',
          attempt: badSeqAttempt + 1,
        } satisfies TxBadSeqEvent);

        // Invalidate both Redis and in-memory caches.
        await this.seqNoManager.reset(pk);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        return this.buildAndSubmit(
          operations,
          signerKeypair,
          retries - 1,
          badSeqAttempt + 1,
        );
      }
      throw error;
    }
  }

  /**
   * Issue #952 / #1177 — Build an **unsigned** Soroban contract-invocation
   * transaction XDR for client-side signing (e.g. Freighter).
   *
   * The returned XDR is a base64-encoded `TransactionEnvelope` that has been
   * simulated and assembled (resource fee + footprint applied) but **not
   * signed**. The client signs it and submits the signed XDR back via
   * {@link submitTransaction}.
   *
   * **Fee** — the base fee is taken from Horizon (cached, 60s TTL) and the
   * resource fee is derived from the simulation, both multiplied by
   * `FEE_BUFFER_MULTIPLIER`.
   *
   * **Time bounds** — the transaction is valid for 30 seconds (matching the
   * server-side invoke path). Callers that need a longer window should sign
   * promptly.
   *
   * **Sequence number** — obtained from the distributed sequence manager
   * (`RedisSequenceNumberManager`) so concurrent builds across replicas do not
   * collide.
   *
   * **Error mapping** — simulation failures throw a raw `Error`; callers should
   * map contract error codes to HTTP exceptions via `contract-error-mapper.ts`.
   *
   * @param contractId - Contract address (StrKey `C...`) to invoke.
   * @param method - Contract function name to call.
   * @param args - Soroban `ScVal` arguments for the function.
   * @param sourceAccount - Public key (`G...`) of the account that will sign
   *   and pay for the transaction.
   * @returns Base64-encoded unsigned transaction XDR.
   * @throws {Error} When the source account cannot be loaded or simulation fails.
   * @example
   * ```ts
   * const xdr = await stellarService.buildContractTransaction(
   *   contractId,
   *   'approve_credit',
   *   [creditIdToScVal, verifierToScVal],
   *   verifierPublicKey,
   * );
   * // hand `xdr` to Freighter for signing, then:
   * await stellarService.submitTransaction(signedXdr);
   * ```
   */
  async buildContractTransaction(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    sourceAccount: string,
  ): Promise<string> {
    this.logger.log(
      `Building tx for ${method} on ${contractId} from ${sourceAccount}`,
    );

    // Load the source account (cached) and obtain the next sequence number
    // from the distributed manager so concurrent builds don't collide.
    await this.getAccountInfo(sourceAccount);
    const seq = await this.getNextSequenceNumber(sourceAccount);
    const account = new Account(sourceAccount, seq.toString());

    // Base fee from Horizon (cached) with buffer applied.
    const baseFee = await this.getHorizonBaseFee();
    const feeWithBuffer = String(Math.ceil(baseFee * this.feeBufferMultiplier));

    const tx = new TransactionBuilder(account, {
      fee: feeWithBuffer,
      networkPassphrase: this.networkPassphrase,
    })
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

    // Simulate to obtain the resource fee and footprint, then assemble.
    const simulation = await this.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(simulation)) {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation)}`);
    }

    const assembledTx = rpc.assembleTransaction(tx, simulation).build();
    const fee = this.computeSorobanFee(simulation);

    // Rebuild with the buffered fee while preserving the assembled sorobanData
    // (resource fee + footprint). The result is unsigned.
    const preparedTx = TransactionBuilder.cloneFrom(assembledTx, {
      fee,
      sorobanData: this.extractSorobanData(assembledTx),
    }).build();

    return preparedTx.toXDR();
  }

  /**
   * Issue #1178 — Submit a pre-signed transaction XDR from the user's wallet.
   *
   * The XDR is parsed with the configured network passphrase, the source
   * account is extracted, and the raw signed envelope is submitted to Soroban
   * RPC. On `tx_bad_seq` the sequence manager is reset and the submission is
   * retried with exponential backoff up to `BAD_SEQ_MAX_RETRIES` times.
   *
   * After submission the transaction is polled to finality so the returned
   * object carries the transaction hash and the final status.
   */
  async submitTransaction(
    signedXdr: string,
  ): Promise<Horizon.HorizonApi.SubmitTransactionResponse> {
    const tx = TransactionBuilder.fromXDR(
      signedXdr,
      this.networkPassphrase,
    ) as Transaction;

    const pk = tx.source;
    const hash = Buffer.from(tx.hash()).toString('hex');

    this.logger.log(
      `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] ` +
        `Submitting pre-signed transaction hash=${hash.slice(0, 16)}... source=${pk}`,
    );

    for (let attempt = 0; attempt <= BAD_SEQ_MAX_RETRIES; attempt++) {
      try {
        const response = await this.withTimeout(
          this.sorobanRpcServer.sendTransaction(tx),
          'sendTransaction',
        );

        // Invalidate the cached account info — the sequence has advanced.
        this.invalidateAccountInfoCache(pk);

        const status = String(response.status);

        if (status === 'ERROR') {
          // RPC reports an error envelope — surface it as a thrown error so
          // callers do not mistake it for a successful submission.
          throw new Error(
            `Transaction submission failed with status ERROR (hash: ${response.hash ?? hash})`,
          );
        }

        // Poll to finality so the caller receives the confirmed status.
        let finalStatus: string = status;
        try {
          const result = await this.pollTransactionStatus(
            response.hash ?? hash,
          );
          finalStatus = String(result.status);
        } catch (pollError) {
          this.logger.warn(
            `[#1178] Failed to poll final status for hash=${hash.slice(0, 16)}...: ${(pollError as Error).message}`,
          );
        }

        return {
          hash: response.hash ?? hash,
          status: finalStatus,
        } as unknown as Horizon.HorizonApi.SubmitTransactionResponse;
      } catch (error: unknown) {
        const isBadSeq = this.isBadSequenceError(error);

        if (isBadSeq && attempt < BAD_SEQ_MAX_RETRIES) {
          const delay = BAD_SEQ_INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);

          this.logger.warn(
            `[#1178] tx_bad_seq for ${pk} (submitTransaction), attempt ${attempt + 1}/${BAD_SEQ_MAX_RETRIES}, ` +
              `resetting sequence and retrying in ${delay}ms`,
          );

          this.metricsEmitter?.emit(TX_BAD_SEQ, {
            publicKey: pk,
            method: 'submitTransaction',
            attempt: attempt + 1,
          } satisfies TxBadSeqEvent);

          // Reset both the Redis-backed and in-memory sequence caches so the
          // next attempt re-fetches the current sequence from Horizon.
          await this.seqNoManager.reset(pk);
          if (this.inMemorySeqManager) {
            await this.inMemorySeqManager.reset(pk);
          }

          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          continue;
        }

        throw error;
      }
    }

    // Should be unreachable — the loop either returns or throws.
    throw new Error(
      `Max tx_bad_seq retries (${BAD_SEQ_MAX_RETRIES}) exceeded for submitTransaction (source: ${pk})`,
    );
  }

  async getContractData(
    contractId: string,
    key: xdr.ScVal,
    durability: xdr.ContractDataDurability = xdr.ContractDataDurability
      .persistent,
  ): Promise<xdr.ScVal | null> {
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key,
        durability,
      }),
    );

    const response = await this.withTimeout(
      this.sorobanRpcServer.getLedgerEntries(ledgerKey),
      'getLedgerEntries',
    );
    if (response.entries && response.entries.length > 0) {
      const entry = response.entries[0];
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const entryXdr = (entry as any).xdr as string;
      const entryData = xdr.LedgerEntryData.fromXDR(entryXdr, 'base64');
      if (entryData.type !== 'contractData') {
        return null;
      }
      return entryData.contractData.val;
    }
    return null;
  }

  /**
   * Simulate a transaction against the Soroban RPC node without submitting it.
   *
   * The call is bounded by `STELLAR_RPC_TIMEOUT_MS` (default 10s). Simulation
   * does **not** consume fees or sequence numbers.
   *
   * @param tx - The transaction to simulate.
   * @returns The raw simulation response; inspect with
   *   `rpc.Api.isSimulationSuccess`.
   * @throws {Error} When the RPC call times out.
   * @example
   * ```ts
   * const sim = await stellarService.simulateTransaction(tx);
   * if (rpc.Api.isSimulationSuccess(sim)) {
   *   console.log(sim.result?.retval);
   * }
   * ```
   */
  async simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.withTimeout(
      this.sorobanRpcServer.simulateTransaction(tx),
      'simulateTransaction',
    );
  }

  private async pollTransactionStatus(
    hash: string,
    maxRetries = 10,
    delayMs = 2000,
  ): Promise<rpc.Api.GetTransactionResponse> {
    for (let i = 0; i < maxRetries; i++) {
      const response = await this.withTimeout(
        this.sorobanRpcServer.getTransaction(hash),
        'getTransaction',
      );
      if (
        String(response.status) !== 'NOT_FOUND' &&
        String(response.status) !== 'PENDING'
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

        const message = lastError.message.toLowerCase();
        const transient =
          statusCode === 429 ||
          statusCode === 500 ||
          statusCode === 502 ||
          statusCode === 503 ||
          statusCode === 504 ||
          message.includes('timed out') ||
          message.includes('econnreset');
        if (!transient) {
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

  /**
   * Read a value from a Soroban contract via a simulation-only call.
   *
   * Uses a dummy all-zeroes source account (valid for simulation) and wraps
   * the call in the RPC circuit breaker plus jittered exponential retry
   * (`rpc-resilience.ts`, issue #939). When the circuit is open, the call
   * fails fast with a `CircuitOpenError` and the `stellar.rpc.degraded` metric
   * is emitted.
   *
   * @param contractId - Contract address (StrKey `C...`) to read from.
   * @param method - Read-only contract function name.
   * @param args - Soroban `ScVal` arguments. Defaults to `[]`.
   * @returns The function's return `ScVal`, or `undefined` when the simulation
   *   does not produce a result.
   * @throws {Error} When the circuit is open or retries are exhausted.
   * @example
   * ```ts
   * const val = await stellarService.readContract(contractId, 'get_credit', [
   *   creditIdToScVal,
   * ]);
   * ```
   */
  async readContract(
    contractId: string,
    method: string,
    args: xdr.ScVal[] = [],
  ): Promise<xdr.ScVal | undefined> {
    // Issue #939: wrap with circuit breaker + jittered exponential retry
    return rpcBreaker.call(() =>
      withRetry(async () => {
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
      }),
    );
  }

  /**
   * Expose the RPC circuit-breaker status for health/metrics endpoints.
   * Issue #939.
   *
   * @returns The current circuit state (`CLOSED` | `OPEN` | `HALF_OPEN`) and
   *   the metric name emitted when the breaker trips.
   * @example
   * ```ts
   * const { status } = stellarService.getRpcStatus();
   * if (status === 'OPEN') { // degrade gracefully }
   * ```
   */
  getRpcStatus(): { status: CircuitState; metric: string } {
    return { status: rpcBreaker.state, metric: 'stellar.rpc.degraded' };
  }

  /**
   * Returns Horizon account info for `publicKey`.
   *
   * Results are cached for 30 seconds (`ACCOUNT_INFO_TTL_MS`) to avoid
   * redundant Horizon calls on every request. The cache entry for an address
   * is invalidated after every successful transaction submission for that
   * address, and can be invalidated explicitly via
   * {@link invalidateAccountCache} (which also propagates across replicas via
   * Redis, issue #1180).
   *
   * The Horizon call is bounded by `STELLAR_RPC_TIMEOUT_MS`.
   *
   * @param publicKey - Stellar account public key (`G...`).
   * @returns The Horizon account record.
   * @throws {Error} When the account cannot be loaded or the call times out.
   * @example
   * ```ts
   * const account = await stellarService.getAccountInfo(publicKey);
   * console.log(account.sequenceNumber);
   * ```
   */
  async getAccountInfo(
    publicKey: string,
  ): Promise<Horizon.ServerApi.AccountRecord> {
    const now = Date.now();
    const cached = this.accountInfoCache.get(publicKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const account = await this.withTimeout(
      this.horizonServer.loadAccount(publicKey),
      'loadAccount',
    );
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

  /**
   * Issue #1180 — Invalidate the cached account info for `address`.
   *
   * Drops the local `accountInfoCache` entry and publishes an invalidation
   * event through the Redis-backed sequence manager so every replica drops its
   * own entry. Call this after any operation that mutates account state
   * (credit transfer, offer create/cancel/buy, retirement, etc.).
   *
   * The Redis publish is best-effort: failures are logged and do not throw, so
   * callers are never blocked by cache-invalidation problems.
   *
   * @param address - Stellar account public key (`G...`) whose cache entry
   *   should be dropped.
   * @returns A promise that resolves once the local entry is dropped and the
   *   invalidation event has been published (or publishing has failed).
   * @example
   * ```ts
   * await stellarService.invalidateAccountCache(sellerPublicKey);
   * ```
   */
  async invalidateAccountCache(address: string): Promise<void> {
    this.accountInfoCache.delete(address);
    try {
      await this.seqNoManager.publishAccountInvalidation(address);
    } catch (err) {
      this.logger.warn(
        `Failed to publish account cache invalidation for ${address}: ${(err as Error).message}`,
      );
    }
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
   * - On SUCCESS  → returns `{ status: 'SUCCESS', hash, latencyMs }`
   * - On FAILED   → returns `{ status: 'FAILED', hash, latencyMs, errorMessage }`
   * - On timeout  → returns `{ status: 'TIMEOUT', hash, latencyMs }`
   *
   * Callers are responsible for rolling back optimistic DB state on
   * FAILED/TIMEOUT. This method does not throw on FAILED/TIMEOUT — inspect the
   * returned `status`.
   *
   * @param hash - Transaction hash to poll.
   * @param maxPolls - Maximum number of `getTransaction` polls. Defaults to 20.
   * @param pollIntervalMs - Delay between polls in ms. Defaults to 2000.
   * @returns A {@link TransactionConfirmation} describing the final state.
   * @example
   * ```ts
   * const { status } = await stellarService.confirmTransaction(hash);
   * if (status !== 'SUCCESS') { // roll back optimistic state }
   * ```
   */
  async confirmTransaction(
    hash: string,
    maxPolls = 20,
    pollIntervalMs = 2_000,
  ): Promise<TransactionConfirmation> {
    const start = Date.now();

    for (let i = 0; i < maxPolls; i++) {
      const response = await this.sorobanRpcServer.getTransaction(hash);

      if (String(response.status) === 'SUCCESS') {
        const latencyMs = Date.now() - start;
        this.logger.log(
          `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] ` +
            `TX confirmed SUCCESS hash=${hash.slice(0, 16)}... latency=${latencyMs}ms`,
        );
        return { status: 'SUCCESS', hash, latencyMs };
      }

      if (String(response.status) === 'FAILED') {
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
        return result.result.type ?? 'FAILED';
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
    sourceAccount?: string,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    // Issue #1179 — When a custom source account is supplied, load it from
    // Horizon so the simulation uses the real sequence number and the
    // resulting fee/resource estimates are accurate for client-side signing.
    let account: Account;
    if (sourceAccount) {
      const accountInfo = await this.getAccountInfo(sourceAccount);
      account = new Account(sourceAccount, accountInfo.sequenceNumber);
    } else {
      // Dummy source account (all-zeroes) is valid for simulation-only calls
      // because the RPC node does not enforce account existence.
      account = new Account(
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '0',
      );
    }

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
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

    // Simulate without signing — the RPC node only needs the envelope.
    return this.withTimeout(
      this.sorobanRpcServer.simulateTransaction(tx),
      'simulateContractCall',
    );
  }

  /**
   * Fetch recent contract events from the Soroban RPC node.
   *
   * Returns an empty array (and logs an error) on failure rather than throwing,
   * so callers can treat event retrieval as best-effort. The RPC call is
   * bounded by `STELLAR_RPC_TIMEOUT_MS`.
   *
   * @param contractId - Contract address (StrKey `C...`) to filter events for.
   * @param startLedger - First ledger to scan. Defaults to 0.
   * @returns Up to 100 matching events, or `[]` on failure.
   * @example
   * ```ts
   * const events = await stellarService.getContractEvents(contractId, ledger);
   * ```
   */
  async getContractEvents(
    contractId: string,
    startLedger = 0,
  ): Promise<rpc.Api.EventResponse[]> {
    try {
      const response = await this.withTimeout(
        this.sorobanRpcServer.getEvents({
          filters: [
            {
              type: 'contract',
              contractIds: [contractId],
            },
          ],
          startLedger,
          limit: 100,
        }),
        'getContractEvents',
      );
      return response.events || [];
    } catch (error) {
      this.logger.error(
        `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] Failed to fetch events for contract ${contractId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Fetch the latest ledger sequence from the Soroban RPC node.
   *
   * Returns `0` (and logs an error) on failure rather than throwing. The RPC
   * call is bounded by `STELLAR_RPC_TIMEOUT_MS`.
   *
   * @returns The latest ledger sequence, or `0` on failure.
   * @example
   * ```ts
   * const ledger = await stellarService.getLatestLedger();
   * ```
   */
  async getLatestLedger(): Promise<number> {
    try {
      const response = await this.withTimeout(
        this.sorobanRpcServer.getLatestLedger(),
        'getLatestLedger',
      );
      return response.sequence;
    } catch (error) {
      this.logger.error(
        `[requestId=${RequestContextStore.getRequestId() ?? 'unknown'}] Failed to get latest ledger: ${(error as Error).message}`,
      );
      return 0;
    }
  }
}
