#!/bin/bash
# Post-deployment contract-state smoke test (additive, standalone).
#
# Complements scripts/smoke-test.sh by verifying core contract wiring via the
# Soroban/Stellar CLI instead of HTTP endpoints: admin initialization on each
# contract, and that credit_registry is wired to the correct retirement
# contract address. Catches deployment regressions such as wrong contract
# wiring or missing admin initialization.
#
# Usage: scripts/smoke-test-contracts.sh <contract-ids.json> <network>

set -euo pipefail

CONTRACTS_FILE="${1:?Usage: $0 <contract-ids.json> <network>}"
NETWORK="${2:-testnet}"

log()  { echo "  [contract-smoke] $*"; }
pass() { echo "  ✅ $*"; }
fail() { echo "  ❌ $*" >&2; exit 1; }

command -v stellar >/dev/null 2>&1 || fail "stellar CLI not found on PATH"
[[ -f "$CONTRACTS_FILE" ]] || fail "Contracts file not found: $CONTRACTS_FILE"

CREDIT_REGISTRY_ID=$(jq -r '.credit_registry' "$CONTRACTS_FILE")
RETIREMENT_ID=$(jq -r '.retirement' "$CONTRACTS_FILE")
MARKETPLACE_ID=$(jq -r '.marketplace' "$CONTRACTS_FILE")
VERIFIER_REGISTRY_ID=$(jq -r '.verifier_registry // .credit_registry' "$CONTRACTS_FILE")

invoke() {
  local contract_id="$1"; shift
  stellar contract invoke --id "$contract_id" --network "$NETWORK" -- "$@"
}

log "Checking admin is initialized on each contract..."
for name_id in "credit_registry:$CREDIT_REGISTRY_ID" "retirement:$RETIREMENT_ID" "marketplace:$MARKETPLACE_ID"; do
  name="${name_id%%:*}"
  id="${name_id##*:}"
  [[ "$id" != "null" && -n "$id" ]] || fail "$name contract id missing from $CONTRACTS_FILE"
  ADMIN=$(invoke "$id" get_admin 2>/dev/null || true)
  [[ -n "$ADMIN" && "$ADMIN" != "null" ]] || fail "$name: admin not initialized"
  pass "$name admin initialized ($ADMIN)"
done

log "Checking credit_registry is wired to the correct retirement contract..."
WIRED_RETIREMENT=$(invoke "$CREDIT_REGISTRY_ID" get_retirement_contract 2>/dev/null || true)
[[ "$WIRED_RETIREMENT" == *"$RETIREMENT_ID"* ]] || fail "credit_registry.retirement_contract mismatch: got $WIRED_RETIREMENT, expected $RETIREMENT_ID"
pass "credit_registry -> retirement wiring correct"

pass "All contract-state smoke checks passed."
