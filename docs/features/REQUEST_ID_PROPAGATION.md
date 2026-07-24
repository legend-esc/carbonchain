# Request ID Propagation

UUID-based request tracing across the NestJS API and outbound Stellar SDK calls.

## How it works

- `RequestIdMiddleware` (`api/src/common/request-id.middleware.ts`) runs first in the
  middleware chain for every route. It reads the incoming `X-Request-ID` header; if
  absent or empty, it generates a `crypto.randomUUID()`.
- The resolved id is written back onto `req.headers['x-request-id']` and set on the
  response as `X-Request-ID`, so every API response (success or error) carries it.
- The id is also stored for the lifetime of the request in an `AsyncLocalStorage`
  (`RequestContextStore`, `api/src/common/request-context.ts`), so any code running
  inside that request — including `StellarService` — can read it without it being
  threaded through every function signature.
- `StellarService` includes the current request id in its log lines for outbound
  Horizon/Soroban RPC calls (retries, failures, event fetches), so a failing Stellar
  call can be correlated back to the originating API request.

## Example

```
curl -i http://localhost:3000/health
> X-Request-ID: 3f2e7c4a-9b1d-4e3a-8c2f-1a2b3c4d5e6f
```

```
curl -i http://localhost:3000/health -H 'X-Request-ID: my-trace-id'
> X-Request-ID: my-trace-id
```

## Related

- `api/src/common/request-logging.middleware.ts` includes the request id in the
  structured log entry emitted for every request — see
  [`LOGGING.md`](./LOGGING.md).
