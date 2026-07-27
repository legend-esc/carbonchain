#!/bin/bash
# CarbonChain Testnet Deployment Script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_FILE="$SCRIPT_DIR/contract-ids.testnet.json"

# Pinned stellar-cli version — update this when upgrading the CLI.
REQUIRED_STELLAR_CLI_VERSION="26.1.0"

log()  { echo "🌿 $*"; }
fail() { echo "❌ $*" >&2; exit 1; }

# Retry a command up to 3 times with exponential back-off (5s, 10s, 20s).
# Usage: retry <description> <command...>
retry() {
  local desc="$1"; shift
  local attempt delay
  for attempt in 1 2 3; do
    if "$@"; then
      return 0
    fi
    if [[ $attempt -lt 3 ]]; then
      delay=$(( 5 * (1 << (attempt - 1)) ))   # 5, 10
      echo "  ⚠️  $desc failed (attempt $attempt/3), retrying in ${delay}s…" >&2
      sleep "$delay"
    fi
  done
  fail "$desc failed after 3 attempts"
}

# ── 0. Verify stellar-cli version ────────────────────────────────────────────

if ! command -v stellar &>/dev/null; then
    fail "stellar CLI not found. Install with: cargo install --locked stellar-cli@${REQUIRED_STELLAR_CLI_VERSION} --features opt"
fi

INSTALLED_VERSION=$(stellar --version 2>&1 | grep -oP '\d+\.\d+\.\d+' | head -1)
if [[ "$INSTALLED_VERSION" != "$REQUIRED_STELLAR_CLI_VERSION" ]]; then
    fail "stellar-cli version mismatch: required ${REQUIRED_STELLAR_CLI_VERSION}, found ${INSTALLED_VERSION:-unknown}. Install with: cargo install --locked stellar-cli@${REQUIRED_STELLAR_CLI_VERSION} --features opt"
fi

log "stellar-cli ${INSTALLED_VERSION} ✓"

[[ -n "${ADMIN_SECRET_KEY:-}" ]] || fail "ADMIN_SECRET_KEY is not set"

ADMIN_ADDRESS=$(stellar keys address "$ADMIN_SECRET_KEY" 2>/dev/null || \
  stellar keys show --secret-key "$ADMIN_SECRET_KEY" 2>/dev/null | grep -oP 'G[A-Z0-9]{55}' | head -1)
[[ -n "$ADMIN_ADDRESS" ]] || fail "Could not derive admin address from ADMIN_SECRET_KEY"

log "Deploying CarbonChain to Stellar Testnet..."
log "Admin: $ADMIN_ADDRESS"

# ── 1. Fund account ───────────────────────────────────────────────────────────

log "Funding testnet account..."
stellar keys fund "$ADMIN_ADDRESS" --network testnet || true

# ── 2. Build contracts ────────────────────────────────────────────────────────

log "Building Soroban contracts..."
(cd "$SCRIPT_DIR/../contracts" && \
  cargo build --target wasm32v1-none --release --quiet)

WASM_DIR="$SCRIPT_DIR/../contracts/target/wasm32v1-none/release"

# ── 3. Deploy contracts ───────────────────────────────────────────────────────

log "Deploying credit_registry..."
CREDIT_REGISTRY_ID=$(retry "deploy credit_registry" stellar contract deploy \
  --wasm "$WASM_DIR/carbonchain_credit_registry.wasm" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet)
log "  credit_registry: $CREDIT_REGISTRY_ID"

log "Deploying retirement..."
RETIREMENT_ID=$(retry "deploy retirement" stellar contract deploy \
  --wasm "$WASM_DIR/carbonchain_retirement.wasm" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet)
log "  retirement: $RETIREMENT_ID"

log "Deploying marketplace..."
MARKETPLACE_ID=$(retry "deploy marketplace" stellar contract deploy \
  --wasm "$WASM_DIR/carbonchain_marketplace.wasm" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet)
log "  marketplace: $MARKETPLACE_ID"

log "Deploying mrv_oracle..."
MRV_ORACLE_ID=$(retry "deploy mrv_oracle" stellar contract deploy \
  --wasm "$WASM_DIR/carbonchain_mrv_oracle.wasm" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet)
log "  mrv_oracle: $MRV_ORACLE_ID"

# ── 4. Initialize contracts ───────────────────────────────────────────────────

log "Initializing credit_registry..."
retry "initialize credit_registry" stellar contract invoke \
  --id "$CREDIT_REGISTRY_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --retirement-contract "$RETIREMENT_ID" \
  --required-approvals 1

log "Initializing retirement..."
retry "initialize retirement" stellar contract invoke \
  --id "$RETIREMENT_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet \
  -- initialize \
  --admin "$ADMIN_ADDRESS"

log "Initializing marketplace..."
retry "initialize marketplace" stellar contract invoke \
  --id "$MARKETPLACE_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet \
  -- initialize \
  --admin "$ADMIN_ADDRESS" \
  --min-price-per-tonne 0

log "Initializing mrv_oracle..."
retry "initialize mrv_oracle" stellar contract invoke \
  --id "$MRV_ORACLE_ID" \
  --source "$ADMIN_SECRET_KEY" \
  --network testnet \
  -- initialize \
  --admin "$ADMIN_ADDRESS"

# ── 5. Save contract IDs ──────────────────────────────────────────────────────

cat > "$CONTRACTS_FILE" <<EOF
{
  "credit_registry": "$CREDIT_REGISTRY_ID",
  "retirement":      "$RETIREMENT_ID",
  "marketplace":     "$MARKETPLACE_ID",
  "mrv_oracle":      "$MRV_ORACLE_ID"
}
EOF

log "Contract IDs written to $CONTRACTS_FILE"

# ── 6. Run smoke tests ────────────────────────────────────────────────────────

log "Running post-deploy smoke tests..."
"$SCRIPT_DIR/smoke-test.sh" "$CONTRACTS_FILE"

log "Deployment complete! ✅"
