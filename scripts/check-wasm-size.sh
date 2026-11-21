#!/usr/bin/env bash
# Automated Soroban smart contract WASM size budget enforcement check (Issue #1360).
#
# Inspects compiled Soroban .wasm artifacts and fails if any contract exceeds
# the configured bytecode size budget (default: 65536 bytes / 64 KiB).
#
# Usage:
#   scripts/check-wasm-size.sh [wasm-dir-or-file...]
#
# Environment variables:
#   WASM_SIZE_BUDGET_BYTES  Maximum allowed WASM size in bytes (default: 65536)
#   BUILD_CONTRACTS         Set to "true" to build contracts before checking

set -euo pipefail

BUDGET_BYTES="${WASM_SIZE_BUDGET_BYTES:-65536}"
BUILD_CONTRACTS="${BUILD_CONTRACTS:-false}"

if [[ "$BUILD_CONTRACTS" == "true" ]]; then
  if command -v stellar >/dev/null 2>&1; then
    echo "Building contracts with stellar contract build..."
    (cd contracts && stellar contract build)
  else
    echo "stellar CLI not found; building contracts with cargo..."
    (cd contracts && cargo build --target wasm32v1-none --release)
  fi
fi

# Collect WASM files from arguments or default release target directory.
WASM_FILES=()
if [[ "$#" -gt 0 ]]; then
  for arg in "$@"; do
    if [[ -d "$arg" ]]; then
      while IFS= read -r -d '' f; do
        WASM_FILES+=("$f")
      done < <(find "$arg" -maxdepth 1 -type f -name '*.wasm' -print0 | sort -z)
    elif [[ -f "$arg" ]]; then
      WASM_FILES+=("$arg")
    else
      echo "::error::WASM path not found: $arg" >&2
      exit 1
    fi
  done
else
  DEFAULT_DIR="contracts/target/wasm32v1-none/release"
  if [[ -d "$DEFAULT_DIR" ]]; then
    while IFS= read -r -d '' f; do
      WASM_FILES+=("$f")
    done < <(find "$DEFAULT_DIR" -maxdepth 1 -type f -name '*.wasm' -print0 | sort -z)
  fi
fi

if [[ "${#WASM_FILES[@]}" -eq 0 ]]; then
  echo "::error::No compiled .wasm files found to inspect." >&2
  exit 1
fi

printf "\n%-36s %12s %10s %10s %8s\n" "Contract WASM" "Size (bytes)" "Size (KiB)" "Budget %" "Status"
printf "%-36s %12s %10s %10s %8s\n" "------------------------------------" "------------" "----------" "----------" "--------"

FAILED=0
for wasm in "${WASM_FILES[@]}"; do
  name="$(basename "$wasm")"
  size_bytes="$(wc -c < "$wasm" | tr -d '[:space:]')"
  size_kib="$(awk "BEGIN { printf \"%.2f\", $size_bytes / 1024 }")"
  pct="$(awk "BEGIN { printf \"%.1f\", ($size_bytes / $BUDGET_BYTES) * 100 }")"

  if (( size_bytes > BUDGET_BYTES )); then
    status="FAIL"
    FAILED=1
    printf "%-36s %12d %10s %9s%% %8s\n" "$name" "$size_bytes" "$size_kib" "$pct" "$status"
    echo "::error file=${wasm}::Contract ${name} (${size_bytes} bytes / ${size_kib} KiB) exceeds WASM size budget of ${BUDGET_BYTES} bytes."
  else
    status="PASS"
    printf "%-36s %12d %10s %9s%% %8s\n" "$name" "$size_bytes" "$size_kib" "$pct" "$status"
  fi
done

echo ""
if (( FAILED != 0 )); then
  echo "WASM size budget check FAILED (budget: ${BUDGET_BYTES} bytes)." >&2
  exit 1
fi

echo "All ${#WASM_FILES[@]} contract(s) are within the ${BUDGET_BYTES}-byte WASM size budget."
