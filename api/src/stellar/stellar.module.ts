import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StellarService } from './stellar.service';
import { StellarKeypairService } from './stellar-keypair.service';
import { SequenceNumberManager } from './sequence-number-manager.service';
import { RedisSequenceNumberManager } from './redis-sequence-number-manager.service';

/**
 * Issue #914 — StellarModule now provides both the in-memory SequenceNumberManager
 * (used as fallback and for single-pod/test deployments) and the Redis-backed
 * RedisSequenceNumberManager (used in multi-replica deployments when Redis is available).
 *
 * StellarService is injected with RedisSequenceNumberManager so that multi-pod
 * deployments benefit from distributed sequence coordination automatically.
 * When Redis is down, RedisSequenceNumberManager falls back to SequenceNumberManager
 * transparently (see redis-sequence-number-manager.service.ts).
 *
 * CacheModule is declared as a global module in AppModule, so CacheService
 * is already available for injection here without re-importing CacheModule.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    StellarKeypairService,
    // In-memory manager — used as fallback inside RedisSequenceNumberManager
    // and directly in unit tests that don't need Redis.
    SequenceNumberManager,
    // Redis-backed manager — issue #914 — primary implementation for multi-replica.
    RedisSequenceNumberManager,
    StellarService,
  ],
  exports: [
    StellarService,
    StellarKeypairService,
    SequenceNumberManager,
    RedisSequenceNumberManager,
  ],
})
export class StellarModule {}
