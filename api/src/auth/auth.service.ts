import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ServiceUnavailableException,
  NotFoundException,
  ForbiddenException,
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
/** Issue #1173 — Session metadata: `auth:session:<familyId>` → SessionRecord */
const SESSION_PREFIX = 'auth:session:';
/** Issue #1174 — Failed auth attempt counter: `auth:failed:<account>` → number */
const FAILED_ATTEMPTS_PREFIX = 'auth:failed:';
/** Issue #1174 — Account lock marker: `auth:lock:<account>` → true */
const ACCOUNT_LOCK_PREFIX = 'auth:lock:';

/** Access token lifetime: 15 minutes. */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Refresh token lifetime: 7 days. */
const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Issue #1174 — default lockout threshold (failed attempts). */
const DEFAULT_LOCKOUT_THRESHOLD = 5;
/** Issue #1174 — default lockout duration: 15 minutes. */
const DEFAULT_LOCKOUT_DURATION_SECONDS = 15 * 60;

/** Issue #1173 — user-facing session metadata record. */
export interface SessionRecord {
  familyId: string;
  account: string;
  userAgent?: string;
  ip?: string;
  createdAt: number;
  lastUsedAt: number;
}

/** Issue #1173 — optional metadata captured when issuing a token pair. */
export interface SessionMetadata {
  userAgent?: string;
  ip?: string;
}

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
  async verifyAndIssueToken(
    signedTransactionXdr: string,
    metadata?: SessionMetadata,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    let tx: Transaction;
    try {
      tx = new Transaction(signedTransactionXdr, this.networkPassphrase);
    } catch {
      // Issue #1174 — malformed transaction counts as a failed attempt.
      await this.recordFailedAttemptFromXdr(signedTransactionXdr);
      throw new BadRequestException('Invalid transaction XDR');
    }

    // Extract client account early so failures can be attributed to it.
    const manageDataOp = tx.operations.find((op) => op.type === 'manageData');
    const clientAccount = manageDataOp?.source;

    // Check time bounds
    const now = Math.floor(Date.now() / 1000);
    const timeBounds = tx.timeBounds;
    if (
      !timeBounds ||
      now < Number(timeBounds.minTime) ||
      now > Number(timeBounds.maxTime)
    ) {
      // Issue #1174 — expired challenge counts as a failed attempt.
      await this.recordFailedAttemptFor(clientAccount);
      throw new UnauthorizedException(
        'Challenge transaction has expired or is not yet valid',
      );
    }

    // Extract client account
    if (!manageDataOp || !manageDataOp.source) {
      throw new BadRequestException(
        'Challenge transaction missing manageData operation',
      );
    }

    if (!StrKey.isValidEd25519PublicKey(clientAccount!)) {
      throw new BadRequestException('Invalid client account in challenge');
    }

    // Verify server signature
    const serverKeypair = this.keypairService.getAdminKeypair();
    const txHash = Buffer.from(tx.hash());
    const serverSig = tx.signatures.find((sig) => {
      try {
        return serverKeypair.verify(txHash, sig.signature);
      } catch {
        return false;
      }
    });
    if (!serverSig) {
      // Issue #1174 — invalid server signature counts as a failed attempt.
      await this.recordFailedAttemptFor(clientAccount);
      throw new UnauthorizedException('Server signature missing or invalid');
    }

    // Verify client signature
    const clientKeypair = Keypair.fromPublicKey(clientAccount!);
    const clientSig = tx.signatures.find((sig) => {
      try {
        return clientKeypair.verify(txHash, sig.signature);
      } catch {
        return false;
      }
    });
    if (!clientSig) {
      // Issue #1174 — invalid client signature counts as a failed attempt.
      await this.recordFailedAttemptFor(clientAccount);
      throw new UnauthorizedException('Client signature missing or invalid');
    }

    // Issue #254 / #932 — verify nonce freshness and account binding, then
    // revoke the nonce so it cannot be replayed.
    // The cached key is the base64-encoded nonce (see generateChallenge), so the
    // Buffer value parsed back from the manageData op must be base64-encoded too.
    const nonceValue = (manageDataOp as { value?: unknown }).value as
      | Buffer
      | Uint8Array
      | string;
    let nonce: string;
    if (nonceValue instanceof Buffer) {
      nonce = nonceValue.toString('base64');
    } else if (nonceValue instanceof Uint8Array) {
      nonce = Buffer.from(nonceValue).toString('base64');
    } else {
      nonce = String(nonceValue);
    }
    const nonceKey = `sep10:nonce:${nonce}`;
    const nonceData = await this.cache.get<{ account: string }>(nonceKey);
    if (!nonceData) {
      // Issue #1174 — replayed/unknown nonce counts as a failed attempt.
      await this.recordFailedAttemptFor(clientAccount);
      throw new UnauthorizedException(
        'Challenge nonce not found or already used',
      );
    }

    // Account binding check — prevent a signed challenge for account A from
    // being replayed to obtain a token for account B.
    if (nonceData.account !== clientAccount) {
      // Issue #1174 — mismatched account binding counts as a failed attempt.
      await this.recordFailedAttemptFor(clientAccount);
      throw new UnauthorizedException(
        'Challenge nonce was issued for a different account',
      );
    }

    // Atomically delete nonce so it cannot be reused.
    await this.cache.del(nonceKey);

    // Issue #1174 — successful verification resets the failure counter.
    await this.resetFailedAttempts(clientAccount);

    // Issue #933 — issue short-lived access token + rotating refresh token.
    // Issue #1173 — persist session metadata (userAgent, ip, timestamps).
    return this.issueTokenPair(clientAccount, undefined, metadata);
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
    metadata?: SessionMetadata,
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

    // Issue #1173 — persist session metadata for the family. On rotation,
    // preserve createdAt and refresh lastUsedAt; on first issue, set both.
    const sessionKey = `${SESSION_PREFIX}${resolvedFamilyId}`;
    const now = Date.now();
    const existing = await this.cache.get<SessionRecord>(sessionKey);
    const session: SessionRecord = {
      familyId: resolvedFamilyId,
      account,
      userAgent: metadata?.userAgent ?? existing?.userAgent,
      ip: metadata?.ip ?? existing?.ip,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    };
    await this.cache.set(sessionKey, session, REFRESH_TOKEN_TTL_SECONDS);

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
  async rotateRefreshToken(
    refreshToken: string,
    metadata?: SessionMetadata,
  ): Promise<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }> {
    const tokenKey = `${REFRESH_TOKEN_PREFIX}${refreshToken}`;
    const tokenData = await this.cache.get<{
      account: string;
      familyId: string;
    }>(tokenKey);

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

    // Issue #1173 — bump lastUsedAt on the session record before rotating.
    const sessionKey = `${SESSION_PREFIX}${familyId}`;
    const existingSession = await this.cache.get<SessionRecord>(sessionKey);
    if (existingSession) {
      const updated: SessionRecord = {
        ...existingSession,
        familyId,
        userAgent: metadata?.userAgent ?? existingSession.userAgent,
        ip: metadata?.ip ?? existingSession.ip,
        lastUsedAt: Date.now(),
      };
      await this.cache.set(sessionKey, updated, REFRESH_TOKEN_TTL_SECONDS);
    }

    // Issue new pair, preserving the family id so the chain stays tracked.
    return this.issueTokenPair(account, familyId, metadata);
  }

  /** Revoke all tokens in a refresh family (used on logout or compromise). */
  private async revokeFamily(familyId: string): Promise<void> {
    await this.cache.del(`${REFRESH_FAMILY_PREFIX}${familyId}`);
    this.logger.log(`Revoked refresh token family ${familyId}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Session management (Issue #1173)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Issue #1173 — List all active sessions (refresh token families) for an
   * account, including device metadata (userAgent, ip) and timestamps.
   * Results are sorted by `lastUsedAt` descending (most recent first).
   */
  async getActiveSessions(account: string): Promise<SessionRecord[]> {
    const keys = await this.cache.scanKeys(`${SESSION_PREFIX}*`);
    if (!keys || keys.length === 0) {
      return [];
    }

    const sessions: SessionRecord[] = [];
    for (const key of keys) {
      const record = await this.cache.get<SessionRecord>(key);
      if (record && record.account === account) {
        sessions.push(record);
      }
    }

    return sessions.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /**
   * Issue #1173 — Revoke a specific session (refresh token family) belonging
   * to the given account. Throws if the session does not exist or belongs to
   * a different account.
   */
  async revokeSession(account: string, familyId: string): Promise<void> {
    const sessionKey = `${SESSION_PREFIX}${familyId}`;
    const session = await this.cache.get<SessionRecord>(sessionKey);

    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.account !== account) {
      throw new ForbiddenException(
        'Session does not belong to the authenticated account',
      );
    }

    // Delete the current refresh token for the family, then the family head
    // and the session record itself.
    const currentRefreshId = await this.cache.get<string>(
      `${REFRESH_FAMILY_PREFIX}${familyId}`,
    );
    if (currentRefreshId) {
      await this.cache.del(`${REFRESH_TOKEN_PREFIX}${currentRefreshId}`);
    }
    await this.cache.del(`${REFRESH_FAMILY_PREFIX}${familyId}`);
    await this.cache.del(sessionKey);

    this.logger.log(`Revoked session ${familyId} for account ${account}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Account lockout (Issue #1174)
  // ─────────────────────────────────────────────────────────────────────────

  /** Issue #1174 — configured lockout threshold (failed attempts). */
  private get lockoutThreshold(): number {
    return this.configService.get<number>(
      'AUTH_LOCKOUT_THRESHOLD',
      DEFAULT_LOCKOUT_THRESHOLD,
    );
  }

  /** Issue #1174 — configured lockout duration in seconds. */
  private get lockoutDurationSeconds(): number {
    return this.configService.get<number>(
      'AUTH_LOCKOUT_DURATION_SECONDS',
      DEFAULT_LOCKOUT_DURATION_SECONDS,
    );
  }

  /**
   * Issue #1174 — Record a failed authentication attempt for an account.
   * Increments the counter (TTL = lock duration) and, once the threshold is
   * reached, sets the lock marker for the configured duration.
   */
  async recordFailedAttempt(account: string): Promise<void> {
    if (!account) {
      return;
    }
    const failedKey = `${FAILED_ATTEMPTS_PREFIX}${account}`;
    const current = (await this.cache.get<number>(failedKey)) ?? 0;
    const next = current + 1;
    await this.cache.set(failedKey, next, this.lockoutDurationSeconds);

    if (next >= this.lockoutThreshold) {
      await this.cache.set(
        `${ACCOUNT_LOCK_PREFIX}${account}`,
        true,
        this.lockoutDurationSeconds,
      );
      this.logger.warn(
        `Account ${account} locked after ${next} failed attempts`,
      );
    }
  }

  /**
   * Issue #1174 — Check whether an account is currently locked.
   * Returns `{ locked, retryAfter }` where `retryAfter` is seconds remaining.
   */
  async isAccountLocked(
    account: string,
  ): Promise<{ locked: boolean; retryAfter: number }> {
    if (!account) {
      return { locked: false, retryAfter: 0 };
    }
    const locked = await this.cache.get<boolean>(
      `${ACCOUNT_LOCK_PREFIX}${account}`,
    );
    if (locked !== true) {
      return { locked: false, retryAfter: 0 };
    }
    const ttl = await this.cache.ttl(`${ACCOUNT_LOCK_PREFIX}${account}`);
    return {
      locked: true,
      retryAfter: ttl && ttl > 0 ? ttl : this.lockoutDurationSeconds,
    };
  }

  /**
   * Best-effort extraction of the Stellar account from a SEP-10 challenge XDR.
   * Returns `undefined` if the XDR cannot be parsed.
   */
  extractAccountFromChallenge(
    signedTransactionXdr: string,
  ): string | undefined {
    try {
      const tx = new Transaction(signedTransactionXdr, this.networkPassphrase);
      const manageDataOp = tx.operations.find((op) => op.type === 'manageData');
      return manageDataOp?.source ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** Issue #1174 — Reset the failed attempt counter after a successful auth. */
  async resetFailedAttempts(account: string): Promise<void> {
    if (!account) {
      return;
    }
    await this.cache.del(`${FAILED_ATTEMPTS_PREFIX}${account}`);
  }

  /** Issue #1174 — Admin action: clear the lock and failure counter. */
  async unlockAccount(account: string): Promise<void> {
    await this.cache.del(`${ACCOUNT_LOCK_PREFIX}${account}`);
    await this.cache.del(`${FAILED_ATTEMPTS_PREFIX}${account}`);
    this.logger.log(`Account ${account} manually unlocked`);
  }

  /** Issue #1174 — record a failure for a known account (best effort). */
  private async recordFailedAttemptFor(
    account: string | undefined,
  ): Promise<void> {
    if (!account) {
      return;
    }
    try {
      await this.recordFailedAttempt(account);
    } catch (err) {
      this.logger.error(
        `Failed to record failed attempt for ${account}: ${String(err)}`,
      );
    }
  }

  /**
   * Issue #1174 — best-effort attempt to attribute a malformed XDR to an
   * account. The XDR cannot be parsed, so no account is available; this is a
   * no-op kept for symmetry with the other failure paths.
   */
  private async recordFailedAttemptFromXdr(
    _signedTransactionXdr: string,
  ): Promise<void> {
    // No account can be derived from an unparseable transaction.
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
        payload = this.jwtService.decode(token);
      } catch {
        // malformed — skip
      }

      if (!payload?.jti) {
        // A non-empty token that carries no jti cannot be revoked. Silently
        // succeeding would leave the token usable, so fail loudly instead.
        throw new UnauthorizedException(
          'Token cannot be revoked: missing jti claim',
        );
      }

      const now = Math.floor(Date.now() / 1000);
      const remainingTtl = Math.max((payload.exp ?? 0) - now, 1);
      const blocklistKey = `${ACCESS_BLOCKLIST_PREFIX}${payload.jti}`;
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

    if (refreshToken) {
      const tokenKey = `${REFRESH_TOKEN_PREFIX}${refreshToken}`;
      const tokenData = await this.cache.get<{
        account: string;
        familyId: string;
      }>(tokenKey);
      if (tokenData) {
        await this.revokeFamily(tokenData.familyId);
        await this.cache.del(tokenKey);
      }
    }
  }

  /** Check whether an access token jti has been blocklisted. */
  async isTokenRevoked(jti: string): Promise<boolean> {
    const [result] = await this.checkTokensRevoked([jti]);
    return result?.revoked === true;
  }

  /**
   * Issue #1175 — Directly blocklist an access token JTI (e.g. for admin
   * revocation or test helpers). The JTI is stored with a default TTL equal
   * to the access token lifetime.
   */
  async revokeToken(jti: string): Promise<void> {
    if (!jti) {
      return;
    }
    const blocklistKey = `${ACCESS_BLOCKLIST_PREFIX}${jti}`;
    await this.cache.set(blocklistKey, true, ACCESS_TOKEN_TTL_SECONDS);
    this.logger.log(`JWT revoked by direct revokeToken: jti=${jti}`);
  }

  /**
   * Issue #1175 — Batch check whether multiple access token JTIs have been
   * revoked. Uses a single Redis MGET round trip for efficiency.
   */
  async checkTokensRevoked(
    jtis: string[],
  ): Promise<Array<{ jti: string; revoked: boolean }>> {
    if (!jtis || jtis.length === 0) {
      return [];
    }
    const keys = jtis.map((jti) => `${ACCESS_BLOCKLIST_PREFIX}${jti}`);
    const values = await this.cache.mget<boolean>(keys);
    return jtis.map((jti, index) => ({
      jti,
      revoked: values?.[index] === true,
    }));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Token introspection (Issue #1172)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Introspect a JWT or refresh token and return its status and claims.
   *
   * Issue #1172 — Supports both access tokens (JWT) and refresh tokens (UUID).
   *
   * For **access tokens**: decodes the JWT, verifies the signature and
   * expiry, then checks the blocklist for the `jti`.  Returns:
   *   { active, account, jti, exp, iat, token_type: 'access' }
   *
   * For **refresh tokens**: looks up the UUID in Redis.  Returns:
   *   { active, account, jti, exp, token_type: 'refresh' }
   *   `exp` is not available for refresh tokens (no embedded expiry); the
   *   `active` flag reflects whether the token still exists in Redis and its
   *   family has not been revoked.
   *
   * If the token is malformed, expired, blocklisted, or the refresh family
   * has been revoked, `active` is `false` and claims are omitted.
   */
  async introspectToken(token: string): Promise<{
    active: boolean;
    account?: string;
    jti?: string;
    exp?: number;
    iat?: number;
    token_type?: 'access' | 'refresh';
  }> {
    if (!token || typeof token !== 'string') {
      return { active: false };
    }

    const trimmed = token.trim();

    // ── Try JWT (access token) first ────────────────────────────────────────
    // JWTs contain exactly two dots: header.payload.signature
    if (trimmed.split('.').length === 3) {
      return this.introspectAccessToken(trimmed);
    }

    // ── Otherwise treat as a refresh token (UUID) ───────────────────────────
    return this.introspectRefreshToken(trimmed);
  }

  /**
   * Introspect an access token (JWT).
   * Verifies signature + expiry, then checks the blocklist.
   */
  private async introspectAccessToken(token: string): Promise<{
    active: boolean;
    account?: string;
    jti?: string;
    exp?: number;
    iat?: number;
    token_type?: 'access' | 'refresh';
  }> {
    let payload: {
      account?: string;
      jti?: string;
      exp?: number;
      iat?: number;
    };

    try {
      // verifyAsync throws on invalid signature or expired token.
      payload = await this.jwtService.verifyAsync<{
        account?: string;
        jti?: string;
        exp?: number;
        iat?: number;
      }>(token);
    } catch {
      // Try decoding without verification so we can still return claims
      // for expired tokens (active: false but with metadata).
      const decoded = this.jwtService.decode<{
        account?: string;
        jti?: string;
        exp?: number;
        iat?: number;
      }>(token);

      return {
        active: false,
        ...(decoded?.account ? { account: decoded.account } : {}),
        ...(decoded?.jti ? { jti: decoded.jti } : {}),
        ...(decoded?.exp ? { exp: decoded.exp } : {}),
        ...(decoded?.iat ? { iat: decoded.iat } : {}),
        token_type: 'access',
      };
    }

    // Check blocklist for revoked access tokens
    if (payload.jti && (await this.isTokenRevoked(payload.jti))) {
      return {
        active: false,
        ...(payload.account ? { account: payload.account } : {}),
        jti: payload.jti,
        ...(payload.exp ? { exp: payload.exp } : {}),
        ...(payload.iat ? { iat: payload.iat } : {}),
        token_type: 'access',
      };
    }

    return {
      active: true,
      account: payload.account,
      jti: payload.jti,
      ...(payload.exp ? { exp: payload.exp } : {}),
      ...(payload.iat ? { iat: payload.iat } : {}),
      token_type: 'access',
    };
  }

  /**
   * Introspect a refresh token (UUID stored in Redis).
   * Checks that the token exists and its family is still active.
   */
  private async introspectRefreshToken(token: string): Promise<{
    active: boolean;
    account?: string;
    jti?: string;
    exp?: number;
    iat?: number;
    token_type?: 'access' | 'refresh';
  }> {
    const tokenKey = `${REFRESH_TOKEN_PREFIX}${token}`;
    const tokenData = await this.cache.get<{
      account: string;
      familyId: string;
    }>(tokenKey);

    if (!tokenData) {
      return { active: false, token_type: 'refresh' };
    }

    // Check that the family is still active (not revoked).
    const currentRefreshId = await this.cache.get<string>(
      `${REFRESH_FAMILY_PREFIX}${tokenData.familyId}`,
    );

    if (!currentRefreshId) {
      // Family has been revoked
      return {
        active: false,
        account: tokenData.account,
        token_type: 'refresh',
      };
    }

    return {
      active: true,
      account: tokenData.account,
      // For refresh tokens, jti maps to the token UUID itself
      jti: token,
      token_type: 'refresh',
    };
  }
}
