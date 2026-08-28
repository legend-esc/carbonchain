import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ipRangeCheck from 'ip-range-check';

/**
 * Guard that restricts webhook endpoints to a configured IP allowlist.
 * Set WEBHOOK_ALLOWED_IPS to a comma-separated list of IPs or CIDR ranges.
 * When the env var is empty all IPs are allowed (open — suitable for development).
 */
@Injectable()
export class WebhookIpAllowlistGuard implements CanActivate {
  private readonly allowlist: string[];

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>('WEBHOOK_ALLOWED_IPS', '');
    this.allowlist = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.allowlist.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<{
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    }>();

    const raw =
      request.ip ||
      (request.headers?.['x-forwarded-for'] as string | undefined)
        ?.split(',')[0]
        ?.trim() ||
      request.socket?.remoteAddress ||
      '';

    // Strip IPv4-mapped IPv6 prefix (::ffff:)
    const ip = raw.replace(/^::ffff:/, '');

    if (!ipRangeCheck(ip, this.allowlist)) {
      throw new ForbiddenException('IP address not in webhook allowlist');
    }

    return true;
  }
}
