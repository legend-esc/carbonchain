#!/bin/bash
# CarbonChain Backup Restore Verification
#
# Downloads the latest S3 pg_dump backup, restores it into a throwaway
# PostgreSQL container, runs smoke-test queries against the restored data,
# and reports success/failure. Intended to run weekly via GitHub Actions
# (see .github/workflows/backup-verification.yml) so backup corruption or
# incompleteness is caught before it's ever needed for real.

set -euo pipefail

S3_BUCKET="${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required}"
S3_PREFIX="${BACKUP_S3_PREFIX:-postgres-backups}"
RESTORE_CONTAINER_NAME="carbonchain-backup-verify"
RESTORE_DB_NAME="carbonchain_restore_check"
RESTORE_DB_PASSWORD="verify-only-$(date +%s)"
WORKDIR="$(mktemp -d)"

log()  { echo "  [backup-verify] $*"; }
pass() { echo "  ✅ $*"; }
fail() { echo "  ❌ $*" >&2; }

cleanup() {
  docker rm -f "$RESTORE_CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

notify_slack() {
  local status="$1" message="$2"
  [[ -n "${SLACK_WEBHOOK_URL:-}" ]] || return 0
  curl -sf -X POST -H 'Content-type: application/json' \
    --data "{\"text\": \"[backup-verify] ${status}: ${message}\"}" \
    "$SLACK_WEBHOOK_URL" >/dev/null || log "Slack notification failed (non-fatal)"
}

fail_and_alert() {
  fail "$1"
  notify_slack "FAILED" "$1"
  exit 1
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

# ── 2. Spin up a throwaway PostgreSQL container ─────────────────────────────
log "Starting throwaway PostgreSQL container"
docker run -d --name "$RESTORE_CONTAINER_NAME" \
  -e POSTGRES_PASSWORD="$RESTORE_DB_PASSWORD" \
  -e POSTGRES_DB="$RESTORE_DB_NAME" \
  -p 55432:5432 \
  postgres:16-alpine >/dev/null

log "Waiting for PostgreSQL to accept connections"
for _ in $(seq 1 30); do
  if docker exec "$RESTORE_CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
docker exec "$RESTORE_CONTAINER_NAME" pg_isready -U postgres >/dev/null 2>&1 \
  || fail_and_alert "PostgreSQL container did not become ready in time"

# ── 3. Restore backup with pg_restore ───────────────────────────────────────
log "Restoring backup into throwaway container"
docker cp "$BACKUP_FILE" "${RESTORE_CONTAINER_NAME}:/tmp/backup.dump"
docker exec "$RESTORE_CONTAINER_NAME" pg_restore \
  -U postgres -d "$RESTORE_DB_NAME" --no-owner --clean --if-exists \
  /tmp/backup.dump \
  || fail_and_alert "pg_restore failed for ${LATEST_KEY}"

# ── 4. Smoke test queries ───────────────────────────────────────────────────
log "Running smoke-test queries against restored data"

CREDIT_COUNT=$(docker exec "$RESTORE_CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB_NAME" -tAc \
  "SELECT count(*) FROM credits;") || fail_and_alert "Smoke query on credits table failed"
[[ "$CREDIT_COUNT" =~ ^[0-9]+$ ]] || fail_and_alert "credits count query returned unexpected value: ${CREDIT_COUNT}"
log "credits row count: ${CREDIT_COUNT}"

EXPECTED_INDEXES=("credits_pkey" "credits_project_id_idx")
for idx in "${EXPECTED_INDEXES[@]}"; do
  FOUND=$(docker exec "$RESTORE_CONTAINER_NAME" psql -U postgres -d "$RESTORE_DB_NAME" -tAc \
    "SELECT count(*) FROM pg_indexes WHERE indexname = '${idx}';")
  [[ "$FOUND" == "1" ]] || fail_and_alert "Expected index '${idx}' missing after restore"
done
pass "All expected indexes present"

pass "Backup ${LATEST_KEY} restored and verified successfully"
notify_slack "SUCCESS" "Backup ${LATEST_KEY} restored and verified (credits=${CREDIT_COUNT})"
