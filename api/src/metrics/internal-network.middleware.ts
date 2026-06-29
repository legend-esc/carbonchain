import { Injectable, NestMiddleware, ForbiddenException } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';

const INTERNAL_RANGES = [
  '127.0.0.1',
  '::1',
  '::ffff:127.0.0.1',
  '10.',
  '172.16.',
  '172.17.',
  '172.18.',
  '172.19.',
  '172.20.',
  '172.21.',
  '172.22.',
  '172.23.',
  '172.24.',
  '172.25.',
  '172.26.',
  '172.27.',
  '172.28.',
  '172.29.',
  '172.30.',
  '172.31.',
  '192.168.',
];

function isInternal(ip: string): boolean {
  return INTERNAL_RANGES.some((range) => ip.startsWith(range));
}

@Injectable()
export class InternalNetworkMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const ip = req.ip ?? req.socket.remoteAddress ?? '';
    if (!isInternal(ip)) {
      throw new ForbiddenException('Metrics are only available from internal network');
    }
    next();
  }
}
