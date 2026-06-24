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
});
