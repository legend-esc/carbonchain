import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { AuthTokenDto } from './dto/auth-token.dto';
import { Throttle, ThrottlerGuard } from '../common/throttler.guard';

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

  @ApiOperation({ summary: 'Verify signed challenge and receive JWT' })
  @Post('token')
  async getToken(
    @Body() body: AuthTokenDto,
  ): Promise<{ access_token: string }> {
    return this.authService.verifyAndIssueToken(body.transaction);
  }

  @ApiOperation({ summary: 'Get authenticated account info' })
  @UseGuards(AuthGuard('jwt'))
  @Get('me')
  getMe(@Request() req: { user: { account: string } }): { account: string } {
    return { account: req.user.account };
  }
}
