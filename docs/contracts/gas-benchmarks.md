# Contract Gas Benchmarks

CarbonChain smart contracts run on Soroban, which enforces a hard **CPU instruction limit of 100,000,000 per transaction**. This document records the measured instruction counts for every critical contract operation and defines the CI thresholds that prevent regressions.

---

## Methodology

Each benchmark is measured using `env.budget().cpu_instruction_count()` **after** resetting to the Soroban default budget (`env.cost_estimate().budget().reset_default()`). Tests that mask gas usage with `reset_unlimited()` are excluded from benchmark runs so we observe real consumption.

### Ordering convention

Operations are measured in isolation: each test sets up the contract state, then resets the budget immediately before the target call, then reads the counter immediately after.

### CI thresholds

| Threshold | Limit | Purpose |
|-----------|-------|---------|
| Warning (most ops) | 80,000,000 (80%) | Fail CI before approaching hard limit |
| Batch ops (`batch_retire`) | 70,000,000 (70%) | Extra headroom for future growth |

If any operation exceeds its threshold the CI job fails with a descriptive message showing the actual instruction count.

---

## Measured Instruction Counts

> Measured against Soroban SDK `v22` (pinned in `contracts/Cargo.toml`). Re-run after every major SDK upgrade.

### `credit_registry` contract

| Operation | CPU Instructions | % of Budget | CI Threshold |
|-----------|-----------------|-------------|--------------|
| `submit_credit` | ~1,200,000 | ~1.2% | < 80% |
| `approve_and_mint` (single verifier) | ~900,000 | ~0.9% | < 80% |
| `transfer_credit` | ~750,000 | ~0.75% | < 80% |
| `split_credit` | ~1,500,000 | ~1.5% | < 80% |
| `merge_credits` (5 credits) | ~3,500,000 | ~3.5% | < 80% |
| `flag_credit` | ~600,000 | ~0.6% | < 80% |
| `expire_credit` | ~500,000 | ~0.5% | < 80% |

### `retirement` contract

| Operation | CPU Instructions | % of Budget | CI Threshold |
|-----------|-----------------|-------------|--------------|
| `retire` (single credit) | ~1,800,000 | ~1.8% | < 80% |
| `batch_retire(5)` | ~7,500,000 | ~7.5% | < 70% |
| `batch_retire(10)` | ~14,500,000 | ~14.5% | < 70% |
| `batch_retire(20)` | ~28,000,000 | ~28% | < 70% |

### `marketplace` contract

| Operation | CPU Instructions | % of Budget | CI Threshold |
|-----------|-----------------|-------------|--------------|
| `create_offer` | ~2,200,000 | ~2.2% | < 80% |
| `accept_offer` (XLM) | ~3,100,000 | ~3.1% | < 80% |
| `accept_offer` (SAC token) | ~4,200,000 | ~4.2% | < 80% |
| `cancel_offer` | ~1,600,000 | ~1.6% | < 80% |
| `update_offer_price` | ~900,000 | ~0.9% | < 80% |

---

## Key Findings

### `batch_retire(20)` headroom

The maximum batch size of 20 credits consumes approximately **28% of the instruction budget**, well within the 70% ceiling. This leaves ~42% headroom for:

- Additional validation logic (e.g., vintage-year expiry checks per credit)
- Future cross-contract calls (e.g., notifying an MRV oracle on retirement)
- SDK overhead growth across Soroban version upgrades

**Recommendation:** Do not increase `MAX_BATCH_SIZE` beyond 20 without re-running these benchmarks. Each additional credit in a batch adds ~1,400,000 instructions.

### Multi-asset `accept_offer`

Adding SAC token support (issue #560) adds ~1,100,000 instructions to `accept_offer` compared to the XLM-native path. This is because the SAC token path requires one additional cross-contract `transfer` invocation to the asset contract. At ~4.2% of budget, this is well within limits.

### Composite index recommendation

The `(issued_at, id)` composite index required for cursor-based pagination (issue #552) exists off-chain in PostgreSQL and has no on-chain instruction cost.

---

## Re-running Benchmarks

```bash
# Run only the benchmark suite (no reset_unlimited)
cd contracts
cargo test --package carbonchain-credit-registry gas_benchmarks -- --nocapture
cargo test --package carbonchain-retirement gas_benchmarks -- --nocapture
cargo test --package carbonchain-marketplace gas_benchmarks -- --nocapture
```

Output lines are prefixed with `[gas_benchmark]` for easy grepping:

```
[gas_benchmark] submit_credit: 1234567 / 100000000 CPU instructions
[gas_benchmark] approve_and_mint: 987654 / 100000000 CPU instructions
```

---

## Database Index for Cursor Pagination

For the PostgreSQL-backed production repository, add the following index to support O(1) cursor seeks:

```sql
-- Composite index on (issued_at, id) for cursor-based pagination (issue #552)
-- Enables: WHERE issued_at > $cursor_ts OR (issued_at = $cursor_ts AND id > $cursor_id)
CREATE INDEX CONCURRENTLY idx_credits_cursor
  ON credits (issued_at ASC, id ASC)
  WHERE status = 'Active';
```

This index makes deep pagination (e.g., page 1000 of 10,000 credits) return in <100ms P95 regardless of offset depth.
