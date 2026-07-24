# Retry and Backoff

CarbonChain's `StellarService` applies exponential backoff with jitter when submitting transactions to Horizon or the Soroban RPC.

## Strategy

- **Max retries:** 3 attempts after the initial try (4 total).
- **Initial delay:** 100 ms.
- **Backoff formula:** `delay = initialDelay * 2^attempt + jitter` (10 % jitter).
- **Retryable status codes:** `429` (rate limited), `503` (service unavailable).
- **Non-retryable status codes:** `400`, `404` — fail immediately, no retry.

## Example Delays

| Attempt | Base delay | Max delay (with jitter) |
|---------|-----------|------------------------|
| 1 | 100 ms | 110 ms |
| 2 | 200 ms | 220 ms |
| 3 | 400 ms | 440 ms |
| 4 | 800 ms | 880 ms |

## Sequence Number Reset

When Horizon returns `tx_bad_seq`, the cached sequence number for the signing key is invalidated and the transaction is rebuilt with a fresh sequence number fetched from Horizon. This retry path is separate from the backoff mechanism and limited to **1 retry**.

## Configuration

Retry parameters are hardcoded constants in `StellarService.submitTransactionWithRetry`. To change defaults, edit that method directly.

## See Also

- `docs/guides/RETRY_QUICK_REFERENCE.md` — quick-reference card for retry patterns.
