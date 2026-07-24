#!/bin/bash
# CarbonChain Post-Deploy Smoke Tests
# Verifies that all four contracts are live and respond correctly after deployment.
# Exits non-zero on any failure so the deployment pipeline fails fast.

set -euo pipefail

CONTRACTS_FILE="${1:-$(dirname "$0")/contract-ids.testnet.json}"

# ── Helpers ──────────────────────────────────────────────────────────────────

log()  { echo "  [smoke] $*"; }
pass() { echo "  ✅ $*"; }
fail() { echo "  ❌ $*" >&2; exit 1; }

require_env() {
  [[ -n "${!1:-}" ]] || fail "Required env var $1 is not set"
}

invoke() {
  # invoke <contract_id> <function> [args...]
  local contract_id="$1"; shift
  stellar contract invoke \
    --id "$contract_id" \
    --source "$ADMIN_SECRET_KEY" \
    --network testnet \
    -- "$@"
}

invoke_as() {
  # invoke_as <secret_key> <contract_id> <function> [args...]
  local secret="$1"; shift
  local contract_id="$1"; shift
  stellar contract invoke \
    --id "$contract_id" \
    --source "$secret" \
    --network testnet \
    -- "$@"
}

assert_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    pass "$label: got '$got'"
  else
    fail "$label: expected '$want', got '$got'"
  fi
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

require_env ADMIN_SECRET_KEY

[[ -f "$CONTRACTS_FILE" ]] || fail "Contract IDs file not found: $CONTRACTS_FILE"

CREDIT_REGISTRY_ID=$(jq -r '.credit_registry' "$CONTRACTS_FILE")
RETIREMENT_ID=$(jq -r '.retirement'       "$CONTRACTS_FILE")
MARKETPLACE_ID=$(jq -r '.marketplace'     "$CONTRACTS_FILE")
MRV_ORACLE_ID=$(jq -r '.mrv_oracle'       "$CONTRACTS_FILE")

for var in CREDIT_REGISTRY_ID RETIREMENT_ID MARKETPLACE_ID MRV_ORACLE_ID; do
  [[ "${!var}" != "null" && -n "${!var}" ]] || fail "$var is missing from $CONTRACTS_FILE"
done

log "Contract IDs loaded from $CONTRACTS_FILE"
log "  credit_registry : $CREDIT_REGISTRY_ID"
log "  retirement      : $RETIREMENT_ID"
log "  marketplace     : $MARKETPLACE_ID"
log "  mrv_oracle      : $MRV_ORACLE_ID"

# Derive the admin public key from the secret key
ADMIN_ADDRESS=$(stellar keys address "$ADMIN_SECRET_KEY" 2>/dev/null || \
  stellar keys show --secret-key "$ADMIN_SECRET_KEY" 2>/dev/null | grep -oP 'G[A-Z0-9]{55}' | head -1)
[[ -n "$ADMIN_ADDRESS" ]] || fail "Could not derive admin address from ADMIN_SECRET_KEY"
log "Admin address: $ADMIN_ADDRESS"

echo ""
echo "🔬 Running smoke tests..."
echo ""

# ── 1. credit_registry ────────────────────────────────────────────────────────

echo "── credit_registry ──────────────────────────────────────────────────────"

log "Checking paused() == false"
PAUSED=$(invoke "$CREDIT_REGISTRY_ID" paused)
assert_eq "credit_registry.paused()" "$PAUSED" "false"

log "Checking get_nonce(admin) returns a number"
NONCE=$(invoke "$CREDIT_REGISTRY_ID" get_nonce --address "$ADMIN_ADDRESS")
[[ "$NONCE" =~ ^[0-9]+$ ]] || fail "credit_registry.get_nonce() returned non-numeric: $NONCE"
pass "credit_registry.get_nonce() = $NONCE"

log "Registering a test verifier"
stellar keys rm smoke-verifier 2>/dev/null || true
stellar keys generate smoke-verifier --no-fund || stellar keys generate smoke-verifier
VERIFIER_SECRET=$(stellar keys show smoke-verifier 2>/dev/null)
VERIFIER_ADDRESS=$(stellar keys address smoke-verifier 2>/dev/null)
[[ -n "$VERIFIER_ADDRESS" ]] || fail "Could not generate smoke-verifier keypair"
stellar keys fund "$VERIFIER_ADDRESS" --network testnet 2>/dev/null || true

NONCE=$(invoke "$CREDIT_REGISTRY_ID" get_nonce --address "$ADMIN_ADDRESS")
invoke "$CREDIT_REGISTRY_ID" register_verifier \
  --admin "$ADMIN_ADDRESS" \
  --verifier "$VERIFIER_ADDRESS" \
  --nonce "$NONCE" > /dev/null
pass "credit_registry.register_verifier() succeeded"

log "Verifying is_verifier() == true"
IS_VERIFIER=$(invoke "$CREDIT_REGISTRY_ID" is_verifier --address "$VERIFIER_ADDRESS")
assert_eq "credit_registry.is_verifier()" "$IS_VERIFIER" "true"

log "Registering a test issuer"
stellar keys rm smoke-issuer 2>/dev/null || true
stellar keys generate smoke-issuer --no-fund || stellar keys generate smoke-issuer
ISSUER_SECRET=$(stellar keys show smoke-issuer 2>/dev/null)
ISSUER_ADDRESS=$(stellar keys address smoke-issuer 2>/dev/null)
[[ -n "$ISSUER_ADDRESS" ]] || fail "Could not generate smoke-issuer keypair"
stellar keys fund "$ISSUER_ADDRESS" --network testnet 2>/dev/null || true

NONCE=$(invoke "$CREDIT_REGISTRY_ID" get_nonce --address "$ADMIN_ADDRESS")
invoke "$CREDIT_REGISTRY_ID" register_issuer \
  --admin "$ADMIN_ADDRESS" \
  --issuer "$ISSUER_ADDRESS" \
  --nonce "$NONCE" > /dev/null
pass "credit_registry.register_issuer() succeeded"

log "Registering VCS methodology"
NONCE=$(invoke "$CREDIT_REGISTRY_ID" get_nonce --address "$ADMIN_ADDRESS")
invoke "$CREDIT_REGISTRY_ID" register_methodology \
  --admin "$ADMIN_ADDRESS" \
  --code '"VCS"' \
  --name '"Verified Carbon Standard"' \
  --nonce "$NONCE" > /dev/null 2>&1 || true  # may already exist from prior run
pass "credit_registry.register_methodology() succeeded (or already registered)"

log "Registering test project"
invoke_as "$ISSUER_SECRET" "$CREDIT_REGISTRY_ID" register_project \
  --owner "$ISSUER_ADDRESS" \
  --project-id '"SMOKE-PROJ-001"' \
  --name '"Smoke Test Project"' \
  --description '"Automated smoke test project"' \
  --location '"NG"' 2>&1 || true  # may already exist from prior run
pass "credit_registry.register_project() succeeded (or already registered)"

log "Submitting a test credit"
ISSUER_NONCE=$(invoke "$CREDIT_REGISTRY_ID" get_nonce --address "$ISSUER_ADDRESS")
CREDIT_ID=$(invoke_as "$ISSUER_SECRET" "$CREDIT_REGISTRY_ID" submit_credit \
  --issuer "$ISSUER_ADDRESS" \
  --project-id '"SMOKE-PROJ-001"' \
  --vintage-year 2024 \
  --methodology '"VCS"' \
  --geography '"NG"' \
  --tonnes 1000000 \
  --ipfs-hash '"bafybeismoke000000000000000000000000000000000000000000000000"' \
  --nonce "$ISSUER_NONCE")
[[ -n "$CREDIT_ID" ]] || fail "credit_registry.submit_credit() returned empty credit ID"
pass "credit_registry.submit_credit() returned credit ID: $CREDIT_ID"

log "Fetching the submitted credit"
CREDIT_STATUS=$(invoke "$CREDIT_REGISTRY_ID" get_credit --credit-id "$CREDIT_ID" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || \
  invoke "$CREDIT_REGISTRY_ID" get_credit --credit-id "$CREDIT_ID" | grep -oP '"status":\s*"\K[^"]+' | head -1)
[[ -n "$CREDIT_STATUS" ]] || fail "credit_registry.get_credit() returned no status"
pass "credit_registry.get_credit() status = $CREDIT_STATUS"

log "Approving and minting the credit"
VERIFIER_NONCE=$(invoke "$CREDIT_REGISTRY_ID" get_nonce --address "$VERIFIER_ADDRESS")
invoke_as "$VERIFIER_SECRET" "$CREDIT_REGISTRY_ID" approve_and_mint \
  --verifier "$VERIFIER_ADDRESS" \
  --credit-id "$CREDIT_ID" \
  --nonce "$VERIFIER_NONCE" > /dev/null
pass "credit_registry.approve_and_mint() succeeded"

echo ""

# ── 2. retirement ─────────────────────────────────────────────────────────────

echo "── retirement ───────────────────────────────────────────────────────────"

log "Checking paused() == false"
PAUSED=$(invoke "$RETIREMENT_ID" paused)
assert_eq "retirement.paused()" "$PAUSED" "false"

log "Checking get_nonce(admin) returns a number"
NONCE=$(invoke "$RETIREMENT_ID" get_nonce --address "$ADMIN_ADDRESS")
[[ "$NONCE" =~ ^[0-9]+$ ]] || fail "retirement.get_nonce() returned non-numeric: $NONCE"
pass "retirement.get_nonce() = $NONCE"

echo ""

# ── 3. marketplace ────────────────────────────────────────────────────────────

echo "── marketplace ──────────────────────────────────────────────────────────"

log "Checking paused() == false"
PAUSED=$(invoke "$MARKETPLACE_ID" paused)
assert_eq "marketplace.paused()" "$PAUSED" "false"

log "Checking offer_count() returns a number"
OFFER_COUNT=$(invoke "$MARKETPLACE_ID" offer_count)
[[ "$OFFER_COUNT" =~ ^[0-9]+$ ]] || fail "marketplace.offer_count() returned non-numeric: $OFFER_COUNT"
pass "marketplace.offer_count() = $OFFER_COUNT"

echo ""

# ── 4. mrv_oracle ─────────────────────────────────────────────────────────────

echo "── mrv_oracle ───────────────────────────────────────────────────────────"

log "Checking paused() == false"
PAUSED=$(invoke "$MRV_ORACLE_ID" paused)
assert_eq "mrv_oracle.paused()" "$PAUSED" "false"

echo ""

# ── Done ──────────────────────────────────────────────────────────────────────

echo "🌿 All smoke tests passed."
