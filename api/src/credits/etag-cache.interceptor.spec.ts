import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { ETagCacheInterceptor } from './etag-cache.interceptor';
import { CreditStatus } from '@shared';

describe('ETagCacheInterceptor', () => {
  let interceptor: ETagCacheInterceptor;

  beforeEach(() => {
    interceptor = new ETagCacheInterceptor();
  });

  function createMockContext(credit: Record<string, unknown>, ifNoneMatch?: string) {
    const responseHeaders: Record<string, string> = {};
    let statusCode = 200;

    const request = {
      headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {},
    };

    const response = {
      setHeader: (key: string, value: string) => {
        responseHeaders[key] = value;
      },
      status: (code: number) => {
        statusCode = code;
        return response;
      },
    };

    const context = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    const callHandler: CallHandler = {
      handle: () => of(credit),
    };

    return { context, callHandler, responseHeaders, statusCode };
  }

  it('adds ETag header for credit response', (done) => {
    const credit = {
      id: 'credit-123',
      status: CreditStatus.Active,
      owner: 'GABC',
      tonnes: '1000000',
    };

    const { context, callHandler, responseHeaders } = createMockContext(credit);

    interceptor.intercept(context, callHandler).subscribe((result) => {
      expect(responseHeaders['ETag']).toBeDefined();
      expect(responseHeaders['ETag']).toMatch(/^"[a-f0-9]{16}"$/);
      expect(result).toEqual(credit);
      done();
    });
  });

  it('sets Cache-Control: public, max-age=30 for Active credits', (done) => {
    const credit = {
      id: 'credit-1',
      status: CreditStatus.Active,
      owner: 'GABC',
      tonnes: '1000000',
    };

    const { context, callHandler, responseHeaders } = createMockContext(credit);

    interceptor.intercept(context, callHandler).subscribe(() => {
      expect(responseHeaders['Cache-Control']).toBe('public, max-age=30');
      done();
    });
  });

  it('sets Cache-Control: no-store for Retired credits', (done) => {
    const credit = {
      id: 'credit-1',
      status: CreditStatus.Retired,
      owner: 'GABC',
      tonnes: '1000000',
    };

    const { context, callHandler, responseHeaders } = createMockContext(credit);

    interceptor.intercept(context, callHandler).subscribe(() => {
      expect(responseHeaders['Cache-Control']).toBe('no-store');
      done();
    });
  });

  it('sets Cache-Control: no-store for Flagged credits', (done) => {
    const credit = {
      id: 'credit-1',
      status: CreditStatus.Flagged,
      owner: 'GABC',
      tonnes: '1000000',
    };

    const { context, callHandler, responseHeaders } = createMockContext(credit);

    interceptor.intercept(context, callHandler).subscribe(() => {
      expect(responseHeaders['Cache-Control']).toBe('no-store');
      done();
    });
  });

  it('returns 304 when If-None-Match matches ETag', (done) => {
    const credit = {
      id: 'credit-1',
      status: CreditStatus.Active,
      owner: 'GABC',
      tonnes: '1000000',
    };

    // First compute the ETag
    const { context: ctx1, callHandler: ch1, responseHeaders: rh1 } =
      createMockContext(credit);
    interceptor.intercept(ctx1, ch1).subscribe(() => {
      const etag = rh1['ETag'];

      // Now test with matching If-None-Match
      const { context, callHandler, statusCode } = createMockContext(
        credit,
        etag,
      );
      interceptor.intercept(context, callHandler).subscribe((result) => {
        expect(statusCode).toBe(304);
        expect(result).toBeNull();
        done();
      });
    });
  });

  it('does not add headers for non-credit responses', (done) => {
    const nonCredit = { message: 'hello' };

    const { context, callHandler, responseHeaders } =
      createMockContext(nonCredit);

    interceptor.intercept(context, callHandler).subscribe((result) => {
      expect(responseHeaders['ETag']).toBeUndefined();
      expect(responseHeaders['Cache-Control']).toBeUndefined();
      expect(result).toEqual(nonCredit);
      done();
    });
  });

  it('ETag changes when credit status changes', () => {
    const base = {
      id: 'credit-1',
      status: CreditStatus.Active,
      owner: 'GABC',
      tonnes: '1000000',
    };

    const { responseHeaders: rh1 } = createMockContext(base);
    const { context: ctx1, callHandler: ch1 } = createMockContext(base);
    interceptor.intercept(ctx1, ch1).subscribe(() => {
      const activeEtag = rh1['ETag'];

      const retired = { ...base, status: CreditStatus.Retired };
      const { responseHeaders: rh2 } = createMockContext(retired);
      const { context: ctx2, callHandler: ch2 } = createMockContext(retired);
      interceptor.intercept(ctx2, ch2).subscribe(() => {
        const retiredEtag = rh2['ETag'];
        expect(activeEtag).not.toBe(retiredEtag);
      });
    });
  });

  it('ETag excludes issued_at field', () => {
    const c1 = {
      id: 'credit-1',
      status: CreditStatus.Active,
      owner: 'GABC',
      tonnes: '1000000',
      issued_at: 1000000,
    };
    const c2 = {
      id: 'credit-1',
      status: CreditStatus.Active,
      owner: 'GABC',
      tonnes: '1000000',
      issued_at: 9999999,
    };

    const { responseHeaders: rh1 } = createMockContext(c1);
    const { context: ctx1, callHandler: ch1 } = createMockContext(c1);
    const { responseHeaders: rh2 } = createMockContext(c2);
    const { context: ctx2, callHandler: ch2 } = createMockContext(c2);

    interceptor.intercept(ctx1, ch1).subscribe(() => {
      interceptor.intercept(ctx2, ch2).subscribe(() => {
        expect(rh1['ETag']).toBe(rh2['ETag']);
      });
    });
  });
});
