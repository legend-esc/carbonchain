import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  Account,
  Transaction,
  StrKey,
} from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import { StellarKeypairService } from '../stellar/stellar-keypair.service';
import { CacheService } from '../common/cache.service';

/** Redis key prefixes. */
const ACCESS_BLOCKLIST_PREFIX = 'auth:blocklist:jti:';
/** Refresh token family: `auth:refresh:<familyId>` → current refreshId */
const REFRESH_FAMILY_PREFIX = 'auth:refresh:family:';
/** Per-token key: `auth:refresh:token:<refreshId>` → { account, familyId, exp } */
const REFRESH_TOKEN_PREFIX = 'auth:refresh:token:';

/** Access token lifetime: 15 minutes. */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Refresh token lifetime: 7 days. */
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly networkPassphrase: string;
  private readonly serverHomeDomain: string;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly keypairService: StellarKeypairService,
    private readonly cache: CacheService,
  ) {
    const network = this.configService.get<string>(
      'STELLAR_NETWORK',
      'TESTNET',
    );
    this.networkPassphrase =
      network === 'PUBLIC' ? Networks.PUBLIC : Networks.TESTNET;
    this.serverHomeDomain = this.configService.get<string>(
      'HOME_DOMAIN',
      'localhost',
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEP-10 challenge / verify
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * SEP-10 §3.1 — Build a challenge transaction.
   * The server nonce is stored in Redis with a 300s TTL (Issue #932).
   * The nonce is bound to the client account so it cannot be replayed
   * against a different account.
   */
  async generateChallenge(clientAccount: string): Promise<{
    transaction: string;
    network_passphrase: string;
  }> {
    if (!clientAccount || !StrKey.isValidEd25519PublicKey(clientAccount)) {
      throw new BadRequestException('Invalid Stellar account address');
    }

    const serverKeypair = this.keypairService.getAdminKeypair();

    const account = new Account(serverKeypair.publicKey(), '-1');

    // Generate a random 32-byte nonce; store as raw bytes in the manageData op
    // so that op.value.toString('base64') round-trips cleanly.
    const nonceBytes = Keypair.random().rawPublicKey();
    const nonce = Buffer.from(nonceBytes).toString('base64');

    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.manageData({
          name: `${this.serverHomeDomain} auth`,
          value: nonceBytes,
          source: clientAccount,
        }),
      )
      .setTimeout(300)
      .build();

    tx.sign(serverKeypair);

    // Issue #932 — bind nonce to the client account so it cannot be replayed
    // against a different account. TTL = 300s (matches setTimeout above).
    await this.cache.set(
      `sep10:nonce:${nonce}`,
      { account: clientAccount },
      300,
    );

    return {
      transaction: tx.toEnvelope().toXDR('base64'),
      network_passphrase: this.networkPassphrase,
    };
  }

  /**
   * SEP-10 §3.3 — Verify the client-signed challenge and issue tokens.
   *
   * Issue #933 — Returns a short-lived access token (15m) AND a rotating
   * refresh token (7d) so a stolen access token has a bounded impact window.
   *
   * Issue #932 — Validates server nonce one-time binding; re-submitting the
   * same signed challenge after the first successful verify yields 401.
   */
  async verifyAndIssueToken(signedTransactionXdr: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    let tx: Transaction;
    try {
      tx = new Transaction(signedTransactionXdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException('Invalid transaction XDR');
    }

    // Check time bounds
    const now = Math.floor(Date.now() / 1000);
    const timeBounds = tx.timeBounds;
    if (
      !timeBounds ||
      now < Number(timeBounds.minTime) ||
      now > Number(timeBounds.maxTime)
    ) {
      throw new UnauthorizedException(
        'Challenge transaction has expired or is not yet valid',
      );
    }

    // Extract client account
    const manageDataOp = tx.operations.find((op) => op.type === 'manageData');
    if (!manageDataOp || !manageDataOp.source) {
      throw new BadRequestException(
        'Challenge transaction missing manageData operation',
      );
    }
    const clientAccount = manageDataOp.source;

    if (!StrKey.isValidEd25519PublicKey(clientAccount)) {
      throw new BadRequestException('Invalid client account in challenge');
    }

    // Verify server signature
    const serverKeypair = this.keypairService.getAdminKeypair();
    const txHash = tx.hash();
    const serverSig = tx.signatures.find((sig) => {
      try {
        return serverKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });
    if (!serverSig) {
      throw new UnauthorizedException('Server signature missing or invalid');
    }

    // Verify client signature
    const clientKeypair = Keypair.fromPublicKey(clientAccount);
    const clientSig = tx.signatures.find((sig) => {
      try {
        return clientKeypair.verify(txHash, sig.signature());
      } catch {
        return false;
      }
    });
    if (!clientSig) {
      throw new UnauthorizedException('Client signature missing or invalid');
    }

    // Issue #932 — verify nonce freshness, account binding, and revoke-on-success
    const nonce = (manageDataOp as { value?: unknown }).value;
    const nonceKey = `sep10:nonce:${String(nonce)}`;
    const nonceData = await this.cache.get<{ account: string }>(nonceKey);

    if (!nonceData) {
    // Issue #254 — Verify nonce freshness and prevent replay attacks.
    // The cached key is the base64-encoded nonce (see generateChallenge), so the
    // Buffer value parsed back from the manageData op must be base64-encoded too.
    const nonceValue = (manageDataOp as any).value as
      | Buffer
      | string
      | undefined;
    const nonce =
      nonceValue instanceof Buffer
        ? nonceValue.toString('base64')
        : String(nonceValue);
    const nonceKey = `sep10:nonce:${nonce}`;
    const nonceExists = await this.cache.get<boolean>(nonceKey);
    if (!nonceExists) {
      throw new UnauthorizedException(
        'Challenge nonce not found or already used',
      );
    }

    // Account binding check — prevent a signed challenge for account A from
    // being replayed to obtain a token for account B.
    if (nonceData.account !== clientAccount) {
      throw new UnauthorizedException(
        'Challenge nonce was issued for a different account',
      );
    }

    // Atomically delete nonce so it cannot be reused.
    await this.cache.del(nonceKey);

    // Issue #933 — issue short-lived access token + rotating refresh token.
    return this.issueTokenPair(clientAccount);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token management (Issue #933)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Issue a new access + refresh token pair for the given account.
   * Reuses the provided `familyId` if rotating (to detect refresh token theft).
   */
  async issueTokenPair(
    account: string,
    familyId?: string,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    const jti = randomUUID();
    const access_token = this.jwtService.sign(
      { account, jti },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
    );

    const refreshId = randomUUID();
    const resolvedFamilyId = familyId ?? randomUUID();

    // Store refresh token in Redis with metadata for rotation + family revocation.
    await this.cache.set(
      `${REFRESH_TOKEN_PREFIX}${refreshId}`,
      { account, familyId: resolvedFamilyId },
      REFRESH_TOKEN_TTL_SECONDS,
    );

    // Track the current (latest) refresh token in the family so theft detection
    // can tell if an old token is being replayed.
    await this.cache.set(
      `${REFRESH_FAMILY_PREFIX}${resolvedFamilyId}`,
      refreshId,
      REFRESH_TOKEN_TTL_SECONDS,
    );

    this.logger.log(
      `Issued token pair for ${account} — jti=${jti}, refreshId=${refreshId}`,
    );

    return {
      access_token,
      refresh_token: refreshId,
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Rotate a refresh token.
   *
   * If the presented refresh token is NOT the current one for the family,
   * we detect a potential theft: revoke the entire family immediately
   * (all sessions for the account derived from this family become invalid).
   *
   * Returns a new access + refresh token pair on success.
   */
  async rotateRefreshToken(refreshToken: string): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    const tokenKey = `${REFRESH_TOKEN_PREFIX}${refreshToken}`;
    const tokenData = await this.cache.get<{ account: string; familyId: string }>(
      tokenKey,
    );

    if (!tokenData) {
      throw new UnauthorizedException('Refresh token not found or expired');
    }

    const { account, familyId } = tokenData;

    // Theft detection: if the presented token is not the current head of the
    // family, a previously rotated (stolen) token is being replayed.
    const currentRefreshId = await this.cache.get<string>(
      `${REFRESH_FAMILY_PREFIX}${familyId}`,
    );

    if (currentRefreshId !== refreshToken) {
      // Compromise detected — revoke the entire family.
      this.logger.warn(
        `Refresh token replay detected for account ${account} — revoking family ${familyId}`,
      );
      await this.revokeFamily(familyId);
      throw new UnauthorizedException(
        'Refresh token has already been used — possible token theft. Please re-authenticate.',
      );
    }

    // Invalidate the old refresh token before issuing a new one.
    await this.cache.del(tokenKey);

    // Issue new pair, preserving the family id so the chain stays tracked.
    return this.issueTokenPair(account, familyId);
  }

  /** Revoke all tokens in a refresh family (used on logout or compromise). */
  private async revokeFamily(familyId: string): Promise<void> {
    await this.cache.del(`${REFRESH_FAMILY_PREFIX}${familyId}`);
    this.logger.log(`Revoked refresh token family ${familyId}`);
    const blocklistKey = `${BLOCKLIST_PREFIX}${payload.jti}`;
    const persisted = await this.cache.set(blocklistKey, true, remainingTtl);
    if (!persisted) {
      this.logger.error(
        `JWT revocation NOT persisted (cache unavailable): jti=${payload.jti}`,
      );
      throw new ServiceUnavailableException(
        'Unable to revoke token: revocation store unavailable. Token remains valid until it expires naturally.',
      );
    }
    this.logger.log(`JWT revoked: jti=${payload.jti}, TTL=${remainingTtl}s`);
  }

  /**
   * Logout: revoke the current access token's jti AND invalidate the refresh
   * token family so all sessions derived from it are dead.
   *
   * @param token       Raw Bearer token (without "Bearer " prefix)
   * @param refreshToken Optional refresh token to revoke its family
   */
  async logout(token: string, refreshToken?: string): Promise<void> {
    if (token) {
      let payload: { jti?: string; exp?: number } | null = null;
      try {
        payload = this.jwtService.decode(token) as { jti?: string; exp?: number } | null;
      } catch {
        // malformed — skip
      }

      if (payload?.jti) {
        const now = Math.floor(Date.now() / 1000);
        const remainingTtl = Math.max((payload.exp ?? 0) - now, 1);
        await this.cache.set(
          `${ACCESS_BLOCKLIST_PREFIX}${payload.jti}`,
          true,
          remainingTtl,
        );
        this.logger.log(`Access token revoked: jti=${payload.jti}`);
      }
    }

    if (refreshToken) {
      const tokenKey = `${REFRESH_TOKEN_PREFIX}${refreshToken}`;
      const tokenData = await this.cache.get<{ account: string; familyId: string }>(
        tokenKey,
      );
      if (tokenData) {
        await this.revokeFamily(tokenData.familyId);
        await this.cache.del(tokenKey);
      }
    }
  }

  /** Check whether an access token jti has been blocklisted. */
  async isTokenRevoked(jti: string): Promise<boolean> {
    const blocklistKey = `${ACCESS_BLOCKLIST_PREFIX}${jti}`;
    const blocked = await this.cache.get<boolean>(blocklistKey);
    return blocked === true;
  }
}
