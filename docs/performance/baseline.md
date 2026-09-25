# CarbonChain API Performance Baseline

> Issue #548 — Establishes the initial performance characteristics of the API under concurrent load.
> Updated on every release branch via the `load-test.yml` CI workflow.

---

## CI Thresholds (hard gates)

| Metric | Gate | Action on breach |
|---|---|---|
| P95 request latency | < 500 ms | CI fails |
| Error rate | < 0.1 % | CI fails |

---

## Load Test Scenarios

Three scenarios are run against every release branch commit:

| Scenario | Shape | Purpose |
|---|---|---|
| **Sustained** | 100 RPS × 5 min (constant arrival rate) | Establish steady-state throughput and catch memory leaks or connection pool exhaustion |
| **Spike** | 10 → 500 VUs over 30 s, hold 1 min, ramp down | Measure burst tolerance — cache effectiveness, Stellar SDK connection reuse |
| **Stress** | Step-up arrival rate (10 → 600 RPS) | Find the break point — P95 > 1 s or error rate > 1 % |

---

## Endpoints Covered

| Script | Endpoint | Notes |
|---|---|---|
| `scripts/load-test/list-credits.js` | `GET /api/v1/credits` | Filter combos rotated per iteration to exercise index paths |
| `scripts/load-test/issue-credits.js` | `POST /api/v1/credits/issue` | Random methodology + vintage year per VU to avoid key collision |
| `scripts/load-test/retire-credit.js` | `POST /api/v1/credits/:id/retire` | Requires pre-seeded `CREDIT_IDS`; 409 (already-retired) counted as pass |

---

## Initial Baseline (to be populated after first CI run)

> Fill in this table after the first successful load-test workflow run.
> Pull the values from the `load-test-results` artifact → `*-summary.json`.

### GET /api/v1/credits

| Metric | Sustained (100 RPS) | Spike (500 VU peak) | Stress break point |
|---|---|---|---|
| P50 latency | — ms | — ms | — ms |
| P95 latency | — ms | — ms | — ms |
| P99 latency | — ms | — ms | — ms |
| Error rate | —% | —% | —% |
| Max RPS achieved | — | — | — |

### POST /api/v1/credits/issue

| Metric | Sustained (100 RPS) | Spike (500 VU peak) | Stress break point |
|---|---|---|---|
| P50 latency | — ms | — ms | — ms |
| P95 latency | — ms | — ms | — ms |
| P99 latency | — ms | — ms | — ms |
| Error rate | —% | —% | —% |
| Max RPS achieved | — | — | — |

### POST /api/v1/credits/:id/retire

| Metric | Sustained (100 RPS) | Spike (500 VU peak) | Stress break point |
|---|---|---|---|
| P50 latency | — ms | — ms | — ms |
| P95 latency | — ms | — ms | — ms |
| P99 latency | — ms | — ms | — ms |
| Error rate | —% | —% | —% |
| Max RPS achieved | — | — | — |

---

## Known Bottlenecks (pre-baseline)

- **Sequence number race condition (#51):** Concurrent credit issuance requests share the Stellar account nonce. Under high concurrency this causes transaction failures that will appear as errors in the `issue-credits` scenario.
- **Cache invalidation slowness (#81):** Cache TTL mismatches mean the first request after expiry hits the database and Stellar RPC in series. Visible as latency spikes in the `list-credits` sustained scenario.
- **DB connection pool saturation:** Without `statement_timeout` (fixed in #551), slow queries hold connections indefinitely. The stress scenario is designed to expose this.

---

## Running Load Tests Locally

```bash
# Install k6 — https://k6.io/docs/get-started/installation/
# macOS:  brew install k6
# Ubuntu: sudo apt-get install k6

# Start the full stack
docker compose up -d

# Run a single scenario (quick smoke — 30 s sustained)
BASE_URL=http://localhost:3000 k6 run \
  --duration 30s --vus 10 \
  scripts/load-test/list-credits.js

# Run with HTML output
k6 run --out json=results.json scripts/load-test/issue-credits.js
```

---

## Workflow Artifacts

The `load-test.yml` workflow uploads the following artifacts after every run:

| Artifact | Contents |
|---|---|
| `load-test-results` | `*.json` k6 raw metrics + per-scenario summary JSON + `report.html` |

Retention: 30 days.
