#!/usr/bin/env bash
# Deterministic Soroban contract WASM build & SHA-256 verification script (Issue #1372).
#
# Runs inside the official stellar/soroban-build Docker image to eliminate host
# compiler/linker variance and produces reproducible .wasm artifacts plus a
# SHA-256 release manifest (contracts/wasm-checksums.json).
#
# Usage:
#   scripts/build-reproducible-wasm.sh [--verify <manifest.json>] [--manifest <out.json>]
#
# Environment variables:
#   SOROBAN_BUILD_IMAGE  Docker image to use (default: stellar/soroban-build:v22.0.0)
#   MANIFEST_PATH        Output manifest path (default: contracts/wasm-checksums.json)
#   VERIFY_MANIFEST      Optional manifest path to verify against

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SOROBAN_BUILD_IMAGE="${SOROBAN_BUILD_IMAGE:-stellar/soroban-build:v22.0.0}"
MANIFEST_PATH="${MANIFEST_PATH:-contracts/wasm-checksums.json}"
VERIFY_MANIFEST="${VERIFY_MANIFEST:-}"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --verify)
      VERIFY_MANIFEST="${2:?Missing manifest path for --verify}"
      shift 2
      ;;
    --manifest)
      MANIFEST_PATH="${2:?Missing manifest path for --manifest}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

cd "${REPO_ROOT}"

echo "Building Soroban contracts reproducibly using ${SOROBAN_BUILD_IMAGE}..."
docker run --rm \
  -v "${REPO_ROOT}:/workspace" \
  -w /workspace/contracts \
  -e CARGO_INCREMENTAL=0 \
  -e SOURCE_DATE_EPOCH=0 \
  -e RUSTFLAGS="--remap-path-prefix=/workspace=. --remap-path-prefix=/root/.cargo=/cargo" \
  "${SOROBAN_BUILD_IMAGE}" \
  bash -c "cargo build --target wasm32v1-none --release --locked"

WASM_DIR="contracts/target/wasm32v1-none/release"
if [[ ! -d "${WASM_DIR}" ]]; then
  echo "::error::Expected WASM output directory not found: ${WASM_DIR}" >&2
  exit 1
fi

mapfile -t WASM_FILES < <(find "${WASM_DIR}" -maxdepth 1 -type f -name '*.wasm' | sort)
if [[ "${#WASM_FILES[@]}" -eq 0 ]]; then
  echo "::error::No compiled .wasm artifacts found in ${WASM_DIR}" >&2
  exit 1
fi

# Generate JSON manifest with SHA-256 hashes and byte sizes
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
TMP_MANIFEST="$(mktemp)"
trap 'rm -f "${TMP_MANIFEST}"' EXIT

{
  echo "{"
  echo "  \"builderImage\": \"${SOROBAN_BUILD_IMAGE}\","
  echo "  \"gitSha\": \"${GIT_SHA}\","
  echo "  \"contracts\": {"
  for i in "${!WASM_FILES[@]}"; do
    wasm="${WASM_FILES[$i]}"
    name="$(basename "${wasm}")"
    sha="$(sha256sum "${wasm}" | awk '{print $1}')"
    size="$(wc -c < "${wasm}" | tr -d '[:space:]')"
    comma=","
    if [[ "$i" -eq $((${#WASM_FILES[@]} - 1)) ]]; then
      comma=""
    fi
    echo "    \"${name}\": { \"sha256\": \"${sha}\", \"bytes\": ${size} }${comma}"
  done
  echo "  }"
  echo "}"
} > "${TMP_MANIFEST}"

if [[ -n "${VERIFY_MANIFEST}" ]]; then
  if [[ ! -f "${VERIFY_MANIFEST}" ]]; then
    echo "::error::Verification manifest not found: ${VERIFY_MANIFEST}" >&2
    exit 1
  fi

  echo "Verifying compiled WASM SHA-256 hashes against ${VERIFY_MANIFEST}..."
  FAILED=0
  for wasm in "${WASM_FILES[@]}"; do
    name="$(basename "${wasm}")"
    actual_sha="$(sha256sum "${wasm}" | awk '{print $1}')"
    expected_sha="$(node -e "
      const fs = require('fs');
      const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      console.log((m.contracts && m.contracts[process.argv[2]] && m.contracts[process.argv[2]].sha256) || '');
    " "${VERIFY_MANIFEST}" "${name}")"

    if [[ -z "${expected_sha}" ]]; then
      echo "::error::Contract ${name} missing from release manifest ${VERIFY_MANIFEST}" >&2
      FAILED=1
    elif [[ "${actual_sha}" != "${expected_sha}" ]]; then
      echo "::error::SHA-256 mismatch for ${name}: expected ${expected_sha}, got ${actual_sha}" >&2
      FAILED=1
    else
      echo "OK: ${name} -> ${actual_sha}"
    fi
  done

  if (( FAILED != 0 )); then
    echo "Reproducible build verification FAILED." >&2
    exit 1
  fi
  echo "Reproducible build verification PASSED: all contract WASM hashes match."
else
  mkdir -p "$(dirname "${MANIFEST_PATH}")"
  cp "${TMP_MANIFEST}" "${MANIFEST_PATH}"
  echo "Wrote reproducible WASM checksum manifest to ${MANIFEST_PATH}:"
  cat "${MANIFEST_PATH}"
fi
