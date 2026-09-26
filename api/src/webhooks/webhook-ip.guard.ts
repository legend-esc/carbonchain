import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ipRangeCheck from 'ip-range-check';

@Injectable()
export class WebhookIpGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    const ip =
      request.ip ||
      request.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
      request.socket?.remoteAddress;

    const configured = this.configService.get<string>(
      'WEBHOOK_ALLOWED_IPS',
      '',
    );

    const allowlist = configured
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    if (allowlist.length === 0) {
      return true;
    }

    if (!ipRangeCheck(ip, allowlist)) {
      throw new ForbiddenException('IP address not allowed');
    }

    return true;
  }
}
