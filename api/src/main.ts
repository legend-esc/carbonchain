import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PinoNestLogger } from './common/pino-nest-logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(new PinoNestLogger());

  // #45 — security headers
  app.use(helmet());

  // #45 — CORS: allow only the frontend origin
  app.enableCors({
    origin: process.env.FRONTEND_URL ?? 'http://localhost:4200',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
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
