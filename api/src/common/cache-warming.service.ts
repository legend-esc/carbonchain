import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CacheService } from './cache.service';
import { MarketplaceService } from '../marketplace/marketplace.service';

export const CACHE_WARM_OFFERS_KEY = 'warm:marketplace:top-offers';
export const CACHE_WARM_STATS_KEY = 'warm:platform:stats';
export const CACHE_WARM_TTL = 300; // 5 minutes

@Injectable()
export class CacheWarmingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CacheWarmingService.name);

  constructor(
    private readonly cache: CacheService,
    private readonly marketplace: MarketplaceService,
  ) {}

  onApplicationBootstrap(): void {
    // Fire-and-forget: do not await so server boot is never delayed.
    void this.warmCache();
  }

  async warmCache(): Promise<void> {
    const start = Date.now();
    let count = 0;

    try {
      // Pre-load top 20 active offers using keyset pagination.
      const page = await this.marketplace.getListingsKeyset({ limit: 20 });
      await this.cache.set(CACHE_WARM_OFFERS_KEY, page, CACHE_WARM_TTL);
      count += page.data?.length ?? 0;
      this.logger.log(
        `Cache warming: loaded ${page.data?.length ?? 0} active offers`,
      );

      // Pre-load platform stats stub.
      const stats = {
        totalOffers: page.count ?? 0,
        warmAt: Date.now(),
      };
      await this.cache.set(CACHE_WARM_STATS_KEY, stats, CACHE_WARM_TTL);
      count += 1;

      const elapsed = Date.now() - start;
      this.logger.log(
        `Cache warming complete: ${count} entries in ${elapsed}ms`,
      );
    } catch (err) {
      this.logger.warn(`Cache warming failed: ${(err as Error).message}`);
    }
  }
}
