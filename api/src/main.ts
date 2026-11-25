import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as crypto from 'crypto';
import helmet from 'helmet';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import compression = require('compression');
import { AppModule } from './app.module';
import { PinoNestLogger } from './common/pino-nest-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Disable NestJS built-in logger so all output flows through PinoNestLogger
    logger: false,
  });
  app.useLogger(new PinoNestLogger());
  app.flushLogs();

  // #45 — security headers
  app.use(helmet());

  // #588 — gzip compression for responses >1KB.
  // level 6 balances CPU cost and compression ratio; threshold skips tiny
  // payloads where gzip overhead would exceed the savings.
  // The Vary: Accept-Encoding header is added automatically by the library,
  // ensuring CDN/proxy caches store separate copies per encoding.
  app.use(compression({ level: 6, threshold: 1024 }));

  // #542 — CORS: whitelist allowed origins from env, reject everything else.
  // Non-production environments always keep localhost:4200 whitelisted so
  // local dev works without extra config; production relies solely on
  // CORS_ORIGINS (the deployed frontend domain).
  const configuredOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowedOrigins =
    process.env.NODE_ENV === 'production'
      ? configuredOrigins
      : Array.from(new Set([...configuredOrigins, 'http://localhost:4200']));

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      // Requests without an Origin header (server-to-server, curl) are not
      // subject to browser CORS enforcement — let them through.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new ForbiddenException('Origin not allowed by CORS policy'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
    maxAge: 86400,
  });

  // #43 — global input validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // #38 & #1380 — Swagger/OpenAPI docs at /api/docs with dev test-account auth
  const isProduction = process.env.NODE_ENV === 'production';
  const devTestToken = !isProduction ? buildSwaggerDevJwt() : null;

  const config = new DocumentBuilder()
    .setTitle('CarbonChain API')
    .setDescription(
      isProduction
        ? 'Transparent carbon credit registry and marketplace on Stellar'
        : 'Transparent carbon credit registry and marketplace on Stellar.\n\n' +
            '**Development Playground**: Click **"Authorize with Test Account"** in the top bar ' +
            '(or see `docs/guides/API_PLAYGROUND.md`) to pre-authenticate with a testnet JWT ' +
            'without manually signing a SEP-10 challenge.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'SEP-10 JWT access token',
      },
      'bearer',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      tryItOutEnabled: !isProduction,
    },
    customJsStr: devTestToken
      ? buildSwaggerPlaygroundScript(devTestToken)
      : undefined,
  });

  await app.listen(process.env.PORT ?? 3000);
}

/**
 * #1380 — Generates a signed HS256 JWT for local Swagger playground testing
 * when `SWAGGER_DEV_JWT` is not explicitly provided. Never called in production.
 */
function buildSwaggerDevJwt(): string {
  if (process.env.SWAGGER_DEV_JWT) {
    return process.env.SWAGGER_DEV_JWT;
  }

  const secret = process.env.JWT_SECRET ?? 'dev-secret';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub:
        process.env.SWAGGER_TEST_PUBLIC_KEY ??
        'GDEVTESTNETACCOUNT7777777777777777777777777777777777777',
      role: process.env.SWAGGER_TEST_ROLE ?? 'buyer',
      network: 'TESTNET',
      iat: now,
      exp: now + 86400,
    }),
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');

  return `${header}.${payload}.${signature}`;
}

/**
 * #1380 — Injects an "Authorize with Test Account" button into Swagger UI's
 * topbar so developers can authenticate all endpoints in one click.
 */
function buildSwaggerPlaygroundScript(token: string): string {
  const safeToken = JSON.stringify(token);
  return `
(function () {
  var DEV_TOKEN = ${safeToken};
  function injectTestAuthButton() {
    var topbar = document.querySelector('.swagger-ui .topbar-wrapper');
    if (!topbar || document.getElementById('cc-test-auth-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'cc-test-auth-btn';
    btn.type = 'button';
    btn.textContent = 'Authorize with Test Account';
    btn.style.cssText =
      'margin-left:16px;padding:6px 14px;background:#10b981;color:#fff;' +
      'border:none;border-radius:4px;font-weight:600;cursor:pointer;font-size:13px;';
    btn.onclick = function () {
      if (window.ui && typeof window.ui.preauthorizeApiKey === 'function') {
        window.ui.preauthorizeApiKey('bearer', DEV_TOKEN);
        btn.textContent = 'Test Account Authorized ✓';
        btn.style.background = '#059669';
      }
    };
    topbar.appendChild(btn);
  }
  var observer = new MutationObserver(injectTestAuthButton);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', injectTestAuthButton);
})();
`;
}
bootstrap().catch((error) => {
  // Route startup failures through Pino so they are emitted as structured
  // JSON (with redaction) rather than plain console.error output.
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  new PinoNestLogger().error(message, stack, 'Bootstrap');
  process.exit(1);
});
