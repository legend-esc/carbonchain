/**
 * k6 load test — POST /api/v1/credits/:id/retire
 *
 * Scenarios:
 *   sustained  — 100 RPS for 5 minutes
 *   spike      — ramp from 10 → 500 VUs over 30 s
 *   stress     — step-up until P95 latency > 1 s or error rate > 1 %
 *
 * Thresholds (CI gate):
 *   http_req_duration p(95) < 500 ms
 *   http_req_failed   rate  < 0.001  (0.1 %)
 *
 * NOTE: Retirement is irreversible on-chain.  This script targets the API
 * request path (auth, validation, Stellar transaction building) and is
 * designed to run against testnet with disposable credits from a setup phase.
 * CREDIT_IDS env var should be a comma-separated list of pre-minted credit IDs.
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 JWT_TOKEN=<token> \
 *     CREDIT_IDS=id1,id2,id3 k6 run retire-credit.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom metrics ───────────────────────────────────────────────────────────
const errorRate = new Rate('retire_error_rate');
const p95Latency = new Trend('retire_p95_latency', true);

// ── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JWT_TOKEN = __ENV.JWT_TOKEN || '';
const API_BASE = `${BASE_URL}/api/v1`;

// Pre-seeded credit IDs to retire — passed via environment variable.
// In CI the setup job should provision these and pass them in.
const CREDIT_IDS = (__ENV.CREDIT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Fallback synthetic IDs (API will return 404 — counted in error rate)
const FALLBACK_IDS = Array.from({ length: 20 }, (_, i) => `load-test-credit-${i}`);
const ids = CREDIT_IDS.length > 0 ? CREDIT_IDS : FALLBACK_IDS;

// ── Thresholds (CI gates) ────────────────────────────────────────────────────
export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { scenario: 'sustained' },
    },
    spike: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 10 },
      ],
      startTime: '6m',
      tags: { scenario: 'spike' },
    },
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      stages: [
        { duration: '1m', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '1m', target: 200 },
        { duration: '1m', target: 400 },
        { duration: '1m', target: 600 },
      ],
      preAllocatedVUs: 100,
      maxVUs: 600,
      startTime: '10m',
      tags: { scenario: 'stress' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
    retire_error_rate: ['rate<0.001'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function authHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(JWT_TOKEN ? { Authorization: `Bearer ${JWT_TOKEN}` } : {}),
  };
}

// ── Default function (one VU iteration) ─────────────────────────────────────
export default function () {
  const creditId = ids[__ITER % ids.length];

  const payload = JSON.stringify({
    reason: `Load test retirement — VU ${__VU} iter ${__ITER}`,
  });

  const res = http.post(`${API_BASE}/credits/${creditId}/retire`, payload, {
    headers: authHeaders(),
    tags: { endpoint: 'retire_credit' },
  });

  // Accepted status codes: 200 (OK), 201 (Created), 409 (AlreadyRetired — expected
  // for repeated calls on the same credit under load).
  const ok = check(res, {
    'status is 200, 201 or 409': (r) =>
      r.status === 200 || r.status === 201 || r.status === 409,
    'not a 5xx error': (r) => r.status < 500,
    'latency < 500ms': (r) => r.timings.duration < 500,
  });

  // Only count 5xx responses as errors; 409 is an expected business-logic outcome.
  errorRate.add(res.status >= 500);
  p95Latency.add(res.timings.duration);

  sleep(0.1);
}
