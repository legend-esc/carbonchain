#!/usr/bin/env bash
# CarbonChain Redis persistence + ACL verification (#975)
#
# Proves the acceptance criteria for "Redis runs without persistence in the
# compose stack":
#
#   1. Redis requires AUTH (unauthenticated commands are rejected).
#   2. AOF persistence is enabled and a key written before a *hard* restart
#      (kill -9, not a graceful stop) is still readable afterwards.
#   3. The correctness-critical key families survive that restart:
#        - idempotency:<sha256(idempotency-key)>
#        - revoked_tokens / revoked_tokens:ttl:<jti>
#        - nonce:<address>:<nonce>
#
# The equivalent API-level guarantee is that a POST replayed with the same
# Idempotency-Key after a Redis restart returns the original completed
# response instead of executing again (see IdempotencyInterceptor).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REDIS_PASSWORD="${REDIS_PASSWORD:-carbonchain_dev_password}"
export REDIS_PASSWORD

COMPOSE=(docker compose)
if ! docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
fi

log()  { printf '  [redis-verify] %s\n' "$*"; }
pass() { printf '  ✅ %s\n' "$*"; }
fail() { printf '  ❌ %s\n' "$*" >&2; exit 1; }

cd "$REPO_ROOT"

# redis-cli against the master, authenticated.
rcli() {
  "${COMPOSE[@]}" exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" "$@"
}

# redis-cli against the master with no AUTH (used to assert ACL enforcement).
rcli_noauth() {
  "${COMPOSE[@]}" exec -T redis redis-cli "$@"
}

wait_for_healthy() {
  local container deadline
  container="$("${COMPOSE[@]}" ps -q redis)"
  [[ -n "$container" ]] || fail "redis container not found"
  deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    local status
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || echo missing)"
    [[ "$status" == "healthy" ]] && return 0
    sleep 2
  done
  "${COMPOSE[@]}" logs --tail 50 redis >&2 || true
  fail "redis did not become healthy within 60s"
}

cleanup() {
  if [[ "${KEEP_REDIS:-0}" != "1" ]]; then
    log "Stopping redis service (set KEEP_REDIS=1 to leave it running)"
    "${COMPOSE[@]}" stop redis >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ── 1. Start redis and confirm AUTH is enforced ──────────────────────────────
log "Starting redis service…"
"${COMPOSE[@]}" up -d redis
wait_for_healthy
pass "redis is healthy"

noauth_output="$(rcli_noauth ping 2>&1 || true)"
if grep -qi 'NOAUTH\|Authentication required' <<<"$noauth_output"; then
  pass "unauthenticated PING rejected (ACL enforced): ${noauth_output%%$'\n'*}"
else
  fail "expected NOAUTH for unauthenticated PING, got: ${noauth_output}"
fi

appendonly="$(rcli config get appendonly | tail -n1)"
[[ "$appendonly" == "yes" ]] || fail "appendonly is '$appendonly', expected 'yes'"
pass "appendonly=yes"

# Replicas are not required for this check, but if they were started they must
# also require AUTH.
if "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx redis-replica-1; then
  replica_noauth="$("${COMPOSE[@]}" exec -T redis-replica-1 redis-cli ping 2>&1 || true)"
  grep -qi 'NOAUTH\|Authentication required' <<<"$replica_noauth" \
    || fail "redis-replica-1 accepted an unauthenticated command"
  pass "redis-replica-1 also enforces AUTH"
fi

# ── 2. Seed correctness-critical keys ────────────────────────────────────────
IDEMPOTENCY_KEY="bounty-975-replayed-key"
IDEMPOTENCY_HASH="$(printf '%s' "$IDEMPOTENCY_KEY" | sha256sum | awk '{print $1}')"
IDEMPOTENCY_REDIS_KEY="idempotency:${IDEMPOTENCY_HASH}"
JTI="bounty-975-revoked-jti"
NONCE_ADDR="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
NONCE_VALUE="42"

log "Seeding keys…"
rcli set "$IDEMPOTENCY_REDIS_KEY" \
  '{"status":"completed","statusCode":201,"body":{"ok":true}}' EX 86400 >/dev/null
rcli sadd revoked_tokens "$JTI" >/dev/null
rcli set "revoked_tokens:ttl:${JTI}" 1 EX 3600 >/dev/null
rcli set "nonce:${NONCE_ADDR}:${NONCE_VALUE}" 1 EX 10 >/dev/null
pass "seeded ${IDEMPOTENCY_REDIS_KEY}, revoked_tokens:${JTI}, nonce:${NONCE_ADDR}:${NONCE_VALUE}"

# Give appendfsync everysec a chance to flush to disk before the hard kill.
sleep 2

# ── 3. Hard restart — kill -9, then bring the container back ─────────────────
log "Hard-restarting redis (kill -9)…"
"${COMPOSE[@]}" kill redis >/dev/null
"${COMPOSE[@]}" up -d redis
wait_for_healthy
pass "redis restarted"

# ── 4. Assert the keys survived ──────────────────────────────────────────────
[[ "$(rcli exists "$IDEMPOTENCY_REDIS_KEY")" == "1" ]] \
  || fail "idempotency record did not survive restart"
pass "idempotency record survived restart"

stored_body="$(rcli get "$IDEMPOTENCY_REDIS_KEY")"
grep -q '"status":"completed"' <<<"$stored_body" \
  || fail "idempotency record lost its completed body: $stored_body"
pass "idempotency record still reports completed"

[[ "$(rcli sismember revoked_tokens "$JTI")" == "1" ]] \
  || fail "revoked token did not survive restart"
[[ "$(rcli exists "revoked_tokens:ttl:${JTI}")" == "1" ]] \
  || fail "revoked-token TTL marker did not survive restart"
pass "revoked-token state survived restart"

[[ "$(rcli exists "nonce:${NONCE_ADDR}:${NONCE_VALUE}")" == "1" ]] \
  || fail "nonce reservation did not survive restart"
pass "nonce reservation survived restart"

# ── 5. AUTH still enforced after restart ─────────────────────────────────────
noauth_after="$(rcli_noauth ping 2>&1 || true)"
grep -qi 'NOAUTH\|Authentication required' <<<"$noauth_after" \
  || fail "ACL was not enforced after restart: ${noauth_after}"
pass "ACL still enforced after restart"

echo
pass "All Redis persistence + ACL checks passed."
