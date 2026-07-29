import client from 'prom-client';

/**
 * @deprecated Issue #495 — These standalone instruments are superseded by the
 * equivalent metrics defined in MetricsService (which uses a custom Registry
 * so they appear in the /metrics endpoint output).
 *
 * The metrics here register against the **default** prom-client registry and
 * thus DO NOT appear in the GET /metrics response exposed by MetricsController.
 *
 * They are kept temporarily for backward compatibility until all downstream
 * consumers (e.g. Datadog agent scraping the default /metrics endpoint) are
 * migrated to scrape the MetricsController endpoint.
 *
 * Replacement metrics in MetricsService (custom registry):
 *   - stellar_contract_invocations_total{contract, method, status}
 *   - stellar_contract_invocation_duration_ms{contract, method}
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
 * @deprecated Use the event emitter pattern from metrics-events.ts instead.
 *
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
