import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AdminGuard } from './admin.guard';
import { nativeToScVal } from '@stellar/stellar-sdk';

describe('AdminGuard', () => {
  let guard: AdminGuard;
  const ADMIN = 'GBCI2DH7MEKQUTCXZ7YLEVOZHDMBWPCMB6V46ZQHOUN2BHBWRWYY2JRP';

  const mockConfigService = {
    get: jest.fn((key: string) =>
      key === 'CREDIT_REGISTRY_CONTRACT_ID'
        ? 'CAABCAABCAABCAABCAABCAABCAABCAABCAAB'
        : undefined,
    ),
  };
  const mockCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
  const mockStellar = {
    readContract: jest
      .fn()
      .mockResolvedValue(nativeToScVal(ADMIN, { type: 'address' })),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new AdminGuard(
      mockConfigService as any,
      mockStellar as any,
      mockCache as any,
    );
  });

  const buildCtx = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  it('should allow admin users whose on-chain address matches', async () => {
    await expect(
      guard.canActivate(buildCtx({ account: ADMIN, role: 'admin' })),
    ).resolves.toBe(true);
    expect(mockStellar.readContract).toHaveBeenCalledWith(
      'CAABCAABCAABCAABCAABCAABCAABCAABCAAB',
      'get_admin',
      [],
    );
  });

  it('should throw ForbiddenException for non-admin role', async () => {
    await expect(
      guard.canActivate(buildCtx({ account: 'GUSER', role: 'user' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should throw ForbiddenException when no user present', async () => {
    await expect(guard.canActivate(buildCtx(undefined))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should throw ForbiddenException when JWT publicKey does not match on-chain admin', async () => {
    mockStellar.readContract.mockResolvedValue(
      nativeToScVal('GOTHERADMINADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXX', {
        type: 'address',
      }),
    );
    await expect(
      guard.canActivate(buildCtx({ account: ADMIN, role: 'admin' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('should deny access when the contract call fails (fail-closed)', async () => {
    mockStellar.readContract.mockRejectedValue(new Error('RPC down'));
    await expect(
      guard.canActivate(buildCtx({ account: ADMIN, role: 'admin' })),
    ).rejects.toThrow(ForbiddenException);
  });
});
