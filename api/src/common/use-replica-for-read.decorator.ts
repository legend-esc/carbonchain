import { SetMetadata } from '@nestjs/common';

export const REPLICA_READ_METADATA_KEY = 'useReplicaForRead';

/**
 * Marks a read-only route handler as safe to serve from a PostgreSQL read
 * replica instead of the master (see issue #559 and the `replication`
 * config in `src/data-source.ts`).
 *
 * Only apply this to handlers whose result can tolerate a small amount of
 * replication lag. Do NOT apply it to a read that must observe a write from
 * earlier in the same request/response cycle (e.g. re-fetching a resource
 * immediately after creating or updating it) — query that from the master
 * instead, since a lagging replica may not have the write yet.
 */
export const UseReplicaForRead = (): MethodDecorator & ClassDecorator =>
  SetMetadata(REPLICA_READ_METADATA_KEY, true);
