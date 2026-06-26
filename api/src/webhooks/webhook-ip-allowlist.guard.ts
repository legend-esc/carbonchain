import { Injectable, CanActivate, ExecutionContext, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'net';

@Injectable()
export class WebhookIpAllowlistGuard implements CanActivate {
  private readonly allowedCidrs: net.SubnetInfo[];

  constructor(private readonly configService: ConfigService) {
    const raw = this.configService.get<string>('WEBHOOK_ALLOWED_IPS') || '';
    this.allowedCidrs = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((cidr) => {
        try {
          return net.subnet(cidr);
        } catch {
          throw new BadRequestException(`Invalid WEBHOOK_ALLOWED_IPS entry: ${cidr}`);
        }
      });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const clientIp = request.ip || request.connection.remoteAddress || '';

    if (this.allowedCidrs.length === 0) {
      return true;
    }

    const ip = clientIp.replace(/^::ffff:/, '');
    const allowed = this.allowedCidrs.some((cidr) => cidr.contains(ip));
    if (!allowed) {
      throw new BadRequestException('Forbidden: IP not in webhook allowlist');
    }
    return true;
  }
}
