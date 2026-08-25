use crate::types::{
    AuditLogEntry, CreditMetadata, DataKey, Methodology, ServiceType, Session, UnbondingRequest,
    VerifierReputation,
};
use soroban_sdk::{Address, BytesN, Env, String, Vec};

/// Minimum TTL in ledgers (~1 year at 5s/ledger).
pub const MIN_TTL: u32 = 6_307_200;
/// Threshold below which TTL is extended (half of MIN_TTL).
pub const TTL_THRESHOLD: u32 = MIN_TTL / 2;

pub fn set_version(env: &Env, version: u32) {
    env.storage().instance().set(&DataKey::Version, &version);
}

pub fn get_version(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::Version).unwrap_or(0)
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

pub fn has_admin(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Admin)
}

pub fn set_credit(env: &Env, id: &BytesN<32>, metadata: &CreditMetadata) {
    let key = DataKey::Credit(id.clone());
    env.storage().persistent().set(&key, metadata);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_credit(env: &Env, id: &BytesN<32>) -> Option<CreditMetadata> {
    env.storage().persistent().get(&DataKey::Credit(id.clone()))
}

pub fn get_verifiers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::VerifierSet)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_verifiers(env: &Env, verifiers: &Vec<Address>) {
    env.storage()
        .instance()
        .set(&DataKey::VerifierSet, verifiers);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, MIN_TTL);
}

pub fn is_verifier(env: &Env, verifier: &Address) -> bool {
    get_verifiers(env).contains(verifier)
}

/// Append a credit id to the per-project index.
pub fn add_credit_to_project(env: &Env, project_id: &String, credit_id: &BytesN<32>) {
    let key = DataKey::ProjectCredits(project_id.clone());
    let mut list: Vec<BytesN<32>> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    list.push_back(credit_id.clone());
    env.storage().persistent().set(&key, &list);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_credits_by_project(env: &Env, project_id: &String) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::ProjectCredits(project_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn get_credit_by_project_vintage(
    env: &Env,
    project_id: &String,
    vintage_year: u32,
) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::CreditByProjectVintage(
            project_id.clone(),
            vintage_year,
        ))
}

pub fn set_credit_by_project_vintage(
    env: &Env,
    project_id: &String,
    vintage_year: u32,
    credit_id: &BytesN<32>,
) {
    let key = DataKey::CreditByProjectVintage(project_id.clone(), vintage_year);
    env.storage().persistent().set(&key, credit_id);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn set_retirement_contract(env: &Env, addr: &Address) {
    env.storage()
        .instance()
        .set(&DataKey::RetirementContract, addr);
}

pub fn get_retirement_contract(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::RetirementContract)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0u64)
}

pub fn consume_nonce(env: &Env, addr: &Address, expected: u64) -> bool {
    let current = get_nonce(env, addr);
    if current != expected {
        return false;
    }
    let key = DataKey::Nonce(addr.clone());
    env.storage().persistent().set(&key, &(current + 1));
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
    true
}

pub fn get_verifier_reputation(env: &Env, verifier: &Address) -> VerifierReputation {
    env.storage()
        .persistent()
        .get(&DataKey::VerifierReputation(verifier.clone()))
        .unwrap_or(VerifierReputation {
            approval_count: 0,
            dispute_count: 0,
        })
}

pub fn set_verifier_reputation(env: &Env, verifier: &Address, rep: &VerifierReputation) {
    let key = DataKey::VerifierReputation(verifier.clone());
    env.storage().persistent().set(&key, rep);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn increment_approval_count(env: &Env, verifier: &Address) {
    let mut rep = get_verifier_reputation(env, verifier);
    rep.approval_count += 1;
    set_verifier_reputation(env, verifier, &rep);
}

pub fn increment_dispute_count(env: &Env, verifier: &Address) {
    let mut rep = get_verifier_reputation(env, verifier);
    rep.dispute_count += 1;
    set_verifier_reputation(env, verifier, &rep);
}

pub fn get_issuers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::IssuerSet)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_issuers(env: &Env, issuers: &Vec<Address>) {
    env.storage().instance().set(&DataKey::IssuerSet, issuers);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, MIN_TTL);
}

pub fn is_issuer(env: &Env, issuer: &Address) -> bool {
    get_issuers(env).contains(issuer)
}

pub fn get_methodologies(env: &Env) -> Vec<Methodology> {
    env.storage()
        .instance()
        .get(&DataKey::MethodologySet)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_methodologies(env: &Env, methodologies: &Vec<Methodology>) {
    env.storage()
        .instance()
        .set(&DataKey::MethodologySet, methodologies);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, MIN_TTL);
}

pub fn is_methodology_valid(env: &Env, code: &String) -> bool {
    let methodologies = get_methodologies(env);
    for m in methodologies.iter() {
        if m.code == *code {
            return true;
        }
    }
    false
}

// ── Verifier pending credit tracking ─────────────────────────────────────────

/// Returns the number of Pending credits currently assigned to `verifier`.
pub fn get_verifier_pending_count(env: &Env, verifier: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::VerifierPendingCount(verifier.clone()))
        .unwrap_or(0u64)
}

pub fn set_verifier_pending_count(env: &Env, verifier: &Address, count: u64) {
    let key = DataKey::VerifierPendingCount(verifier.clone());
    env.storage().persistent().set(&key, &count);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn increment_verifier_pending(env: &Env, verifier: &Address) {
    let count = get_verifier_pending_count(env, verifier);
    set_verifier_pending_count(env, verifier, count + 1);
}

/// Decrements the pending count for `verifier`, saturating at zero.
pub fn decrement_verifier_pending(env: &Env, verifier: &Address) {
    let count = get_verifier_pending_count(env, verifier);
    if count > 0 {
        set_verifier_pending_count(env, verifier, count - 1);
    }
}

// ── Multi-sig approval tracking ───────────────────────────────────────────────

pub fn get_required_approvals(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::RequiredApprovals)
        .unwrap_or(1u32)
}

pub fn set_required_approvals(env: &Env, count: u32) {
    env.storage()
        .instance()
        .set(&DataKey::RequiredApprovals, &count);
}

pub fn get_credit_approvals(env: &Env, credit_id: &BytesN<32>) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::CreditApprovals(credit_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_credit_approvals(env: &Env, credit_id: &BytesN<32>, approvals: &Vec<Address>) {
    let key = DataKey::CreditApprovals(credit_id.clone());
    env.storage().persistent().set(&key, approvals);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn remove_credit_approvals(env: &Env, credit_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::CreditApprovals(credit_id.clone()));
}

// ── Session management ────────────────────────────────────────────────────────

pub fn set_session(env: &Env, session_id: &BytesN<32>, session: &Session) {
    let key = DataKey::Session(session_id.clone());
    env.storage().persistent().set(&key, session);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_session(env: &Env, session_id: &BytesN<32>) -> Option<Session> {
    env.storage()
        .persistent()
        .get(&DataKey::Session(session_id.clone()))
}

pub fn get_session_op_count(env: &Env, session_id: &BytesN<32>) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::SessionOpCount(session_id.clone()))
        .unwrap_or(0u64)
}

pub fn increment_session_op_count(env: &Env, session_id: &BytesN<32>) {
    let count = get_session_op_count(env, session_id);
    let key = DataKey::SessionOpCount(session_id.clone());
    env.storage().persistent().set(&key, &(count + 1));
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

pub fn get_audit_log_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::AuditLogCount)
        .unwrap_or(0u64)
}

/// Returns the monotonic session counter used to derive unique session IDs.
/// Kept independent of `AuditLogCount` so that session IDs never collide with
/// audit-log IDs. (Issue #671)
pub fn get_session_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::SessionCount)
        .unwrap_or(0u64)
}

/// Increments the session counter and returns the *previous* value (the one
/// that was used to derive the current session ID).
pub fn consume_session_count(env: &Env) -> u64 {
    let count = get_session_count(env);
    env.storage()
        .instance()
        .set(&DataKey::SessionCount, &(count + 1));
    count
}

pub fn append_audit_log(env: &Env, entry: &AuditLogEntry) -> BytesN<32> {
    use soroban_sdk::xdr::ToXdr;
    let count = get_audit_log_count(env);
    // Derive a deterministic log ID from the session_id + count
    let mut preimage = entry.session_id.clone().to_xdr(env);
    preimage.append(&count.to_xdr(env));
    let log_id: BytesN<32> = env.crypto().sha256(&preimage).into();
    let key = DataKey::AuditLog(log_id.clone());
    env.storage().persistent().set(&key, entry);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
    env.storage()
        .instance()
        .set(&DataKey::AuditLogCount, &(count + 1));
    log_id
}

pub fn get_audit_log(env: &Env, log_id: &BytesN<32>) -> Option<AuditLogEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::AuditLog(log_id.clone()))
}

// ── Credits by owner index ─────────────────────────────────────────────────────

pub fn add_credit_to_owner(env: &Env, owner: &Address, credit_id: &BytesN<32>) {
    let key = DataKey::CreditsByOwner(owner.clone());
    let mut list: Vec<BytesN<32>> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    list.push_back(credit_id.clone());
    env.storage().persistent().set(&key, &list);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_credits_by_owner(env: &Env, owner: &Address) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::CreditsByOwner(owner.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

// ── Total credit count ──────────────────────────────────────────────────────

/// Returns the total number of credits ever submitted (see `DataKey::TotalCredits`).
pub fn get_total_credits(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::TotalCredits)
        .unwrap_or(0u64)
}

/// Increments the global total-credits counter. Call exactly once per
/// `submit_credit`. Never call a corresponding decrement — the counter
/// tracks credits ever issued, not credits currently active.
pub fn increment_total_credits(env: &Env) {
    let count = get_total_credits(env);
    env.storage()
        .instance()
        .set(&DataKey::TotalCredits, &(count + 1));
}

/// Remove a single credit ID from the per-owner index.
///
/// Issue #470: `transfer_credit` and `split_credit` did not remove the credit
/// from the old owner's `CreditsByOwner` list, leaving stale entries that
/// caused `list_credits_by_owner` / `get_credits_by_owner` to return incorrect
/// results.
///
/// Complexity note: Soroban `Vec` has no O(1) remove — this function iterates
/// the list and rebuilds it without the target ID, which is O(n). For portfolios
/// of up to ~50 credits this stays well within the Soroban instruction budget.
/// For very large portfolios (hundreds of credits) the instruction cost grows
/// linearly; callers should be aware of this trade-off and, if necessary, switch
/// to a paginated or bitmap-based index.
pub fn remove_credit_from_owner(env: &Env, owner: &Address, credit_id: &BytesN<32>) {
    let key = DataKey::CreditsByOwner(owner.clone());
    let existing: Vec<BytesN<32>> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));

    let mut updated: Vec<BytesN<32>> = Vec::new(env);
    for id in existing.iter() {
        if id != *credit_id {
            updated.push_back(id);
        }
    }
    env.storage().persistent().set(&key, &updated);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

// ── Verifier services ─────────────────────────────────────────────────────────

/// Persist `services` for `verifier` with a long-lived TTL (~1 year).
pub fn set_verifier_services(env: &Env, verifier: &Address, services: &Vec<ServiceType>) {
    let key = DataKey::VerifierServices(verifier.clone());
    env.storage().persistent().set(&key, services);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

/// Returns the configured services for `verifier`, or an empty Vec if none
/// have been configured yet.
pub fn get_verifier_services_for(env: &Env, verifier: &Address) -> Vec<ServiceType> {
    env.storage()
        .persistent()
        .get(&DataKey::VerifierServices(verifier.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

/// Returns `true` if the verifier has at least one service configured AND
/// `ServiceType::CreditApproval` is among them, OR if the verifier has no
/// service configuration at all (open-capability assumption).
///
/// The "no config → allow all" semantic lets existing verifiers continue to
/// work before they have configured their services.
pub fn verifier_has_credit_approval(env: &Env, verifier: &Address) -> bool {
    let key = DataKey::VerifierServices(verifier.clone());
    // No entry at all → open capability: allow everything
    if !env.storage().persistent().has(&key) {
        return true;
    }
    let services: Vec<ServiceType> = env
        .storage()
        .persistent()
        .get(&key)
        .unwrap_or_else(|| Vec::new(env));
    // Empty list stored → open capability (shouldn't happen via the contract API,
    // but guard defensively)
    if services.is_empty() {
        return true;
    }
    services.contains(ServiceType::CreditApproval)
}

// ── Verifier staking (issue #565) ─────────────────────────────────────────────

/// Default minimum stake required to register as a verifier: 1000 XLM,
/// expressed in stroops (the native token's smallest unit, 7 decimals).
pub const DEFAULT_MIN_STAKE: i128 = 1_000 * 10_000_000;

/// 30-day unbonding period, in seconds.
pub const UNBONDING_PERIOD_SECS: u64 = 30 * 24 * 60 * 60;

/// Percentage of a verifier's stake slashed on a malicious-approval finding.
pub const SLASH_PERCENT: i128 = 10;

pub fn get_min_stake(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::MinStake)
        .unwrap_or(DEFAULT_MIN_STAKE)
}

pub fn set_min_stake(env: &Env, amount: i128) {
    env.storage().instance().set(&DataKey::MinStake, &amount);
}

pub fn get_verifier_stake(env: &Env, verifier: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::VerifierStake(verifier.clone()))
        .unwrap_or(0)
}

pub fn set_verifier_stake(env: &Env, verifier: &Address, amount: i128) {
    let key = DataKey::VerifierStake(verifier.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_unbonding_request(env: &Env, verifier: &Address) -> Option<UnbondingRequest> {
    env.storage()
        .persistent()
        .get(&DataKey::UnbondingRequest(verifier.clone()))
}

pub fn set_unbonding_request(env: &Env, verifier: &Address, request: &UnbondingRequest) {
    let key = DataKey::UnbondingRequest(verifier.clone());
    env.storage().persistent().set(&key, request);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn remove_unbonding_request(env: &Env, verifier: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::UnbondingRequest(verifier.clone()));
}

// ── Per-credit verifier snapshots ──────────────────────────────────────────────

pub fn get_credit_verifiers(env: &Env, credit_id: &BytesN<32>) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::CreditVerifiers(credit_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_credit_verifiers(env: &Env, credit_id: &BytesN<32>, verifiers: &Vec<Address>) {
    let key = DataKey::CreditVerifiers(credit_id.clone());
    env.storage().persistent().set(&key, verifiers);
    env.storage()
        .persistent()
        .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn remove_credit_verifiers(env: &Env, credit_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::CreditVerifiers(credit_id.clone()));
}

// ── Pending credits index ────────────────────────────────────────────────────

pub fn get_pending_credits(env: &Env) -> Vec<BytesN<32>> {
    env.storage()
        .instance()
        .get(&DataKey::PendingCredits)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn add_to_pending_credits(env: &Env, credit_id: &BytesN<32>) {
    let mut pending = get_pending_credits(env);
    pending.push_back(credit_id.clone());
    env.storage()
        .instance()
        .set(&DataKey::PendingCredits, &pending);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, MIN_TTL);
}

pub fn remove_from_pending_credits(env: &Env, credit_id: &BytesN<32>) {
    let pending = get_pending_credits(env);
    let mut updated: Vec<BytesN<32>> = Vec::new(env);
    for id in pending.iter() {
        if id != *credit_id {
            updated.push_back(id);
        }
    }
    env.storage()
        .instance()
        .set(&DataKey::PendingCredits, &updated);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, MIN_TTL);
}
