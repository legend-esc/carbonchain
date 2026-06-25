import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { HealthController } from './health.controller';
import { HealthService, PG_POOL } from './health.service';
import { StellarModule } from '../stellar/stellar.module';

@Module({
  imports: [ConfigModule, StellarModule],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new Pool({
          connectionString: configService.get<string>('DATABASE_URL'),
          max: 1,
          connectionTimeoutMillis: 2000,
        }),
    },
  ],
})
export class HealthModule {}
