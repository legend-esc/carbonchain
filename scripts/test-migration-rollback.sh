#!/usr/bin/env bash
# Verifies that the most recently applied TypeORM migration's `down()` method
# cleanly reverts its `up()` — see issue #564.
#
# Round-trip: forward (apply all pending migrations) -> revert (undo the
# newest migration) -> forward again (reapply it). The schema after the
# final forward run must exactly match the schema from the first forward
# run, and the revert step must have actually changed the schema (a no-op
# `down()` fails this check too).
#
# Usage (from repo root):
#   DATABASE_URL=postgresql://user:pass@host:5432/db ./scripts/test-migration-rollback.sh
set -euo pipefail

cd "$(dirname "$0")/../api"

: "${DATABASE_URL:?DATABASE_URL must be set}"

SNAPSHOT_FORWARD=$(mktemp)
SNAPSHOT_REVERTED=$(mktemp)
SNAPSHOT_REAPPLIED=$(mktemp)
trap 'rm -f "$SNAPSHOT_FORWARD" "$SNAPSHOT_REVERTED" "$SNAPSHOT_REAPPLIED"' EXIT

dump_schema() {
  # pg_dump 16.x emits a random per-run \restrict/\unrestrict session token at
  # the top and bottom of the dump — filter it out so schema diffs stay stable.
  pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges --no-comments \
    | grep -vE '^\\(un)?restrict '
}

echo "==> [1/3] Running all pending migrations forward"
npm run migration:run
dump_schema > "$SNAPSHOT_FORWARD"

echo "==> [2/3] Reverting the most recently applied migration"
npm run migration:revert
dump_schema > "$SNAPSHOT_REVERTED"

if diff -q "$SNAPSHOT_FORWARD" "$SNAPSHOT_REVERTED" > /dev/null; then
  echo "FAIL: schema is unchanged after migration:revert — the down() method appears to be a no-op."
  exit 1
fi

echo "==> [3/3] Re-running the migration forward"
npm run migration:run
dump_schema > "$SNAPSHOT_REAPPLIED"

if ! diff -u "$SNAPSHOT_FORWARD" "$SNAPSHOT_REAPPLIED"; then
  echo "FAIL: schema after revert + re-run differs from the original forward migration."
  echo "The migration's down() does not cleanly restore the prior state."
  exit 1
fi

echo "PASS: migration rollback round-trip produced an identical schema."
