#!/bin/bash
# Runs once, on first init of the master's data directory (via
# docker-entrypoint-initdb.d). Creates the replication role the
# `postgres-replica` service uses for streaming replication (#559),
# and grants it access from any container on the compose network.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD '${REPLICATION_PASSWORD}';
EOSQL

echo "host replication replicator all md5" >> "$PGDATA/pg_hba.conf"
