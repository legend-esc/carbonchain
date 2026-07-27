import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * TypeORM DataSource used by the migration CLI.
 *
 * Usage:
 *   npx typeorm migration:run   -d src/data-source.ts
 *   npx typeorm migration:revert -d src/data-source.ts
 *   npx typeorm migration:show  -d src/data-source.ts
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  url:
    process.env['DATABASE_URL'] ??
    'postgresql://postgres:postgres@localhost:5432/carbonchain',
  synchronize: false,
  logging: process.env['NODE_ENV'] !== 'production',
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'typeorm_migrations',
  // Pool config: without this, pg creates a new connection per request and
  // never returns it, exhausting Postgres's max_connections under load.
  poolSize: 20,
  extra: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    // Issue #551: kill runaway queries after 10 s to free the connection pool.
    // A slow full-table scan on 100 K credits can hold a connection for 30+ s
    // and starve concurrent requests. statement_timeout is set at the
    // connection level so it applies to every query through this pool.
    // Long-running operations that legitimately exceed 10 s (e.g. data export)
    // must issue `SET LOCAL statement_timeout = 0;` inside their own
    // transaction to opt out.
    statement_timeout: 10000,
    // Warn in application logs when a query takes > 8 s so operators have a
    // heads-up before the hard 10 s kill fires.
    query_timeout: 8000,
  },
});
