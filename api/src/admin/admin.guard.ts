import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';
import { CacheService } from '../common/cache.service';
import { scValToNative } from '@stellar/stellar-sdk';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly contractId: string;
  private readonly adminCacheTtlSeconds = 60;
  private adminAddressCache: {
    address: string;
    expiresAt: number;
  } | null = null;

  constructor(
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    private readonly cacheService: CacheService,
  ) {
    this.contractId = this.configService.get<string>(
      'CREDIT_REGISTRY_CONTRACT_ID',
      '',
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ user?: { account: string } }>();

    if (!request.user?.account) {
      throw new ForbiddenException('No authenticated user');
    }

    const userAccount = request.user.account;
    const adminAddress = await this.getAdminAddress();

    if (userAccount !== adminAddress) {
      this.logger.warn(
        `Admin access denied for account ${userAccount}. Admin is ${adminAddress}`,
      );
      throw new ForbiddenException('Admin access required');
    }

    this.logger.log(`Admin access granted for account ${userAccount}`);
    return true;
  }

  private async getAdminAddress(): Promise<string> {
    const now = Date.now();

    if (
      this.adminAddressCache &&
      this.adminAddressCache.expiresAt > now
    ) {
      return this.adminAddressCache.address;
    }

    const adminAddress = await this.fetchAdminAddressFromContract();
    this.adminAddressCache = {
      address: adminAddress,
      expiresAt: now + this.adminCacheTtlSeconds * 1000,
    };

    return adminAddress;
  }

  private async fetchAdminAddressFromContract(): Promise<string> {
    try {
      const retval = await this.stellarService.readContract(
        this.contractId,
        'get_admin',
      );

      if (!retval) {
        throw new Error('Unable to retrieve admin address from contract');
      }

      const adminAddress = scValToNative(retval) as string;
      this.logger.log(`Retrieved admin address from contract: ${adminAddress}`);
      return adminAddress;
    } catch (error: unknown) {
      this.logger.error(
        `Failed to fetch admin address from contract: ${(error as Error).message}`,
      );
      throw new ForbiddenException('Unable to verify admin status on-chain');
    }
  }
}
