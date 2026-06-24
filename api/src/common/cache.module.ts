import { Module, Global, OnApplicationBootstrap } from '@nestjs/common';
import { CacheService } from './cache.service';

/**
 * Global CacheModule — import once in AppModule.
 * Provides CacheService to every module without re-importing.
 */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule implements OnApplicationBootstrap {
  constructor(private readonly cache: CacheService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.cache.connect();
  }
}
