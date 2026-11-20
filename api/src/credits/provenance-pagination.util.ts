/**
 * Cursor-based paging + exact-match helpers for credit provenance lookups
 * (issue: credits.service.ts fetched from startLedger=0 and filtered
 * in-memory, and matched credit ids via substring instead of exact
 * topic/key comparison, making provenance cost unbounded and imprecise).
 */

export interface EventPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface LedgerCursor {
  startLedger: number;
  pageToken?: string;
}

/** Parses an opaque provenance cursor into a startLedger + pageToken. */
export function decodeProvenanceCursor(cursor: string | null): LedgerCursor {
  if (!cursor) {
    return { startLedger: 0 };
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [startLedger, pageToken] = decoded.split(':');
  return {
    startLedger: Number(startLedger) || 0,
    pageToken: pageToken || undefined,
  };
}

export function encodeProvenanceCursor(
  startLedger: number,
  pageToken?: string,
): string {
  const raw = `${startLedger}:${pageToken ?? ''}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Exact match on a decoded event topic/key against the target credit id.
 * Callers should decode the ScVal topic to a hex/string key before calling
 * this, rather than doing a substring/`includes` comparison.
 */
export function matchesCreditIdExactly(
  topicKey: string,
  creditId: string,
): boolean {
  return topicKey.toLowerCase() === creditId.toLowerCase();
}
