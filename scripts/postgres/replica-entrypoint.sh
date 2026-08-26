#!/bin/bash
# Custom entrypoint for the `postgres-replica` service (#559).
#
# On first start (empty data directory) this clones the master via
# pg_basebackup with `-R`, which writes `standby.signal` and
# `primary_conninfo` so Postgres starts in hot-standby streaming mode.
# On subsequent restarts the data directory is already populated, so this
# just hands off to the normal entrypoint.
set -euo pipefail

if [ -z "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  echo "postgres-replica: data directory empty — cloning from primary ($PRIMARY_HOST)..."

  until pg_isready -h "$PRIMARY_HOST" -p 5432 -U "$POSTGRES_USER"; do
    echo "postgres-replica: waiting for primary to accept connections..."
    sleep 2
  done

  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
    -h "$PRIMARY_HOST" \
    -p 5432 \
    -D "$PGDATA" \
    -U replicator \
    -Fp -Xstream -P -R

  chmod 0700 "$PGDATA"
  echo "postgres-replica: base backup complete, starting in standby mode."
fi

exec docker-entrypoint.sh postgres
