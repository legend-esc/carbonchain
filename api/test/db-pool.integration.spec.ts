import { DataSource } from 'typeorm';

/**
 * Integration test for issue: TypeORM had no pool config, so 50 concurrent
 * requests exhausted Postgres's max_connections=100. Verifies 100 concurrent
 * queries all succeed while the pool stays capped at poolSize (20).
 *
 * Requires a reachable Postgres (DATABASE_URL) — not run as part of unit
 * test suite; intended for `npm run test:integration` once wired up.
 */
describe('DB connection pool under concurrent load', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      url:
        process.env['DATABASE_URL'] ??
        'postgresql://postgres:postgres@localhost:5432/carbonchain',
      poolSize: 20,
      extra: {
        max: 20,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
      },
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('handles 100 concurrent queries with at most 20 pooled connections', async () => {
    const queries = Array.from({ length: 100 }, () =>
      dataSource.query('SELECT 1'),
    );

    const results = await Promise.all(queries);

    expect(results).toHaveLength(100);

    const pool = (dataSource.driver as unknown as { master?: any }).master;
    expect(pool.totalCount).toBeLessThanOrEqual(20);
  });
});
