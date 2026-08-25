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