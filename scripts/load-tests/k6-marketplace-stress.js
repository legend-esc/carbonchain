/**
 * k6 E2E stress test — Marketplace high-concurrency order placement (#1376)
 *
 * Simulates 50 virtual users concurrently fetching active marketplace offers
 * and calling transaction build / quote endpoints over a 5-minute ramp-up.
 *
 * Endpoints exercised:
 *   1. GET  /api/v1/marketplace/listings
 *   2. POST /api/v1/marketplace/offers/:id/quote
 *   3. GET  /api/v1/marketplace/offer/:id/xdr?buyerPublicKey=... (when JWT_TOKEN set)
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 k6 run scripts/load-tests/k6-marketplace-stress.js
 *   BASE_URL=http://localhost:3000 JWT_TOKEN=<token> BUYER_PUBLIC_KEY=<G...> k6 run scripts/load-tests/k6-marketplace-stress.js
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ── Custom metrics ───────────────────────────────────────────────────────────
const listingsErrorRate = new Rate('marketplace_listings_error_rate');
const buildTxErrorRate = new Rate('marketplace_build_tx_error_rate');
const listingsLatency = new Trend('marketplace_listings_latency', true);
const buildTxLatency = new Trend('marketplace_build_tx_latency', true);

// ── Configuration ────────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const API_BASE = `${BASE_URL}/api/v1`;
const JWT_TOKEN = __ENV.JWT_TOKEN || '';
const BUYER_PUBLIC_KEY =
  __ENV.BUYER_PUBLIC_KEY ||
  'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const FALLBACK_OFFER_ID = __ENV.OFFER_ID || '1';

// ── 5-minute ramp-up to 50 concurrent VUs ────────────────────────────────────
export const options = {
  scenarios: {
    marketplace_order_stress: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '5m', target: 50 }, // 5-minute ramp-up to 50 VUs
        { duration: '2m', target: 50 }, // hold peak concurrency
        { duration: '30s', target: 0 }, // graceful ramp-down
      ],
      gracefulRampDown: '30s',
      tags: { scenario: 'marketplace_stress' },
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
    marketplace_listings_error_rate: ['rate<0.01'],
    marketplace_build_tx_error_rate: ['rate<0.01'],
  },
};

function requestHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(JWT_TOKEN ? { Authorization: `Bearer ${JWT_TOKEN}` } : {}),
  };
}

export default function () {
  let selectedOfferId = FALLBACK_OFFER_ID;

  // ── 1. Fetch active marketplace listings ───────────────────────────────────
  group('fetch_active_offers', () => {
    const res = http.get(`${API_BASE}/marketplace/listings?limit=20`, {
      headers: requestHeaders(),
      tags: { endpoint: 'marketplace_listings' },
    });

    let parsedBody = null;
    try {
      parsedBody = JSON.parse(res.body);
    } catch {
      parsedBody = null;
    }

    const ok = check(res, {
      'listings status is 200': (r) => r.status === 200,
      'listings payload has data array': () =>
        parsedBody !== null && Array.isArray(parsedBody.data),
    });

    listingsErrorRate.add(!ok);
    listingsLatency.add(res.timings.duration);

    if (parsedBody && Array.isArray(parsedBody.data) && parsedBody.data.length > 0) {
      const idx = (__VU + __ITER) % parsedBody.data.length;
      const candidate = parsedBody.data[idx];
      if (candidate && candidate.id !== undefined) {
        selectedOfferId = String(candidate.id);
      }
    }
  });

  // ── 2. Call transaction build / quote endpoints concurrently ───────────────
  group('build_buy_transaction', () => {
    const quoteRes = http.post(
      `${API_BASE}/marketplace/offers/${encodeURIComponent(selectedOfferId)}/quote`,
      JSON.stringify({ accountId: BUYER_PUBLIC_KEY }),
      {
        headers: requestHeaders(),
        tags: { endpoint: 'marketplace_quote' },
      },
    );

    const quoteOk = check(quoteRes, {
      'quote status is 200 or 404': (r) => r.status === 200 || r.status === 404,
      'quote latency < 500ms': (r) => r.timings.duration < 500,
    });

    buildTxErrorRate.add(!quoteOk);
    buildTxLatency.add(quoteRes.timings.duration);

    if (JWT_TOKEN) {
      const xdrRes = http.get(
        `${API_BASE}/marketplace/offer/${encodeURIComponent(selectedOfferId)}/xdr?buyerPublicKey=${encodeURIComponent(BUYER_PUBLIC_KEY)}`,
        {
          headers: requestHeaders(),
          tags: { endpoint: 'marketplace_build_xdr' },
        },
      );

      const xdrOk = check(xdrRes, {
        'xdr status is 200 or 404': (r) => r.status === 200 || r.status === 404,
        'xdr latency < 500ms': (r) => r.timings.duration < 500,
      });

      buildTxErrorRate.add(!xdrOk);
      buildTxLatency.add(xdrRes.timings.duration);
    }
  });

  sleep(0.2);
}
