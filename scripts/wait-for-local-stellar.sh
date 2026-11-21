#!/usr/bin/env bash
# Wait for local Stellar standalone container (Horizon + Soroban RPC + Friendbot)
# to become healthy before running integration/E2E tests (Issue #1365).
#
# Usage:
#   scripts/wait-for-local-stellar.sh [horizon_url] [soroban_rpc_url]
#
# Environment variables:
#   STELLAR_HORIZON_URL  Horizon base URL (default: http://localhost:8000)
#   STELLAR_SOROBAN_RPC  Soroban RPC URL (default: http://localhost:8000/soroban/rpc)
#   TIMEOUT_SECONDS      Maximum wait time in seconds (default: 120)
#   POLL_INTERVAL        Seconds between health checks (default: 2)

set -euo pipefail

HORIZON_URL="${1:-${STELLAR_HORIZON_URL:-http://localhost:8000}}"
SOROBAN_RPC_URL="${2:-${STELLAR_SOROBAN_RPC:-${HORIZON_URL%/}/soroban/rpc}}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-120}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"

elapsed=0

echo "Waiting for local Stellar standalone node..."
echo "  Horizon URL:     ${HORIZON_URL}"
echo "  Soroban RPC URL: ${SOROBAN_RPC_URL}"
echo "  Timeout:         ${TIMEOUT_SECONDS}s"

check_horizon() {
  curl -fsS --max-time 3 "${HORIZON_URL%/}/" >/dev/null 2>&1
}

check_soroban_rpc() {
  local response
  response=$(curl -fsS --max-time 3 -X POST "${SOROBAN_RPC_URL}" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null || true)
  echo "$response" | grep -q '"status":"healthy"'
}

while (( elapsed < TIMEOUT_SECONDS )); do
  if check_horizon && check_soroban_rpc; then
    echo "Local Stellar Horizon and Soroban RPC are healthy (waited ${elapsed}s)."
    exit 0
  fi

  echo "Waiting for Stellar standalone node... (${elapsed}/${TIMEOUT_SECONDS}s)"
  sleep "${POLL_INTERVAL}"
  elapsed=$((elapsed + POLL_INTERVAL))
done

echo "::error::Timed out after ${TIMEOUT_SECONDS}s waiting for local Stellar node at ${HORIZON_URL}" >&2
exit 1
