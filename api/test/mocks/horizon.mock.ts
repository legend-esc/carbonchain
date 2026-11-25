import * as http from 'http';
import { AddressInfo } from 'net';

/**
 * Simulated Horizon account balance entry.
 */
export interface MockHorizonBalance {
  balance: string;
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  asset_code?: string;
  asset_issuer?: string;
  limit?: string;
}

/**
 * Simulated Horizon account record returned by `GET /accounts/:accountId`
 * and `Horizon.Server.loadAccount(accountId)`.
 */
export interface MockHorizonAccount {
  id: string;
  account_id: string;
  sequence: string;
  balances: MockHorizonBalance[];
  subentry_count: number;
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
  };
  signers: Array<{
    key: string;
    weight: number;
    type: string;
  }>;
  accountId?: () => string;
}

/**
 * Simulated Horizon fee stats returned by `GET /fee_stats` and
 * `Horizon.Server.feeStats()`.
 */
export interface MockHorizonFeeStats {
  last_ledger: string;
  last_ledger_base_fee: string;
  ledger_capacity_usage: string;
  fee_charged: {
    max: string;
    min: string;
    mode: string;
    p10: string;
    p20: string;
    p30: string;
    p40: string;
    p50: string;
    p60: string;
    p70: string;
    p80: string;
    p90: string;
    p95: string;
    p99: string;
  };
  max_fee: {
    max: string;
    min: string;
    mode: string;
    p10: string;
    p20: string;
    p30: string;
    p40: string;
    p50: string;
    p60: string;
    p70: string;
    p80: string;
    p90: string;
    p95: string;
    p99: string;
  };
}

export type MockHorizonTxErrorCode =
  | 'tx_bad_seq'
  | 'tx_insufficient_balance'
  | 'tx_failed'
  | 'rate_limit'
  | 'timeout';

export interface MockHorizonTxSuccess {
  successful: true;
  hash: string;
  ledger: number;
  envelope_xdr: string;
  result_xdr: string;
  result_meta_xdr: string;
}

const DEFAULT_FEE_STATS: MockHorizonFeeStats = {
  last_ledger: '1234567',
  last_ledger_base_fee: '100',
  ledger_capacity_usage: '0.15',
  fee_charged: {
    max: '5000',
    min: '100',
    mode: '100',
    p10: '100',
    p20: '100',
    p30: '100',
    p40: '100',
    p50: '200',
    p60: '250',
    p70: '300',
    p80: '500',
    p90: '1000',
    p95: '2000',
    p99: '5000',
  },
  max_fee: {
    max: '10000',
    min: '100',
    mode: '100',
    p10: '100',
    p20: '100',
    p30: '100',
    p40: '100',
    p50: '200',
    p60: '250',
    p70: '300',
    p80: '500',
    p90: '1000',
    p95: '2000',
    p99: '5000',
  },
};

/**
 * Issue #1379 — Disconnected Mock Horizon test harness.
 *
 * Provides both:
 *  1. A lightweight local HTTP server (`start()` / `stop()`) that speaks
 *     Horizon's REST protocol (`/accounts/:id`, `/fee_stats`, `/transactions`)
 *     so `@stellar/stellar-sdk`'s `Horizon.Server` can run fully offline.
 *  2. A direct `createServerAdapter()` helper for unit tests that mock
 *     `Horizon.Server` methods (`loadAccount`, `feeStats`, `submitTransaction`).
 */
export class MockHorizonHarness {
  private server: http.Server | null = null;
  private baseUrl = '';
  private accounts = new Map<string, MockHorizonAccount>();
  private feeStats: MockHorizonFeeStats = structuredClone(DEFAULT_FEE_STATS);
  private txErrorQueue: MockHorizonTxErrorCode[] = [];
  private submittedTransactions: Array<{ xdr: string; hash: string }> = [];
  private txCounter = 0;

  /** Base URL of the running mock Horizon HTTP server (set after `start()`). */
  get url(): string {
    if (!this.baseUrl) {
      throw new Error(
        'MockHorizonHarness has not been started. Call start() first.',
      );
    }
    return this.baseUrl;
  }

  /** Starts the local HTTP server on an ephemeral localhost port. */
  async start(): Promise<string> {
    if (this.server) return this.baseUrl;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });

    const address = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this.baseUrl;
  }

  /** Stops the local HTTP server. */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = null;
    this.baseUrl = '';
  }

  /** Resets all accounts, fee stats, error queues, and recorded submissions. */
  reset(): void {
    this.accounts.clear();
    this.feeStats = structuredClone(DEFAULT_FEE_STATS);
    this.txErrorQueue = [];
    this.submittedTransactions = [];
    this.txCounter = 0;
  }

  /** Registers or updates a simulated Stellar account. */
  setAccount(
    publicKey: string,
    overrides: Partial<Omit<MockHorizonAccount, 'id' | 'account_id'>> = {},
  ): MockHorizonAccount {
    const record: MockHorizonAccount = {
      id: publicKey,
      account_id: publicKey,
      sequence: overrides.sequence ?? '100',
      balances: overrides.balances ?? [
        { balance: '1000.0000000', asset_type: 'native' },
      ],
      subentry_count: overrides.subentry_count ?? 0,
      thresholds: overrides.thresholds ?? {
        low_threshold: 0,
        med_threshold: 0,
        high_threshold: 0,
      },
      flags: overrides.flags ?? {
        auth_required: false,
        auth_revocable: false,
        auth_immutable: false,
      },
      signers: overrides.signers ?? [
        { key: publicKey, weight: 1, type: 'ed25519_public_key' },
      ],
      accountId: () => publicKey,
    };
    this.accounts.set(publicKey, record);
    return record;
  }

  /** Updates the simulated Horizon fee stats response. */
  setFeeStats(overrides: Partial<MockHorizonFeeStats>): void {
    this.feeStats = {
      ...this.feeStats,
      ...overrides,
      fee_charged: {
        ...this.feeStats.fee_charged,
        ...(overrides.fee_charged ?? {}),
      },
      max_fee: {
        ...this.feeStats.max_fee,
        ...(overrides.max_fee ?? {}),
      },
    };
  }

  /**
   * Queues one or more Horizon error responses for subsequent
   * `submitTransaction` calls (FIFO).
   */
  queueTransactionError(...errors: MockHorizonTxErrorCode[]): void {
    this.txErrorQueue.push(...errors);
  }

  /** Returns all transactions successfully submitted to the mock harness. */
  getSubmittedTransactions(): Array<{ xdr: string; hash: string }> {
    return [...this.submittedTransactions];
  }

  /** Builds a Horizon-shaped Axios-like error object for a given result code. */
  buildHorizonError(code: MockHorizonTxErrorCode): Error & {
    response: { status: number; data: Record<string, unknown> };
  } {
    if (code === 'rate_limit') {
      const err = new Error('Too Many Requests') as Error & {
        response: { status: number; data: Record<string, unknown> };
      };
      err.response = {
        status: 429,
        data: {
          type: 'https://stellar.org/horizon-errors/rate_limit_exceeded',
          title: 'Rate Limit Exceeded',
          status: 429,
          detail: 'Rate limit exceeded in MockHorizonHarness.',
        },
      };
      return err;
    }

    if (code === 'timeout') {
      const err = new Error('Gateway Timeout') as Error & {
        response: { status: number; data: Record<string, unknown> };
      };
      err.response = {
        status: 504,
        data: {
          type: 'https://stellar.org/horizon-errors/timeout',
          title: 'Timeout',
          status: 504,
          detail: 'Simulated Horizon timeout.',
        },
      };
      return err;
    }

    const err = new Error(`Transaction failed with ${code}`) as Error & {
      response: { status: number; data: Record<string, unknown> };
    };
    err.response = {
      status: 400,
      data: {
        type: 'https://stellar.org/horizon-errors/transaction_failed',
        title: 'Transaction Failed',
        status: 400,
        detail: `The transaction failed when submitted to the stellar network (${code}).`,
        extras: {
          result_codes: {
            transaction: code,
          },
        },
      },
    };
    return err;
  }

  /**
   * Returns a mock `Horizon.Server`-compatible object (`loadAccount`,
   * `feeStats`, `submitTransaction`) backed by this harness's state.
   */
  createServerAdapter(): {
    loadAccount: (publicKey: string) => Promise<MockHorizonAccount>;
    feeStats: () => Promise<MockHorizonFeeStats>;
    submitTransaction: (tx: {
      toXDR?: () => string;
    }) => Promise<MockHorizonTxSuccess>;
  } {
    return {
      loadAccount: async (publicKey: string) =>
        this.handleLoadAccount(publicKey),
      feeStats: async () => structuredClone(this.feeStats),
      submitTransaction: async (tx: { toXDR?: () => string }) => {
        const xdr =
          typeof tx?.toXDR === 'function'
            ? tx.toXDR()
            : typeof tx === 'string'
              ? tx
              : '';
        return this.handleSubmitTransaction(xdr);
      },
    };
  }

  private handleLoadAccount(publicKey: string): MockHorizonAccount {
    const account = this.accounts.get(publicKey);
    if (!account) {
      const err = new Error(`Account not found: ${publicKey}`) as Error & {
        response: { status: number; data: Record<string, unknown> };
      };
      err.response = {
        status: 404,
        data: {
          type: 'https://stellar.org/horizon-errors/not_found',
          title: 'Resource Missing',
          status: 404,
          detail: `The resource at /accounts/${publicKey} was not found.`,
        },
      };
      throw err;
    }
    return account;
  }

  private handleSubmitTransaction(xdr: string): MockHorizonTxSuccess {
    const nextError = this.txErrorQueue.shift();
    if (nextError) {
      throw this.buildHorizonError(nextError);
    }

    this.txCounter += 1;
    const hash = `mock_horizon_tx_hash_${String(this.txCounter).padStart(4, '0')}`;
    this.submittedTransactions.push({ xdr, hash });

    return {
      successful: true,
      hash,
      ledger: 1234568 + this.txCounter,
      envelope_xdr: xdr,
      result_xdr: 'AAAAAAAAAGQAAAAAAAAAAQAAAAAAAAABAAAAAAAAAAA=',
      result_meta_xdr: 'AAAAAgAAAAA=',
    };
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    res.setHeader('Content-Type', 'application/json');

    try {
      if (req.method === 'GET' && path === '/') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            horizon_version: '2.30.0-mock',
            core_version: 'stellar-core-mock',
            network_passphrase: 'Test SDF Network ; September 2015',
          }),
        );
        return;
      }

      if (req.method === 'GET' && path === '/fee_stats') {
        res.statusCode = 200;
        res.end(JSON.stringify(this.feeStats));
        return;
      }

      if (req.method === 'GET' && path.startsWith('/accounts/')) {
        const accountId = decodeURIComponent(path.replace('/accounts/', ''));
        const account = this.handleLoadAccount(accountId);
        res.statusCode = 200;
        res.end(JSON.stringify(account));
        return;
      }

      if (req.method === 'POST' && path === '/transactions') {
        const rawBody = await readRequestBody(req);
        const params = new URLSearchParams(rawBody);
        const xdr = params.get('tx') ?? rawBody;
        const result = this.handleSubmitTransaction(xdr);
        res.statusCode = 200;
        res.end(JSON.stringify(result));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ title: 'Not Found', status: 404 }));
    } catch (err) {
      const horizonErr = err as Error & {
        response?: { status: number; data: Record<string, unknown> };
      };
      res.statusCode = horizonErr.response?.status ?? 500;
      res.end(
        JSON.stringify(
          horizonErr.response?.data ?? {
            title: 'Internal Server Error',
            status: res.statusCode,
            detail: horizonErr.message,
          },
        ),
      );
    }
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
