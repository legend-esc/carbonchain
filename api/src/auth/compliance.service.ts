import { Injectable, ForbiddenException } from '@nestjs/common';
import { timingSafeEqual, createHmac } from 'crypto';
import { CacheService } from '../common/cache.service';

export type KycStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface KycRecord {
  userId: string;
  kyc_status: KycStatus;
  kyc_tier: 1 | 2 | 3;
  updatedAt: number;
}

const KYC_CACHE_TTL = 86400;
const KYC_ORDER_THRESHOLD_USD = 10_000;

@Injectable()
export class ComplianceService {
  constructor(private readonly cache: CacheService) {}

  /**
   * Verify an HMAC-SHA256 webhook signature.
   * Compares the computed digest against the provided signature using
   * timingSafeEqual to prevent timing attacks.
   */
  verifyWebhookSignature(
    payload: Buffer,
    signature: string,
    secret: string,
  ): boolean {
    const digest = createHmac('sha256', secret).update(payload).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  /**
   * Store or update a KYC record for a user.
   */
  async updateKycStatus(
    userId: string,
    status: KycStatus,
    tier: 1 | 2 | 3,
  ): Promise<KycRecord> {
    const record: KycRecord = {
      userId,
      kyc_status: status,
      kyc_tier: tier,
      updatedAt: Date.now(),
    };
    await this.cache.set(`kyc:${userId}`, record, KYC_CACHE_TTL);
    return record;
  }

  /**
   * Retrieve the KYC record for a user, or null if not found.
   */
  async getKycRecord(userId: string): Promise<KycRecord | null> {
    return this.cache.get<KycRecord>(`kyc:${userId}`);
  }

  /**
   * Enforce KYC tier requirements for high-value orders.
   * Orders above $10,000 require a VERIFIED KYC record.
   */
  async enforceKycTier(userId: string, orderValueUsd: number): Promise<void> {
    if (orderValueUsd <= KYC_ORDER_THRESHOLD_USD) {
      return;
    }

    const record = await this.getKycRecord(userId);

    if (!record || record.kyc_status !== 'VERIFIED') {
      throw new ForbiddenException(
        'KYC verification required for orders above $10,000',
      );
    }
  }
}
