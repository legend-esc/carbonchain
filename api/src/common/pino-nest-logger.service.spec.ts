import { PinoNestLogger } from './pino-nest-logger.service';
import { pinoLogger } from './logger';
import { RequestContextStore } from './request-context.store';

jest.mock('./logger', () => ({
  pinoLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
  },
}));

describe('PinoNestLogger', () => {
  const logger = new PinoNestLogger();

  afterEach(() => {
    jest.clearAllMocks();
    RequestContextStore.clear?.();
  });

  it('forwards log() to pino info with context', () => {
    logger.log('starting up', 'Bootstrap');
    expect(pinoLogger.info).toHaveBeenCalledWith(
      { context: 'Bootstrap' },
      'starting up',
    );
  });

  it('forwards error() to pino error with trace and context', () => {
    logger.error('boom', 'stack-trace', 'AppService');
    expect(pinoLogger.error).toHaveBeenCalledWith(
      { context: 'AppService', trace: 'stack-trace' },
      'boom',
    );
  });

  it('JSON-stringifies non-string messages', () => {
    logger.log({ foo: 'bar' }, 'AppService');
    expect(pinoLogger.info).toHaveBeenCalledWith(
      { context: 'AppService' },
      JSON.stringify({ foo: 'bar' }),
    );
  });

  describe('requestId inclusion', () => {
    it('includes requestId from RequestContextStore in log()', () => {
      RequestContextStore.run({ requestId: 'req-123' }, () => {
        logger.log('hello', 'AppService');
      });
      expect(pinoLogger.info).toHaveBeenCalledWith(
        { context: 'AppService', requestId: 'req-123' },
        'hello',
      );
    });

    it('includes requestId from RequestContextStore in error()', () => {
      RequestContextStore.run({ requestId: 'req-456' }, () => {
        logger.error('boom', 'stack-trace', 'AppService');
      });
      expect(pinoLogger.error).toHaveBeenCalledWith(
        { context: 'AppService', trace: 'stack-trace', requestId: 'req-456' },
        'boom',
      );
    });

    it('includes requestId from RequestContextStore in warn/debug/verbose', () => {
      RequestContextStore.run({ requestId: 'req-789' }, () => {
        logger.warn('warn-msg', 'AppService');
        logger.debug('debug-msg', 'AppService');
        logger.verbose('verbose-msg', 'AppService');
      });
      expect(pinoLogger.warn).toHaveBeenCalledWith(
        { context: 'AppService', requestId: 'req-789' },
        'warn-msg',
      );
      expect(pinoLogger.debug).toHaveBeenCalledWith(
        { context: 'AppService', requestId: 'req-789' },
        'debug-msg',
      );
      expect(pinoLogger.trace).toHaveBeenCalledWith(
        { context: 'AppService', requestId: 'req-789' },
        'verbose-msg',
      );
    });

    it('omits requestId when no context is active', () => {
      logger.log('no-context', 'AppService');
      expect(pinoLogger.info).toHaveBeenCalledWith(
        { context: 'AppService' },
        'no-context',
      );
    });
  });

  describe('secret redaction', () => {
    it('redacts password fields in object messages', () => {
      logger.log({ username: 'alice', password: 'super-secret' }, 'AuthService');
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed.username).toBe('alice');
      expect(parsed.password).not.toBe('super-secret');
      expect(parsed.password).toBe('[REDACTED]');
    });

    it('redacts token fields in object messages', () => {
      logger.log({ accessToken: 'abc.def.ghi', refreshToken: 'xyz' }, 'AuthService');
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed.accessToken).toBe('[REDACTED]');
      expect(parsed.refreshToken).toBe('[REDACTED]');
    });

    it('redacts apiKey and secret fields in object messages', () => {
      logger.log({ apiKey: 'key-123', clientSecret: 'shh' }, 'ConfigService');
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed.apiKey).toBe('[REDACTED]');
      expect(parsed.clientSecret).toBe('[REDACTED]');
    });

    it('redacts nested secret fields in object messages', () => {
      logger.log(
        { user: { name: 'bob', password: 'nested-secret' }, token: 'tok' },
        'AuthService',
      );
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed.user.name).toBe('bob');
      expect(parsed.user.password).toBe('[REDACTED]');
      expect(parsed.token).toBe('[REDACTED]');
    });

    it('redacts secrets in string messages', () => {
      logger.log('login with password=hunter2 and token=abc123', 'AuthService');
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('abc123');
      expect(message).toContain('[REDACTED]');
    });

    it('redacts secrets in error messages', () => {
      logger.error('failed with apiKey=secret-key', 'stack', 'AppService');
      const [, message] = (pinoLogger.error as jest.Mock).mock.calls[0];
      expect(message).not.toContain('secret-key');
      expect(message).toContain('[REDACTED]');
    });
  });

  describe('JSON output shape', () => {
    it('produces a JSON object with level, timestamp, service and message', () => {
      logger.log('shape-check', 'AppService');
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed).toHaveProperty('level');
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('service');
      expect(parsed).toHaveProperty('message', 'shape-check');
      expect(typeof parsed.timestamp).toBe('string');
      expect(parsed.service).toBe('api');
    });

    it('includes requestId in the JSON output shape when context is active', () => {
      RequestContextStore.run({ requestId: 'req-shape' }, () => {
        logger.log('shape-check', 'AppService');
      });
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed.requestId).toBe('req-shape');
      expect(parsed).toHaveProperty('level');
      expect(parsed).toHaveProperty('timestamp');
      expect(parsed).toHaveProperty('service');
    });

    it('includes traceId in the JSON output shape when context is active', () => {
      RequestContextStore.run(
        { requestId: 'req-trace', traceId: 'trace-abc' },
        () => {
          logger.log('shape-check', 'AppService');
        },
      );
      const [, message] = (pinoLogger.info as jest.Mock).mock.calls[0];
      const parsed = JSON.parse(message);
      expect(parsed.traceId).toBe('trace-abc');
    });
  });
});