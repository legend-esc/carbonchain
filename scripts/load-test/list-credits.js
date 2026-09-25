/**
 * k6 load test — GET /api/v1/credits
 *
 * Scenarios:
 *   sustained  — 100 RPS for 5 minutes (steady-state read throughput baseline)
 *   spike      — ramp from 10 → 500 VUs over 30 s (cache / DB burst tolerance)
 *   stress     — step-up until P95 latency > 1 s or error rate > 1 %
 *
 * Thresholds (CI gate):
 *   http_req_duration p(95) < 500 ms
 *   http_req_failed   rate  < 0.001  (0.1 %)
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 k6 run list-credits.js
 *   k6 run --out json=results/list-credits.json list-credits.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom metrics ───────────────────────────────────────────────────────────
const errorRate = new Rate('list_error_rate');
const p95Latency = new Trend('list_p95_latency', true);

// ── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const JWT_TOKEN = __ENV.JWT_TOKEN || '';
const API_BASE = `${BASE_URL}/api/v1`;

// ── Filter combinations used to simulate realistic traffic patterns ──────────
const FILTER_COMBOS = [
  {},
  { methodology: 'VCS' },
  { methodology: 'REDD+' },
  { geography: 'NG' },
  { vintage_year: '2023' },
  { methodology: 'VCS', geography: 'BR' },
  { methodology: 'Gold Standard', vintage_year: '2022' },
];

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
      startTime: '6m',
      tags: { scenario: 'spike' },
    },
    // Stress test: ramp up arrivals until thresholds are breached
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
    list_error_rate: ['rate<0.001'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function authHeaders() {
  return {
    ...(JWT_TOKEN ? { Authorization: `Bearer ${JWT_TOKEN}` } : {}),
  };
}

function buildQueryString(params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

// ── Default function (one VU iteration) ─────────────────────────────────────
export default function () {
  // Rotate through filter combos to simulate a realistic mix of queries
  const filters = FILTER_COMBOS[__ITER % FILTER_COMBOS.length];
  const qs = buildQueryString(filters);

  const res = http.get(`${API_BASE}/credits${qs}`, {
    headers: authHeaders(),
    tags: { endpoint: 'list_credits' },
  });

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'response is array or object': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body) || (typeof body === 'object' && body !== null);
      } catch {
        return false;
      }
    },
    'latency < 500ms': (r) => r.timings.duration < 500,
  });

  errorRate.add(!ok);
  p95Latency.add(res.timings.duration);

  sleep(0.05);
}
