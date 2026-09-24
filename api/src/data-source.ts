import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';

dotenv.config();

const masterUrl =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5432/carbonchain';

// #559 — comma-separated replica connection strings. When present, TypeORM
// routes SELECT queries across `slaves` (round-robin) and everything else
// (INSERT/UPDATE/DELETE, transactions) to `master`. Empty/unset means no
// replicas are configured — all traffic goes to the master, same as before.
const replicaUrls = (process.env['DATABASE_REPLICA_URLS'] ?? '')
  .split(',')
  .map((url) => url.trim())
  .filter((url) => url.length > 0);

// Pool config: without this, pg creates a new connection per request and
// never returns it, exhausting Postgres's max_connections under load.
const pool = {
  poolSize: 20,
  extra: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  },
};

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
  // Migrations always run against the master directly — `replication` only
  // affects query routing for a running application, not the CLI.
  ...(replicaUrls.length > 0
    ? {
        replication: {
          master: { url: masterUrl },
          slaves: replicaUrls.map((url) => ({ url })),
        },
      }
    : { url: masterUrl }),
  synchronize: false,
  logging: process.env['NODE_ENV'] !== 'production',
  entities: [__dirname + '/**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
  migrationsTableName: 'typeorm_migrations',
  ...pool,
});
