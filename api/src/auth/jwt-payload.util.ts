import { randomUUID } from 'crypto';

/**
 * Builds a JWT payload with a unique `jti` claim so individual tokens can
 * be targeted for revocation (see TokenRevocationService). Use in place of
 * `{ account }` wherever AuthService signs a new token.
 */
export function buildJwtPayload(account: string): {
  account: string;
  jti: string;
} {
  return { account, jti: randomUUID() };
}
