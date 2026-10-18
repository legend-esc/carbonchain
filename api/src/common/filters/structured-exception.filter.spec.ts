import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import {
  StructuredExceptionFilter,
  extractContractErrorCode,
  resolveContractError,
} from './structured-exception.filter';

// === Helpers

function makeHost(responseMock: object): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => responseMock,
    }),
  } as unknown as ArgumentsHost;
}

function makeResponse() {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: null as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    set(header: string, value: string) {
      res._headers[header] = value;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res;
}

// === extractContractErrorCode

describe('extractContractErrorCode', () => {
  it('extracts a plain contract error', () => {
    expect(extractContractErrorCode('Error(Contract, #104)')).toBe(104);
  });

  it('extracts from a longer Soroban host-error string', () => {
    expect(
      extractContractErrorCode(
        'HostError: Error(Contract, #309) Some description',
      ),
    ).toBe(309);
  });

  it('handles extra whitespace around the code', () => {
    expect(extractContractErrorCode('Error(Contract,  #112)')).toBe(112);
  });

  it('is case-insensitive', () => {
    expect(extractContractErrorCode('error(contract, #300)')).toBe(300);
  });

  it('returns null when no contract error is present', () => {
    expect(extractContractErrorCode('connection refused')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractContractErrorCode('')).toBeNull();
  });
});

// === resolveContractError

describe('resolveContractError', () => {
  it('returns ContractErrorInfo for a known code', () => {
    const err = new Error('Error(Contract, #104)');
    const info = resolveContractError(err);
    expect(info).not.toBeNull();
    expect(info!.contractCode).toBe(104);
    expect(info!.httpStatus).toBe(404);
    expect(info!.code).toBe('CREDIT_NOT_FOUND');
  });

  it('returns null for an unknown code', () => {
    const err = new Error('Error(Contract, #999)');
    expect(resolveContractError(err)).toBeNull();
  });

  it('returns null for a non-Error value', () => {
    expect(resolveContractError('something')).toBeNull();
    expect(resolveContractError(null)).toBeNull();
    expect(resolveContractError(42)).toBeNull();
  });

  it('returns null when message has no contract code', () => {
    expect(resolveContractError(new Error('network timeout'))).toBeNull();
  });
});

// === StructuredExceptionFilter

describe('StructuredExceptionFilter', () => {
  let filter: StructuredExceptionFilter;

  beforeEach(() => {
    filter = new StructuredExceptionFilter();
    jest.spyOn(filter['logger'], 'warn').mockImplementation(() => undefined);
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  // === QueryTimeoutError path

  describe('QueryTimeoutError', () => {
    it('returns 503 with Retry-After header and QUERY_TIMEOUT code', () => {
      const res = makeResponse();
      const err = Object.assign(new Error('query timeout'), {
        name: 'QueryTimeoutError',
      });
      filter.catch(err, makeHost(res));
      expect(res._status).toBe(503);
      expect(res._headers['Retry-After']).toBe('5');
      expect((res._body as { code: string }).code).toBe('QUERY_TIMEOUT');
    });

    it('detects pg error code 57014', () => {
      const res = makeResponse();
      const err = Object.assign(
        new Error('canceling statement due to statement timeout'),
        {
          code: '57014',
        },
      );
      filter.catch(err, makeHost(res));
      expect(res._status).toBe(503);
    });
  });

  // === Contract error path

  describe('contract errors', () => {
    it('maps credit registry 104 (CreditNotFound) → 404 CREDIT_NOT_FOUND', () => {
      const res = makeResponse();
      filter.catch(
        new Error('HostError: Error(Contract, #104)'),
        makeHost(res),
      );
      expect(res._status).toBe(404);
      expect((res._body as { code: string }).code).toBe('CREDIT_NOT_FOUND');
      expect(
        (res._body as { details: { contractCode: number } }).details
          .contractCode,
      ).toBe(104);
    });

    it('maps marketplace 309 (OfferExpired) → 410 OFFER_EXPIRED', () => {
      const res = makeResponse();
      filter.catch(
        new Error('transaction simulation failed: Error(Contract, #309)'),
        makeHost(res),
      );
      expect(res._status).toBe(410);
      expect((res._body as { code: string }).code).toBe('OFFER_EXPIRED');
    });

    it('maps marketplace 300 (OfferNotFound) → 404 OFFER_NOT_FOUND', () => {
      const res = makeResponse();
      filter.catch(new Error('Error(Contract, #300)'), makeHost(res));
      expect(res._status).toBe(404);
      expect((res._body as { code: string }).code).toBe('OFFER_NOT_FOUND');
    });

    it('maps marketplace 312 (InsufficientFunds) → 402 INSUFFICIENT_FUNDS', () => {
      const res = makeResponse();
      filter.catch(new Error('Error(Contract, #312)'), makeHost(res));
      expect(res._status).toBe(402);
    });

    it('maps marketplace 307 (ContractPaused) → 503 MARKETPLACE_CONTRACT_PAUSED', () => {
      const res = makeResponse();
      filter.catch(new Error('Error(Contract, #307)'), makeHost(res));
      expect(res._status).toBe(503);
      expect((res._body as { code: string }).code).toBe(
        'MARKETPLACE_CONTRACT_PAUSED',
      );
    });

    it('maps retirement 200 (CreditNotActive) → 400', () => {
      const res = makeResponse();
      filter.catch(new Error('Error(Contract, #200)'), makeHost(res));
      expect(res._status).toBe(400);
      expect((res._body as { code: string }).code).toBe(
        'RETIREMENT_CREDIT_NOT_ACTIVE',
      );
    });

    it('maps MRV oracle 401 (Unauthorized) → 403', () => {
      const res = makeResponse();
      filter.catch(new Error('Error(Contract, #401)'), makeHost(res));
      expect(res._status).toBe(403);
      expect((res._body as { code: string }).code).toBe('ORACLE_UNAUTHORIZED');
    });

    it('falls through to 500 for an unknown contract code', () => {
      const res = makeResponse();
      filter.catch(new Error('Error(Contract, #999)'), makeHost(res));
      expect(res._status).toBe(500);
      expect((res._body as { code: string }).code).toBe(
        'INTERNAL_SERVER_ERROR',
      );
    });

    it('does NOT misclassify a message containing "123" without the contract-error pattern', () => {
      const res = makeResponse();
      // Plain number in message — must NOT trigger contract error path.
      filter.catch(
        new Error('session 123 expired while processing'),
        makeHost(res),
      );
      // No contract code → falls to unhandled → 500
      expect(res._status).toBe(500);
    });
  });

  // === HttpException path

  describe('HttpException', () => {
    it('preserves the status and normalizes the body', () => {
      const res = makeResponse();
      filter.catch(
        new HttpException('Not Found', HttpStatus.NOT_FOUND),
        makeHost(res),
      );
      expect(res._status).toBe(404);
      expect((res._body as { message: string }).message).toBe('Not Found');
    });

    it('handles object bodies with array messages', () => {
      const res = makeResponse();
      filter.catch(
        new HttpException(
          {
            message: ['field is required', 'field must be string'],
            error: 'Bad Request',
          },
          HttpStatus.BAD_REQUEST,
        ),
        makeHost(res),
      );
      expect(res._status).toBe(400);
      expect((res._body as { message: string }).message).toBe(
        'field is required; field must be string',
      );
    });
  });

  // === Fallback path

  describe('unhandled errors', () => {
    it('returns 500 INTERNAL_SERVER_ERROR for a plain Error', () => {
      const res = makeResponse();
      filter.catch(new Error('something unexpected'), makeHost(res));
      expect(res._status).toBe(500);
      expect((res._body as { code: string }).code).toBe(
        'INTERNAL_SERVER_ERROR',
      );
    });

    it('returns 500 for a thrown string', () => {
      const res = makeResponse();
      filter.catch('oops', makeHost(res));
      expect(res._status).toBe(500);
    });
  });
});
