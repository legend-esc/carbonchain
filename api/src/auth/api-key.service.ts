import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface ApiKeyTier {
  name: string;
  monthlyQuota: number;
  bypassIpThrottling: boolean;
}

export interface ApiKeyRecord {
  id: string;
  hashedKey: string;
  tier: string;
  usageThisMonth: number;
  lastResetDate: Date;
  active: boolean;
}

/**
 * Issue #1292 — API key authentication and quota management service.
 * Validates API keys and enforces monthly quota limits by tier.
 */
@Injectable()
export class ApiKeyService {
  // In-memory store for demo; replace with database
  private readonly apiKeys = new Map<string, ApiKeyRecord>();

  private readonly tiers: Record<string, ApiKeyTier> = {
    free: {
      name: 'Free',
      monthlyQuota: 10000,
      bypassIpThrottling: false,
    },
    pro: {
      name: 'Pro',
      monthlyQuota: 1000000,
      bypassIpThrottling: true,
    },
    enterprise: {
      name: 'Enterprise',
      monthlyQuota: 100000000,
      bypassIpThrottling: true,
    },
  };

  constructor(private configService: ConfigService) {}

  /**
   * Hash an API key using SHA-256 for secure storage.
   */
  hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  /**
   * Validate an API key against the stored hashed key.
   * Returns the API key record if valid, null otherwise.
   */
  validateApiKey(key: string): ApiKeyRecord | null {
    const hashed = this.hashKey(key);
    const record = Array.from(this.apiKeys.values()).find(
      (r) => r.hashedKey === hashed && r.active,
    );

    if (!record) return null;

    // Check if monthly quota has been reset
    const now = new Date();
    const monthsAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    if (record.lastResetDate < monthsAgo) {
      record.usageThisMonth = 0;
      record.lastResetDate = now;
    }

    return record;
  }

  /**
   * Check if an API key has available quota.
   */
  hasAvailableQuota(record: ApiKeyRecord, requestCount = 1): boolean {
    const tier = this.tiers[record.tier];
    return (record.usageThisMonth + requestCount) <= tier.monthlyQuota;
  }

  /**
   * Increment usage counter for an API key.
   */
  incrementUsage(record: ApiKeyRecord, count = 1): void {
    record.usageThisMonth += count;
  }

  /**
   * Register a new API key (admin operation).
   */
  registerApiKey(tier: string, keyId: string): string {
    const plainKey = `sk_${keyId}_${crypto.randomBytes(16).toString('hex')}`;
    const hashed = this.hashKey(plainKey);

    this.apiKeys.set(keyId, {
      id: keyId,
      hashedKey: hashed,
      tier,
      usageThisMonth: 0,
      lastResetDate: new Date(),
      active: true,
    });

    return plainKey;
  }

  /**
   * Get tier configuration for an API key.
   */
  getTier(record: ApiKeyRecord): ApiKeyTier {
    return this.tiers[record.tier];
  }
}
