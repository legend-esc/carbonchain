import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { StellarService } from '../stellar/stellar.service';

export const PG_POOL = 'PG_POOL';

export type HealthStatus = 'ok' | 'error';

export interface HealthCheckResult {
  status: HealthStatus;
  db: HealthStatus;
  stellar: HealthStatus;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly stellarService: StellarService,
  ) {}

  async check(): Promise<HealthCheckResult> {
    const [db, stellar] = await Promise.all([
      this.checkDb(),
      this.checkStellar(),
    ]);

    return {
      status: db === 'ok' && stellar === 'ok' ? 'ok' : 'error',
      db,
      stellar,
    };
  }

  private async checkDb(): Promise<HealthStatus> {
    try {
      await this.pool.query('SELECT 1');
      return 'ok';
    } catch (error) {
      this.logger.error(
        `Database health check failed: ${(error as Error).message}`,
      );
      return 'error';
    }
  }

  private async checkStellar(): Promise<HealthStatus> {
    try {
      await this.stellarService.getSorobanRpcServer().getHealth();
      return 'ok';
    } catch (error) {
      this.logger.error(
        `Soroban RPC health check failed: ${(error as Error).message}`,
      );
      return 'error';
    }
  }
}
