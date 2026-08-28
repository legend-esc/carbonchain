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
   * POST /auth/token — original SEP-10 verify endpoint (kept for backward compatibility).
   */
  @ApiOperation({ summary: 'Verify signed challenge and receive JWT (legacy)' })
  @UseGuards(ThrottlerGuard)
  @AccountThrottle({ accountLimit: 10, ipLimit: 50, ttl: 300_000 })
  @Post('token')
  async getToken(
    @Body() body: AuthTokenDto,
  ): Promise<{ access_token: string }> {
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  /**
   * POST /auth/verify — SEP-10 verify endpoint (issue #492 alias).
   * Rate-limited per Stellar account (10 attempts per 5-minute window)
   * AND per IP (50 attempts per 5-minute window).
   */
  @ApiOperation({ summary: 'Verify signed challenge and receive JWT' })
  @UseGuards(ThrottlerGuard)
  @AccountThrottle({ accountLimit: 10, ipLimit: 50, ttl: 300_000 })
  @Post('verify')
  async verify(@Body() body: AuthTokenDto): Promise<{ access_token: string }> {
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  /**
   * POST /auth/logout — issue #491.
   * Invalidates the JWT by storing its jti in the Redis blocklist.
   */
  @ApiOperation({ summary: 'Invalidate JWT (logout)' })
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Request()
    req: {
      user: { account: string };
      headers: { authorization?: string };
    },
  ): Promise<{ message: string }> {
    const authHeader = req.headers.authorization ?? '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;
    await this.authService.logout(token);
    return { message: 'Logged out successfully' };
  }

  @ApiOperation({ summary: 'Get authenticated account info' })
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: { user: { account: string } }): { account: string } {
    return { account: req.user.account };
  }
}
