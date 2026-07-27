import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { TokenRevocationService } from './token-revocation.service';
import { JwtPayload } from './stellar-auth.strategy';

/**
 * Companion guard to JwtAuthGuard('jwt') — run AFTER the passport 'jwt'
 * guard so req.user/req.user's raw payload (with `jti`) is already
 * populated, then reject the request if the token's jti is on the
 * revocation list. Wire in via:
 *   @UseGuards(JwtAuthGuard, JwtRevocationGuard)
 */
@Injectable()
export class JwtRevocationGuard implements CanActivate {
  constructor(private readonly revocation: TokenRevocationService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const payload = req.user as (JwtPayload & { jti?: string }) | undefined;
    const jti = payload?.jti;
    if (jti && (await this.revocation.isRevoked(jti))) {
      throw new UnauthorizedException('Token has been revoked');
    }
    return true;
  }
}
