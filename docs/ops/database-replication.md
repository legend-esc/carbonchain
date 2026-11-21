# PostgreSQL Read-Replica Configuration & Migration Rollbacks

CarbonChain separates read-heavy marketplace and registry queries from write-heavy blockchain event indexers and transaction submissions using **TypeORM master/slave replication**, and enforces reversible schema changes via automated **migration rollback verification** in CI.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CarbonChain Stack                              │
│                                                                         │
│  ┌────────────┐   INSERT/UPDATE/DELETE    ┌──────────────────────────┐  │
│  │ NestJS API │──────────────────────────►│  PostgreSQL Primary      │  │
│  │ (TypeORM)  │                           │  (Master Write Node)     │  │
│  └─────┬──────┘                           └────────────┬─────────────┘  │
│        │                                               │ WAL streaming  │
│        │  SELECT (@UseReplicaForRead / RR)             ▼                │
│        │                                  ┌──────────────────────────┐  │
│        └─────────────────────────────────►│  PostgreSQL Read Replica │  │
│                                           │  (Secondary Read Node)   │  │
│                                           └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Query Routing Behaviour

- **Writes & Transactions (`INSERT`, `UPDATE`, `DELETE`, migrations):** Always routed to `master` (`DATABASE_URL`).
- **Reads (`SELECT`):** When `DATABASE_REPLICA_URLS` (or `DATABASE_REPLICA_URL`) is configured, TypeORM routes read queries across `slaves` using round-robin (`selector: 'RR'`).
- **Fallback:** When no replica URL is set, all queries go directly to `master` without changing connection semantics.

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | `postgresql://postgres:postgres@localhost:5432/carbonchain` | Primary PostgreSQL write node connection string |
| `DATABASE_REPLICA_URLS` | No | `""` | Comma-separated list of read-replica PostgreSQL URLs |
| `DATABASE_REPLICA_URL` | No | `""` | Single secondary read-replica URL (used if `DATABASE_REPLICA_URLS` is unset) |

### Example `.env`

```env
DATABASE_URL=postgresql://postgres:postgres@pg-primary.internal:5432/carbonchain
DATABASE_REPLICA_URLS=postgresql://postgres:postgres@pg-replica-1.internal:5432/carbonchain,postgresql://postgres:postgres@pg-replica-2.internal:5432/carbonchain
```

---

## Connection Pooling

`api/src/data-source.ts` configures bounded pooling to prevent connection exhaustion under concurrent load:

- `poolSize`: `20`
- `extra.max`: `20`
- `extra.idleTimeoutMillis`: `30000` (30 s)
- `extra.connectionTimeoutMillis`: `2000` (2 s)

---

## Database Migration Rollbacks

Every TypeORM migration must implement a working `down()` method that cleanly reverses `up()`.

### CLI Commands

From the repository root:

```bash
# Apply pending migrations
npm --prefix api run migration:run

# Roll back the most recently applied migration
npm run migration:down

# Verify full forward -> down -> forward schema round-trip
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/carbonchain npm run migration:rollback:verify
```

From `api/`:

```bash
npm run migration:run
npm run migration:down   # alias for migration:revert
npm run migration:show
```

### CI Rollback Verification

When `api/src/migrations/` is modified in a pull request, CI runs `scripts/test-migration-rollback.sh`:

1. Applies all migrations (`npm run migration:run`) and snapshots the PostgreSQL schema via `pg_dump --schema-only`.
2. Reverts the latest migration (`npm run migration:revert` / `migration:down`) and verifies the schema actually changed (rejecting no-op `down()` methods).
3. Re-applies the migration (`npm run migration:run`) and asserts the resulting schema is byte-for-byte identical to step 1.
