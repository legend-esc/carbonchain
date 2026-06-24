import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { WebhooksController } from './webhooks.controller';
import { UnauthorizedException } from '@nestjs/common';

const SECRET = 'test-secret';
const PAYLOAD = JSON.stringify({ event: 'mrv.update', value: 42 });
const RAW_BODY = Buffer.from(PAYLOAD);

function validSignature(): string {
  return createHmac('sha256', SECRET).update(RAW_BODY).digest('hex');
}

function makeReq(rawBody?: Buffer): any {
  return { rawBody };
}

describe('WebhooksController', () => {
  let controller: WebhooksController;

  beforeEach(async () => {
    process.env['WEBHOOK_SECRET'] = SECRET;
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
    }).compile();
    controller = module.get(WebhooksController);
  });

  afterEach(() => {
    delete process.env['WEBHOOK_SECRET'];
  });

  it('accepts a valid HMAC signature', () => {
    const result = controller.receiveMrv(
      makeReq(RAW_BODY),
      validSignature(),
      JSON.parse(PAYLOAD),
    );
    expect(result).toEqual({ received: true });
  });

  it('returns HTTP 401 when signature header is missing', () => {
    expect(() =>
      controller.receiveMrv(makeReq(RAW_BODY), undefined, JSON.parse(PAYLOAD)),
    ).toThrow(UnauthorizedException);
  });

  it('returns HTTP 401 when payload has been tampered', () => {
    const tamperedBody = Buffer.from(JSON.stringify({ event: 'mrv.update', value: 999 }));
    expect(() =>
      controller.receiveMrv(
        makeReq(tamperedBody),
        validSignature(), // signature was for original payload
        { event: 'mrv.update', value: 999 },
      ),
    ).toThrow(UnauthorizedException);
  });

  it('returns HTTP 401 for a wrong signature', () => {
    expect(() =>
      controller.receiveMrv(makeReq(RAW_BODY), 'deadbeef', JSON.parse(PAYLOAD)),
    ).toThrow(UnauthorizedException);
  });
});
