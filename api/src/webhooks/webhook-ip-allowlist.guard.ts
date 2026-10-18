import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ipRangeCheck from 'ip-range-check';
import { WebhookIpAllowlistService } from './webhook-ip-allowlist.service';

/**
 * Guard that restricts webhook endpoints to a configured IP allowlist.
 *
 * Issue #1170 — The guard now consults a dynamic, admin-managed allowlist
 * stored in Redis (via WebhookIpAllowlistService) in addition to the static
 * WEBHOOK_ALLOWED_IPS env var.  The dynamic list takes precedence; when it
 * is non-empty only IPs in that list are allowed.  When the dynamic list is
 * empty the guard falls back to the env-var-based static list.  When both
 * are empty all IPs are allowed (open — suitable for development).
 */
@Injectable()
export class WebhookIpAllowlistGuard implements CanActivate {
  private readonly staticAllowlist: string[];

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    private readonly allowlistService?: WebhookIpAllowlistService,
  ) {
    const raw = this.configService.get<string>('WEBHOOK_ALLOWED_IPS', '');
    this.staticAllowlist = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Dynamic allowlist takes precedence when available (Issue #1170)
    let allowlist: string[];

    if (this.allowlistService) {
      const dynamic = await this.allowlistService.getAllowlist();
      if (dynamic.length > 0) {
        allowlist = dynamic;
      } else {
        allowlist = this.staticAllowlist;
      }
    } else {
      allowlist = this.staticAllowlist;
    }

    if (allowlist.length === 0) {
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

    if (!ipRangeCheck(ip, allowlist)) {
      throw new ForbiddenException('IP address not in webhook allowlist');
    }

    return true;
  }
}
