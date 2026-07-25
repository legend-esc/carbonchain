import { Logger as TypeOrmLogger, QueryRunner } from 'typeorm';
import { Counter, Histogram } from 'prom-client';
import { RequestContextStore } from '../request-context';

/**
 * Recommended `logging` option per environment:
 *   production:  ['error', 'warn', 'schema']
 *   development: ['query', 'error', 'warn', 'schema']
 *
 * Wire this logger into DataSource options as:
 *   logger: new SlowQueryLogger()
 */
const SLOW_QUERY_THRESHOLD_MS = 500;

export const slowQueriesTotal = new Counter({
  name: 'slow_queries_total',
  help: 'Count of database queries exceeding the slow query threshold',
  labelNames: ['request_id'] as const,
});

export const queryDurationSeconds = new Histogram({
  name: 'query_duration_seconds',
  help: 'Database query duration in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

export class SlowQueryLogger implements TypeOrmLogger {
  logQuery(_query: string, _parameters?: unknown[], _queryRunner?: QueryRunner): void {
    // No-op in production; TypeORM's built-in 'query' logging level covers dev.
  }

  logQuerySlow(
    time: number,
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): void {
    queryDurationSeconds.observe(time / 1000);

    if (time < SLOW_QUERY_THRESHOLD_MS) {
      return;
    }

    const requestId = RequestContextStore.get()?.requestId ?? 'unknown';
    slowQueriesTotal.inc({ request_id: requestId });

    this.explainAnalyze(query, parameters, queryRunner)
      .then((plan) => {
        // eslint-disable-next-line no-console
        console.warn('[slow-query]', {
          requestId,
          durationMs: time,
          query,
          parameters,
          plan,
        });
      })
      .catch(() => {
        // eslint-disable-next-line no-console
        console.warn('[slow-query]', {
          requestId,
          durationMs: time,
          query,
          parameters,
        });
      });
  }

  private async explainAnalyze(
    query: string,
    parameters?: unknown[],
    queryRunner?: QueryRunner,
  ): Promise<unknown> {
    if (!queryRunner || !/^\s*select/i.test(query)) {
      return undefined;
    }
    const rows = await queryRunner.query(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
      parameters,
    );
    return rows;
  }

  logQueryError(
    error: string | Error,
    query: string,
    parameters?: unknown[],
    _queryRunner?: QueryRunner,
  ): void {
    const requestId = RequestContextStore.get()?.requestId ?? 'unknown';
    // eslint-disable-next-line no-console
    console.error('[query-error]', { requestId, query, parameters, error });
  }

  logSchemaBuild(_message: string): void {}
  logMigration(_message: string): void {}
  log(_level: 'log' | 'info' | 'warn', _message: unknown): void {}
}
