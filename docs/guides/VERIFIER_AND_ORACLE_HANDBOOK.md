# Verifier Node and MRV Oracle Integration Handbook

This handbook covers everything needed to run an authorised MRV oracle node against the CarbonChain platform: registration, webhook authentication, telemetry ingestion, anomaly handling, key management, and troubleshooting.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Verifier Node Registration](#2-verifier-node-registration)
3. [API Webhook Authentication](#3-api-webhook-authentication)
4. [Telemetry Ingestion — Python](#4-telemetry-ingestion--python)
5. [Telemetry Ingestion — Node.js](#5-telemetry-ingestion--nodejs)
6. [Anomaly Detection and Dispute Resolution](#6-anomaly-detection-and-dispute-resolution)
7. [Key Management Best Practices](#7-key-management-best-practices)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. Overview

### What verifier nodes and MRV oracles are

A **verifier node** is an off-chain process that holds a Stellar keypair registered as an authorised oracle on the MRV oracle smart contract. Its job is to collect measurement, reporting, and verification (MRV) data from physical sensors or third-party data providers, then relay that data to the CarbonChain platform so it can be recorded on-chain.

An **MRV oracle** is the Soroban smart contract (`contracts/mrv_oracle/`) that accepts, validates, and stores those telemetry readings. The contract enforces that only registered oracle addresses may submit data, that nonces are not replayed, and that timestamps fall within a narrow skew window of the ledger time.

### Trust chain

```
IoT sensors / satellite data / field measurements
         │
         ▼
Verifier node process (signs HMAC payload)
         │  POST /oracle/mrv  (HMAC-SHA256 webhook)
         ▼
NestJS API (oracle.service.ts — validates signature, timestamp, nonce)
         │  Soroban invoke_contract  (admin keypair signs the tx)
         ▼
MRV oracle Soroban contract (checks oracle registration, nonce, timestamp, registry)
         │  cross-contract call on anomaly  →  credit_registry.flag_credit()
         ▼
Persistent on-chain storage  →  triggers credit issuance / anomaly review
```

Each link in the chain enforces its own access control:

- The **NestJS API** validates the HMAC-SHA256 signature and rejects stale timestamps and replayed nonces before forwarding anything to the chain.
- The **Soroban contract** validates that the caller is a registered oracle address, checks the per-oracle nonce, checks the timestamp against the ledger clock, and resolves the anomaly threshold before writing.
- The **credit registry contract** (called cross-contract on anomaly) validates that the entity flagging a credit is a registered verifier.

### Carbon unit conversion

All tonnage values in the contract are stored as `i128` scaled integers.

```
1 tonne CO₂ = 1,000,000 scaled units
0.1 tonne   =   100,000 scaled units  (minimum granularity)
```

The API accepts `tonnesSequestered` as a decimal string (e.g. `"1000000"` for 1 tonne) to avoid JavaScript integer precision loss.

---

## 2. Verifier Node Registration

### Prerequisites

| Requirement | Details |
|---|---|
| Stellar account | A funded Stellar account on the target network (testnet or mainnet). The account must exist on-chain before registration. |
| Soroban toolchain | `stellar` CLI ≥ 21 or the Rust SDK for scripted registration. |
| Admin access | Only the MRV oracle contract admin can register new oracle addresses. Coordinate with the platform team for mainnet registration. |
| `MRV_ORACLE_CONTRACT_ID` | The deployed contract address (C... 56 chars). |

### Generating a Stellar keypair for the oracle identity

Each verifier node needs its own Stellar keypair. The public key (G...) is the oracle's on-chain identity. The secret key (S...) is what the node uses to sign Stellar transactions submitted through the API's admin keypair.

```bash
# Using the Stellar CLI
stellar keys generate oracle-node-1 --network testnet
stellar keys address oracle-node-1   # prints G... public key
```

Store the secret key in a vault immediately (see [Section 7](#7-key-management-best-practices)). Never print it to a terminal in production.

The oracle signing keypair is conceptually separate from the HMAC webhook secret:

| Secret | Purpose | Where used |
|---|---|---|
| Oracle Stellar secret key (S...) | Signs Soroban transactions submitted on-chain | Vault, injected as `ORACLE_SECRET_KEY` |
| `ORACLE_WEBHOOK_SECRET` | Signs the HMAC-SHA256 payload sent to the REST API | Vault, injected as `ORACLE_WEBHOOK_SECRET` |

These two secrets serve different trust boundaries and must never be the same value.

### Registering the oracle address (admin operation)

Registration is an admin-only operation on the MRV oracle contract. The admin calls `register_oracle(admin, oracle_address, nonce)`.

```bash
# Example using the Stellar CLI's Soroban contract invoke command
stellar contract invoke \
  --id $MRV_ORACLE_CONTRACT_ID \
  --source admin-secret-key \
  --network testnet \
  -- register_oracle \
  --admin $ADMIN_PUBLIC_KEY \
  --oracle $ORACLE_PUBLIC_KEY \
  --nonce $CURRENT_ADMIN_NONCE
```

The nonce must equal the current admin nonce from `get_nonce(admin_address)`. The contract uses a 16-slot sliding window, so nonces `current` through `current + 15` are all valid in one call; they cannot be reused.

`register_oracle` returns `true` if the oracle was newly added and `false` if it was already registered (and emits an `orc_dup` event). A duplicate registration is not an error.

### Confirming registration

```bash
stellar contract invoke \
  --id $MRV_ORACLE_CONTRACT_ID \
  --source any-read-key \
  --network testnet \
  -- get_oracle_count
```

Also check `GET /oracle/status` on the API, which returns `oracleCount`.

---

## 3. API Webhook Authentication

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `ORACLE_WEBHOOK_SECRET` | Yes | Shared secret for HMAC-SHA256 signing. Must be at least 32 random bytes encoded as hex or base64. The API will refuse to start without this value in non-test environments. |
| `WEBHOOK_ALLOWED_IPS` | Recommended | Comma-separated IP/CIDR allowlist for the oracle webhook endpoint. Example: `10.0.1.0/24,203.0.113.5/32`. When empty, all IPs are permitted (development only). |
| `MRV_ORACLE_CONTRACT_ID` | Yes | The deployed contract address (C... 56 chars). |

### Canonical signature string

The HMAC-SHA256 input is a colon-delimited string of five fields with no spaces:

```
${oraclePublicKey}:${projectId}:${tonnesSequestered}:${timestamp}:${nonce}
```

Field definitions:

| Field | Type | Example | Notes |
|---|---|---|---|
| `oraclePublicKey` | string | `GABCDE...` | Stellar G... public key of the oracle node |
| `projectId` | string | `PROJ-001` | Project identifier as registered in the credit registry |
| `tonnesSequestered` | string | `1000000` | Scaled integer — 1 tonne = 1,000,000 units |
| `timestamp` | integer | `1735689600` | Unix seconds (UTC); must be within ±300 s of server time |
| `nonce` | string | `a1b2c3d4-...` | Per-request unique string; UUID4 recommended |

The resulting hex digest is placed in the `signature` field of the request body.

### Timestamp window

The API rejects any payload where `|server_time - timestamp| > 300 seconds`. Ensure your oracle node's system clock is synchronised (NTP). The ±5-minute window is generous but clocks that drift more than a minute in production indicate a configuration problem.

### Nonce requirements

- Each `nonce` value must be unique per oracle public key within a 300-second window (the same window as the timestamp check).
- The API stores seen nonces in Redis with a 300-second TTL. A replay of the same `(oraclePublicKey, nonce)` pair within that window returns HTTP 401.
- UUID4 is recommended: `crypto.randomUUID()` in Node.js or `str(uuid.uuid4())` in Python.
- Do not reuse nonces across retries. Generate a new nonce and new timestamp for each attempt.

### Request body schema (`MrvWebhookDto`)

```json
{
  "oraclePublicKey": "GABCDE...",
  "projectId": "PROJ-001",
  "tonnesSequestered": "1000000",
  "timestamp": 1735689600,
  "nonce": "550e8400-e29b-41d4-a716-446655440000",
  "signature": "deadbeef1234..."
}
```

| Field | Type | Constraints |
|---|---|---|
| `oraclePublicKey` | string | Valid Stellar G... address |
| `projectId` | string | Must match a project registered in the credit registry |
| `tonnesSequestered` | string | Decimal integer string; must parse to a positive `i128`; minimum 1 |
| `timestamp` | number | Unix seconds integer; within ±300 s of server time |
| `nonce` | string | Unique per oracle within the timestamp window |
| `signature` | string | Lowercase hex HMAC-SHA256 digest |

### Endpoint

```
POST /oracle/mrv
Content-Type: application/json
```

Successful response (HTTP 201):

```json
{ "anomaly": false }
```

When `anomaly` is `true` the reading was recorded but flagged (see [Section 6](#6-anomaly-detection-and-dispute-resolution)).

---

## 4. Telemetry Ingestion — Python

The script below is a complete, runnable example. It reads configuration from environment variables, constructs the HMAC-SHA256 signature, and posts to the API.

```python
#!/usr/bin/env python3
"""
CarbonChain MRV oracle telemetry ingestion script (Python).

Usage:
    ORACLE_PUBLIC_KEY=G...  \
    ORACLE_WEBHOOK_SECRET=your-secret  \
    CARBONCHAIN_API_URL=https://api.example.com  \
    python ingest_mrv.py PROJ-001 1000000

Arguments:
    project_id        Project identifier (e.g. PROJ-001)
    tonnes            Scaled integer — 1 tonne CO2 = 1,000,000 units
"""

import hashlib
import hmac
import json
import os
import sys
import time
import uuid

import requests


def build_signature(
    secret: str,
    oracle_public_key: str,
    project_id: str,
    tonnes_sequestered: str,
    timestamp: int,
    nonce: str,
) -> str:
    """Return the lowercase hex HMAC-SHA256 signature for the canonical payload."""
    canonical = f"{oracle_public_key}:{project_id}:{tonnes_sequestered}:{timestamp}:{nonce}"
    return hmac.new(
        secret.encode("utf-8"),
        canonical.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def ingest_mrv(project_id: str, tonnes: int) -> None:
    oracle_public_key = os.environ["ORACLE_PUBLIC_KEY"]
    webhook_secret = os.environ["ORACLE_WEBHOOK_SECRET"]
    api_url = os.environ.get("CARBONCHAIN_API_URL", "http://localhost:3000").rstrip("/")

    if tonnes <= 0:
        raise ValueError(f"tonnes must be positive, got {tonnes}")

    tonnes_str = str(tonnes)
    timestamp = int(time.time())
    nonce = str(uuid.uuid4())

    signature = build_signature(
        webhook_secret,
        oracle_public_key,
        project_id,
        tonnes_str,
        timestamp,
        nonce,
    )

    payload = {
        "oraclePublicKey": oracle_public_key,
        "projectId": project_id,
        "tonnesSequestered": tonnes_str,
        "timestamp": timestamp,
        "nonce": nonce,
        "signature": signature,
    }

    print(f"Submitting MRV: project={project_id} tonnes={tonnes_str} ts={timestamp}")

    try:
        response = requests.post(
            f"{api_url}/oracle/mrv",
            json=payload,
            timeout=30,
            headers={"Content-Type": "application/json"},
        )
        response.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        status = exc.response.status_code
        body = exc.response.text
        print(f"ERROR: HTTP {status} — {body}", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.RequestException as exc:
        print(f"ERROR: Request failed — {exc}", file=sys.stderr)
        sys.exit(1)

    result = response.json()
    anomaly = result.get("anomaly", False)

    if anomaly:
        print(
            f"WARNING: anomaly detected for project {project_id}. "
            "Reading recorded but flagged for review."
        )
    else:
        print(f"OK: MRV data ingested successfully (anomaly=False)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <project_id> <tonnes>", file=sys.stderr)
        sys.exit(2)

    project_id_arg = sys.argv[1]
    try:
        tonnes_arg = int(sys.argv[2])
    except ValueError:
        print("ERROR: tonnes must be an integer", file=sys.stderr)
        sys.exit(2)

    ingest_mrv(project_id_arg, tonnes_arg)
```

**Dependencies:** `pip install requests` (all other imports are from the standard library).

**Example invocation:**

```bash
export ORACLE_PUBLIC_KEY="GABCDE..."
export ORACLE_WEBHOOK_SECRET="$(cat /run/secrets/oracle_webhook_secret)"
export CARBONCHAIN_API_URL="https://api.carbonchain.example.com"

python ingest_mrv.py PROJ-001 1000000
```

---

## 5. Telemetry Ingestion — Node.js

The script below uses ESM syntax with the built-in `crypto` and `fetch` modules (Node.js ≥ 18 required; no external dependencies).

```js
#!/usr/bin/env node
/**
 * CarbonChain MRV oracle telemetry ingestion script (Node.js ESM).
 *
 * Usage:
 *   ORACLE_PUBLIC_KEY=G...  \
 *   ORACLE_WEBHOOK_SECRET=your-secret  \
 *   CARBONCHAIN_API_URL=https://api.example.com  \
 *   node ingest_mrv.mjs PROJ-001 1000000
 *
 * Arguments:
 *   project_id   Project identifier (e.g. PROJ-001)
 *   tonnes       Scaled integer — 1 tonne CO2 = 1,000,000 units
 */

import { createHmac, randomUUID } from "node:crypto";

function buildSignature(secret, oraclePublicKey, projectId, tonnesSequestered, timestamp, nonce) {
  const canonical = `${oraclePublicKey}:${projectId}:${tonnesSequestered}:${timestamp}:${nonce}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

async function ingestMrv(projectId, tonnes) {
  const oraclePublicKey = process.env.ORACLE_PUBLIC_KEY;
  const webhookSecret = process.env.ORACLE_WEBHOOK_SECRET;
  const apiUrl = (process.env.CARBONCHAIN_API_URL ?? "http://localhost:3000").replace(/\/$/, "");

  if (!oraclePublicKey) throw new Error("ORACLE_PUBLIC_KEY is required");
  if (!webhookSecret) throw new Error("ORACLE_WEBHOOK_SECRET is required");
  if (tonnes <= 0n) throw new Error(`tonnes must be positive, got ${tonnes}`);

  const tonnesStr = tonnes.toString();
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();

  const signature = buildSignature(webhookSecret, oraclePublicKey, projectId, tonnesStr, timestamp, nonce);

  const payload = {
    oraclePublicKey,
    projectId,
    tonnesSequestered: tonnesStr,
    timestamp,
    nonce,
    signature,
  };

  console.log(`Submitting MRV: project=${projectId} tonnes=${tonnesStr} ts=${timestamp}`);

  let response;
  try {
    response = await fetch(`${apiUrl}/oracle/mrv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`ERROR: Request failed — ${err.message}`);
    process.exit(1);
  }

  if (!response.ok) {
    const body = await response.text();
    console.error(`ERROR: HTTP ${response.status} — ${body}`);
    process.exit(1);
  }

  const result = await response.json();
  const anomaly = result.anomaly ?? false;

  if (anomaly) {
    console.warn(
      `WARNING: anomaly detected for project ${projectId}. Reading recorded but flagged for review.`
    );
  } else {
    console.log("OK: MRV data ingested successfully (anomaly=false)");
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const [, , projectIdArg, tonnesArg] = process.argv;

if (!projectIdArg || !tonnesArg) {
  console.error(`Usage: node ingest_mrv.mjs <project_id> <tonnes>`);
  process.exit(2);
}

let tonnesBigInt;
try {
  tonnesBigInt = BigInt(tonnesArg);
} catch {
  console.error("ERROR: tonnes must be an integer");
  process.exit(2);
}

ingestMrv(projectIdArg, tonnesBigInt).catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
```

**Requirements:** Node.js ≥ 18 (built-in `fetch` and `crypto`). Save as `ingest_mrv.mjs`.

**Example invocation:**

```bash
export ORACLE_PUBLIC_KEY="GABCDE..."
export ORACLE_WEBHOOK_SECRET="$(cat /run/secrets/oracle_webhook_secret)"
export CARBONCHAIN_API_URL="https://api.carbonchain.example.com"

node ingest_mrv.mjs PROJ-001 1000000
```

---

## 6. Anomaly Detection and Dispute Resolution

### Anomaly threshold mechanism

Each time a new MRV reading arrives, the contract computes the percentage deviation from the previous reading for the same project:

```
deviation = |new_tonnes - prev_tonnes| / prev_tonnes
```

This is compared against the **effective threshold**, resolved in priority order:

1. **Per-project override** — set by admin via `set_project_anomaly_threshold(project_id, threshold_bps)`. Takes highest priority.
2. **Methodology override** — set by admin via `set_methodology_threshold(methodology_symbol, threshold_bps)`. Applies to all projects that use that carbon methodology code.
3. **Global default** — 2000 basis points (20%). Set by admin via `set_anomaly_threshold(threshold_bps)`.

Thresholds are expressed in **basis points**: 100 bps = 1%, 2000 bps = 20%, 10000 bps = 100%.

If `deviation > threshold`, the reading is stored with `anomaly: true` and the API endpoint returns `{ "anomaly": true }`.

The contract also runs a **sliding-window variance check** (issue #1285): if the last five readings are available, it computes a moving average and flags a reading that deviates more than the threshold from that average. This catches slow data-tampering patterns that the single-step check might miss.

**Edge cases:**
- First reading for a project: never flagged (no previous reading to compare).
- Previous reading was zero: any non-zero reading is flagged.
- Negative tonnes: rejected with `InvalidReading` (error 410) before the anomaly check runs.

### What happens when `anomaly: true`

1. The reading is stored on-chain with `anomaly: true`. It is not discarded.
2. An `AnomalyDetected` event is emitted on-chain, containing the project ID, old and new tonnage, and the threshold that was exceeded.
3. The contract attempts a cross-contract call to `credit_registry.flag_credit()` for each credit associated with the project (up to 20 credits per reading, bounded by `MAX_FLAG_BATCH`). If the oracle is not registered as a verifier in the credit registry, this call fails silently and no `CreditFlagged` event is emitted.
4. The API returns `{ "anomaly": true }` to the oracle node.
5. Anomalous readings are excluded from `GET /oracle/:projectId/aggregate` when `excludeAnomalies=true`.

The oracle node should alert on anomaly responses and trigger manual review. Do not automatically retry with a modified value; a corrected reading requires a new, legitimately measured value.

### Reputation and slashing system

Each oracle address has an `OracleReputation` record on-chain:

```rust
pub struct OracleReputation {
    pub oracle: Address,
    pub reputation_score: i32,   // starts at 100
    pub dispute_count: u32,      // increments on each admin dispute
    pub deregistered: bool,      // true when dispute_count >= 5
}
```

The admin calls `dispute_reading(admin, project_id, timestamp, reason)` to dispute a reading. Each dispute:

- Increments `dispute_count` by 1.
- Reduces `reputation_score` by 10 (floor 0).
- Sets `deregistered = true` when `dispute_count` reaches 5.

A deregistered oracle can still be in the oracle set (the `OracleSet` storage key). Deregistration via the reputation system is a flag on the reputation record; actual removal from the oracle set requires the admin to call a separate remove function (or the contract to check the reputation flag on `update_mrv_data`). Monitor the `dispute_count` field to detect degrading oracle health before the deregistration threshold is reached.

---

## 7. Key Management Best Practices

### Never commit Stellar secret keys

Stellar secret keys begin with `S` and are 56 characters long (Base32-encoded). They must never appear in:

- Source code or configuration files committed to git
- Log files or stdout
- Environment variable dumps in CI/CD artefacts
- Container image layers

The `.gitignore` file excludes `secrets/` and `*.env.secrets`. The `api/.env.example` marks secrets with `[SECRET]` comments and stores them in `secrets/.env.secrets` (not checked in).

### Use a secrets manager

| Platform | Recommended approach |
|---|---|
| Self-hosted / Kubernetes | HashiCorp Vault with the Kubernetes auth method; mount secrets as files via the Vault Agent sidecar. |
| AWS | AWS Secrets Manager + IAM role for the ECS task or EC2 instance. Retrieve at startup, never log. |
| GCP | Secret Manager with Workload Identity Federation. |
| Local development | `secrets/.env.secrets` file (excluded by `.gitignore`). Never copy to `api/.env`. |

### Rotating `ORACLE_WEBHOOK_SECRET`

The DLQ webhook rotation feature in the codebase provides a rotation endpoint for webhook secrets. The rotation procedure is:

1. Generate a new secret: `openssl rand -hex 32`.
2. Update the secret in the vault.
3. Deploy the new API version that picks up the new secret on startup (or trigger a live reload via the rotation endpoint).
4. Restart oracle nodes to pick up the new secret from the vault.
5. The old secret stops being accepted immediately after the API restarts.

Plan a brief maintenance window for secret rotation or implement dual-secret acceptance (old and new) during the transition period.

### Separating read-only monitoring keys from signing keys

Signing keys (oracle nodes, admin keypair) need `require_auth()` to pass. Monitoring keys used for read-only contract queries (`get_latest`, `get_history`, `get_oracle_count`, etc.) do not need signing authority.

Use separate Stellar accounts for:

- **Oracle signing** — secret key stored in vault, used only for `update_mrv_data` calls.
- **Admin operations** — secret key stored in vault with stricter access controls; used only for `register_oracle`, `set_anomaly_threshold`, etc.
- **Monitoring/alerting** — public key only; queries read-only endpoints. No secret key needed.

---

## 8. Troubleshooting

### Error code quick reference

| HTTP status | Contract error | Code | Cause | Remediation |
|---|---|---|---|---|
| 401 Unauthorized | `Unauthorized` | 401 | Signature mismatch, stale timestamp, or oracle address not registered | Verify `ORACLE_WEBHOOK_SECRET` matches server config. Check system clock (NTP). Confirm oracle is registered via `get_oracle_count` and `list_oracles`. |
| 400 Bad Request | `InvalidNonce` | 406 | Nonce reused within the 300-second window | Generate a fresh UUID4 for every request. Never retry with the same nonce. |
| 400 Bad Request | `InvalidTimestamp` | 408 | Timestamp more than ±300 s from server time, or more than ±3600 s from ledger time | Synchronise the oracle node clock with NTP. Check for large network delays. |
| 400 Bad Request | `InvalidProject` | 407 | Project has no credits in the credit registry | Confirm the project has at least one minted credit via `GET /credits?projectId=PROJ-001`. |
| 400 Bad Request | `InvalidReading` | 410 | `tonnes` is zero or negative | Ensure the sensor value is positive. The minimum unit is 1 scaled unit (1,000,000 = 1 tonne). |
| 400 Bad Request | `Overflow` | 403 | `tonnes` value is extremely large (overflows i128 arithmetic in anomaly calculation) | Validate sensor output range before submission. Max safe value is well below `i128::MAX`. |
| 503 Service Unavailable | `ContractPaused` | 404 | The MRV oracle contract is paused by the admin | Contact the platform admin. Poll `GET /oracle/status` and check `paused: false` before retrying. |
| 503 Service Unavailable | `NotInitialized` | 400 | Contract has not been initialised | Contact the platform team. The `initialize(admin)` call must be made once after deployment. |
| 404 Not Found | `ProjectNotFound` | 405 | Returned by `get_latest` when no MRV history exists for the project | This is not an ingestion error. The project has simply never received an MRV reading. |
| 403 Forbidden | (no contract error) | — | Oracle node's IP is not in `WEBHOOK_ALLOWED_IPS` | Add the oracle's egress IP to the allowlist (env var or admin API). |

### Nonce replay rejection

**Symptom:** HTTP 401 with body `"Oracle webhook payload replay detected"`.

**Cause:** The same `(oraclePublicKey, nonce)` pair was submitted more than once within 300 seconds.

**Fix:**
- Generate a new UUID4 nonce for every request, including retries.
- Never cache and resend the same payload.

### Timestamp skew rejection

**Symptom:** HTTP 401 with body `"Oracle webhook payload timestamp is stale or in the future"`, or HTTP 400 with `"Timestamp rejected by contract: clock skew too large"`.

**Cause:**
- The first message (from the API) means the payload's `timestamp` field differs from the API server's wall clock by more than 300 seconds.
- The second message (from the contract) means the timestamp passed on-chain differs from the ledger timestamp by more than 3600 seconds.

**Fix:**
1. Run `chronyc tracking` or `timedatectl` on the oracle node to confirm clock synchronisation.
2. Ensure the oracle node is not in a suspended VM state that caused a large clock jump.
3. Regenerate the timestamp at the moment of sending, not at the moment of measurement. The `timestamp` field represents when the payload was sent to the API, not when the sensor reading was taken (the sensor timestamp is tracked separately in your off-chain records).

### Oracle address not in the oracle set

**Symptom:** HTTP 401 from the contract (`Unauthorized`, code 401) even though the HMAC signature is valid.

**Cause:** The oracle's Stellar public key has not been registered via `register_oracle`.

**Fix:**
1. Confirm the correct public key is in `ORACLE_PUBLIC_KEY`.
2. Ask an admin to call `register_oracle` with that address.
3. Verify with `stellar contract invoke --id $MRV_ORACLE_CONTRACT_ID -- list_oracles --page 0 --page_size 50`.

### IP allowlist rejection

**Symptom:** HTTP 403 with body `"IP address not in webhook allowlist"`.

**Cause:** The `WEBHOOK_ALLOWED_IPS` env var (or the dynamic Redis allowlist) does not include the oracle node's egress IP.

**Fix:**
- Add the oracle's public IP or CIDR block to `WEBHOOK_ALLOWED_IPS` in the API configuration.
- For dynamic management, use the admin API endpoint that manages the webhook IP allowlist.
- If the oracle is behind NAT, add the NAT gateway IP.

### SSE live stream

The API exposes a Server-Sent Events endpoint at `GET /oracle/projects/:id/stream` that pushes each new MRV reading in real time. This is useful for monitoring dashboards. It emits a `:ping` keep-alive comment every 15 seconds to prevent proxy timeouts. No authentication is required for this read-only endpoint.

```js
const es = new EventSource("https://api.example.com/oracle/projects/PROJ-001/stream");
es.onmessage = (event) => console.log("New MRV reading:", JSON.parse(event.data));
```
