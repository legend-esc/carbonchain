import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { IsJWT, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TokenRevocationService } from './token-revocation.service';

export class RevokeTokenDto {
  @ApiProperty({ description: 'JWT access token to revoke' })
  @IsJWT()
  @IsNotEmpty()
  token: string;
}

/**
 * Admin-only endpoint to immediately revoke a leaked/compromised JWT.
 * POST /api/v1/auth/revoke
 *
 * NOTE: this controller must be registered in AuthModule's `controllers`
 * array, and an admin-role guard (e.g. RolesGuard('admin')) added on top
 * of JwtAuthGuard, to be wired live.
 */
@ApiTags('auth')
@Controller('auth')
export class RevokeController {
  constructor(
    private readonly jwtService: JwtService,
    private readonly revocation: TokenRevocationService,
  ) {}

  @ApiOperation({ summary: '[admin] Revoke a JWT before its natural expiry' })
  @UseGuards(JwtAuthGuard)
  @Post('revoke')
  async revoke(@Body() body: RevokeTokenDto): Promise<{ revoked: boolean }> {
    const decoded = this.jwtService.decode(body.token);

    if (!decoded?.jti || !decoded?.exp) {
      return { revoked: false };
    }

    const ttlSeconds = decoded.exp - Math.floor(Date.now() / 1000);
    if (ttlSeconds <= 0) {
      // Already expired — nothing to revoke.
      return { revoked: false };
    }

    await this.revocation.revoke(decoded.jti, ttlSeconds);
    return { revoked: true };
  }
}
