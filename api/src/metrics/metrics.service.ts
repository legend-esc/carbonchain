import { Injectable, OnModuleInit } from '@nestjs/common';
import client from 'prom-client';

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly register: client.Registry;

  httpRequestsTotal: client.Counter<string>;
  httpRequestDurationSeconds: client.Histogram<string>;
  stellarTxSubmitTotal: client.Counter<string>;
  /**
   * Issue #546 — Histogram of the fee paid (in stroops) for each Soroban
   * contract call.  Buckets span 100 stroops (minimum base fee) up to
   * 10,000,000 stroops (10 XLM) to capture the full realistic range.
   *
   * Labels:
   *   contract — the Soroban contract address (or "unknown" if unavailable)
   *   method   — the contract function name
   */
  contractCallFeeStroops: client.Histogram<string>;

  // ── Issue #495: New observability metrics ─────────────────────────────────

  /** Counter: total Stellar contract invocations (success/failure). */
  stellarContractInvocationsTotal: client.Counter<string>;

  /** Histogram: wall-clock duration of contract invocations in ms. */
  stellarContractInvocationDurationMs: client.Histogram<string>;

  /** Counter: total retirements by type (single / batch). */
  carbonchainRetirementsTotal: client.Counter<string>;

  /** Gauge: current number of active (non-retired) credits on-chain. */
  carbonchainCreditsActiveTotal: client.Gauge<string>;

  /**
   * Issue #944 — Histogram of wall-clock duration of Soroban RPC calls
   * (readContract and invokeContract), bucketed by method and outcome.
   *
   * Labels:
   *   method  — the contract function name (e.g. "retire", "approve_and_mint")
   *   outcome — "success" | "failure"
   *
   * Buckets are designed to cover the realistic Soroban response range:
   *   fast simulation (50ms) → slow submission + polling (30s).
   */
  stellarRpcDurationSeconds: client.Histogram<string>;

  /**
   * Issue #944 — Counter of Soroban contract operations by key operation type.
   * Tracks read vs write operations independently so dashboards can distinguish
   * simulation-only calls from full submission flows.
   *
   * Labels:
   *   op_type — "read" | "invoke"
   *   method  — the contract function name
   *   outcome — "success" | "failure"
   */
  stellarContractOpsTotal: client.Counter<string>;

  constructor() {
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register });
  }

  onModuleInit(): void {
    this.httpRequestsTotal = new client.Counter({
      name: 'http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status_code'],
      registers: [this.register],
    });

    this.httpRequestDurationSeconds = new client.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });

    this.stellarTxSubmitTotal = new client.Counter({
      name: 'stellar_tx_submit_total',
      help: 'Total number of Stellar transaction submissions',
      labelNames: ['contract', 'method', 'status'],
      registers: [this.register],
    });

    // Issue #546 — fee distribution histogram for Soroban contract calls.
    this.contractCallFeeStroops = new client.Histogram({
      name: 'contract_call_fee_stroops',
      help: 'Fee paid in stroops for each Soroban contract call invocation',
      labelNames: ['contract', 'method'],
      // Exponential-ish buckets: 100 → 10_000_000 stroops
      buckets: [
        100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000,
        500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000,
      ],
      registers: [this.register],
    });

    // ── Issue #495: Contract invocation metrics ─────────────────────────────
    this.stellarContractInvocationsTotal = new client.Counter({
      name: 'stellar_contract_invocations_total',
      help: 'Total number of Stellar contract invocations',
      labelNames: ['contract', 'method', 'status'],
      registers: [this.register],
    });

    this.stellarContractInvocationDurationMs = new client.Histogram({
      name: 'stellar_contract_invocation_duration_ms',
      help: 'Wall-clock duration of Stellar contract invocations in milliseconds',
      labelNames: ['contract', 'method'],
      // Buckets spanning fast (50ms) to very slow (30s) Soroban calls
      buckets: [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000],
      registers: [this.register],
    });

    this.carbonchainRetirementsTotal = new client.Counter({
      name: 'carbonchain_retirements_total',
      help: 'Total number of carbon credit retirements by type',
      labelNames: ['type'],
      registers: [this.register],
    });

    this.carbonchainCreditsActiveTotal = new client.Gauge({
      name: 'carbonchain_credits_active_total',
      help: 'Current number of active carbon credits on-chain',
      registers: [this.register],
    });

    // ── Issue #944: Soroban RPC latency metrics ──────────────────────────────

    this.stellarRpcDurationSeconds = new client.Histogram({
      name: 'stellar_rpc_duration_seconds',
      help: 'Wall-clock duration of Soroban RPC calls (readContract / invokeContract) in seconds',
      labelNames: ['method', 'outcome'],
      // Buckets span fast simulation (~50ms) to slow polling submission (~30s).
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.register],
    });

    this.stellarContractOpsTotal = new client.Counter({
      name: 'stellar_contract_ops_total',
      help: 'Total number of Soroban contract operations by type (read vs invoke), method and outcome',
      labelNames: ['op_type', 'method', 'outcome'],
      registers: [this.register],
    });
  }

  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}
