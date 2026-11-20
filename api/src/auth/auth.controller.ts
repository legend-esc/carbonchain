import {
  Controller,
  Post,
  Body,
  Get,
  Delete,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
  HttpException,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiTags,
  ApiBody,
  ApiResponse,
  ApiHeader,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { AuthTokenDto } from './dto/auth-token.dto';
import { IntrospectTokenDto } from './dto/introspect-token.dto';
import {
  Throttle,
  ThrottlerGuard,
  AccountThrottle,
} from '../common/throttler.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({
    summary: 'Request SEP-10 auth challenge',
    description:
      'Returns a base64-encoded SEP-10 challenge transaction XDR and the ' +
      'Stellar network passphrase. The client must sign the transaction with ' +
      'the account keypair and submit the signed XDR to POST /auth/verify.',
  })
  @ApiResponse({
    status: 200,
    description: 'SEP-10 challenge transaction',
    schema: {
      type: 'object',
      properties: {
        transaction: {
          type: 'string',
          description: 'Base64-encoded challenge transaction XDR',
          example: 'AAAAAgAAAAB...base64-xdr...AAAAAA==',
        },
        network_passphrase: {
          type: 'string',
          description: 'Stellar network passphrase',
          example: 'Test SDF Network ; September 2015',
        },
      },
      required: ['transaction', 'network_passphrase'],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid or missing account',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'Invalid Stellar account' },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: {
          type: 'string',
          example: 'ThrottlerException: Too Many Requests',
        },
        error: { type: 'string', example: 'Too Many Requests' },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
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
  @ApiOperation({
    summary: 'Verify signed challenge and receive JWT (legacy)',
    description:
      'Verifies a signed SEP-10 challenge transaction XDR and issues a token ' +
      'pair. Response schema: { access_token, refresh_token, expires_in } ' +
      'where expires_in is the access token lifetime in seconds.',
  })
  @ApiBody({ type: AuthTokenDto })
  @ApiResponse({
    status: 201,
    description: 'Token pair issued',
    schema: {
      type: 'object',
      properties: {
        access_token: {
          type: 'string',
          description: 'Signed JWT access token',
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
        refresh_token: {
          type: 'string',
          description: 'Opaque refresh token (UUID)',
          example: '3f1c2b4a-5d6e-7f80-9a1b-2c3d4e5f6a7b',
        },
        expires_in: {
          type: 'number',
          description: 'Access token lifetime in seconds',
          example: 900,
        },
      },
      required: ['access_token', 'refresh_token', 'expires_in'],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid, malformed, or expired challenge transaction',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'Invalid challenge signature' },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Challenge expired or nonce already used',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Challenge expired' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many requests or account locked after repeated failures — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: { type: 'string', example: 'Account locked' },
        error: { type: 'string', example: 'Too Many Requests' },
        retryAfter: {
          type: 'number',
          description: 'Seconds until the account is unlocked',
          example: 900,
        },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
  @UseGuards(ThrottlerGuard)
  @AccountThrottle({ accountLimit: 10, ipLimit: 50, ttl: 300_000 })
  @Post('token')
  async getToken(@Body() body: AuthTokenDto): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    await this.assertNotLocked(body.transaction);
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  /**
   * POST /auth/verify — SEP-10 verify endpoint.
   * Issue #933 — returns access_token (15m) + refresh_token (7d).
   * Issue #932 — enforces one-time server nonce with account binding.
   */
  @ApiOperation({
    summary: 'Verify signed challenge and receive JWT + refresh token',
    description:
      'Verifies a signed SEP-10 challenge transaction XDR and issues a token ' +
      'pair. Response schema: { access_token, refresh_token, expires_in } ' +
      'where expires_in is the access token lifetime in seconds. After 5 ' +
      'failed attempts the account is locked (429) for a configurable period.',
  })
  @ApiBody({ type: AuthTokenDto })
  @ApiResponse({
    status: 201,
    description: 'Token pair issued',
    schema: {
      type: 'object',
      properties: {
        access_token: {
          type: 'string',
          description: 'Signed JWT access token',
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
        refresh_token: {
          type: 'string',
          description: 'Opaque refresh token (UUID)',
          example: '3f1c2b4a-5d6e-7f80-9a1b-2c3d4e5f6a7b',
        },
        expires_in: {
          type: 'number',
          description: 'Access token lifetime in seconds',
          example: 900,
        },
      },
      required: ['access_token', 'refresh_token', 'expires_in'],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid, malformed, or expired challenge transaction',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'Invalid challenge signature' },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Challenge expired or nonce already used',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Challenge expired' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description:
      'Too many requests or account locked after repeated failures — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: { type: 'string', example: 'Account locked' },
        error: { type: 'string', example: 'Too Many Requests' },
        retryAfter: {
          type: 'number',
          description: 'Seconds until the account is unlocked',
          example: 900,
        },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
  @UseGuards(ThrottlerGuard)
  @AccountThrottle({ accountLimit: 10, ipLimit: 50, ttl: 300_000 })
  @Post('verify')
  async verify(@Body() body: AuthTokenDto): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    await this.assertNotLocked(body.transaction);
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  /**
   * POST /auth/refresh — Issue #933.
   * Exchange a valid refresh token for a new access + refresh token pair.
   * The old refresh token is invalidated (rotation).  If a previously rotated
   * token is replayed the entire family is revoked (theft detection).
   */
  @ApiOperation({
    summary: 'Rotate refresh token and receive new token pair (Issue #933)',
    description:
      'Exchanges a valid refresh token for a new token pair. The old refresh ' +
      'token is invalidated (rotation). Replaying a rotated token revokes the ' +
      'entire family (theft detection). Response schema: ' +
      '{ access_token, refresh_token, expires_in }.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        refresh_token: {
          type: 'string',
          description: 'Opaque refresh token (UUID)',
          example: '3f1c2b4a-5d6e-7f80-9a1b-2c3d4e5f6a7b',
        },
      },
      required: ['refresh_token'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'New token pair issued',
    schema: {
      type: 'object',
      properties: {
        access_token: {
          type: 'string',
          description: 'Signed JWT access token',
          example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        },
        refresh_token: {
          type: 'string',
          description: 'New opaque refresh token (UUID)',
          example: '9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d',
        },
        expires_in: {
          type: 'number',
          description: 'Access token lifetime in seconds',
          example: 900,
        },
      },
      required: ['access_token', 'refresh_token', 'expires_in'],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Missing refresh_token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'refresh_token is required' },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Refresh token invalid, expired, or family revoked',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Refresh token family revoked' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: {
          type: 'string',
          example: 'ThrottlerException: Too Many Requests',
        },
        error: { type: 'string', example: 'Too Many Requests' },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
  @UseGuards(ThrottlerGuard)
  @Throttle({ limit: 30, ttl: 60_000 })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: { refresh_token: string }): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    if (!body.refresh_token) {
      throw new Error('refresh_token is required');
    }
    return this.authService.rotateRefreshToken(body.refresh_token);
  }

  /**
   * POST /auth/logout — Revokes both the access token jti AND the refresh
   * token family so all sessions derived from that family are invalidated.
   */
  @ApiOperation({
    summary: 'Invalidate JWT and refresh token family (logout)',
    description:
      'Revokes the presented access token jti and, when a refresh_token is ' +
      'supplied, the entire refresh token family.',
  })
  @ApiBearerAuth()
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        refresh_token: {
          type: 'string',
          description: 'Optional refresh token whose family should be revoked',
          example: '3f1c2b4a-5d6e-7f80-9a1b-2c3d4e5f6a7b',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Logged out',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Logged out successfully' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: {
          type: 'string',
          example: 'ThrottlerException: Too Many Requests',
        },
        error: { type: 'string', example: 'Too Many Requests' },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
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
    const refreshToken = req.body?.refresh_token;
    await this.authService.logout(token, refreshToken);
    return { message: 'Logged out successfully' };
  }

  @ApiOperation({ summary: 'Get authenticated account info' })
  @ApiBearerAuth()
  @ApiResponse({
    status: 200,
    description: 'Authenticated account',
    schema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          example: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV',
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Unauthorized' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: {
          type: 'string',
          example: 'ThrottlerException: Too Many Requests',
        },
        error: { type: 'string', example: 'Too Many Requests' },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
  @UseGuards(JwtAuthGuard)
  @Get('me')
  getMe(@Request() req: { user: { account: string } }): { account: string } {
    return { account: req.user.account };
  }

  // ── Issue #1172: JWT Token Introspection ──────────────────────────────────

  /**
   * POST /auth/introspect — Introspect a token's validity, claims, and
   * expiration without full authentication.  Public endpoint, rate-limited.
   *
   * Supports both access tokens (JWT) and refresh tokens (UUID).
   *
   * Response shape (RFC 7662-inspired):
   *   {
   *     active: boolean,
   *     account?: string,
   *     jti?: string,
   *     exp?: number,         // access tokens only
   *     iat?: number,         // access tokens only
   *     token_type?: 'access' | 'refresh'
   *   }
   *
   * For **access tokens**: verifies signature + expiry, then checks the
   *   blocklist for revoked jti.
   * For **refresh tokens**: looks up the UUID in Redis and checks that the
   *   family has not been revoked.
   */
  @ApiOperation({
    summary: 'Introspect a JWT or refresh token (Issue #1172)',
  })
  @ApiBody({ type: IntrospectTokenDto })
  @ApiResponse({
    status: 200,
    description:
      'Token introspection result — { active, account?, jti?, exp?, iat?, token_type? }',
    schema: {
      type: 'object',
      properties: {
        active: {
          type: 'boolean',
          description: 'Whether the token is currently valid',
        },
        account: {
          type: 'string',
          description: 'Stellar account address (when active)',
        },
        jti: { type: 'string', description: 'Token identifier' },
        exp: {
          type: 'number',
          description: 'Expiration timestamp (access tokens only)',
        },
        iat: {
          type: 'number',
          description: 'Issued-at timestamp (access tokens only)',
        },
        token_type: {
          type: 'string',
          enum: ['access', 'refresh'],
          description: 'Token type',
        },
      },
      required: ['active'],
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Token is required',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'string', example: 'token is required' },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Token signature invalid or expired',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 401 },
        message: { type: 'string', example: 'Invalid token' },
        error: { type: 'string', example: 'Unauthorized' },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Too many requests — see Retry-After header',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 429 },
        message: {
          type: 'string',
          example: 'ThrottlerException: Too Many Requests',
        },
        error: { type: 'string', example: 'Too Many Requests' },
      },
    },
  })
  @ApiHeader({
    name: 'Retry-After',
    description: 'Seconds to wait before retrying (present on 429 responses)',
    required: false,
  })
  @UseGuards(ThrottlerGuard)
  @Throttle({ limit: 30, ttl: 60_000 })
  @Post('introspect')
  @HttpCode(HttpStatus.OK)
  async introspect(@Body() body: IntrospectTokenDto): Promise<{
    active: boolean;
    account?: string;
    jti?: string;
    exp?: number;
    iat?: number;
    token_type?: 'access' | 'refresh';
  }> {
    if (!body?.token) {
      throw new Error('token is required');
    }
    return this.authService.introspectToken(body.token);
  }

  /**
   * Throws `TooManyRequestsException` if the account extracted from the
   * challenge XDR is currently locked due to too many failed auth attempts.
   */
  private async assertNotLocked(transaction: string): Promise<void> {
    try {
      const account = this.authService.extractAccountFromChallenge(transaction);
      if (!account) return;
      const { locked, retryAfter } =
        await this.authService.isAccountLocked(account);
      if (locked) {
        throw Object.assign(
          new HttpException(
            {
              message:
                'Account temporarily locked due to too many failed attempts',
              retryAfter,
            },
            429,
          ),
          { retryAfter },
        );
      }
    } catch (err) {
      if ((err as { status?: number }).status === 429) throw err;
      // Ignore parse errors — let the main handler produce the right error
    }
  }

  // ── Issue #1173: Session management ──────────────────────────────────────

  /**
   * GET /auth/sessions — List all active sessions for the authenticated user.
   */
  @ApiOperation({ summary: 'List active sessions (Issue #1173)' })
  @ApiResponse({ status: 200, description: 'Array of active session records' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async getSessions(
    @Request() req: { user: { account: string } },
  ): Promise<unknown[]> {
    return this.authService.getActiveSessions(req.user.account);
  }

  /**
   * DELETE /auth/sessions/:familyId — Revoke a specific session by family ID.
   */
  @ApiOperation({ summary: 'Revoke a session (Issue #1173)' })
  @ApiParam({ name: 'familyId', description: 'Refresh token family ID' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:familyId')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @Request() req: { user: { account: string } },
    @Param('familyId') familyId: string,
  ): Promise<{ revoked: boolean }> {
    await this.authService.revokeSession(req.user.account, familyId);
    return { revoked: true };
  }

  // ── Issue #1175: Batch revocation check ──────────────────────────────────

  /**
   * POST /auth/revocation/check — Batch-check whether JTIs are revoked.
   * Admin-only.
   */
  @ApiOperation({
    summary: 'Batch-check JTI revocation status (Issue #1175)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        jtis: { type: 'array', items: { type: 'string' } },
      },
      required: ['jtis'],
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Array of { jti, revoked } results',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('revocation/check')
  async checkRevocations(
    @Body() body: { jtis: string[] },
  ): Promise<{ results: Array<{ jti: string; revoked: boolean }> }> {
    const results = await this.authService.checkTokensRevoked(body.jtis ?? []);
    return { results };
  }

  // ── Issue #1174: Admin account unlock ────────────────────────────────────

  /**
   * POST /auth/unlock — Admin action to clear an account lockout.
   */
  @ApiOperation({ summary: 'Unlock a locked account (Issue #1174)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Stellar account address' },
      },
      required: ['account'],
    },
  })
  @ApiResponse({ status: 200, description: 'Account unlocked' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — admin only' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, AdminGuard)
  @Post('unlock')
  @HttpCode(HttpStatus.OK)
  async unlock(
    @Body() body: { account: string },
  ): Promise<{ unlocked: boolean }> {
    await this.authService.unlockAccount(body.account);
    return { unlocked: true };
  }
}
