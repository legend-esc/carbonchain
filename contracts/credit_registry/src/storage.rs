use soroban_sdk::{Env, Address, BytesN, Vec, String};
use crate::types::{DataKey, CreditMetadata, VerifierReputation, Methodology, ProjectMetadata, Session, AuditLogEntry};

/// Minimum TTL in ledgers (~1 year at 5s/ledger).
pub const MIN_TTL: u32 = 6_307_200;
/// Threshold below which TTL is extended (half of MIN_TTL).
pub const TTL_THRESHOLD: u32 = MIN_TTL / 2;

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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_credit(env: &Env, id: &BytesN<32>) -> Option<CreditMetadata> {
    env.storage().persistent().get(&DataKey::Credit(id.clone()))
}

pub fn set_project(env: &Env, project_id: &String, metadata: &ProjectMetadata) {
    let key = DataKey::Project(project_id.clone());
    env.storage().persistent().set(&key, metadata);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_project(env: &Env, project_id: &String) -> Option<ProjectMetadata> {
    env.storage().persistent().get(&DataKey::Project(project_id.clone()))
}

pub fn get_verifiers(env: &Env) -> Vec<Address> {
    env.storage()
        .instance()
        .get(&DataKey::VerifierSet)
        .unwrap_or_else(|| Vec::new(env))
}

pub fn set_verifiers(env: &Env, verifiers: &Vec<Address>) {
    env.storage().instance().set(&DataKey::VerifierSet, verifiers);
    env.storage().instance().extend_ttl(TTL_THRESHOLD, MIN_TTL);
}

pub fn is_verifier(env: &Env, verifier: &Address) -> bool {
    get_verifiers(env).contains(verifier)
}

/// Append a credit id to the per-project index.
pub fn add_credit_to_project(env: &Env, project_id: &String, credit_id: &BytesN<32>) {
    let key = DataKey::ProjectCredits(project_id.clone());
    let mut list: Vec<BytesN<32>> = env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(env));
    list.push_back(credit_id.clone());
    env.storage().persistent().set(&key, &list);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_credits_by_project(env: &Env, project_id: &String) -> Vec<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::ProjectCredits(project_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

pub fn get_credit_by_project_vintage(env: &Env, project_id: &String, vintage_year: u32) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::CreditByProjectVintage(project_id.clone(), vintage_year))
}

pub fn set_credit_by_project_vintage(env: &Env, project_id: &String, vintage_year: u32, credit_id: &BytesN<32>) {
    let key = DataKey::CreditByProjectVintage(project_id.clone(), vintage_year);
    env.storage().persistent().set(&key, credit_id);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn set_retirement_contract(env: &Env, addr: &Address) {
    env.storage().instance().set(&DataKey::RetirementContract, addr);
}

pub fn get_retirement_contract(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::RetirementContract)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
}

pub fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage().persistent().get(&DataKey::Nonce(addr.clone())).unwrap_or(0u64)
}

pub fn consume_nonce(env: &Env, addr: &Address, expected: u64) -> bool {
    let current = get_nonce(env, addr);
    if current != expected { return false; }
    let key = DataKey::Nonce(addr.clone());
    env.storage().persistent().set(&key, &(current + 1));
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
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
    env.storage().instance().set(&DataKey::MethodologySet, methodologies);
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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
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

// ── Credit → assigned verifier mapping ───────────────────────────────────────

pub fn set_credit_assigned_verifier(env: &Env, credit_id: &BytesN<32>, verifier: &Address) {
    let key = DataKey::CreditAssignedVerifier(credit_id.clone());
    env.storage().persistent().set(&key, verifier);
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

pub fn get_credit_assigned_verifier(env: &Env, credit_id: &BytesN<32>) -> Option<Address> {
    env.storage()
        .persistent()
        .get(&DataKey::CreditAssignedVerifier(credit_id.clone()))
}

pub fn remove_credit_assigned_verifier(env: &Env, credit_id: &BytesN<32>) {
    env.storage()
        .persistent()
        .remove(&DataKey::CreditAssignedVerifier(credit_id.clone()));
}

// ── Multi-sig approval tracking ───────────────────────────────────────────────

pub fn get_required_approvals(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::RequiredApprovals)
        .unwrap_or(1u32)
}

pub fn set_required_approvals(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::RequiredApprovals, &count);
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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

pub fn get_audit_log_count(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::AuditLogCount)
        .unwrap_or(0u64)
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
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
    env.storage().instance().set(&DataKey::AuditLogCount, &(count + 1));
    log_id
}

pub fn get_audit_log(env: &Env, log_id: &BytesN<32>) -> Option<AuditLogEntry> {
    env.storage()
        .persistent()
        .get(&DataKey::AuditLog(log_id.clone()))
}
