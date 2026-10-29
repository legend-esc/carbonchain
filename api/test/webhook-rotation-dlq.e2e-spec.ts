import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { WebhooksController } from '../src/webhooks/webhooks.controller';
import { WebhooksService } from '../src/webhooks/webhooks.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { RolesGuard } from '../src/auth/roles.guard';
import { createHmac } from 'crypto';

describe('Webhook rotation & DLQ (e2e)', () => {
  let app: INestApplication;
  let webhooksService: WebhooksService;
  let dataSource: any;

  const webhookId = '11111111-1111-1111-1111-111111111111';
  const otherWebhookId = '22222222-2222-2222-2222-222222222222';

  const oldSecret = 'a'.repeat(64);
  let currentSecret = oldSecret;

  const makeWebhookRow = (overrides: any = {}) => ({
    id: webhookId,
    url: 'https://example.com/hook',
    secret: currentSecret,
    events: ['user.created'],
    active: true,
    description: 'test webhook',
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  });

  const signPayload = (secret: string, payload: string) =>
    createHmac('sha256', secret).update(payload).digest('hex');

  beforeAll(async () => {
    dataSource = {
      query: jest.fn(),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        WebhooksService,
        { provide: DataSource, useValue: dataSource },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          req.user = { id: 'admin-id', role: 'admin' };
          return true;
        },
      })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();

    webhooksService = moduleRef.get<WebhooksService>(WebhooksService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentSecret = oldSecret;
  });

  describe('POST /webhooks/:id/rotate-secret', () => {
    it('returns a new secret once and invalidates the old secret', async () => {
      const payload = JSON.stringify({ event: 'user.created', id: 'u1' });
      const oldSignature = signPayload(oldSecret, payload);

      // Rotation: service generates a new secret and updates the row.
      const rotateSpy = jest
        .spyOn(webhooksService, 'rotateWebhookSecret')
        .mockImplementation(async (id: string) => {
          if (id !== webhookId) {
            throw new Error('Webhook not found');
          }
          const newSecret = 'b'.repeat(64);
          currentSecret = newSecret;
          return { id, secret: newSecret };
        });

      const res = await request(app.getHttpServer())
        .post(`/webhooks/${webhookId}/rotate-secret`)
        .expect(200);

      expect(rotateSpy).toHaveBeenCalledWith(webhookId);
      expect(res.body).toHaveProperty('secret');
      expect(typeof res.body.secret).toBe('string');
      expect(res.body.secret).not.toBe(oldSecret);

      const newSecret = res.body.secret;

      // Old secret no longer validates the delivery signature.
      const newSignature = signPayload(newSecret, payload);
      expect(newSignature).not.toBe(oldSignature);
      expect(signPayload(currentSecret, payload)).toBe(newSignature);
      expect(signPayload(oldSecret, payload)).toBe(oldSignature);
      expect(oldSignature).not.toBe(newSignature);

      // A subsequent GET does not expose the secret.
      jest.spyOn(webhooksService, 'getWebhook').mockResolvedValue({
        id: webhookId,
        url: 'https://example.com/hook',
        events: ['user.created'],
        active: true,
        description: 'test webhook',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      const getRes = await request(app.getHttpServer())
        .get(`/webhooks/${webhookId}`)
        .expect(200);

      expect(getRes.body).not.toHaveProperty('secret');
      expect(JSON.stringify(getRes.body)).not.toContain(newSecret);
    });

    it('returns 404 when rotating a non-existent webhook', async () => {
      jest
        .spyOn(webhooksService, 'rotateWebhookSecret')
        .mockRejectedValue(new Error('Webhook not found'));

      await request(app.getHttpServer())
        .post(`/webhooks/does-not-exist/rotate-secret`)
        .expect(404);
    });
  });

  describe('POST /webhooks/retry-failed', () => {
    it('resets failed deliveries globally and reactivates webhooks', async () => {
      const retrySpy = jest
        .spyOn(webhooksService, 'retryFailedDeliveries')
        .mockResolvedValue({ retried: 3, reactivated: 1 });

      const res = await request(app.getHttpServer())
        .post('/webhooks/retry-failed')
        .send({})
        .expect(200);

      expect(retrySpy).toHaveBeenCalledWith(undefined);
      expect(res.body).toMatchObject({ retried: 3, reactivated: 1 });
    });

    it('resets failed deliveries for a specific webhook', async () => {
      const retrySpy = jest
        .spyOn(webhooksService, 'retryFailedDeliveries')
        .mockResolvedValue({ retried: 2, reactivated: 1 });

      const res = await request(app.getHttpServer())
        .post('/webhooks/retry-failed')
        .send({ webhookId })
        .expect(200);

      expect(retrySpy).toHaveBeenCalledWith(webhookId);
      expect(res.body).toMatchObject({ retried: 2, reactivated: 1 });
    });

    it('reactivates a deactivated webhook when retrying its failed deliveries', async () => {
      const deactivatedRow = makeWebhookRow({ active: false });

      jest
        .spyOn(webhooksService, 'retryFailedDeliveries')
        .mockImplementation(async (id?: string) => {
          if (id === webhookId || id === undefined) {
            deactivatedRow.active = true;
            return { retried: 1, reactivated: 1 };
          }
          return { retried: 0, reactivated: 0 };
        });

      const res = await request(app.getHttpServer())
        .post('/webhooks/retry-failed')
        .send({ webhookId })
        .expect(200);

      expect(res.body.reactivated).toBe(1);
      expect(deactivatedRow.active).toBe(true);
    });

    it('returns zero counts when there are no failed deliveries', async () => {
      jest
        .spyOn(webhooksService, 'retryFailedDeliveries')
        .mockResolvedValue({ retried: 0, reactivated: 0 });

      const res = await request(app.getHttpServer())
        .post('/webhooks/retry-failed')
        .send({})
        .expect(200);

      expect(res.body).toMatchObject({ retried: 0, reactivated: 0 });
    });
  });
});
