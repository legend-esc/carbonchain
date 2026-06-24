import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

@Controller('webhooks')
export class WebhooksController {
  private readonly secret = process.env['WEBHOOK_SECRET'] ?? '';

  @Post('mrv')
  receiveMrv(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-webhook-signature') signature: string | undefined,
    @Body() body: unknown,
  ): { received: boolean } {
    if (!signature) throw new UnauthorizedException('Missing signature header');

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(body));
    const expected = createHmac('sha256', this.secret)
      .update(rawBody)
      .digest('hex');

    let valid: boolean;
    try {
      valid = timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      valid = false;
    }

    if (!valid) throw new UnauthorizedException('Invalid HMAC signature');

    return { received: true };
  }
}
