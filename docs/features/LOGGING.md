# Structured Logging

Single-line JSON-formatted, correlatable logging for the NestJS API, compatible with Datadog and Grafana Loki.

## How it works

- `pinoLogger` (`api/src/common/logger.ts`) outputs single-line JSON in production (`NODE_ENV=production`) and pretty-printed logs in local development.
- `PinoNestLogger` (`api/src/common/pino-nest-logger.service.ts`) implements Nest's `LoggerService` on top of `pino` and is installed via `app.useLogger(...)` (with `app.flushLogs()`) in `api/src/main.ts`, replacing Nest's default console logger for framework-level logs (startup, errors, warnings).
- `RequestLoggingMiddleware` (`api/src/common/request-logging.middleware.ts`) emits one structured log entry per HTTP request when the response finishes, with `requestId`, `userId`, `method`, `path`, `statusCode`, and `durationMs`.
  - `correlationId` (and `requestId`) comes from the `AsyncLocalStorage`-backed `RequestContextStore` — see [`REQUEST_ID_PROPAGATION.md`](./REQUEST_ID_PROPAGATION.md).
- Log level is configured via the `LOG_LEVEL` env var (`fatal` | `error` | `warn` | `info` | `debug` | `trace` | `silent`), validated in `env-validation.ts` and defaulting to `info`.

## Standard JSON Fields (Production)

| Field | Description |
| --- | --- |
| `timestamp` | ISO-8601 UTC timestamp |
| `level` | Log severity (`info`, `warn`, `error`, `debug`, `trace`, `fatal`) |
| `correlationId` | Per-request correlation ID from `RequestContextStore` |
| `context` | NestJS module/service name or `Bootstrap` |
| `message` | Log message string (with sensitive `key=value` pairs redacted) |
| `error.stack` | Stack trace when logging an error |

## Example output

```json
{"level":"info","timestamp":"2026-06-25T10:00:00.000Z","service":"carbonchain-api","correlationId":"3f2e7c4a-...","requestId":"3f2e7c4a-...","context":"CreditsController","message":"Listing active credits"}
```

Error example:

```json
{"level":"error","timestamp":"2026-06-25T10:00:01.000Z","service":"carbonchain-api","correlationId":"3f2e7c4a-...","context":"Bootstrap","message":"Database connection failed","error":{"stack":"Error: Database connection failed\n    at ..."}}
```

## Configuration

```bash
NODE_ENV=production
LOG_LEVEL=info
SERVICE_NAME=carbonchain-api
```
