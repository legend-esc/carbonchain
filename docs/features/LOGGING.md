# Structured Logging

JSON-formatted, correlatable logging for the NestJS API.

## How it works

- `PinoNestLogger` (`api/src/common/pino-nest-logger.service.ts`) implements Nest's
  `LoggerService` on top of `pino` and is installed via `app.useLogger(...)` in
  `api/src/main.ts`, replacing Nest's default console logger for framework-level logs
  (startup, errors, warnings).
- `RequestLoggingMiddleware` (`api/src/common/request-logging.middleware.ts`) emits one
  structured log entry per HTTP request when the response finishes, with the fields:
  `requestId`, `userId`, `method`, `path`, `statusCode`, `durationMs`.
  - `requestId` comes from the `AsyncLocalStorage`-backed `RequestContextStore` — see
    [`REQUEST_ID_PROPAGATION.md`](./REQUEST_ID_PROPAGATION.md).
  - `userId` is the authenticated Stellar account (`req.user.account`) when the request
    passed JWT auth, otherwise `undefined`.
- Log level is configured via the `LOG_LEVEL` env var (`fatal` | `error` | `warn` |
  `info` | `debug` | `trace` | `silent`), validated in `env-validation.ts` and
  defaulting to `info`.

## Example output

```json
{"level":"info","time":"2026-06-25T10:00:00.000Z","requestId":"3f2e7c4a-...","userId":"GABCDEF...","method":"GET","path":"/credits/123","statusCode":200,"durationMs":42.17}
```

## Configuration

```bash
LOG_LEVEL=debug
```
