import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import {
  BadRequestException,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Keypair, Transaction, Networks } from '@stellar/stellar-sdk';
import { AuthService } from './auth.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';

/**
 * Tests for Issue #933 — rotating refresh tokens and short-lived access tokens.
 * Tests for Issue #932 — server nonce account binding.
 */
describe('AuthService — token management (Issue #933)', () => {
  let service: AuthService;
  let jwtService: jest.Mocked<JwtService>;
  let cacheService: jest.Mocked<CacheService>;

  const cacheStore = new Map<string, unknown>();

  beforeEach(async () => {
    cacheStore.clear();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('signed-access-token'),
            decode: jest.fn().mockReturnValue({ jti: 'jti-1', exp: Math.floor(Date.now() / 1000) + 900 }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def?: unknown) => {
              if (key === 'STELLAR_NETWORK') return 'TESTNET';
              if (key === 'HOME_DOMAIN') return 'localhost';
              return def;
            }),
          },
        },
        {
          provide: StellarKeypairService,
          useValue: {
            getAdminKeypair: jest.fn().mockReturnValue({
              publicKey: () => 'GADMIN',
              sign: jest.fn(),
            }),
          },
        },
        {
          provide: CacheService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) =>
              Promise.resolve(cacheStore.get(key) ?? null),
            ),
            set: jest.fn().mockImplementation((key: string, value: unknown) => {
              cacheStore.set(key, value);
              return Promise.resolve();
            }),
            del: jest.fn().mockImplementation((key: string) => {
              cacheStore.delete(key);
              return Promise.resolve();
            }),
          },
        },
// === In-memory fake cache mirroring the async CacheService interface.

class FakeCache {
  private store = new Map<string, { value: unknown; expiry: number }>();

  async set(key: string, value: unknown, ttl = 0): Promise<boolean> {
    this.store.set(key, { value, expiry: Math.floor(Date.now() / 1000) + ttl });
    return true;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiry && Math.floor(Date.now() / 1000) > entry.expiry) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async del(key: string): Promise<boolean> {
    this.store.delete(key);
    return true;
  }

  clear() {
    this.store.clear();
  }
}

const VALID_CLIENT = Keypair.random();

const mockConfigService = {
  get: jest.fn((key: string, def?: string) => {
    if (key === 'STELLAR_NETWORK') return 'TESTNET';
    if (key === 'HOME_DOMAIN') return 'localhost';
    return def;
  }),
};

const mockKeypairService = {
  getAdminKeypair: jest.fn().mockReturnValue(Keypair.random()),
};

const mockJwtService = {
  sign: jest.fn().mockReturnValue('signed.jwt.token'),
  decode: jest.fn(),
};

describe('AuthService', () => {
  let service: AuthService;
  let cache: FakeCache;

  beforeEach(async () => {
    cache = new FakeCache();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: StellarKeypairService, useValue: mockKeypairService },
        { provide: CacheService, useValue: cache },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    jwtService = module.get(JwtService);
    cacheService = module.get(CacheService);
  });

  describe('issueTokenPair', () => {
    it('returns an access_token, refresh_token, and expires_in', async () => {
      const result = await service.issueTokenPair('GACCOUNT');
      expect(result).toHaveProperty('access_token', 'signed-access-token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('expires_in', 900);
      expect(typeof result.refresh_token).toBe('string');
    });

    it('stores refresh token metadata in cache', async () => {
      const result = await service.issueTokenPair('GACCOUNT');
      expect(cacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('auth:refresh:token:'),
        expect.objectContaining({ account: 'GACCOUNT' }),
        expect.any(Number),
      );
      expect(cacheService.set).toHaveBeenCalledWith(
        expect.stringContaining('auth:refresh:family:'),
        result.refresh_token,
        expect.any(Number),
      );
    });

    it('preserves the provided familyId when rotating', async () => {
      const familyId = 'family-abc';
      await service.issueTokenPair('GACCOUNT', familyId);
      expect(cacheService.set).toHaveBeenCalledWith(
        `auth:refresh:family:${familyId}`,
        expect.any(String),
        expect.any(Number),
      );
    });
  });

  describe('rotateRefreshToken', () => {
    it('issues a new token pair on valid rotation', async () => {
      const first = await service.issueTokenPair('GACCOUNT');

      // The family should now point to first.refresh_token.
      const result = await service.rotateRefreshToken(first.refresh_token);
      expect(result.access_token).toBe('signed-access-token');
      expect(result.refresh_token).not.toBe(first.refresh_token);
    });

    it('throws UnauthorizedException when token is not found', async () => {
      await expect(
        service.rotateRefreshToken('non-existent-token'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('detects replay: revoking family when an old token is re-used', async () => {
      const first = await service.issueTokenPair('GACCOUNT');
      // Rotate once — family now points to a NEW token
      await service.rotateRefreshToken(first.refresh_token);

      // Replay the first (now stale) token → should detect theft
      await expect(
        service.rotateRefreshToken(first.refresh_token),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('isTokenRevoked', () => {
    it('returns false for a fresh JTI', async () => {
      const revoked = await service.isTokenRevoked('fresh-jti');
      expect(revoked).toBe(false);
    });

    it('returns true after the jti is added to the blocklist', async () => {
      cacheStore.set('auth:blocklist:jti:blocked-jti', true);
      const revoked = await service.isTokenRevoked('blocked-jti');
      expect(revoked).toBe(true);
    });
  });

  describe('logout', () => {
    it('adds the access token jti to the blocklist', async () => {
      await service.issueTokenPair('GACCOUNT');
      await service.logout('raw-bearer-token');
      expect(cacheService.set).toHaveBeenCalledWith(
        'auth:blocklist:jti:jti-1',
        true,
        expect.any(Number),
      );
    });

    it('revokes the refresh family when refresh_token is provided', async () => {
      const pair = await service.issueTokenPair('GACCOUNT');
      await service.logout('raw-bearer-token', pair.refresh_token);
      // Family key and token key should be deleted
      expect(cacheService.del).toHaveBeenCalledWith(
        expect.stringContaining('auth:refresh:family:'),
      );
      expect(cacheService.del).toHaveBeenCalledWith(
        expect.stringContaining('auth:refresh:token:'),
      );
    });
  });
  });

  afterEach(() => {
    jest.clearAllMocks();
    cache.clear();
  });

  // === generateChallenge — SEP-10 §3.1

  describe('generateChallenge', () => {
    it('rejects an invalid Stellar account', async () => {
      await expect(service.generateChallenge('not-a-key')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('returns an XDR transaction and network passphrase', async () => {
      const result = await service.generateChallenge(VALID_CLIENT.publicKey());
      expect(typeof result.transaction).toBe('string');
      expect(result.network_passphrase).toBe(Networks.TESTNET);
      // The XDR must parse back into a Transaction.
      const tx = new Transaction(result.transaction, result.network_passphrase);
      expect(tx.operations.some((op) => op.type === 'manageData')).toBe(true);
    });

    it('caches the nonce under a base64 key for replay protection', async () => {
      const result = await service.generateChallenge(VALID_CLIENT.publicKey());
      const tx = new Transaction(result.transaction, result.network_passphrase);
      const nonce = (
        tx.operations.find((op) => op.type === 'manageData') as any
      ).value.toString('base64');
      const cached = await cache.get<boolean>(`sep10:nonce:${nonce}`);
      expect(cached).toBe(true);
    });

    it('uses the server home domain in the manageData name', async () => {
      const result = await service.generateChallenge(VALID_CLIENT.publicKey());
      const tx = new Transaction(result.transaction, result.network_passphrase);
      const op = tx.operations.find((op) => op.type === 'manageData') as any;
      expect(op.name).toBe('localhost auth');
    });
  });

  // === verifyAndIssueToken — SEP-10 §3.3

  describe('verifyAndIssueToken', () => {
    async function signedChallenge(): Promise<string> {
      const { transaction, network_passphrase } =
        await service.generateChallenge(VALID_CLIENT.publicKey());
      const tx = new Transaction(transaction, network_passphrase);
      tx.sign(VALID_CLIENT); // client signs its own manageData op
      return tx.toEnvelope().toXDR('base64');
    }

    it('throws BadRequestException on unparseable XDR', async () => {
      await expect(
        service.verifyAndIssueToken('@@@not-xdr@@@'),
      ).rejects.toThrow(BadRequestException);
    });

    it('issues a JWT for a valid client-signed challenge', async () => {
      const signed = await signedChallenge();
      const result = await service.verifyAndIssueToken(signed);
      expect(result.access_token).toBe('signed.jwt.token');
      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          account: VALID_CLIENT.publicKey(),
          jti: expect.any(String),
        }),
      );
    });

    it('consumes the nonce so it cannot be replayed (double-use rejected)', async () => {
      const signed = await signedChallenge();
      await service.verifyAndIssueToken(signed);
      // A second verification with the same challenge must fail (nonce deleted).
      await expect(service.verifyAndIssueToken(signed)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('round-trips the nonce as base64 (regression for #254 type mismatch)', async () => {
      // The nonce extracted from the op value (a Buffer) must base64-encode to the
      // same string used as the cache key; otherwise verification fails with the
      // "nonce not found" error. This guards against the Buffer/base64 mismatch.
      const { transaction, network_passphrase } =
        await service.generateChallenge(VALID_CLIENT.publicKey());
      const tx = new Transaction(transaction, network_passphrase);
      const nonce = (
        tx.operations.find((op) => op.type === 'manageData') as any
      ).value.toString('base64');
      const before = await cache.get<boolean>(`sep10:nonce:${nonce}`);
      expect(before).toBe(true);

      tx.sign(VALID_CLIENT);
      // Should NOT throw "Challenge nonce not found or already used".
      await expect(
        service.verifyAndIssueToken(tx.toEnvelope().toXDR('base64')),
      ).resolves.toHaveProperty('access_token');
    });
  });

  // === logout — Issue #491 revocation

  describe('logout', () => {
    it('returns early when token is empty', async () => {
      await expect(service.logout('')).resolves.toBeUndefined();
      expect(mockJwtService.decode).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException for a token without a jti claim', async () => {
      mockJwtService.decode.mockReturnValueOnce({ exp: 9999999999 });
      await expect(service.logout('some.token.without.jti')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('blocklists the jti in the cache with a TTL', async () => {
      const jti = 'abc-123';
      const exp = Math.floor(Date.now() / 1000) + 3600;
      mockJwtService.decode.mockReturnValueOnce({ jti, exp });
      await service.logout('header.payload.sig');
      const blocked = await cache.get<boolean>(`auth:blocklist:jti:${jti}`);
      expect(blocked).toBe(true);
    });

    it('throws ServiceUnavailableException when the cache cannot persist', async () => {
      const brokenCache = {
        set: jest.fn().mockResolvedValue(false),
        get: jest.fn().mockResolvedValue(null),
        del: jest.fn().mockResolvedValue(true),
      };
      // Re-instantiate a service bound to the broken cache.
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AuthService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: StellarKeypairService, useValue: mockKeypairService },
          { provide: CacheService, useValue: brokenCache },
          { provide: JwtService, useValue: mockJwtService },
        ],
      }).compile();
      const brokenService = module.get<AuthService>(AuthService);
      mockJwtService.decode.mockReturnValueOnce({
        jti: 'x',
        exp: Math.floor(Date.now() / 1000) + 100,
      });
      await expect(brokenService.logout('header.payload.sig')).rejects.toThrow(
        ServiceUnavailableException,
      );
    });
  });

  // === isTokenRevoked

  describe('isTokenRevoked', () => {
    it('returns true when the jti is blocklisted', async () => {
      await cache.set('auth:blocklist:jti:revoked-jti', true, 100);
      expect(await service.isTokenRevoked('revoked-jti')).toBe(true);
    });

    it('returns false when the jti is unknown', async () => {
      expect(await service.isTokenRevoked('fresh-jti')).toBe(false);
    });
  });
});
