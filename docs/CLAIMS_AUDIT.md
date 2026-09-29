# Claims Audit — IMPLEMENTATION_SUMMARY.md

**Audit date:** 2026-09-29
**Audited by:** Issue #979 automated documentation review

This document records the evidence audit performed against every issue-linked claim in
`IMPLEMENTATION_SUMMARY.md`. It also provides guidance for contributors.

---

## Contributor Guidance

### Rule: Every ✅ must cite a file

Every line in `IMPLEMENTATION_SUMMARY.md` that carries a ✅ (done) marker **must** include
a `(see path/to/file)` citation on the **same line**. For example:

```
## Issue #97: MRV Data Aggregation ✅ (see `contracts/mrv_oracle/src/lib.rs`)
```

A ✅ line without a `(see ...)` citation will cause the `docs-drift` CI job to fail.

### When a feature is not yet implemented

Mark the entry with `⚠️ **Not Yet Implemented**` and add a note pointing to the roadmap.
The `docs-drift` CI job will print these as advisory warnings so reviewers see what is
outstanding.

Example:

```
## Issue #96: Marketplace Fee Collection

⚠️ **Not Yet Implemented** — Described in this summary but code not found — see Roadmap Phase 3
```

### Where aspirational claims belong

Claims for features that are planned but not yet coded belong in the **Roadmap** section of
`README.md`, not in `IMPLEMENTATION_SUMMARY.md`. Move them there and open a GitHub issue to
track the implementation work.

---

## Audit Results (2026-09-29)

| Issue | Claimed Feature | Evidence Found | Status |
|-------|-----------------|----------------|--------|
| #96 | Marketplace Fee Collection (`fee_bps`, `fee_recipient`, `update_fee`, fee deduction in `buy_offer`) | `initialize()` takes `admin, min_price_per_tonne, registry_id, token_id` — no fee params. `buy_offer()` transfers full price directly to seller with no deduction. No `update_fee` function exists. | ⚠️ Not implemented — moved to ⚠️ in summary; see Roadmap Phase 3 |
| #97 | MRV Data Aggregation (`get_mrv_aggregate`) | Function found in `contracts/mrv_oracle/src/lib.rs`; two passing tests confirm behaviour. | ✅ Implemented |
| #98 | Soroban Events Indexer (NestJS `EventsService`) | Module directory `api/src/events/` exists with `events.service.ts`, `events.controller.ts`, `events.module.ts`, `events.service.spec.ts`. | ✅ Implemented |
| #99 | Webhook Delivery (`WebhooksService`) | Module directory `api/src/webhooks/` exists with `webhooks.service.ts`, `webhooks.controller.ts`, `webhooks.module.ts`, `webhooks.service.spec.ts`, `webhooks.controller.spec.ts`. | ✅ Implemented |

---

## Additional Finding: Marketplace "Stellar DEX integration" language

Several places in the codebase (README.md, `contracts/marketplace` description) used language
implying that the marketplace integrates with the native Stellar DEX (path-payment or
manage-offer operations). Inspection of `contracts/marketplace/src/lib.rs` shows the contract
is a **self-contained on-chain offer book** (`create_offer` / `buy_offer`) with no Stellar DEX
cross-contract calls.

**Action taken (2026-09-29):**
- `README.md` line 13: Changed "Stellar DEX integration for liquid secondary market trading" →
  "On-chain offer-book marketplace for secondary market trading (Stellar DEX AMM integration is
  a Phase 3 roadmap item)"
- `README.md` line 102: Changed "Native Stellar DEX listings" → "On-chain offer-book listings"

---

## Re-audit Instructions

To re-verify this audit at any time:

```bash
# 1. Check fee collection is absent from marketplace
grep -r 'fee_bps\|fee_recipient\|fee_collection' contracts/marketplace/

# 2. Confirm get_mrv_aggregate exists
grep -r 'get_mrv_aggregate' contracts/mrv_oracle/

# 3. Confirm events service exists
ls api/src/events/

# 4. Confirm webhooks service exists
ls api/src/webhooks/

# 5. Simulate the docs-drift CI check
grep -n '✅' IMPLEMENTATION_SUMMARY.md | grep -v '(see ' \
  && echo 'FOUND UNCITED CLAIMS - CI would fail' \
  || echo 'All claims cited - CI would pass'
```

---

## Related Files

- `IMPLEMENTATION_SUMMARY.md` — the document audited by this file
- `FEATURES_IMPLEMENTED.md` — summary of issues #84–87 (not audited here; see separate review)
- `.github/workflows/ci.yml` — contains `docs-drift` job that enforces citation rules
- `README.md` — Roadmap section for aspirational claims
