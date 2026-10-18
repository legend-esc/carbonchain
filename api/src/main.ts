import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
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

  // #38 — Swagger/OpenAPI docs at /api/docs
  const config = new DocumentBuilder()
    .setTitle('CarbonChain API')
    .setDescription(
      'Transparent carbon credit registry and marketplace on Stellar',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap().catch(console.error);
