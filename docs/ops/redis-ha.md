# Redis High Availability — Sentinel Setup

CarbonChain uses **Redis Sentinel** to eliminate the single point of failure that existed with a standalone Redis instance. This document covers the architecture, configuration, failover behaviour, and local vs. production operation.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CarbonChain Stack                             │
│                                                                      │
│  ┌──────────┐    Sentinel-aware    ┌─────────────────────────────┐  │
│  │ NestJS   │◄──── ioredis ───────►│  Redis Sentinel (×3)        │  │
│  │   API    │                      │  sentinel-1  :26379         │  │
│  └──────────┘                      │  sentinel-2  :26380         │  │
│                                    │  sentinel-3  :26381         │  │
│                                    └──────────────┬──────────────┘  │
│                                         monitors  │                  │
│                                    ┌──────────────▼──────────────┐  │
│                                    │  Redis Master  (redis:6379) │  │
│                                    │  Redis Replica 1            │  │
│                                    │  Redis Replica 2            │  │
│                                    └─────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

| Node | Role | Port |
|------|------|------|
| `redis` | Master | 6379 |
| `redis-replica-1` | Replica | (internal) |
| `redis-replica-2` | Replica | (internal) |
| `redis-sentinel-1` | Sentinel | 26379 |
| `redis-sentinel-2` | Sentinel | 26380 |
| `redis-sentinel-3` | Sentinel | 26381 |

### Why 3 sentinels?

Sentinel requires a **quorum** (majority) to agree before initiating a failover. With 3 sentinels and a quorum of 2, the system tolerates the loss of one sentinel without losing HA capability.

---

## Failover Behaviour

1. A sentinel detects the master is unreachable after `down-after-milliseconds` (5 000 ms = 5 s).
2. Once quorum (2 of 3) agree, the sentinel with the highest priority initiates failover.
3. One replica is promoted to master; all other replicas reconfigure to replicate from the new master.
4. ioredis in the API automatically queries the sentinels for the new master address and reconnects — no API restart required.
5. Commands queued during failover are held in ioredis's `enableOfflineQueue` buffer and replayed once the connection is restored.

**Observed downtime:** < 5 seconds in tests with `failover-timeout 10000ms`.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_SENTINEL_HOSTS` | Yes (sentinel mode) | — | Comma-separated `host:port` list of sentinel nodes |
| `REDIS_SENTINEL_NAME` | No | `mymaster` | Sentinel master name |
| `REDIS_URL` | Fallback | — | Single-node Redis URL — used when sentinels are not configured |
| `CACHE_TTL_SECONDS` | No | `60` | Default TTL for all cached keys |

### Example `.env` (staging / production)

```env
REDIS_SENTINEL_HOSTS=redis-sentinel-1:26379,redis-sentinel-2:26379,redis-sentinel-3:26379
REDIS_SENTINEL_NAME=mymaster
CACHE_TTL_SECONDS=120
```

### Example `.env` (local dev — single node)

```env
REDIS_URL=redis://localhost:6379
CACHE_TTL_SECONDS=60
```

---

## Running Locally

The full Sentinel topology is included in `docker-compose.yml` (1 master + 2 replicas + 3 sentinels):

```bash
docker compose up -d
```

For lightweight local dev without Sentinel overhead, override in `docker-compose.override.yml`:

```yaml
# docker-compose.override.yml (local dev only)
services:
  redis-replica-1:
    profiles: ["sentinel"]
  redis-replica-2:
    profiles: ["sentinel"]
  redis-sentinel-1:
    profiles: ["sentinel"]
  redis-sentinel-2:
    profiles: ["sentinel"]
  redis-sentinel-3:
    profiles: ["sentinel"]
  api:
    environment:
      REDIS_SENTINEL_HOSTS: ""
      REDIS_URL: redis://redis:6379
```

This keeps only the master Redis running for local development and the API falls back to single-node mode.

---

## Failover Test Procedure

To verify that the API survives a master failure:

```bash
# 1. Start the full stack
docker compose up -d

# 2. Watch API logs in one terminal
docker compose logs -f api | grep -i redis

# 3. Kill the master in another terminal
docker compose kill redis

# 4. Within 5–10s, sentinels promote a replica
# 5. Verify the API reconnects and continues serving cache reads

# 6. Check sentinel logs
docker compose logs redis-sentinel-1 | grep -i failover

# 7. Restore master (becomes a replica of the new master)
docker compose start redis
```

Expected output in sentinel logs:
```
+failover-state-send-slaveof-noone slave 172.x.x.x:6379@redis
+failover-end master mymaster 172.x.x.x 6379
+switch-master mymaster 172.x.x.x 6379 172.x.x.y 6379
```

---

## Production Checklist

- [ ] `REDIS_SENTINEL_HOSTS` is set in all production `.env` files
- [ ] Sentinel nodes are deployed on separate physical/virtual machines (not co-located with master)
- [ ] `maxmemory` and `maxmemory-policy allkeys-lru` are set on all Redis nodes to prevent OOM
- [ ] Redis persistence is enabled (`--save 60 1`) on the master so state survives restart
- [ ] Monitoring alerts are configured for `+sdown` (subjective down) events from sentinels
- [ ] `requirepass` / `masterauth` are set in production (add to sentinel config and ioredis options)

---

## Dependency

The API uses **ioredis** (v5) for Sentinel-aware connections. The `redis` npm package (v4) does not support Sentinel mode and has been replaced:

```json
// api/package.json
"ioredis": "5.3.2"
```
