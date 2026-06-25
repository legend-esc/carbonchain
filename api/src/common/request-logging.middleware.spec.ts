import { EventEmitter } from 'node:events';
import { RequestLoggingMiddleware } from './request-logging.middleware';
import { RequestContextStore } from './request-context';
import { pinoLogger } from './logger';

jest.mock('./logger', () => ({
  pinoLogger: { info: jest.fn() },
}));

describe('RequestLoggingMiddleware', () => {
  afterEach(() => jest.clearAllMocks());

  it('logs requestId, userId, method, path, statusCode and durationMs on finish', () => {
    const middleware = new RequestLoggingMiddleware();
    const req: any = {
      method: 'GET',
      originalUrl: '/credits/abc',
      user: { account: 'GUSER123' },
    };
    const res: any = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = jest.fn();

    RequestContextStore.run({ requestId: 'req-1' }, () => {
      middleware.use(req, res, next);
      res.emit('finish');
    });

    expect(next).toHaveBeenCalled();
    expect(pinoLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        userId: 'GUSER123',
        method: 'GET',
        path: '/credits/abc',
        statusCode: 200,
      }),
    );
    const [entry] = (pinoLogger.info as jest.Mock).mock.calls[0];
    expect(typeof entry.durationMs).toBe('number');
  });

  it('logs an undefined userId for unauthenticated requests', () => {
    const middleware = new RequestLoggingMiddleware();
    const req: any = { method: 'GET', url: '/health' };
    const res: any = Object.assign(new EventEmitter(), { statusCode: 200 });

    RequestContextStore.run({ requestId: 'req-2' }, () => {
      middleware.use(req, res, jest.fn());
      res.emit('finish');
    });

    expect(pinoLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ userId: undefined, path: '/health' }),
    );
  });
});
