# Anchor Info Discovery

CarbonChain parses `stellar.toml` files to discover anchor services (SEP-10 endpoints, currencies, documentation) for any Stellar domain.

## What It Does

When a user connects a Stellar address, the API resolves the home domain from the account record and fetches `https://<domain>/.well-known/stellar.toml`. The parsed result is cached to avoid repeated network calls.

## Cached Fields

| Field | Description |
|-------|-------------|
| `WEB_AUTH_ENDPOINT` | SEP-10 challenge URL |
| `TRANSFER_SERVER_SEP0024` | SEP-24 deposit/withdrawal URL |
| `CURRENCIES` | List of issued assets |
| `DOCUMENTATION` | Org name, URL, description |
| `SIGNING_KEY` | Anchor signing key |

## Cache Behaviour

- TTL: **5 minutes** per domain.
- Cache key: the home domain string (e.g. `carbonchain.example`).
- On cache miss the TOML is fetched fresh; on hit the cached object is returned immediately.
- The cache is stored in-process (Map); Redis is not required.

## API

```typescript
// Resolve and cache stellar.toml for a domain
const info = await anchorInfoService.getAnchorInfo('carbonchain.example');
console.log(info.WEB_AUTH_ENDPOINT); // 'https://carbonchain.example/auth'
```

## Error Handling

- If the domain has no `stellar.toml`, `null` is returned (not an exception).
- Network errors are logged and `null` is returned so callers can degrade gracefully.
- Malformed TOML is treated as a missing file.

## Configuration

No additional environment variables are required. The home domain is read from the account record returned by Horizon.
