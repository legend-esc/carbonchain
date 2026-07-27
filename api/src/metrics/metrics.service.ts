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
        100, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000,
        250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000,
      ],
      registers: [this.register],
    });
  }

  async getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}
