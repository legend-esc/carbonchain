import { Injectable, Logger } from '@nestjs/common';
import { CacheService } from '../common/cache.service';

/**
 * #1180 — Subscribes to Redis pub/sub account-invalidation events so that
 * each API pod evicts its local in-memory account-info cache when another pod
 * updates the sequence number or detects an on-chain state change.
 */
@Injectable()
export class AccountCacheInvalidationService {
  private readonly logger = new Logger(AccountCacheInvalidationService.name);

  constructor(private readonly cacheService: CacheService) {}

  /** Subscribe to invalidation events. Called on module init. */
  async subscribe(onInvalidate: (address: string) => void): Promise<void> {
    if (!this.cacheService.isConnected) return;
    const client = (this.cacheService as any)['client'];
    if (!client) return;
    try {
      const subscriber = client.duplicate();
      await subscriber.subscribe('carbonchain:account-invalidation');
      subscriber.on('message', (_channel: string, address: string) => {
        this.logger.debug(
          `[#1180] Account cache invalidation received for ${address}`,
        );
        onInvalidate(address);
      });
    } catch (err) {
      this.logger.warn(
        `[#1180] Failed to subscribe to account invalidation channel: ${(err as Error).message}`,
      );
    }
  }
}
