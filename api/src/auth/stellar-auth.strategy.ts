import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

export interface JwtPayload {
  account: string;
  jti?: string;
  iat: number;
  exp: number;
}

/**
 * JWT strategy for wallet-based auth (SEP-10).
 * Validates the Bearer token issued after a successful SEP-10 challenge/response.
 * The token payload carries the authenticated Stellar account public key and,
 * for tokens issued after issue #491, a `jti` UUID for blocklist revocation.
 */
@Injectable()
export class StellarAuthStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(config: ConfigService) {
    const jwtSecret = config.get<string>('JWT_SECRET');
    if (!jwtSecret && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'JWT_SECRET must be set — refusing to start with an insecure default',
      );
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret ?? 'test-only-secret-do-not-use',
    });
  }

  /**
   * Called after signature verification — return value is attached to req.user.
   * We forward the `jti` so JwtAuthGuard can perform the blocklist check.
   */
  validate(payload: JwtPayload): { account: string; jti?: string } {
    return { account: payload.account, jti: payload.jti };
  }
}
