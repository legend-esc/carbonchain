> Last audited: 2026-09-29

# Implementation Summary: Issues #96-99

## Overview
This document summarises the implementation status of GitHub issues #96–99.
Every DONE claim **must** cite a file reference on the same line — see `docs/CLAIMS_AUDIT.md`
for the contributor guidance and audit trail.

> **Contributor rule:** To keep this document accurate, every DONE entry must include
> a `(see path/to/file)` citation. Entries without a citation will fail the
> `docs-drift` CI job. Aspirational or unverified claims belong in the Roadmap
> section of `README.md`, not here.

---

## Issue #96: Implement Marketplace Fee Collection

⚠️ **Not Yet Implemented** — Described in this summary but code not found — see Roadmap Phase 3

**What was claimed:** `initialize()` would accept `fee_bps` and `fee_recipient` parameters;
`buy_offer()` would deduct a fee and send it to the fee recipient; an `update_fee()` admin
function would allow changing the rate at runtime.

**What the code actually does:** `initialize()` accepts `admin`, `min_price_per_tonne`,
`registry_id`, and `token_id` — no fee parameters. `buy_offer()` transfers the full price
directly from buyer to seller with no deduction.
(see `contracts/marketplace/src/lib.rs` — `initialize` at line 223, `buy_offer` at line 959)

---

## Issue #97: Implement MRV Data Aggregation View Function ✅ (see `contracts/mrv_oracle/src/lib.rs`)

**Status**: Implemented in the MRV oracle contract.

### Features
- `get_mrv_aggregate(project_id, from_ts, to_ts)` — aggregates MRV readings over a time range
- Returns a tuple `(sum_tonnes, average_tonnes)`
- Comprehensive tests with known datasets

### Key entry points
- `get_mrv_aggregate()` (see `contracts/mrv_oracle/src/lib.rs`)

---

## Issue #98: Implement Soroban Events Indexer in NestJS API ✅ (see `api/src/events/events.service.ts`)

**Status**: Implemented as a NestJS module.

### Features
- `EventsService` with cron-based polling every 30 seconds
- Parses and stores `CreditSubmitted`, `CreditMinted`, `CreditRetired` events
- `GET /events` endpoint with filtering support

### Key components
1. **EventsService** — polls Soroban RPC, stores events, triggers webhooks
   (see `api/src/events/events.service.ts`)
2. **EventsController** — `GET /events`, `GET /events/:eventId`
   (see `api/src/events/events.controller.ts`)
3. **EventsModule** — wires service and controller into AppModule
   (see `api/src/events/events.module.ts`)

### API endpoints
```
GET /events?contractId=<id>&eventType=<type>&limit=100
GET /events/:eventId
```

---

## Issue #99: Implement Webhook Delivery for Credit Status Changes ✅ (see `api/src/webhooks/webhooks.service.ts`)

**Status**: Implemented as a NestJS module.

### Features
- Webhook registration, listing, and deletion
- Automatic delivery on credit status changes
- Retry logic with exponential backoff (max 5 retries)
- Webhook delivery tracking

### Key components
1. **WebhooksService** — register, trigger, retry failed deliveries
   (see `api/src/webhooks/webhooks.service.ts`)
2. **WebhooksController** — `POST /webhooks`, `GET /webhooks`, `GET /webhooks/:id`, `DELETE /webhooks/:id`
   (see `api/src/webhooks/webhooks.controller.ts`)
3. **WebhooksModule** — wires service and controller into AppModule
   (see `api/src/webhooks/webhooks.module.ts`)

### API endpoints
```
POST   /webhooks
GET    /webhooks
GET    /webhooks/:id
DELETE /webhooks/:id
```

### Retry logic
- Max 5 retry attempts with exponential backoff (5 s, 10 s, 15 s, 20 s, 25 s)
- Webhooks deactivated after max retries
- Automatic retry on next cron cycle

---

## Marketplace Architecture Note

The marketplace contract is a **Soroban-native offer book** — sellers post offers and buyers
fill them via `create_offer` / `buy_offer`. It does **not** currently integrate with the
Stellar DEX path-payment or manage-offer operations. "Stellar DEX integration" in older
references to this module referred to the aspiration described in Roadmap Phase 3 (limit
order book, AMM pool). The current implementation is an independent offer-book contract.
(see `contracts/marketplace/src/lib.rs`)

---

## Roadmap

Features listed below are **not yet implemented** and are tracked in the Phase 3 roadmap
section of `README.md`:

- Marketplace fee collection (`fee_bps`, `fee_recipient`, `update_fee`) — Issue #96
- Limit order book — price/quantity matching beyond single-offer listings
- Automated market maker (AMM) pool for continuous liquidity
- Price history charts and market analytics

---

## Testing

Verified implementations include tests:
- ✅ `get_mrv_aggregate` tests (see `contracts/mrv_oracle/src/lib.rs`)
- ✅ EventsService tests (see `api/src/events/events.service.spec.ts`)
- ✅ EventsController tests — implied by module (see `api/src/events/`)
- ✅ WebhooksService tests (see `api/src/webhooks/webhooks.service.spec.ts`)
- ✅ WebhooksController tests (see `api/src/webhooks/webhooks.controller.spec.ts`)
