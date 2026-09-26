import { DataSource } from 'typeorm';
import { Logger } from '@nestjs/common';

const logger = new Logger('DbPoolHealth');
const SLOW_ACQUIRE_THRESHOLD_MS = 500;

export interface DbPoolStats {
  activeConnections: number;
  idleConnections: number;
  waitingCount: number;
}

/**
 * Reads pg Pool stats off the underlying node-postgres driver so callers can
 * expose DB_POOL_ACTIVE_CONNECTIONS / DB_POOL_IDLE_CONNECTIONS metrics.
 *
 * Not yet wired into HealthController — add a call to this alongside the
 * existing checks once poolSize is configured in data-source.ts.
 */
export function getDbPoolStats(dataSource: DataSource): DbPoolStats {
  // node-postgres exposes totalCount/idleCount/waitingCount on the driver's
  // underlying pool; TypeORM's postgres driver stores it as `master`.
  const pool = (dataSource.driver as unknown as { master?: any }).master;

  return {
    activeConnections: (pool?.totalCount ?? 0) - (pool?.idleCount ?? 0),
    idleConnections: pool?.idleCount ?? 0,
    waitingCount: pool?.waitingCount ?? 0,
  };
}

/**
 * Wrap a connection-acquiring call to log when it takes longer than
 * SLOW_ACQUIRE_THRESHOLD_MS (500ms) — a signal the pool is saturated.
 */
export async function withSlowAcquireLogging<T>(
  label: string,
  acquire: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await acquire();
  } finally {
    const elapsed = Date.now() - start;
    if (elapsed > SLOW_ACQUIRE_THRESHOLD_MS) {
      logger.warn(`slow connection acquisition for ${label}: ${elapsed}ms`);
    }
  }
}
