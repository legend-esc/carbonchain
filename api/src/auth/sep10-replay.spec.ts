/**
 * SEP-10 Replay Protection tests — Issue #932
 *
 * Acceptance criteria:
 *  - Re-submitting the same signed challenge twice yields one valid JWT,
 *    the second is rejected with 401.
 *  - Stale challenges (nonce past TTL) are rejected.
 *  - A challenge issued for account A cannot be verified as account B.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';

/**
 * Build a SEP-10 challenge that already has the client signature applied.
 * Mirrors what generateChallenge + Freighter signing would produce.
 */
function buildSignedChallenge(
  serverKp: Keypair,
  clientKp: Keypair,
  nonce: string,
  domain: string,
  networkPassphrase: string,
  timeBoundsOverride?: { minTime: number; maxTime: number },
): string {
  const account = new Account(serverKp.publicKey(), '-1');
  const now = Math.floor(Date.now() / 1000);

  const builder = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase,
  }).addOperation(
    Operation.manageData({
      name: `${domain} auth`,
      value: nonce,
      source: clientKp.publicKey(),
    }),
  );

  if (timeBoundsOverride) {
    builder.setTimebounds(
      timeBoundsOverride.minTime,
      timeBoundsOverride.maxTime,
    );
  } else {
    builder.setTimeout(300);
  }

  const tx = builder.build();
  tx.sign(serverKp);
  tx.sign(clientKp);
  return tx.toEnvelope().toXDR('base64');
}

describe('SEP-10 replay protection (Issue #932)', () => {
  let service: AuthService;
  let serverKp: Keypair;
  let clientKp: Keypair;

  const cacheStore = new Map<string, unknown>();
  const NETWORK = Networks.TESTNET;
  const DOMAIN = 'localhost';

  beforeEach(async () => {
    cacheStore.clear();
    serverKp = Keypair.random();
    clientKp = Keypair.random();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('mock-access-token'),
            decode: jest.fn().mockReturnValue({ jti: 'jti-1', exp: 9999999999 }),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, def?: unknown) => {
              if (key === 'STELLAR_NETWORK') return 'TESTNET';
              if (key === 'HOME_DOMAIN') return DOMAIN;
              return def;
            }),
          },
        },
        {
          provide: StellarKeypairService,
          useValue: {
            getAdminKeypair: jest.fn().mockReturnValue(serverKp),
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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('generateChallenge', () => {
    it('stores nonce bound to the requesting account with 300s TTL', async () => {
      const cacheService = (service as any).cache as jest.Mocked<CacheService>;
      await service.generateChallenge(clientKp.publicKey());

      // The set call should store an object { account: clientKp.publicKey() }
      expect(cacheService.set).toHaveBeenCalledWith(
        expect.stringMatching(/^sep10:nonce:/),
        expect.objectContaining({ account: clientKp.publicKey() }),
        300,
      );
    });

    it('rejects invalid account addresses', async () => {
      await expect(
        service.generateChallenge('not-a-valid-key'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifyAndIssueToken — replay protection', () => {
    /**
     * Helper: put a known nonce into the cache as generateChallenge would.
     * Returns the signed transaction XDR.
     */
    function seedChallengeAndSign(nonce: string): string {
      cacheStore.set(`sep10:nonce:${nonce}`, {
        account: clientKp.publicKey(),
      });
      return buildSignedChallenge(serverKp, clientKp, nonce, DOMAIN, NETWORK);
    }

    it('accepts a valid challenge on first use', async () => {
      const nonce = Buffer.from(Keypair.random().rawPublicKey()).toString(
        'base64',
      );
      const xdr = seedChallengeAndSign(nonce);
      const result = await service.verifyAndIssueToken(xdr);
      expect(result).toHaveProperty('access_token', 'mock-access-token');
      expect(result).toHaveProperty('refresh_token');
    });

    it('rejects the same signed challenge on second use (replay)', async () => {
      const nonce = Buffer.from(Keypair.random().rawPublicKey()).toString(
        'base64',
      );
      const xdr = seedChallengeAndSign(nonce);

      // First call — succeeds and removes the nonce from the cache
      await service.verifyAndIssueToken(xdr);

      // Second call — nonce gone, should be rejected
      await expect(service.verifyAndIssueToken(xdr)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects an expired challenge (no nonce in cache)', async () => {
      const nonce = 'expired-nonce';
      // Do NOT seed the cache — simulates TTL expiry
      const xdr = buildSignedChallenge(serverKp, clientKp, nonce, DOMAIN, NETWORK);

      await expect(service.verifyAndIssueToken(xdr)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a challenge presented for a different account (account binding)', async () => {
      const nonce = Buffer.from(Keypair.random().rawPublicKey()).toString(
        'base64',
      );
      const otherKp = Keypair.random();

      // Nonce is bound to clientKp, but we build a tx signed by otherKp
      cacheStore.set(`sep10:nonce:${nonce}`, {
        account: clientKp.publicKey(), // bound to clientKp
      });
      // otherKp signs — its account won't match the nonce binding
      const xdr = buildSignedChallenge(serverKp, otherKp, nonce, DOMAIN, NETWORK);

      await expect(service.verifyAndIssueToken(xdr)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a challenge with expired time bounds', async () => {
      const nonce = Buffer.from(Keypair.random().rawPublicKey()).toString(
        'base64',
      );
      cacheStore.set(`sep10:nonce:${nonce}`, { account: clientKp.publicKey() });

      // Build a transaction with past time bounds
      const past = Math.floor(Date.now() / 1000) - 600;
      const xdr = buildSignedChallenge(
        serverKp,
        clientKp,
        nonce,
        DOMAIN,
        NETWORK,
        { minTime: past - 300, maxTime: past },
      );

      await expect(service.verifyAndIssueToken(xdr)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
