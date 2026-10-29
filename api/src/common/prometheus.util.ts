import client from 'prom-client';

/**
 * Return an existing metric from the default registry or create a new one.
 *
 * Prometheus metrics are process-global, but Nest providers are instantiated
 * once per application instance.  Test suites create several apps in the same
 * process, so constructing a metric each time would throw
 * "metric ... has already been registered".
 */
export function getOrCreateMetric<M extends client.Metric>(
  name: string,
  create: () => M,
): M {
  return (client.register.getSingleMetric(name) as M | undefined) ?? create();
}
