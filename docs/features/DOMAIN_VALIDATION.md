# Domain Validation

CarbonChain validates Stellar home domains when resolving anchor info to prevent SSRF and open-redirect attacks.

## Validation Rules

1. **Scheme** — only `https://` is allowed. Plain `http://` is rejected.
2. **Hostname** — must be a valid public domain or IP. Private/loopback ranges (`127.x`, `10.x`, `192.168.x`, `::1`) are rejected.
3. **Port** — non-standard ports are rejected unless explicitly allow-listed in configuration.
4. **Path** — the `stellar.toml` path is always `/.well-known/stellar.toml`; user-supplied paths are ignored.
5. **Redirect** — HTTP redirects are not followed (fetch is made with `redirect: 'error'`).

## Example: Rejected Domains

```
http://example.com          ← not HTTPS
https://localhost/...        ← loopback
https://192.168.1.1/...     ← private range
https://evil.com@good.com/  ← credential injection
```

## Integration with Anchor Info Discovery

`AnchorInfoService.getAnchorInfo(domain)` runs domain validation before making any outbound request. If validation fails, the call returns `null` immediately and the rejection is logged at `warn` level with the request ID.

## Configuration

No allow-list configuration is required for standard use. To permit non-standard ports in development, set:

```env
ANCHOR_ALLOW_NONSTANDARD_PORTS=true
```

This flag has no effect in production (`NODE_ENV=production`).
