import { PinoNestLogger } from './pino-nest-logger.service';
import { pinoLogger } from './logger';

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

  afterEach(() => jest.clearAllMocks());

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
});
