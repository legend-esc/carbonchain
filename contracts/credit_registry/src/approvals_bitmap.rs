use soroban_sdk::{Env, BytesN, Vec};

pub fn get_approvals_bitmap(env: &Env, credit_id: &BytesN<32>) -> Vec<u64> {
    env.storage()
        .persistent()
        .get(&crate::types::DataKey::CreditApprovals(credit_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_approvals_bitmap(env: &Env, credit_id: &BytesN<32>, bitmap: &Vec<u64>) {
    let key = crate::types::DataKey::CreditApprovals(credit_id.clone());
    env.storage().persistent().set(&key, bitmap);
    env.storage().persistent().extend_ttl(&key, crate::storage::TTL_THRESHOLD, crate::storage::MIN_TTL);
}

pub fn has_approved(bitmap: &Vec<u64>, verifier_id: u32) -> bool {
    let word_idx = (verifier_id / 64) as usize;
    let bit_idx = verifier_id % 64;
    if word_idx >= bitmap.len() {
        return false;
    }
    let word = bitmap.get(word_idx).unwrap_or(&0);
    (word & (1u64 << bit_idx)) != 0
}

pub fn mark_approved(env: &Env, credit_id: &BytesN<32>, verifier_id: u32) {
    let mut bitmap = get_approvals_bitmap(env, credit_id);
    let word_idx = (verifier_id / 64) as usize;
    let bit_idx = verifier_id % 64;
    while bitmap.len() <= word_idx {
        bitmap.push_back(0);
    }
    let mut word = bitmap.get(word_idx).unwrap_or(&0);
    word |= 1u64 << bit_idx;
    bitmap.set(word_idx, word);
    set_approvals_bitmap(env, credit_id, &bitmap);
}

pub fn clear_approvals(env: &Env, credit_id: &BytesN<32>) {
    crate::storage::remove_credit_approvals(env, credit_id);
}

pub fn count_approvals(bitmap: &Vec<u64>) -> u32 {
    let mut count: u32 = 0;
    for word in bitmap.iter() {
        count += word.count_ones();
    }
    count
}
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
