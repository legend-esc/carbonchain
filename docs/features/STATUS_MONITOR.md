# Status Monitor (Verifier Node Health)

CarbonChain monitors the health of registered verifier nodes and exposes a summary via the health endpoint.

## Health Endpoint

```
GET /api/v1/health
```

**Response (200)**
```json
{
  "status": "ok",
  "uptime": 3600,
  "stellar": "connected",
  "database": "connected",
  "verifiers": {
    "registered": 3,
    "healthy": 2,
    "degraded": 1
  }
}
```

A verifier node is considered **healthy** when it has responded to a liveness ping within the last **5 minutes**. Nodes that have not responded are marked **degraded**.

## Liveness Checks

The API polls each registered verifier's endpoint (if configured) every 60 seconds. The result is cached in-process and included in the `/health` response.

## Alerting

When all verifiers are degraded, the `/health` endpoint returns HTTP `503` so load balancers and uptime monitors can trigger alerts.

## Admin Panel

The Angular admin panel at `/admin/verifiers` shows per-verifier health status in real time via polling the `/health` endpoint every 30 seconds.

## Configuration

No additional environment variables are required. Verifier endpoints are read from the `verifiers` table in PostgreSQL.
