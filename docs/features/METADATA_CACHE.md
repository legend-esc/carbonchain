# Metadata Cache

CarbonChain caches frequently-read on-chain data (credit metadata, account info) in-process to reduce Horizon and Soroban RPC round-trips.

## Cached Resources

| Resource | TTL | Invalidation trigger |
|----------|-----|----------------------|
| `StellarService.getAccountInfo` | 30 seconds | Successful transaction submission for that account |
| Credit metadata (read-only fields) | 60 seconds | Explicit cache bust on status change |

## Account Info Cache (#353)

`getAccountInfo` is called on every request to verify the submitter exists on-chain. The result is keyed by Stellar address and cached for **30 seconds**.

The cache is invalidated for a specific address after every successful `invokeContract` or `buildAndSubmit` call for that address, ensuring the sequence number and balance are re-read after a state change.

```typescript
// Example: repeated calls within 30 s hit the in-process cache
const info = await stellarService.getAccountInfo('GABC...');
// second call within TTL — no Horizon round-trip
const info2 = await stellarService.getAccountInfo('GABC...');
```

## Implementation

The cache uses a plain `Map<string, { value: T; expiresAt: number }>`. No external dependency (Redis, Memcached) is required for this layer. Redis is used separately for rate limiting.

## Cache Miss Behaviour

On a cache miss the value is fetched from Horizon/RPC and stored with the TTL timestamp. Concurrent requests that miss at the same time will each fetch independently (no locking); this is acceptable given the short TTL.
