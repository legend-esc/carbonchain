import pino from 'pino';
import { RequestContextStore } from './request-context.store';

const isProduction = process.env.NODE_ENV === 'production';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.secret',
  '*.token',
  '*.key',
  '*.password',
  '*.signature',
  '*.nonce',
  '*.apiKey',
  '*.accessToken',
  '*.refreshToken',
  '*.privateKey',
];

export const pinoLogger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: process.env.SERVICE_NAME ?? 'carbonchain-api',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const requestId = RequestContextStore.getRequestId();
    return requestId ? { requestId } : {};
  },
  redact: {
    paths: redactPaths,
    censor: '[REDACTED]',
  },
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
});