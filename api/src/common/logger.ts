import pino from 'pino';
import { RequestContextStore } from './request-context';

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
  messageKey: 'message',
  errorKey: 'error',
  base: {
    service: process.env.SERVICE_NAME ?? 'carbonchain-api',
  },
  formatters: {
    level(label) {
      return { level: label };
    },
    log(object: Record<string, unknown>) {
      const formatted: Record<string, unknown> = { ...object };
      if (typeof formatted.trace === 'string' && !formatted.error) {
        formatted.error = { stack: formatted.trace };
      }
      return formatted;
    },
  },
  serializers: {
    error: pino.stdSerializers.err,
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  mixin() {
    const requestId = RequestContextStore.getRequestId();
    return requestId ? { requestId, correlationId: requestId } : {};
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
