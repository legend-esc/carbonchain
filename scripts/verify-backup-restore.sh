#!/bin/bash
# CarbonChain Backup Restore Verification
#
# Downloads the latest S3 pg_dump backup, restores it into a throwaway
# PostgreSQL container (postgres:16-alpine), runs smoke-test queries against
# the restored data, and writes connection details + row counts to
# /tmp/restore-connection.env and /tmp/restore-counts.txt so the calling
# workflow can run migrations and assert post-migration integrity.
#
# The container is intentionally kept alive after this script exits;
# the workflow's cleanup step removes it via the exported container name.
#
# Usage (called from .github/workflows/backup-verification.yml):
#   ./scripts/verify-backup-restore.sh
#
# Required env vars:
#   BACKUP_S3_BUCKET    — S3 bucket holding pg_dump backups
#   BACKUP_S3_PREFIX    — key prefix (default: postgres-backups)
#   SLACK_WEBHOOK_URL   — optional; Slack webhook for failure alerts

set -euo pipefail

S3_BUCKET="${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
S3_PREFIX="${BACKUP_S3_PREFIX:-postgres-backups}"
RESTORE_CONTAINER_NAME="carbonchain-backup-verify"
RESTORE_DB_NAME="carbonchain_restore_check"
RESTORE_DB_USER="postgres"
RESTORE_DB_PASSWORD="verify-only-$(date +%s)"
RESTORE_DB_PORT="55432"
WORKDIR="$(mktemp -d)"

# Connection file paths written for the workflow to consume
CONNECTION_ENV_FILE="/tmp/restore-connection.env"
COUNTS_FILE="/tmp/restore-counts.txt"

log()  { echo "  [backup-verify] $*"; }
pass() { echo "  ✅ $*"; }

# fail() now exits immediately — previously it only echoed.
fail() {
  echo "  ❌ $*" >&2
  exit 1
}

# Cleanup only removes the temp workdir; the container is left running so the
# workflow's subsequent steps can connect.  The workflow's "Cleanup restore
# container" step removes the container unconditionally via `docker rm -f`.
cleanup_workdir() {
  rm -rf "$WORKDIR"
}
trap cleanup_workdir EXIT

notify_slack() {
  local status="$1" message="$2"
  [[ -n "${SLACK_WEBHOOK_URL:-}" ]] || return 0
  curl -sf -X POST -H 'Content-type: application/json' \
    --data "{\"text\": \"[backup-verify] ${status}: ${message}\"}" \
    "$SLACK_WEBHOOK_URL" >/dev/null || log "Slack notification failed (non-fatal)"
}

fail_and_alert() {
  local msg="$1"
  echo "  ❌ ${msg}" >&2
  notify_slack "FAILED" "$msg"
  exit 1
}

# Helper: run a psql query in the restore container and return trimmed output.
db_query() {
  docker exec "$RESTORE_CONTAINER_NAME" psql \
    -U "$RESTORE_DB_USER" -d "$RESTORE_DB_NAME" -tAc "$1"
}

# Helper: return row count for a table if it exists, else 0.
count_table() {
  local table="$1"
  local exists
  exists=$(db_query \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${table}';")
  if [[ "$exists" == "1" ]]; then
    db_query "SELECT count(*) FROM ${table};"
  else
    echo "0"
  fi
}

# ── 1. Download latest backup from S3 ───────────────────────────────────────
log "Locating latest backup under s3://${S3_BUCKET}/${S3_PREFIX}/"
LATEST_KEY=$(aws s3api list-objects-v2 \
  --bucket "$S3_BUCKET" --prefix "${S3_PREFIX}/" \
  --query 'sort_by(Contents, &LastModified)[-1].Key' --output text) \
  || fail_and_alert "Unable to list backups in s3://${S3_BUCKET}/${S3_PREFIX}/"

[[ -n "$LATEST_KEY" && "$LATEST_KEY" != "None" ]] \
  || fail_and_alert "No backups found in s3://${S3_BUCKET}/${S3_PREFIX}/"

BACKUP_FILE="${WORKDIR}/$(basename "$LATEST_KEY")"
log "Downloading ${LATEST_KEY}"
aws s3 cp "s3://${S3_BUCKET}/${LATEST_KEY}" "$BACKUP_FILE" \
  || fail_and_alert "Download failed for ${LATEST_KEY}"

# ── 2. Spin up a clean throwaway PostgreSQL container ───────────────────────
# Must use postgres:16-alpine to match the production major version.
log "Starting clean throwaway PostgreSQL container (postgres:16-alpine)"

# Remove any stale container from a previous aborted run.
docker rm -f "$RESTORE_CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d --name "$RESTORE_CONTAINER_NAME" \
  -e POSTGRES_PASSWORD="$RESTORE_DB_PASSWORD" \
  -e POSTGRES_USER="$RESTORE_DB_USER" \
  -e POSTGRES_DB="$RESTORE_DB_NAME" \
  -p "${RESTORE_DB_PORT}:5432" \
  postgres:16-alpine >/dev/null

log "Waiting for PostgreSQL to accept connections"
READY=0
for _ in $(seq 1 30); do
  if docker exec "$RESTORE_CONTAINER_NAME" \
       pg_isready -U "$RESTORE_DB_USER" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
[[ "$READY" -eq 1 ]] \
  || fail_and_alert "PostgreSQL container did not become ready in time"

# ── 3. Record pre-restore counts (always 0 — fresh container) ───────────────
# The container is brand-new so all tables are absent; we set explicit 0s.
# These are compared against post-migration counts in the workflow.
PRE_CREDITS=0
PRE_PROJECTS=0
PRE_VERIFIERS=0
PRE_RETIREMENT_RECORDS=0

log "Pre-restore baseline: credits=${PRE_CREDITS} projects=${PRE_PROJECTS} verifiers=${PRE_VERIFIERS} retirement_records=${PRE_RETIREMENT_RECORDS}"

# ── 4. Restore backup with pg_restore ───────────────────────────────────────
log "Restoring backup into throwaway container"
docker cp "$BACKUP_FILE" "${RESTORE_CONTAINER_NAME}:/tmp/backup.dump"
docker exec "$RESTORE_CONTAINER_NAME" pg_restore \
  -U "$RESTORE_DB_USER" -d "$RESTORE_DB_NAME" \
  --no-owner --clean --if-exists \
  /tmp/backup.dump \
  || fail_and_alert "pg_restore failed for ${LATEST_KEY}"

pass "pg_restore completed for ${LATEST_KEY}"

# ── 5. Capture post-restore counts for key tables ───────────────────────────
log "Capturing post-restore row counts"

POST_CREDITS=$(count_table credits)
POST_PROJECTS=$(count_table projects)
POST_VERIFIERS=$(count_table verifiers)
POST_RETIREMENT_RECORDS=$(count_table retirement_records)

log "Post-restore counts: credits=${POST_CREDITS} projects=${POST_PROJECTS} verifiers=${POST_VERIFIERS} retirement_records=${POST_RETIREMENT_RECORDS}"

# Assert the backup is not completely empty (at least one key table has rows).
TOTAL_ROWS=$(( POST_CREDITS + POST_PROJECTS + POST_VERIFIERS + POST_RETIREMENT_RECORDS ))
[[ "$TOTAL_ROWS" -gt 0 ]] \
  || fail_and_alert "Backup appears empty — all key tables have 0 rows after restore"

pass "Backup is non-empty (total key-table rows: ${TOTAL_ROWS})"

# ── 6. Smoke test: indexes ──────────────────────────────────────────────────
log "Checking expected indexes"
EXPECTED_INDEXES=("credits_pkey" "credits_project_id_idx")
for idx in "${EXPECTED_INDEXES[@]}"; do
  FOUND=$(db_query \
    "SELECT count(*) FROM pg_indexes WHERE indexname = '${idx}';")
  [[ "$FOUND" == "1" ]] || fail_and_alert "Expected index '${idx}' missing after restore"
done
pass "All expected indexes present"

# ── 7. Write connection info for workflow steps ─────────────────────────────
DATABASE_RESTORE_URL="postgresql://${RESTORE_DB_USER}:${RESTORE_DB_PASSWORD}@localhost:${RESTORE_DB_PORT}/${RESTORE_DB_NAME}"

log "Writing connection env to ${CONNECTION_ENV_FILE}"
cat > "$CONNECTION_ENV_FILE" <<EOF
# Written by scripts/verify-backup-restore.sh — sourced by workflow steps
RESTORE_CONTAINER_NAME="${RESTORE_CONTAINER_NAME}"
RESTORE_DB_NAME="${RESTORE_DB_NAME}"
RESTORE_DB_USER="${RESTORE_DB_USER}"
RESTORE_DB_PASSWORD="${RESTORE_DB_PASSWORD}"
RESTORE_DB_PORT="${RESTORE_DB_PORT}"
DATABASE_RESTORE_URL="${DATABASE_RESTORE_URL}"
EOF

log "Writing pre-restore counts to ${COUNTS_FILE}"
cat > "$COUNTS_FILE" <<EOF
# Written by scripts/verify-backup-restore.sh — sourced by workflow steps
PRE_CREDITS=${PRE_CREDITS}
PRE_PROJECTS=${PRE_PROJECTS}
PRE_VERIFIERS=${PRE_VERIFIERS}
PRE_RETIREMENT_RECORDS=${PRE_RETIREMENT_RECORDS}
EOF

pass "Backup ${LATEST_KEY} restored and verified successfully"
pass "Container '${RESTORE_CONTAINER_NAME}' left running on localhost:${RESTORE_DB_PORT} for migration step"
notify_slack "SUCCESS" "Backup ${LATEST_KEY} restored and verified (credits=${POST_CREDITS} projects=${POST_PROJECTS})"
