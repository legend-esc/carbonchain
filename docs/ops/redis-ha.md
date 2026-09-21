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
| `REDIS_PASSWORD` | No | — | Redis AUTH password. Required by the bundled compose stack; passed to ioredis explicitly for Sentinel mode (the master address is discovered dynamically, so it cannot live in the URL). |
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

## Persistence & Durability (#975)

Redis is not just a cache. The API stores correctness-critical, short-lived
state there:

| Key pattern | Written by | Consequence of loss on restart |
|-------------|-----------|--------------------------------|
| `idempotency:<sha256(Idempotency-Key)>` | `IdempotencyInterceptor` | A retried POST/PUT is treated as new and may be double-applied |
| `revoked_tokens`, `revoked_tokens:ttl:<jti>` | `TokenRevocationService` | Revoked JWTs become valid again |
| `nonce:<address>:<nonce>` | `NonceService` | Replay protection is weakened between restart and the next on-chain guard |
| `webhooks:registry`, `webhooks:deliveries`, `webhooks:queue` | `WebhooksService` | The in-memory webhook snapshot is empty until it is rehydrated |

The compose `redis` service therefore runs with persistence enabled via a
**mounted configuration** (`scripts/redis/redis.conf`), not inline flags:

```conf
appendonly yes          # AOF write-ahead log — primary durability mechanism
appendfsync everysec    # fsync at most once per second
save 60 1               # plus RDB point-in-time snapshots
save 300 10
save 900 1
dir /data               # inside the named `redis_data` volume
```

The AOF and RDB files live on the named `redis_data` volume, so they survive
`docker compose restart`, `docker compose down` (without `-v`), and container
recreation. The two replicas also persist to their own
(`redis_replica_1_data` / `redis_replica_2_data`) volumes so a Sentinel
promotion does not hand durability to a blank node.

**What the guarantee is.** A graceful restart (SIGTERM / `compose restart`)
loses nothing: Redis flushes the AOF on shutdown. A hard crash (`kill -9` /
node eviction) loses at most the last `appendfsync` window (≤ 1 second) of
writes.

### Authentication (ACL)

The service no longer accepts unauthenticated clients. At container start,
`scripts/redis/redis-entrypoint.sh` generates `users.acl` on the persisted
volume from `REDIS_PASSWORD` and Redis loads it via the `aclfile` directive:

```conf
user default on >${REDIS_PASSWORD} ~* &* +@all
user carbonchain on >${REDIS_PASSWORD} ~* &* +@all
```

The API, the replicas (`--requirepass` / `--masterauth`) and the Sentinels
(`sentinel auth-pass`) all read the same `REDIS_PASSWORD`, so there is a single
source of truth. `REDIS_PASSWORD` defaults to `carbonchain_dev_password` for
local development **only** — always override it in staging/production.

Verify the full cycle (persistence across a hard restart plus ACL enforcement):

```bash
./scripts/verify-redis-persistence.sh
```

### Durability tradeoff vs. the PostgreSQL-backed webhook store (#54)

Webhook registrations and deliveries were moved to PostgreSQL
(`webhooks` / `webhook_deliveries`, migration
`1756000000000-CreateWebhooksTables.ts`) precisely because a Redis-only store
is not durable enough for them. The two stores trade off differently:

* **PostgreSQL** writes through a WAL and `fsync`s on transaction commit, is
  replicated to the read replica, and is backed up independently. It is the
  system of record for webhooks.
* **Redis with AOF `everysec`** is faster and is the right home for ephemeral
  coordination state (idempotency, nonces, revocation TTLs), but it is
  best-effort: up to one second of writes can be lost on an unclean stop, and
  its snapshots are not independently backed up.

So the flow is: Redis is the fast path / coordination store, PostgreSQL is the
durable store. If a webhook snapshot is lost, `WebhooksService` rehydrates from
PostgreSQL rather than losing the registration. If stricter durability is ever
required for idempotency or revocation, move that state to PostgreSQL or set
`appendfsync always` (at a write-latency cost). Redis Cluster is out of scope.

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
- [ ] Redis persistence is enabled on the master **and** replicas (`appendonly yes`, `appendfsync everysec`, `save 60 1`) so state survives restart and Sentinel promotion
- [ ] The `redis_data` (and replica) volumes are backed by durable storage, not `tmpfs`
- [ ] `REDIS_PASSWORD` is overridden from the dev default and injected from a secret manager
- [ ] `requirepass` / `masterauth` / `sentinel auth-pass` are set (the compose stack wires these from `REDIS_PASSWORD`)
- [ ] Monitoring alerts are configured for `+sdown` (subjective down) events from sentinels
- [ ] If idempotency/revocation must survive an unclean crash with zero loss, set `appendfsync always` or move that state to PostgreSQL

---

## Dependency

The API uses **ioredis** (v5) for Sentinel-aware connections. The `redis` npm package (v4) does not support Sentinel mode and has been replaced:

```json
// api/package.json
"ioredis": "5.3.2"
```
