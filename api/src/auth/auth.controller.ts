import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AuthTokenDto } from './dto/auth-token.dto';
import {
  Throttle,
  ThrottlerGuard,
  AccountThrottle,
} from '../common/throttler.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({ summary: 'Request SEP-10 auth challenge' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ limit: 10, ttl: 60_000 })
  @Get('challenge')
  async getChallenge(@Query('account') account: string): Promise<{
    transaction: string;
    network_passphrase: string;
  }> {
    return this.authService.generateChallenge(account);
  }

  /**
   * POST /auth/token — original SEP-10 verify endpoint (backward-compatible).
   * Issue #933 — now returns access_token (15m) + refresh_token (7d).
   */
  @ApiOperation({ summary: 'Verify signed challenge and receive JWT (legacy)' })
  @UseGuards(ThrottlerGuard)
  @AccountThrottle({ accountLimit: 10, ipLimit: 50, ttl: 300_000 })
  @Post('token')
  async getToken(
    @Body() body: AuthTokenDto,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  /**
   * POST /auth/verify — SEP-10 verify endpoint.
   * Issue #933 — returns access_token (15m) + refresh_token (7d).
   * Issue #932 — enforces one-time server nonce with account binding.
   */
  @ApiOperation({ summary: 'Verify signed challenge and receive JWT + refresh token' })
  @UseGuards(ThrottlerGuard)
  @AccountThrottle({ accountLimit: 10, ipLimit: 50, ttl: 300_000 })
  @Post('verify')
  async verify(
    @Body() body: AuthTokenDto,
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  /**
   * POST /auth/refresh — Issue #933.
   * Exchange a valid refresh token for a new access + refresh token pair.
   * The old refresh token is invalidated (rotation).  If a previously rotated
   * token is replayed the entire family is revoked (theft detection).
   */
  @ApiOperation({ summary: 'Rotate refresh token and receive new token pair (Issue #933)' })
  @UseGuards(ThrottlerGuard)
  @Throttle({ limit: 30, ttl: 60_000 })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: { refresh_token: string },
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
    if (!body.refresh_token) {
      throw new Error('refresh_token is required');
    }
    return this.authService.rotateRefreshToken(body.refresh_token);
  }

  /**
   * POST /auth/logout — Revokes both the access token jti AND the refresh
   * token family so all sessions derived from that family are invalidated.
   */
  @ApiOperation({ summary: 'Invalidate JWT and refresh token family (logout)' })
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Request()
    req: {
      user: { account: string };
      headers: { authorization?: string };
      body?: { refresh_token?: string };
    },
  ): Promise<{ message: string }> {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;
    const refreshToken = (req.body as { refresh_token?: string } | undefined)
      ?.refresh_token;
    await this.authService.logout(token, refreshToken);
    return { message: 'Logged out successfully' };
  }

  @ApiOperation({ summary: 'Get authenticated account info' })
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: { user: { account: string } }): { account: string } {
    return { account: req.user.account };
  }
}
