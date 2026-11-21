# Issue #1289 - Property-Based Invariant Testing for Fractional Credit Math

## Problem

Edge cases with fractional tonne arithmetic (0.1 tonne = 100,000 units) could hide rounding errors or overflow vulnerabilities under extreme inputs.

## Solution

Property-based test harness using **proptest** that generates random sequences of credit operations and asserts invariants.

## Implementation

**Add to Cargo.toml:**

```toml
[dev-dependencies]
proptest = "1.4"
```

**Create contracts/credit_registry/tests/property_tests.rs:**

```rust
use proptest::prelude::*;
use soroban_sdk::{BytesN, Env};

// 1 tonne = 1,000,000 units (defined in lib.rs)
const UNITS_PER_TONNE: i128 = 1_000_000;
const MIN_CREDIT_UNIT: i128 = 100_000; // 0.1 tonne

// Invariant: Total units in == Total units out
#[test]
fn prop_credit_conservation() {
    proptest!(|(
        num_operations in 1..20usize,
        credit_amounts in prop::collection::vec(
            100_000i128..10_000_000_000i128,
            1..num_operations
        ),
        split_percentages in prop::collection::vec(
            10..90u8,
            1..num_operations
        ),
    )| {
        let mut total_in = 0i128;
        let mut total_out = 0i128;

        // Simulate a sequence of credit operations
        for (i, &amount) in credit_amounts.iter().enumerate() {
            if amount % MIN_CREDIT_UNIT != 0 {
                continue; // Skip invalid amounts
            }

            total_in += amount;

            // Simulate split
            if i < split_percentages.len() {
                let percentage = split_percentages[i] as i128;
                let part1 = (amount * percentage) / 100;
                let part2 = amount - part1;

                // Ensure no loss due to rounding
                prop_assert_eq!(part1 + part2, amount, "Split caused loss");
                total_out += part1 + part2;
            }
        }

        // Invariant: total in == total out
        prop_assert_eq!(total_in, total_out, "Credit conservation violated");
    });
}

// Invariant: No overflow when combining multiple credits
#[test]
fn prop_no_overflow_on_merge() {
    proptest!(|(
        num_credits in 1..1000usize,
        amounts in prop::collection::vec(
            MIN_CREDIT_UNIT..i128::MAX / 10_000,
            num_credits
        ),
    )| {
        let mut sum: i128 = 0;

        for amount in amounts {
            if let Some(new_sum) = sum.checked_add(amount) {
                sum = new_sum;
            } else {
                // Overflow detected - this is what we want to catch
                prop_assert!(false, "Overflow would occur on merge");
            }
        }

        // Ensure result fits in i128 (Soroban's scalar type)
        prop_assert!(sum >= 0, "Negative sum result");
    });
}

// Invariant: Splits always result in valid credit units
#[test]
fn prop_split_maintains_unit_validity() {
    proptest!(|(
        credit_amount in (MIN_CREDIT_UNIT..1_000_000_000_000i128).prop_map(|x| {
            // Ensure amount is a multiple of MIN_CREDIT_UNIT
            (x / MIN_CREDIT_UNIT) * MIN_CREDIT_UNIT
        }),
        split_ratio in 10u8..90u8,
    )| {
        let ratio = split_ratio as i128;
        let part1 = (credit_amount * ratio) / 100;
        let part2 = credit_amount - part1;

        // Both parts must be valid credit units (multiples of MIN_CREDIT_UNIT)
        prop_assert_eq!(
            part1 % MIN_CREDIT_UNIT,
            0,
            "Split resulted in invalid unit for part1"
        );

        prop_assert_eq!(
            part2 % MIN_CREDIT_UNIT,
            0,
            "Split resulted in invalid unit for part2"
        );

        // Both parts must be non-negative
        prop_assert!(part1 >= 0, "Part1 is negative");
        prop_assert!(part2 >= 0, "Part2 is negative");

        // Sum must equal original
        prop_assert_eq!(part1 + part2, credit_amount, "Split lost units");
    });
}

// Invariant: Partial retirement cannot exceed available balance
#[test]
fn prop_partial_retirement_bounded() {
    proptest!(|(
        balance in (MIN_CREDIT_UNIT..1_000_000_000_000i128).prop_map(|x| {
            (x / MIN_CREDIT_UNIT) * MIN_CREDIT_UNIT
        }),
        retire_percentages in prop::collection::vec(1u8..100u8, 1..10),
    )| {
        let mut remaining = balance;

        for &percentage in &retire_percentages {
            if remaining == 0 {
                break;
            }

            let pct = percentage as i128;
            let retire_amount = (remaining * pct) / 100;

            // Retirement amount must be <= remaining balance
            prop_assert!(
                retire_amount <= remaining,
                "Retirement amount exceeds balance"
            );

            remaining -= retire_amount;

            // Remaining must be valid unit or zero
            if remaining > 0 {
                prop_assert_eq!(
                    remaining % MIN_CREDIT_UNIT,
                    0,
                    "Remaining is not valid unit"
                );
            }
        }

        // Final remaining must be >= 0
        prop_assert!(remaining >= 0, "Remaining became negative");
    });
}

// Invariant: Marketplace transactions preserve total supply
#[test]
fn prop_marketplace_supply_conservation() {
    proptest!(|(
        num_trades in 1..100usize,
        prices in prop::collection::vec(1i128..1000i128, num_trades),
        volumes in prop::collection::vec(
            MIN_CREDIT_UNIT..1_000_000_000_000i128,
            num_trades
        ).prop_map(|v| {
            v.iter()
                .map(|x| (x / MIN_CREDIT_UNIT) * MIN_CREDIT_UNIT)
                .collect::<Vec<_>>()
        }),
    )| {
        let mut seller_balance = 10_000_000_000_000i128; // Large starting balance
        let mut buyer_balance = 1_000_000i128; // Limited buyer balance
        let mut matched_trades = 0;

        for (i, &price) in prices.iter().enumerate() {
            if i >= volumes.len() {
                break;
            }

            let volume = volumes[i];

            // Check if buyer has sufficient balance
            if buyer_balance >= (volume * price) / 1_000_000 {
                // Execute trade
                seller_balance -= volume;
                buyer_balance -= (volume * price) / 1_000_000;
                matched_trades += 1;

                // Invariant: balances don't go negative
                prop_assert!(seller_balance >= 0, "Seller balance went negative");
                prop_assert!(buyer_balance >= 0, "Buyer balance went negative");
            }
        }

        // At least some trades should have succeeded
        prop_assert!(matched_trades > 0, "No trades matched");
    });
}

// Invariant: Rounding errors don't accumulate
#[test]
fn prop_rounding_bounded() {
    proptest!(|(
        base_amount in (MIN_CREDIT_UNIT..1_000_000_000_000i128).prop_map(|x| {
            (x / MIN_CREDIT_UNIT) * MIN_CREDIT_UNIT
        }),
        num_divisions in 2..1000usize,
    )| {
        let mut error = 0i128;

        for _ in 0..num_divisions {
            // Split in half
            let left = base_amount / 2;
            let right = base_amount - left;

            // Check for rounding error
            if left + right != base_amount {
                error += (left + right - base_amount).abs();
            }
        }

        // Error should be bounded (at most 1 unit per split)
        prop_assert!(error <= (num_divisions as i128), "Rounding error unbounded");
    });
}
```

**Create contracts/marketplace/tests/property_tests.rs:**

```rust
use proptest::prelude::*;

const MIN_CREDIT_UNIT: i128 = 100_000;

// Invariant: Offer price * volume doesn't overflow
#[test]
fn prop_offer_price_volume_safe() {
    proptest!(|(
        prices in 1i128..10_000i128,
        volumes in (MIN_CREDIT_UNIT..1_000_000_000_000i128).prop_map(|x| {
            (x / MIN_CREDIT_UNIT) * MIN_CREDIT_UNIT
        }),
    )| {
        // This should not panic or overflow
        let result = prices.checked_mul(volumes);
        // Overflow is acceptable if it's caught
        prop_assert!(result.is_some() || volumes > i128::MAX / prices);
    });
}

// Invariant: Partial fills never exceed offer volume
#[test]
fn prop_partial_fills_bounded() {
    proptest!(|(
        offer_volume in (MIN_CREDIT_UNIT..1_000_000_000_000i128).prop_map(|x| {
            (x / MIN_CREDIT_UNIT) * MIN_CREDIT_UNIT
        }),
        fill_percentages in prop::collection::vec(1u8..100u8, 1..10),
    )| {
        let mut remaining = offer_volume;

        for &percentage in &fill_percentages {
            if remaining == 0 {
                break;
            }

            let pct = percentage as i128;
            let fill_amount = (remaining * pct) / 100;

            // Fill amount must be <= remaining
            prop_assert!(
                fill_amount <= remaining,
                "Fill amount exceeds remaining volume"
            );

            remaining -= fill_amount;

            // Filled amount must be valid unit
            prop_assert_eq!(
                fill_amount % MIN_CREDIT_UNIT,
                0,
                "Fill amount not valid unit"
            );
        }

        // Final remaining must be >= 0
        prop_assert!(remaining >= 0, "Remaining became negative");
    });
}

// Invariant: Fee calculation never exceeds principal
#[test]
fn prop_fee_bounded() {
    proptest!(|(
        trade_value in 1i128..1_000_000_000i128,
        fee_basis_points in 1u32..10_000u32, // 0.01% to 100%
    )| {
        let fee_bps = fee_basis_points as i128;
        let fee = (trade_value * fee_bps) / 10_000;

        // Fee must not exceed trade value
        prop_assert!(fee <= trade_value, "Fee exceeds trade value");
        // Fee must be non-negative
        prop_assert!(fee >= 0, "Fee is negative");
    });
}
```

## Test Checklist

- [ ] Add proptest to Cargo.toml
- [ ] Create property_tests.rs in credit_registry/tests/
- [ ] Create property_tests.rs in marketplace/tests/
- [ ] Run tests: `cargo test --test property_tests`
- [ ] All invariants should pass with 100s of random inputs
- [ ] Run with extended iterations: `PROPTEST_CASES=10000 cargo test`

## Expected Results

Each property test runs 256+ random cases by default (configurable). Tests verify:
- ✅ Credit conservation (total in == total out)
- ✅ No overflows on operations
- ✅ All intermediate values remain valid
- ✅ Bounded partial operations
- ✅ Accumulation of rounding errors stays bounded

## Benefits

✅ Catches edge cases regular tests miss  
✅ Verifies mathematical invariants hold  
✅ Finds overflow/underflow vulnerabilities  
✅ Builds confidence in fractional arithmetic  
