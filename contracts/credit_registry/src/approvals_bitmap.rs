//! Bitmap-based verifier approval tracking (additive, not yet wired in).
//!
//! DataKey::CreditApprovals(credit_id) currently stores a `Vec<Address>` of every
//! verifier who approved a credit. With 50 registered verifiers this Vec can grow
//! to ~1.6KB per credit, and membership checks in `approve_and_mint` are O(n).
//!
//! This module provides a drop-in replacement storage shape: a `u64` bitmap where
//! bit `i` represents the verifier at index `i` in the registry's verifier list
//! (see `storage::get_verifiers`). 50 verifiers fit in 8 bytes instead of 1.6KB,
//! and approval checks/inserts become O(1) bit operations.
//!
//! To adopt: replace `DataKey::CreditApprovals(BytesN<32>) -> Vec<Address>` reads/
//! writes in `approve_and_mint` with the helpers below, resolving each verifier's
//! index via `get_verifiers(env).iter().position(...)`.

use soroban_sdk::{Address, Env, Vec};

/// Returns true if the verifier at `index` has already approved.
pub fn has_approved(bitmap: u64, index: u32) -> bool {
    debug_assert!(index < 64);
    (bitmap & (1u64 << index)) != 0
}

/// Returns a new bitmap with the verifier at `index` marked as approved.
pub fn set_approved(bitmap: u64, index: u32) -> u64 {
    debug_assert!(index < 64);
    bitmap | (1u64 << index)
}

/// Number of verifiers who have approved so far.
pub fn approval_count(bitmap: u64) -> u32 {
    bitmap.count_ones()
}

/// Finds the index of `verifier` within the registry's verifier list.
pub fn verifier_index(env: &Env, verifiers: &Vec<Address>, verifier: &Address) -> Option<u32> {
    let _ = env;
    verifiers.iter().position(|v| v == *verifier).map(|i| i as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bitmap_set_and_check() {
        let bm = 0u64;
        assert!(!has_approved(bm, 3));
        let bm = set_approved(bm, 3);
        assert!(has_approved(bm, 3));
        assert_eq!(approval_count(bm), 1);
        let bm = set_approved(bm, 10);
        assert_eq!(approval_count(bm), 2);
    }
}
