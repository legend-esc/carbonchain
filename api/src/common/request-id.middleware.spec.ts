import { RequestIdMiddleware } from './request-id.middleware';
import { RequestContextStore } from './request-context';

describe('RequestIdMiddleware', () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function buildReqRes(headers: Record<string, string> = {}) {
    const req = { headers: { ...headers } };
    const res = { setHeader: jest.fn() };
    return { req, res };
  }

  it('generates a UUID and sets it on the request and response when absent', () => {
    const middleware = new RequestIdMiddleware();
    const { req, res } = buildReqRes();
    const next = jest.fn();

    middleware.use(req as any, res as any, next);

    expect(req.headers['x-request-id']).toMatch(UUID_RE);
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Request-ID',
      req.headers['x-request-id'],
    );
    expect(next).toHaveBeenCalled();
  });

  it('reuses an incoming X-Request-ID instead of generating a new one', () => {
    const middleware = new RequestIdMiddleware();
    const { req, res } = buildReqRes({ 'x-request-id': 'client-supplied-id' });
    const next = jest.fn();

    middleware.use(req as any, res as any, next);

    expect(req.headers['x-request-id']).toBe('client-supplied-id');
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Request-ID',
      'client-supplied-id',
    );
  });

  it('makes the request id available via RequestContextStore during the request', () => {
    const middleware = new RequestIdMiddleware();
    const { req, res } = buildReqRes({ 'x-request-id': 'ctx-id' });
    let observed: string | undefined;

    middleware.use(req as any, res as any, () => {
      observed = RequestContextStore.getRequestId();
    });

    expect(observed).toBe('ctx-id');
  });
});
