import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { StellarService } from '../stellar/stellar.service';
import { scValToNative } from '@stellar/stellar-sdk';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';

@Injectable()
export class AdminGuard implements CanActivate {
  private readonly logger = new Logger(AdminGuard.name);
  private readonly contractId: string;
  private readonly adminCacheTtl = 60000;

  constructor(
    private readonly stellarService: StellarService,
    private readonly configService: ConfigService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
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

    const cachedAdmin = await this.cacheManager.get<string>('admin_address');
    let adminAddress = cachedAdmin;

    if (!adminAddress) {
      adminAddress = await this.fetchAdminAddressFromContract();
      await this.cacheManager.set('admin_address', adminAddress, this.adminCacheTtl);
    }

    if (userAccount !== adminAddress) {
      this.logger.warn(
        `Admin access denied for account ${userAccount}. Admin is ${adminAddress}`,
      );
      throw new ForbiddenException('Admin access required');
    }

    this.logger.log(`Admin access granted for account ${userAccount}`);
    return true;
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
