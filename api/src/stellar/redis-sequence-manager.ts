import { Injectable, Logger } from '@nestjs/common';
import * as redis from 'redis';

/**
 * Issue #1298: Redis Sequence Number Manager with Failover & Reconnect Resilience
 * Manages Stellar account sequence numbers with connection heartbeat, automatic retry,
 * and fallback to in-memory manager if Redis is unreachable
 */
@Injectable()
export class RedisSequenceNumberManager {
  private readonly logger = new Logger(RedisSequenceNumberManager.name);
  private client: redis.RedisClient;
  private fallbackMemoryStore = new Map<string, bigint>();
  private isConnected = false;
  private lastConnectionAttempt = 0;
  private readonly CONNECTION_TIMEOUT = 3000; // ms
  private readonly HEARTBEAT_INTERVAL = 30000; // ms (30 seconds)
  private heartbeatTimer?: NodeJS.Timeout;

  constructor() {
    this.initializeRedis();
  }

  /**
   * Initialize Redis connection with retry logic
   */
  private async initializeRedis(): Promise<void> {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      this.client = redis.createClient({
        url: redisUrl,
        socket: {
          reconnectStrategy: (retries: number) => {
            if (retries > 10) {
              this.logger.error('Redis reconnection failed after 10 attempts');
              return new Error('Redis max retries exceeded');
            }
            return Math.min(retries * 50, 500); // Backoff
          },
        },
      });

      // Handle connection events
      this.client.on('connect', () => {
        this.isConnected = true;
        this.logger.log('✓ Redis connected');
        this.startHeartbeat();
      });

      this.client.on('error', (err) => {
        this.isConnected = false;
        this.logger.error('Redis connection error:', err.message);
      });

      this.client.on('reconnecting', () => {
        this.logger.warn('Redis reconnecting...');
      });

      await this.client.connect();
      this.isConnected = true;
      this.startHeartbeat();
    } catch (error) {
      this.logger.error('Failed to initialize Redis:', error);
      this.isConnected = false;
    }
  }

  /**
   * Start heartbeat to monitor Redis connectivity
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(async () => {
      try {
        const startTime = Date.now();
        await this.client.ping();
        const latency = Date.now() - startTime;

        if (latency > 1000) {
          this.logger.warn(`Redis heartbeat slow: ${latency}ms`);
        }
      } catch (error) {
        this.logger.error('Redis heartbeat failed:', error);
        this.isConnected = false;
        this.scheduleReconnect();
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    const now = Date.now();
    if (now - this.lastConnectionAttempt < 1000) {
      // Prevent rapid reconnection attempts
      return;
    }

    this.lastConnectionAttempt = now;
    this.logger.log('Attempting to reconnect to Redis...');

    setTimeout(async () => {
      try {
        await this.client.connect();
        this.isConnected = true;
        this.logger.log('✓ Redis reconnected');
        this.startHeartbeat();
      } catch (error) {
        this.logger.error('Reconnection failed:', error);
        this.scheduleReconnect();
      }
    }, 1000);
  }

  /**
   * Get current sequence number for account
   * Falls back to memory store if Redis unavailable
   */
  async getSequenceNumber(accountId: string): Promise<bigint> {
    // Try Redis first
    if (this.isConnected) {
      try {
        const value = await this.getFromRedis(accountId);
        if (value !== null) {
          return BigInt(value);
        }
      } catch (error) {
        this.logger.warn(`Failed to get sequence from Redis for ${accountId}:`, error);
        this.isConnected = false;
        this.scheduleReconnect();
      }
    }

    // Fallback to memory
    const memoryValue = this.fallbackMemoryStore.get(accountId);
    if (memoryValue !== undefined) {
      this.logger.debug(`Using fallback memory store for ${accountId}`);
      return memoryValue;
    }

    // Default to 0
    return 0n;
  }

  /**
   * Set sequence number for account
   * Writes to both Redis and fallback memory store
   */
  async setSequenceNumber(accountId: string, sequence: bigint): Promise<void> {
    // Update memory store (always reliable)
    this.fallbackMemoryStore.set(accountId, sequence);

    // Try Redis (non-blocking)
    if (this.isConnected) {
      try {
        await this.setToRedis(accountId, sequence.toString());
      } catch (error) {
        this.logger.warn(`Failed to set sequence in Redis for ${accountId}:`, error);
        this.isConnected = false;
        this.scheduleReconnect();
      }
    } else {
      this.logger.warn(`Redis unavailable, sequence stored in memory only for ${accountId}`);
    }
  }

  /**
   * Increment sequence number safely
   */
  async incrementSequenceNumber(accountId: string): Promise<bigint> {
    let current = await this.getSequenceNumber(accountId);
    const next = current + 1n;
    await this.setSequenceNumber(accountId, next);
    return next;
  }

  /**
   * Get Redis connection status
   */
  getConnectionStatus(): {
    connected: boolean;
    fallbackActive: boolean;
    memoryStoreSize: number;
  } {
    return {
      connected: this.isConnected,
      fallbackActive: !this.isConnected && this.fallbackMemoryStore.size > 0,
      memoryStoreSize: this.fallbackMemoryStore.size,
    };
  }

  /**
   * Helper: Get from Redis with timeout
   */
  private async getFromRedis(key: string): Promise<string | null> {
    return Promise.race([
      this.client.get(`seq:${key}`),
      new Promise<null>((_, reject) =>
        setTimeout(
          () => reject(new Error('Redis get timeout')),
          this.CONNECTION_TIMEOUT,
        ),
      ),
    ]);
  }

  /**
   * Helper: Set to Redis with timeout
   */
  private async setToRedis(key: string, value: string): Promise<void> {
    await Promise.race([
      this.client.set(`seq:${key}`, value, {
        EX: 86400, // 24 hour expiry
      }),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error('Redis set timeout')),
          this.CONNECTION_TIMEOUT,
        ),
      ),
    ]);
  }

  /**
   * Cleanup on shutdown
   */
  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    if (this.client) {
      await this.client.quit();
    }
    this.logger.log('Redis sequence manager shutdown');
  }
}
