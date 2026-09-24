import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarService } from '../stellar/stellar.service';
import { CacheService } from '../common/cache.service';
import { nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

/**
 * AdminGuard - Verifies admin status against on-chain contract.
 *
 * Security model:
 * - Checks JWT claim first (fast path)
 * - Verifies publicKey matches on-chain admin address from credit_registry.get_admin()
 * - Caches admin address in Redis for 5 minutes
 * - Fail-closed: if contract call fails, deny access (prioritize security over availability)
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly ADMIN_CACHE_KEY = 'contract:admin:address';
  private readonly ADMIN_CACHE_TTL = 5 * 60; // 5 minutes in seconds

  constructor(
    private readonly configService: ConfigService,
    private readonly stellarService: StellarService,
    private readonly cache: CacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: { publicKey?: string; account?: string; role?: string };
    }>();

    // Step 1: Check JWT claim (fast path)
    if (request.user?.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    // Step 2: Verify against on-chain admin address
    const userPublicKey = request.user.publicKey || request.user.account;
    if (!userPublicKey) {
      throw new ForbiddenException('User public key not found in JWT');
    }

    try {
      const onChainAdmin = await this.getOnChainAdmin();

      if (userPublicKey !== onChainAdmin) {
        this.logger.warn(
          `Admin verification failed: JWT claims admin but publicKey ${userPublicKey} does not match on-chain admin ${onChainAdmin}`,
        );
        throw new ForbiddenException(
          'Admin verification failed - not authorized on-chain',
        );
      }

      this.logger.debug(`Admin verified: ${userPublicKey}`);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      // Fail-closed: if contract is unavailable, deny access
      // This prioritizes security over availability
      this.logger.error(
        `Contract admin verification failed: ${(error as Error).message}`,
      );
      throw new ForbiddenException(
        'Unable to verify admin status - contract unavailable',
      );
    }
  }

  /**
   * Get on-chain admin address with Redis caching.
   * Cache TTL: 5 minutes.
   */
  private async getOnChainAdmin(): Promise<string> {
    // Check cache first
    const cached = await this.cache.get<string>(this.ADMIN_CACHE_KEY);
    if (cached) {
      return cached;
    }

    // Fetch from contract
    const registryContractId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
    );
    if (!registryContractId) {
      throw new Error('CREDIT_REGISTRY_CONTRACT_ID not configured');
    }

    const result = await this.stellarService.readContract(
      registryContractId,
      'get_admin',
      [],
    );

    if (!result) {
      throw new Error('Contract returned null for get_admin');
    }

    const adminAddress = scValToNative(result) as string;

    // Cache for 5 minutes
    await this.cache.set(
      this.ADMIN_CACHE_KEY,
      adminAddress,
      this.ADMIN_CACHE_TTL,
    );

    this.logger.debug(`Cached on-chain admin address: ${adminAddress}`);
    return adminAddress;
  }

  /**
   * Invalidate admin cache. Call this when admin is changed on-chain.
   */
  async invalidateAdminCache(): Promise<void> {
    await this.cache.del(this.ADMIN_CACHE_KEY);
    this.logger.log('Admin cache invalidated');
  }
}
