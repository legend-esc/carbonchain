import client from 'prom-client';

/**
 * Standalone Prometheus instruments for Stellar contract invocations.
 * Kept separate from MetricsService so they can be registered against
 * the app's default registry without touching existing MetricsService
 * wiring: `import { register } from 'prom-client'` picks these up
 * automatically since no custom Registry is passed here.
 */
export const contractCallTotal = new client.Counter({
  name: 'contract_call_total',
  help: 'Total number of Stellar contract invocations',
  labelNames: ['contract', 'method', 'status'] as const,
});

export const contractCallDurationSeconds = new client.Histogram({
  name: 'contract_call_duration_seconds',
  help: 'Duration of Stellar contract invocations in seconds',
  labelNames: ['contract', 'method'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

/**
 * Wrap a contract call to emit contract_call_total{contract,method,status}
 * and contract_call_duration_seconds{contract,method}. Use around
 * StellarService.invokeContract call sites, e.g.:
 *
 *   await withContractMetrics(contractId, method, () =>
 *     this.invokeContract(contractId, method, args, signerKeypair),
 *   );
 */
export async function withContractMetrics<T>(
  contract: string,
  method: string,
  fn: () => Promise<T>,
): Promise<T> {
  const endTimer = contractCallDurationSeconds.startTimer({
    contract,
    method,
  });
  try {
    const result = await fn();
    contractCallTotal.inc({ contract, method, status: 'success' });
    return result;
  } catch (err) {
    contractCallTotal.inc({ contract, method, status: 'failure' });
    throw err;
  } finally {
    endTimer();
  }
}
