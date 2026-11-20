/**
 * k6 load test — POST /api/v1/credits/issue
 *
 * Scenarios:
 *   sustained  — 100 RPS for 5 minutes (steady-state throughput baseline)
 *   spike      — ramp from 10 → 500 VUs over 30 s (burst tolerance)
 *   stress     — step-up until P95 latency > 1 s or error rate > 1 %
 *
 * Thresholds (CI gate):
 *   http_req_duration p(95) < 500 ms
 *   http_req_failed   rate  < 0.001  (0.1 %)
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 JWT_TOKEN=<token> k6 run issue-credits.js
 *   k6 run --out json=results/issue-credits.json issue-credits.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom metrics ───────────────────────────────────────────────────────────
const errorRate = new Rate('issue_error_rate');
const p95Latency = new Trend('issue_p95_latency', true);

// ── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JWT_TOKEN = __ENV.JWT_TOKEN || '';
const API_BASE = `${BASE_URL}/api/v1`;

// ── Thresholds (CI gates) ────────────────────────────────────────────────────
export const options = {
  scenarios: {
    // Sustained load: 100 RPS for 5 minutes
    sustained: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      tags: { scenario: 'sustained' },
    },
    // Spike test: ramp from 10 → 500 VUs over 30 s
    spike: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 10 },
      ],
      startTime: '6m', // start after sustained scenario
      tags: { scenario: 'spike' },
    },
    // Stress test: step up until error/latency thresholds are breached
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
      startTime: '10m', // start after spike scenario
      tags: { scenario: 'stress' },
    },
  },
  thresholds: {
    // CI gate — fail if P95 latency exceeds 500 ms
    http_req_duration: ['p(95)<500'],
    // CI gate — fail if error rate exceeds 0.1 %
    http_req_failed: ['rate<0.001'],
    // Custom metrics mirrors for reporting
    issue_error_rate: ['rate<0.001'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function authHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(JWT_TOKEN ? { Authorization: `Bearer ${JWT_TOKEN}` } : {}),
  };
}

function randomMethodology() {
  const methodologies = ['REDD+', 'VCS', 'Gold Standard', 'CDM', 'Plan Vivo'];
  return methodologies[Math.floor(Math.random() * methodologies.length)];
}

function randomVintageYear() {
  return 2020 + Math.floor(Math.random() * 5);
}

// ── Default function (one VU iteration) ─────────────────────────────────────
export default function () {
  const payload = JSON.stringify({
    project_id: `PROJ-LOAD-${__VU}-${__ITER}`,
    vintage_year: randomVintageYear(),
    methodology: randomMethodology(),
    geography: 'NG',
    tonnes: 1000000,
    ipfs_hash: `bafybeik6load${__VU}${__ITER}`,
  });

  const res = http.post(`${API_BASE}/credits/issue`, payload, {
    headers: authHeaders(),
    tags: { endpoint: 'issue_credit' },
  });

  const ok = check(res, {
    'status is 201 or 202': (r) => r.status === 201 || r.status === 202,
    'response has credit_id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return !!body.credit_id || !!body.id;
      } catch {
        return false;
      }
    },
    'latency < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(!ok);
  p95Latency.add(res.timings.duration);

  sleep(0.1);
}
