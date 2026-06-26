#![no_std]
use soroban_sdk::{contract, contractimpl, Env, Address, String, BytesN, Vec};
use soroban_sdk::xdr::ToXdr;

// ── Unit convention ──────────────────────────────────────────────────────────
//
// The `tonnes` field in `CreditMetadata` stores carbon credits in **micro-tonne
// units** where:
//
//   1 tonne  = 1_000_000 units
//   0.1 tonne = 100_000 units  ← minimum resolution
//
// All amounts submitted to the contract MUST be a positive multiple of
// `MIN_CREDIT_UNIT`.  Amounts that are not a multiple are rejected with
// `CarbonChainError::InvalidTonnes`.
//
// Upper bound: 1_000_000_000_000_000 units = 1 billion tonnes.
pub const UNITS_PER_TONNE: i128 = 1_000_000;
/// Minimum credit unit — represents 0.1 tonne.
pub const MIN_CREDIT_UNIT: i128 = 100_000;

pub mod types;
pub mod errors;
pub mod storage;
pub mod events;
#[cfg(feature = "testutils")]
pub mod test_helpers;

use crate::errors::CarbonChainError;
use crate::storage::{
    set_admin, get_admin, has_admin,
    set_credit, get_credit,
    get_verifiers, set_verifiers, is_verifier,
    add_credit_to_project, get_credits_by_project, get_credit_by_project_vintage, set_credit_by_project_vintage,
    set_retirement_contract, get_retirement_contract,
    set_paused, is_paused,
    get_nonce, consume_nonce,
    get_verifier_reputation,
    increment_approval_count, increment_dispute_count,
    get_issuers, set_issuers, is_issuer as storage_is_issuer,
    get_methodologies, set_methodologies, is_methodology_valid,
    get_verifier_pending_count, increment_verifier_pending, decrement_verifier_pending,
    get_required_approvals, set_required_approvals,
    get_credit_approvals, set_credit_approvals, remove_credit_approvals,
    set_session, get_session, get_session_op_count, increment_session_op_count,
    append_audit_log, get_audit_log,
};
use crate::types::{
    CreditMetadata, CreditStatus, DataKey, ServiceType, VerifierReputation, Methodology,
    ProjectMetadata, Session, AuditLogEntry,
};
use crate::events::{
    ContractPaused, ContractUnpaused,
    VerifierRegistered, VerifierRemoved,
    CreditSubmitted, CreditMinted, CreditFlagged,
    CreditTransferred, CreditSplit, CreditExpired, CreditDisputed,
    DisputeResolved, CreditsMerged, ProjectRegistered, SessionNew,
    RetirementContractUpdated,
};


#[cfg_attr(not(feature = "library"), contract)]
pub struct CreditRegistry;

#[cfg_attr(not(feature = "library"), contractimpl)]
impl CreditRegistry {
    // ── Admin ────────────────────────────────────────────────────────────────

    /// Initialise the registry. Must be called exactly once.
    ///
    /// `required_approvals` sets how many distinct verifier signatures are needed before
    /// a credit transitions from Pending → Active. Must be ≥ 1.
    ///
    /// # Errors
    /// - [`CarbonChainError::AlreadyInitialized`] — contract has already been initialised.
    /// - [`CarbonChainError::InvalidApprovalThreshold`] — `required_approvals` is zero.
    pub fn initialize(env: Env, admin: Address, retirement_contract: Address, required_approvals: u32) -> Result<(), CarbonChainError> {
        if has_admin(&env) {
            return Err(CarbonChainError::AlreadyInitialized);
        }
        if required_approvals == 0 {
            return Err(CarbonChainError::InvalidApprovalThreshold);
        }
        // Validate that admin is a legitimate, authorised address.
        // require_auth() will panic for zero/invalid addresses in the Soroban VM.
        admin.require_auth();
        set_admin(&env, &admin);
        set_retirement_contract(&env, &retirement_contract);
        set_required_approvals(&env, required_approvals);
        Ok(())
    }

    // ── Pause / Unpause ──────────────────────────────────────────────────────

    /// Pause all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        set_paused(&env, true);
        ContractPaused { admin }.publish(&env);
        Ok(())
    }

    /// Resume all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    pub fn unpause(env: Env, admin: Address) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        set_paused(&env, false);
        ContractUnpaused { admin }.publish(&env);
        Ok(())
    }

    /// Returns `true` if the contract is currently paused.
    pub fn paused(env: Env) -> bool {
        is_paused(&env)
    }

    // ── Verifier management ──────────────────────────────────────────────────

    /// Add a verifier to the authorised set. Requires a valid admin nonce for replay protection.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    /// - [`CarbonChainError::VerifierAlreadyExists`] — `verifier` is already registered.
    pub fn register_verifier(env: Env, admin: Address, verifier: Address, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        if is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierAlreadyExists);
        }
        let mut verifiers = get_verifiers(&env);
        verifiers.push_back(verifier.clone());
        set_verifiers(&env, &verifiers);
        VerifierRegistered { admin, verifier }.publish(&env);
        Ok(())
    }

    /// Remove a verifier from the authorised set. Requires a valid admin nonce.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    /// - [`CarbonChainError::VerifierNotFound`] — `verifier` is not in the registered set.
    /// - [`CarbonChainError::VerifierHasPendingCredits`] — `verifier` still has credits in Pending status.
    pub fn remove_verifier(env: Env, admin: Address, verifier: Address, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        // Block removal if the verifier still has pending credits assigned to them.
        let pending = get_verifier_pending_count(&env, &verifier);
        if pending > 0 {
            return Err(CarbonChainError::VerifierHasPendingCredits);
        }
        let old = get_verifiers(&env);
        let mut new_list: Vec<Address> = Vec::new(&env);
        for v in old.iter() {
            if v != verifier {
                new_list.push_back(v);
            }
        }
        set_verifiers(&env, &new_list);
        VerifierRemoved { admin, verifier }.publish(&env);
        Ok(())
    }

    /// Returns the total number of registered verifiers.
    pub fn get_verifier_count(env: Env) -> u32 {
        get_verifiers(&env).len()
    }

    /// Returns up to the first 50 verifiers. Use `list_verifiers_paginated` for larger sets.
    pub fn list_verifiers(env: Env) -> Vec<Address> {
        let all = get_verifiers(&env);
        let cap: u32 = 50;
        if all.len() <= cap {
            return all;
        }
        let mut out: Vec<Address> = Vec::new(&env);
        for i in 0..cap {
            out.push_back(all.get(i).unwrap());
        }
        out
    }

    /// Returns one page of verifiers. `page` is 0-indexed; `page_size` must be 1–50.
    pub fn list_verifiers_paginated(env: Env, page: u32, page_size: u32) -> Vec<Address> {
        let page_size = if page_size == 0 || page_size > 50 { 50 } else { page_size };
        let all = get_verifiers(&env);
        let start = page * page_size;
        let mut out: Vec<Address> = Vec::new(&env);
        let mut i = start;
        while i < start + page_size && i < all.len() {
            out.push_back(all.get(i).unwrap());
            i += 1;
        }
        out
    }

    // ── Issuer management ────────────────────────────────────────────────────

    pub fn register_issuer(env: Env, admin: Address, issuer: Address, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let mut issuers = get_issuers(&env);
        if issuers.contains(&issuer) {
            return Err(CarbonChainError::IssuerNotAllowed);
        }
        issuers.push_back(issuer);
        set_issuers(&env, &issuers);
        Ok(())
    }

    pub fn remove_issuer(env: Env, admin: Address, issuer: Address, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let old = get_issuers(&env);
        let mut new_list: Vec<Address> = Vec::new(&env);
        for i in old.iter() {
            if i != issuer {
                new_list.push_back(i);
            }
        }
        set_issuers(&env, &new_list);
        Ok(())
    }

    pub fn list_issuers(env: Env) -> Vec<Address> {
        get_issuers(&env)
    }

    // ── Methodology management ───────────────────────────────────────────────

    pub fn register_methodology(env: Env, admin: Address, code: String, name: String, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let mut methodologies = get_methodologies(&env);
        for m in methodologies.iter() {
            if m.code == code {
                return Err(CarbonChainError::InvalidMetadata);
            }
        }
        methodologies.push_back(Methodology { code, name });
        set_methodologies(&env, &methodologies);
        Ok(())
    }

    pub fn list_methodologies(env: Env) -> Vec<Methodology> {
        get_methodologies(&env)
    }

    // ── Credit lifecycle ─────────────────────────────────────────────────────

    /// Submit a new carbon credit for verifier approval.
    ///
    /// Stores the credit with [`CreditStatus::Pending`] and returns its deterministic ID
    /// (SHA-256 of `project_id || internal_nonce`). The credit cannot be traded or retired
    /// until a registered verifier calls [`approve_and_mint`].
    ///
    /// `tonnes` is expressed in kg units (1 tonne = 1 000 000). Valid range: `1..=1_000_000_000_000_000`.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::ContractPaused`] — contract is paused.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current issuer nonce.
    /// - [`CarbonChainError::InvalidMetadata`] — `methodology` is not registered, `vintage_year` is outside valid range, or `geography` is too short.
    /// - [`CarbonChainError::InvalidTonnes`] — `tonnes` is zero, negative, or exceeds the upper bound.
    pub fn submit_credit(
        env: Env,
        issuer: Address,
        project_id: String,
        vintage_year: u32,
        methodology: String,
        geography: String,
        tonnes: i128,
        ipfs_hash: String,
        nonce: u64,
    ) -> Result<BytesN<32>, CarbonChainError> {
        if !has_admin(&env) {
            return Err(CarbonChainError::NotInitialized);
        }
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        issuer.require_auth();
        if !consume_nonce(&env, &issuer, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        // Validate project exists
        if env.storage().persistent().get::<_, ProjectMetadata>(&DataKey::Project(project_id.clone())).is_none() {
            return Err(CarbonChainError::ProjectNotFound);
        }
        if !storage_is_issuer(&env, &issuer) {
            return Err(CarbonChainError::IssuerNotAllowed);
        }
        if !is_methodology_valid(&env, &methodology) {
            return Err(CarbonChainError::InvalidMetadata);
        }
        if tonnes <= 0 {
            return Err(CarbonChainError::InvalidTonnes);
        }
        if tonnes % MIN_CREDIT_UNIT != 0 {
            return Err(CarbonChainError::InvalidTonnes);
        }
        // 1 billion tonnes upper bound (1_000_000_000 * TONNES_SCALE = 1e15)
        if tonnes > 1_000_000_000_000_000 {
            return Err(CarbonChainError::InvalidTonnes);
        }
        // Validate vintage_year: 1990 to current_year + 1
        let current_year = (env.ledger().timestamp() / 31_536_000) as u32 + 1970;
        if vintage_year < 1990 || vintage_year > current_year + 1 {
            return Err(CarbonChainError::InvalidMetadata);
        }
        // Validate geography: minimum 2 characters (ISO 3166-1 alpha-2)
        if geography.len() < 2 {
            return Err(CarbonChainError::InvalidMetadata);
        }

        if let Some(existing_id) = get_credit_by_project_vintage(&env, &project_id, vintage_year) {
            if let Some(existing_credit) = get_credit(&env, &existing_id) {
                if existing_credit.status == CreditStatus::Pending || existing_credit.status == CreditStatus::Active {
                    return Err(CarbonChainError::DuplicateCredit);
                }
            }
        }

        // Include a per-contract nonce so two credits for the same project get distinct IDs.
        let nonce: u64 = env.storage().instance().get(&DataKey::CreditNonce).unwrap_or(0u64);
        env.storage().instance().set(&DataKey::CreditNonce, &(nonce + 1));
        let mut preimage = project_id.clone().to_xdr(&env);
        preimage.append(&nonce.to_xdr(&env));
        let id: BytesN<32> = env.crypto().sha256(&preimage).into();
        let metadata = CreditMetadata {
            project_id: project_id.clone(),
            issuer: issuer.clone(),
            owner: issuer.clone(),
            vintage_year,
            methodology,
            geography,
            tonnes,
            ipfs_hash,
            status: CreditStatus::Pending,
            issued_at: env.ledger().timestamp(),
        };

        set_credit(&env, &id, &metadata);
        set_credit_by_project_vintage(&env, &project_id, vintage_year, &id);
        add_credit_to_project(&env, &project_id, &id);

        // Issue 1: track pending credits per verifier so remove_verifier can block removal.
        // We distribute the pending credit across ALL registered verifiers so each one's
        // count reflects that they may be called upon to approve it.
        let verifiers = get_verifiers(&env);
        for v in verifiers.iter() {
            increment_verifier_pending(&env, &v);
        }

        CreditSubmitted { issuer, project_id, credit_id: id.clone(), tonnes }.publish(&env);

        Ok(id)
    }

    /// Issue 2: Multi-sig approval. Each registered verifier calls this once per credit.
    /// The credit transitions to Active only when `required_approvals` distinct verifiers
    /// have approved it. Duplicate approvals from the same verifier are rejected.
    pub fn approve_and_mint(env: Env, verifier: Address, credit_id: BytesN<32>, nonce: u64) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        verifier.require_auth();
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status != CreditStatus::Pending {
            return Err(CarbonChainError::InvalidStatusTransition);
        }

        // Check this verifier hasn't already approved this credit.
        let mut approvals = get_credit_approvals(&env, &credit_id);
        if approvals.contains(&verifier) {
            return Err(CarbonChainError::AlreadyApproved);
        }
        approvals.push_back(verifier.clone());
        set_credit_approvals(&env, &credit_id, &approvals);
        increment_approval_count(&env, &verifier);

        let required = get_required_approvals(&env);
        if approvals.len() >= required {
            // Threshold reached — mint the credit.
            credit.status = CreditStatus::Active;
            set_credit(&env, &credit_id, &credit);
            remove_credit_approvals(&env, &credit_id);

            // Decrement pending count for all verifiers now that this credit is resolved.
            let verifiers = get_verifiers(&env);
            for v in verifiers.iter() {
                decrement_verifier_pending(&env, &v);
            }

            CreditMinted { verifier, id: credit_id }.publish(&env);
        } else {
            // Not yet at threshold — save updated approvals list, no status change.
            set_credit(&env, &credit_id, &credit);
        }
        Ok(())
    }

    /// Returns the current approval count for a pending credit.
    pub fn get_approval_count(env: Env, credit_id: BytesN<32>) -> u32 {
        get_credit_approvals(&env, &credit_id).len()
    }

    /// Returns the required number of approvals to mint a credit.
    pub fn get_required_approvals(env: Env) -> u32 {
        get_required_approvals(&env)
    }

    pub fn flag_credit(env: Env, verifier: Address, credit_id: BytesN<32>, reason: String, nonce: u64) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        verifier.require_auth();
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status == CreditStatus::Retired || credit.status == CreditStatus::Flagged {
            return Err(CarbonChainError::InvalidStatusTransition);
        }
        let was_pending = credit.status == CreditStatus::Pending;
        credit.status = CreditStatus::Flagged;
        set_credit(&env, &credit_id, &credit);
        increment_dispute_count(&env, &verifier);
        // Decrement pending count — this credit is no longer awaiting approval.
        if was_pending {
            let verifiers = get_verifiers(&env);
            for v in verifiers.iter() {
                decrement_verifier_pending(&env, &v);
            }
        }
        CreditFlagged { id: credit_id, reason }.publish(&env);
        Ok(())
    }

    /// Mark a credit as retired. Only callable by the registered retirement contract.
    ///
    /// This is an internal cross-contract call made by the retirement contract after
    /// recording the retirement receipt. The credit must be [`CreditStatus::Active`].
    ///
    /// # Errors
    /// - [`CarbonChainError::ContractPaused`] — contract is paused.
    /// - [`CarbonChainError::NotInitialized`] — no retirement contract has been registered.
    /// - [`CarbonChainError::CreditNotFound`] — no credit exists for `credit_id`.
    /// - [`CarbonChainError::InvalidStatusTransition`] — credit is not in `Active` status.
    pub fn mark_retired(env: Env, credit_id: BytesN<32>) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        // Only the registered retirement contract may call this.
        let retirement_contract = get_retirement_contract(&env)
            .ok_or(CarbonChainError::NotInitialized)?;
        retirement_contract.require_auth();
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status != CreditStatus::Active {
            return Err(CarbonChainError::InvalidStatusTransition);
        }
        credit.status = CreditStatus::Retired;
        set_credit(&env, &credit_id, &credit);
        Ok(())
    }

    // ── Issue #85: Credit Transfer ───────────────────────────────────────────

    pub fn transfer_credit(env: Env, from: Address, to: Address, credit_id: BytesN<32>, nonce: u64) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        from.require_auth();
        if !consume_nonce(&env, &from, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.owner != from {
            return Err(CarbonChainError::Unauthorized);
        }
        credit.owner = to.clone();
        set_credit(&env, &credit_id, &credit);
        CreditTransferred { from, to, credit_id }.publish(&env);
        Ok(())
    }

    // ── Issue #87: Credit Splitting ──────────────────────────────────────────

    pub fn split_credit(env: Env, caller: Address, credit_id: BytesN<32>, split_tonnes: i128, nonce: u64) -> Result<(BytesN<32>, BytesN<32>), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        caller.require_auth();
        if !consume_nonce(&env, &caller, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let mut original = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if original.owner != caller {
            return Err(CarbonChainError::Unauthorized);
        }
        if split_tonnes <= 0 || split_tonnes >= original.tonnes {
            return Err(CarbonChainError::InvalidSplit);
        }

        let remaining_tonnes = original.tonnes - split_tonnes;
        
        // Generate IDs for child credits
        let nonce_val: u64 = env.storage().instance().get(&DataKey::CreditNonce).unwrap_or(0u64);
        env.storage().instance().set(&DataKey::CreditNonce, &(nonce_val + 1));
        let mut preimage1 = credit_id.clone().to_xdr(&env);
        preimage1.append(&nonce_val.to_xdr(&env));
        let child1_id: BytesN<32> = env.crypto().sha256(&preimage1).into();

        let nonce_val2: u64 = env.storage().instance().get(&DataKey::CreditNonce).unwrap_or(0u64);
        env.storage().instance().set(&DataKey::CreditNonce, &(nonce_val2 + 1));
        let mut preimage2 = credit_id.clone().to_xdr(&env);
        preimage2.append(&nonce_val2.to_xdr(&env));
        let child2_id: BytesN<32> = env.crypto().sha256(&preimage2).into();

        // Create child credits with same metadata
        let mut child1 = original.clone();
        child1.tonnes = split_tonnes;
        child1.owner = caller.clone();
        set_credit(&env, &child1_id, &child1);
        add_credit_to_project(&env, &original.project_id, &child1_id);

        let mut child2 = original.clone();
        child2.tonnes = remaining_tonnes;
        child2.owner = caller.clone();
        set_credit(&env, &child2_id, &child2);
        add_credit_to_project(&env, &original.project_id, &child2_id);

        // Retire original credit
        original.status = CreditStatus::Retired;
        set_credit(&env, &credit_id, &original);

        CreditSplit { original_id: credit_id, child1_id: child1_id.clone(), child2_id: child2_id.clone() }.publish(&env);
        Ok((child1_id, child2_id))
    }

    // ── Queries ──────────────────────────────────────────────────────────────

    /// Fetch full metadata for a credit by its ID.
    ///
    /// # Errors
    /// - [`CarbonChainError::CreditNotFound`] — no credit exists for `credit_id`.
    pub fn get_credit(env: Env, credit_id: BytesN<32>) -> Result<CreditMetadata, CarbonChainError> {
        get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)
    }

    /// Returns all credit IDs registered under `project_id`.
    pub fn list_credits_by_project(env: Env, project_id: String) -> Vec<BytesN<32>> {
        get_credits_by_project(&env, &project_id)
    }

    /// Returns the current replay-protection nonce for `address`.
    /// Pass this value as the `nonce` argument to the next state-mutating call.
    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    // ── Issue #84: Verifier Reputation ───────────────────────────────────────

    pub fn get_verifier_reputation(env: Env, verifier: Address) -> VerifierReputation {
        get_verifier_reputation(&env, &verifier)
    }

    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        env.storage().instance().set(&crate::types::DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Complete an admin transfer initiated by [`propose_admin`].
    /// `new_admin` must match the pending candidate.
    ///
    /// # Errors
    /// - [`CarbonChainError::NoPendingAdmin`] — no transfer has been proposed.
    /// - [`CarbonChainError::Unauthorized`] — `new_admin` does not match the pending candidate.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), CarbonChainError> {
        let pending: Address = env
            .storage().instance()
            .get(&crate::types::DataKey::PendingAdmin)
            .ok_or(CarbonChainError::NoPendingAdmin)?;
        if new_admin != pending {
            return Err(CarbonChainError::Unauthorized);
        }
        new_admin.require_auth();
        set_admin(&env, &new_admin);
        env.storage().instance().remove(&crate::types::DataKey::PendingAdmin);
        Ok(())
    }

    /// Returns `true` if `address` is a registered verifier.
    pub fn is_verifier(env: Env, address: Address) -> bool {
        is_verifier(&env, &address)
    }

    // ── Issue #347: Retirement Contract Re-validation ─────────────────────────

    /// Update the registered retirement contract address. Only the admin may call this.
    /// Requires a valid admin nonce for replay protection.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn update_retirement_contract(env: Env, admin: Address, new_address: Address, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        set_retirement_contract(&env, &new_address);
        RetirementContractUpdated { admin, new_address }.publish(&env);
        Ok(())
    }

    // ── Verifier Services ────────────────────────────────────────────────────

    /// Replace all capabilities for a verifier. This overwrites any existing services.
    ///
    /// Consumes **one admin nonce**. When sequencing multiple service-config calls, fetch
    /// the current nonce with `get_nonce(admin)` before each call — do not reuse the same
    /// nonce across calls, as each invocation increments it by one.
    ///
    /// # Example
    /// ```ignore
    /// let n = contract.get_nonce(&admin);
    /// contract.configure_verifier_services(&admin, &verifier, &services, n);
    /// // nonce is now n+1; fetch again before the next admin call
    /// ```
    pub fn configure_verifier_services(env: Env, admin: Address, verifier: Address, services: Vec<ServiceType>, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        env.storage().persistent().set(&DataKey::VerifierServices(verifier), &services);
        Ok(())
    }

    /// Add a single service to a verifier's capabilities.
    ///
    /// Consumes **one admin nonce**. Always call `get_nonce(admin)` immediately before
    /// this function; passing a stale nonce (e.g. one used by a preceding
    /// `configure_verifier_services` call) will return `InvalidNonce`.
    pub fn add_verifier_service(env: Env, admin: Address, verifier: Address, service: ServiceType, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        
        let mut services: Vec<ServiceType> = env.storage().persistent()
            .get(&DataKey::VerifierServices(verifier.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        
        if !services.contains(&service) {
            services.push_back(service);
            env.storage().persistent().set(&DataKey::VerifierServices(verifier), &services);
        }
        Ok(())
    }

    /// Remove a single service from a verifier's capabilities.
    ///
    /// Consumes **one admin nonce**. Always call `get_nonce(admin)` immediately before
    /// this function; passing a stale nonce will return `InvalidNonce`.
    pub fn remove_verifier_service(env: Env, admin: Address, verifier: Address, service: ServiceType, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        
        let old_services: Vec<ServiceType> = env.storage().persistent()
            .get(&DataKey::VerifierServices(verifier.clone()))
            .unwrap_or_else(|| Vec::new(&env));
        
        let mut new_services: Vec<ServiceType> = Vec::new(&env);
        for s in old_services.iter() {
            if s != service {
                new_services.push_back(s);
            }
        }
        env.storage().persistent().set(&DataKey::VerifierServices(verifier), &new_services);
        Ok(())
    }

    pub fn get_verifier_services(env: Env, verifier: Address) -> Vec<ServiceType> {
        env.storage().persistent()
            .get(&DataKey::VerifierServices(verifier))
            .unwrap_or_else(|| Vec::new(&env))
    }

    // ── Issue #91: Project Registry ──────────────────────────────────────────

    pub fn register_project(
        env: Env,
        owner: Address,
        project_id: String,
        name: String,
        description: String,
        location: String,
    ) -> Result<(), CarbonChainError> {
        owner.require_auth();
        if env.storage().persistent().get::<_, ProjectMetadata>(&DataKey::Project(project_id.clone())).is_some() {
            return Err(CarbonChainError::ProjectAlreadyExists);
        }
        let metadata = ProjectMetadata {
            owner: owner.clone(),
            name,
            description,
            location,
            created_at: env.ledger().timestamp(),
        };
        env.storage().persistent().set(&DataKey::Project(project_id.clone()), &metadata);
        ProjectRegistered { owner, project_id }.publish(&env);
        Ok(())
    }

    pub fn get_project(env: Env, project_id: String) -> Result<ProjectMetadata, CarbonChainError> {
        env.storage().persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(CarbonChainError::ProjectNotFound)
    }

    // ── Issue #90: Vintage Year Expiry ───────────────────────────────────────

    pub fn expire_credit(env: Env, admin: Address, credit_id: BytesN<32>) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status == CreditStatus::Retired || credit.status == CreditStatus::Expired {
            return Err(CarbonChainError::InvalidStatusTransition);
        }
        credit.status = CreditStatus::Expired;
        set_credit(&env, &credit_id, &credit);
        CreditExpired { credit_id }.publish(&env);
        Ok(())
    }

    pub fn get_expired_credits(env: Env, project_id: String) -> Vec<BytesN<32>> {
        let credit_ids = get_credits_by_project(&env, &project_id);
        let mut expired: Vec<BytesN<32>> = Vec::new(&env);
        for id in credit_ids.iter() {
            if let Some(credit) = get_credit(&env, &id) {
                if credit.status == CreditStatus::Expired {
                    expired.push_back(id);
                }
            }
        }
        expired
    }

    // ── Issue #89: Verifier Dispute Resolution ───────────────────────────────

    pub fn dispute_credit(
        env: Env,
        disputer: Address,
        credit_id: BytesN<32>,
        evidence_ipfs_hash: String,
    ) -> Result<(), CarbonChainError> {
        disputer.require_auth();
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status == CreditStatus::Retired || credit.status == CreditStatus::Disputed {
            return Err(CarbonChainError::InvalidStatusTransition);
        }
        credit.status = CreditStatus::Disputed;
        set_credit(&env, &credit_id, &credit);
        env.storage().persistent().set(&DataKey::Dispute(credit_id.clone()), &evidence_ipfs_hash);
        CreditDisputed { disputer, credit_id, evidence: evidence_ipfs_hash }.publish(&env);
        Ok(())
    }

    pub fn resolve_dispute(
        env: Env,
        admin: Address,
        credit_id: BytesN<32>,
        outcome: u32,
    ) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status != CreditStatus::Disputed {
            return Err(CarbonChainError::InvalidDisputeStatus);
        }
        if outcome == 0 {
            credit.status = CreditStatus::Active;
        } else if outcome == 1 {
            credit.status = CreditStatus::Flagged;
        } else {
            return Err(CarbonChainError::InvalidMetadata);
        }
        set_credit(&env, &credit_id, &credit);
        env.storage().persistent().remove(&DataKey::Dispute(credit_id.clone()));
        DisputeResolved { credit_id, outcome }.publish(&env);
        Ok(())
    }

    // ── Issue #88: Credit Merging ────────────────────────────────────────────

    pub fn merge_credits(
        env: Env,
        caller: Address,
        credit_ids: Vec<BytesN<32>>,
    ) -> Result<BytesN<32>, CarbonChainError> {
        caller.require_auth();
        if credit_ids.len() < 2 {
            return Err(CarbonChainError::InvalidMetadata);
        }

        let mut total_tonnes: i128 = 0;
        let mut project_id: Option<String> = None;
        let mut vintage_year: Option<u32> = None;
        let mut issuer: Option<Address> = None;
        let mut methodology: Option<String> = None;
        let mut geography: Option<String> = None;
        let mut ipfs_hash: Option<String> = None;

        for id in credit_ids.iter() {
            let credit = get_credit(&env, &id).ok_or(CarbonChainError::CreditNotFound)?;
            
            if credit.owner != caller {
                return Err(CarbonChainError::Unauthorized);
            }

            if credit.status != CreditStatus::Active {
                return Err(CarbonChainError::InvalidStatusTransition);
            }

            if let Some(ref pid) = project_id {
                if credit.project_id != *pid {
                    return Err(CarbonChainError::InvalidMetadata);
                }
            } else {
                project_id = Some(credit.project_id.clone());
            }

            if let Some(vy) = vintage_year {
                if credit.vintage_year != vy {
                    return Err(CarbonChainError::InvalidMetadata);
                }
            } else {
                vintage_year = Some(credit.vintage_year);
            }

            if let Some(ref iss) = issuer {
                if credit.issuer != *iss {
                    return Err(CarbonChainError::InvalidMetadata);
                }
            } else {
                issuer = Some(credit.issuer.clone());
            }

            if let Some(ref meth) = methodology {
                if credit.methodology != *meth {
                    return Err(CarbonChainError::InvalidMetadata);
                }
            } else {
                methodology = Some(credit.methodology.clone());
            }

            if let Some(ref geo) = geography {
                if credit.geography != *geo {
                    return Err(CarbonChainError::InvalidMetadata);
                }
            } else {
                geography = Some(credit.geography.clone());
            }

            ipfs_hash = Some(credit.ipfs_hash.clone());
            total_tonnes = total_tonnes.checked_add(credit.tonnes).ok_or(CarbonChainError::Overflow)?;
        }

        let nonce: u64 = env.storage().instance().get(&DataKey::CreditNonce).unwrap_or(0u64);
        env.storage().instance().set(&DataKey::CreditNonce, &(nonce + 1));
        let mut preimage = project_id.clone().unwrap().to_xdr(&env);
        preimage.append(&nonce.to_xdr(&env));
        let merged_id: BytesN<32> = env.crypto().sha256(&preimage).into();

        let merged_credit = CreditMetadata {
            project_id: project_id.unwrap(),
            issuer: issuer.unwrap(),
            owner: caller.clone(),
            vintage_year: vintage_year.unwrap(),
            methodology: methodology.unwrap(),
            geography: geography.unwrap(),
            tonnes: total_tonnes,
            ipfs_hash: ipfs_hash.unwrap(),
            status: CreditStatus::Active,
            issued_at: env.ledger().timestamp(),
        };

        set_credit(&env, &merged_id, &merged_credit);
        add_credit_to_project(&env, &merged_credit.project_id, &merged_id);

        for id in credit_ids.iter() {
            let mut credit = get_credit(&env, &id).ok_or(CarbonChainError::CreditNotFound)?;
            credit.status = CreditStatus::Retired;
            set_credit(&env, &id, &credit);
        }

        CreditsMerged { new_id: merged_id.clone(), source_count: credit_ids.len() as u32 }.publish(&env);
        Ok(merged_id)
    }

    // ── Issue 3: Contract Upgrade Mechanism ──────────────────────────────────

    /// Upgrade the contract WASM to a new hash. Only the admin may call this.
    ///
    /// After this call the contract executes the new WASM on the next invocation.
    /// The admin must supply a valid nonce to prevent replay attacks.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>, nonce: u64) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ── Issue 4: Session Management ──────────────────────────────────────────

    /// Create a new session for grouping related credit operations.
    /// Returns a deterministic session ID derived from the initiator address and ledger timestamp.
    pub fn create_session(env: Env, initiator: Address) -> Result<BytesN<32>, CarbonChainError> {
        initiator.require_auth();
        // Derive a unique session ID from initiator + current timestamp + session nonce.
        let session_nonce: u64 = env.storage().instance().get(&DataKey::AuditLogCount).unwrap_or(0u64);
        let mut preimage = initiator.clone().to_xdr(&env);
        preimage.append(&env.ledger().timestamp().to_xdr(&env));
        preimage.append(&session_nonce.to_xdr(&env));
        let session_id: BytesN<32> = env.crypto().sha256(&preimage).into();

        let session = Session {
            initiator: initiator.clone(),
            created_at: env.ledger().timestamp(),
            operation_count: 0,
        };
        set_session(&env, &session_id, &session);
        SessionNew { initiator, session_id: session_id.clone() }.publish(&env);
        Ok(session_id)
    }

    /// Submit a credit within an existing session. Records an audit log entry and
    /// increments the session operation count.
    ///
    /// # Errors
    /// - [`CarbonChainError::SessionNotFound`] — no session exists for `session_id`.
    /// - All errors from [`submit_credit`].
    pub fn submit_credit_with_session(
        env: Env,
        session_id: BytesN<32>,
        issuer: Address,
        project_id: String,
        vintage_year: u32,
        methodology: String,
        geography: String,
        tonnes: i128,
        ipfs_hash: String,
        nonce: u64,
    ) -> Result<BytesN<32>, CarbonChainError> {
        // Verify session exists.
        get_session(&env, &session_id).ok_or(CarbonChainError::SessionNotFound)?;

        // Delegate to the standard submit_credit logic.
        let credit_id = Self::submit_credit(
            env.clone(),
            issuer.clone(),
            project_id.clone(),
            vintage_year,
            methodology,
            geography,
            tonnes,
            ipfs_hash,
            nonce,
        )?;

        // Record audit log entry.
        let entry = AuditLogEntry {
            session_id: session_id.clone(),
            credit_id: credit_id.clone(),
            actor: issuer,
            action: String::from_str(&env, "submit_credit"),
            timestamp: env.ledger().timestamp(),
        };
        append_audit_log(&env, &entry);
        increment_session_op_count(&env, &session_id);

        Ok(credit_id)
    }

    /// Returns the number of operations recorded in a session.
    ///
    /// # Errors
    /// - [`CarbonChainError::SessionNotFound`] — no session exists for `session_id`.
    pub fn get_session_operation_count(env: Env, session_id: BytesN<32>) -> Result<u64, CarbonChainError> {
        get_session(&env, &session_id).ok_or(CarbonChainError::SessionNotFound)?;
        Ok(get_session_op_count(&env, &session_id))
    }

    /// Fetch an audit log entry by its ID.
    ///
    /// # Errors
    /// - [`CarbonChainError::CreditNotFound`] — no audit log entry exists for `log_id`.
    pub fn get_audit_log(env: Env, log_id: BytesN<32>) -> Result<AuditLogEntry, CarbonChainError> {
        get_audit_log(&env, &log_id).ok_or(CarbonChainError::CreditNotFound)
    }
}

// ── Test module ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Ledger};

    fn setup() -> (Env, CreditRegistryClient<'static>, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        (env, client, admin, verifier)
    }

    fn submit_test_credit(
        env: &Env,
        client: &CreditRegistryClient,
        admin: &Address,
        issuer: &Address,
    ) -> BytesN<32> {
        let admin_nonce = client.get_nonce(admin);
        client.register_issuer(admin, issuer, &admin_nonce);
        let admin_nonce2 = client.get_nonce(admin);
        client.register_methodology(
            admin,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "Verified Carbon Standard"),
            &admin_nonce2,
        );
        client.register_project(
            admin,
            &String::from_str(env, "PROJ-001"),
            &String::from_str(env, "Test Project"),
            &String::from_str(env, "A test project"),
            &String::from_str(env, "NG"),
        );
        let nonce = client.get_nonce(issuer);
        client.submit_credit(
            issuer,
            &String::from_str(env, "PROJ-001"),
            &2024,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "NG"),
            &1_000_000,
            &String::from_str(env, "bafybei123"),
            &nonce,
        )
    }

    #[test]
    fn test_double_flag_fails() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "first flag"), &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_flag_credit(&verifier, &id, &String::from_str(&env, "second flag"), &vnonce2);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_verifiers_paginated() {
        let (env, client, admin, _) = setup();
        let mut addrs = soroban_sdk::Vec::new(&env);
        for _ in 0..5u32 {
            let v = Address::generate(&env);
            let nonce = client.get_nonce(&admin);
            client.register_verifier(&admin, &v, &nonce);
            addrs.push_back(v);
        }
        let p0 = client.list_verifiers_paginated(&0, &2);
        assert_eq!(p0.len(), 2);
        assert_eq!(p0.get(0).unwrap(), addrs.get(0).unwrap());
        let p1 = client.list_verifiers_paginated(&1, &2);
        assert_eq!(p1.len(), 2);
        assert_eq!(p1.get(0).unwrap(), addrs.get(2).unwrap());
        let p2 = client.list_verifiers_paginated(&2, &2);
        assert_eq!(p2.len(), 1);
    }

    #[test]
    fn test_register_verifier_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);

        client.initialize(&admin, &retirement, &1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);

        let events = env.events().all();
        assert_eq!(events.events().len(), 1);
    }

    #[test]
    fn test_update_retirement_contract_only_admin() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        let new_retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        let nonce = client.get_nonce(&admin);

        // Admin can update retirement contract
        let result = client.try_update_retirement_contract(&admin, &new_retirement, &nonce);
        assert!(result.is_ok());

        // Non-admin cannot update
        let other = Address::generate(&env);
        let other_nonce = client.get_nonce(&other);
        let bad = client.try_update_retirement_contract(&other, &new_retirement, &other_nonce);
        assert!(bad.is_err());
    }

    #[test]
    fn test_mark_retired() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        client.mark_retired(&id);
        assert_eq!(client.get_credit(&id).status, CreditStatus::Retired);
    }

    #[test]
    fn test_unauthorized_mark_retired_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);

        client.initialize(&admin, &retirement, &1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

        env.set_auths(&[]);
        let result = client.try_mark_retired(&id);
        assert!(result.is_err());
    }

    #[test]
    fn test_submit_credit_zero_tonnes_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &0,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_submit_credit_negative_tonnes_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &-1,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_submit_credit_over_upper_bound_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000_000_000_001,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_submit_credit_non_multiple_of_min_unit_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        // 150_001 is not a multiple of MIN_CREDIT_UNIT (100_000)
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &150_001,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidTonnes)));
    }

    #[test]
    fn test_submit_credit_at_upper_bound_succeeds() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce_meth = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce_meth,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000_000_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_submit_credit_duplicate_project_vintage_fails() {
        let (env, client, admin, verifier) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce_meth = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce_meth,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let nonce = client.get_nonce(&issuer);
        assert!(client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        ).is_ok());

        let nonce2 = client.get_nonce(&issuer);
        let duplicate = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce2,
        );
        assert_eq!(duplicate, Err(Ok(CarbonChainError::DuplicateCredit)));

        let vnonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        let credit_ids = client.list_credits_by_project(&String::from_str(&env, "PROJ-001"));
        let first_id = credit_ids.get(0).unwrap();
        client.approve_and_mint(&verifier, &first_id, &vnonce2);

        let nonce3 = client.get_nonce(&issuer);
        let duplicate_active = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce3,
        );
        assert_eq!(duplicate_active, Err(Ok(CarbonChainError::DuplicateCredit)));
    }

    #[test]
    fn test_submit_credit_allows_same_project_different_vintage() {
        let (env, client, admin, _) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce,
        );
        let anonce_proj = client.get_nonce(&admin);
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let issuer = Address::generate(&env);
        let anonce2 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce2);
        let nonce = client.get_nonce(&issuer);
        assert!(client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        ).is_ok());

        let nonce2 = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce2,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_submit_credit_allows_different_project_same_vintage() {
        let (env, client, admin, _) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce,
        );
        let anonce_proj = client.get_nonce(&admin);
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let anonce_proj2 = client.get_nonce(&admin);
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-002"),
            &String::from_str(&env, "Test 2"),
            &String::from_str(&env, "Desc 2"),
            &String::from_str(&env, "NG"),
        );
        let issuer = Address::generate(&env);
        let anonce2 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce2);
        let nonce = client.get_nonce(&issuer);
        assert!(client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        ).is_ok());

        let nonce2 = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-002"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce2,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_get_credit_returns_error_for_missing_credit() {
        let (env, client, _, _) = setup();
        let fake_id = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_get_credit(&fake_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_credit_returns_credit_metadata() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let credit = client.get_credit(&id);
        assert_eq!(credit.tonnes, 1_000_000);
        assert_eq!(credit.status, CreditStatus::Pending);
    }

    #[test]
    fn test_list_credits_by_project() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        submit_test_credit(&env, &client, &admin, &issuer);
        let ids = client.list_credits_by_project(&String::from_str(&env, "PROJ-001"));
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn test_non_verifier_cannot_approve() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let fake = Address::generate(&env);
        let nonce = client.get_nonce(&fake);
        let result = client.try_approve_and_mint(&fake, &id, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn test_approve_and_mint_fails_for_active_credit() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce2);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidStatusTransition)));
    }

    #[test]
    fn test_approve_and_mint_fails_for_flagged_credit() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce2);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidStatusTransition)));
    }

    #[test]
    fn test_approve_and_mint_fails_for_retired_credit() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        client.mark_retired(&id);
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce2);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidStatusTransition)));
    }

    // ── Pause tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_pause_blocks_submit_credit() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        client.pause(&admin);
        assert!(client.paused());
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_unpause_restores_submit_credit() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        client.pause(&admin);
        client.unpause(&admin);
        assert!(!client.paused());
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_pause_blocks_approve_and_mint() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        client.pause(&admin);
        let vnonce = client.get_nonce(&verifier);
        assert!(client.try_approve_and_mint(&verifier, &id, &vnonce).is_err());
    }

    #[test]
    fn test_non_admin_cannot_pause() {
        let (env, client, _, _) = setup();
        let rando = Address::generate(&env);
        assert!(client.try_pause(&rando).is_err());
    }

    // ── Tests for Issue #84: Verifier Reputation ─────────────────────────────

    #[test]
    fn test_verifier_reputation_increments_on_approval() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let rep = client.get_verifier_reputation(&verifier);
        assert_eq!(rep.approval_count, 1);
        assert_eq!(rep.dispute_count, 0);
    }

    #[test]
    fn test_verifier_reputation_increments_on_dispute() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce);
        let rep = client.get_verifier_reputation(&verifier);
        assert_eq!(rep.approval_count, 0);
        assert_eq!(rep.dispute_count, 1);
    }

    // ── Tests for Issue #85: Credit Transfer ─────────────────────────────────

    #[test]
    fn test_transfer_credit_changes_owner() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let recipient = Address::generate(&env);
        let nonce = client.get_nonce(&issuer);
        client.transfer_credit(&issuer, &recipient, &id, &nonce);
        let credit = client.get_credit(&id);
        assert_eq!(credit.owner, recipient);
    }

    #[test]
    fn test_transfer_credit_requires_ownership() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let rando = Address::generate(&env);
        let recipient = Address::generate(&env);
        let nonce = client.get_nonce(&rando);
        let result = client.try_transfer_credit(&rando, &recipient, &id, &nonce);
        assert!(result.is_err());
    }

    // ── Tests for Issue #87: Credit Splitting ───────────────────────────────

    #[test]
    fn test_split_credit_creates_two_children() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        let (child1, child2) = client.split_credit(&issuer, &id, &500_000, &nonce);

        let c1 = client.get_credit(&child1);
        let c2 = client.get_credit(&child2);
        assert_eq!(c1.tonnes, 500_000);
        assert_eq!(c2.tonnes, 500_000);
        assert_eq!(c1.owner, issuer);
        assert_eq!(c2.owner, issuer);
    }

    #[test]
    fn test_split_credit_retires_original() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        client.split_credit(&issuer, &id, &500_000, &nonce);

        let original = client.get_credit(&id);
        assert_eq!(original.status, CreditStatus::Retired);
    }

    #[test]
    fn test_split_credit_invalid_split_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_split_credit(&issuer, &id, &1_000_000, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn test_get_session_operation_count_returns_error_for_missing_session() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let fake_session_id = BytesN::from_array(&env, &[0u8; 32]);

        let result = client.try_get_session_operation_count(&fake_session_id);

        assert_eq!(result, Err(Ok(CarbonChainError::SessionNotFound)));
    }

    // ── Tests for Issue #164: configure_verifier_services auth ───────────────

    #[test]
    fn test_admin_can_configure_verifier_services() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::CreditApproval);
        let nonce2 = client.get_nonce(&admin);
        let result = client.try_configure_verifier_services(&admin, &verifier, &services, &nonce2);
        assert!(result.is_ok());
    }

    #[test]
    fn test_verifier_cannot_self_configure_services() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::CreditApproval);
        let vnonce = client.get_nonce(&verifier);
        let result = client.try_configure_verifier_services(&verifier, &verifier, &services, &vnonce);
        assert_eq!(result, Err(Ok(CarbonChainError::Unauthorized)));
    }

    #[test]
    fn test_nonce_cannot_be_replayed_after_ttl_reset() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);

        // Consume nonce 0 — registers verifier successfully
        let nonce0 = client.get_nonce(&admin);
        assert_eq!(nonce0, 0);
        client.register_verifier(&admin, &verifier, &nonce0);

        // Nonce is now 1; attempting to reuse nonce 0 must fail
        let result = client.try_register_verifier(&admin, &verifier, &0);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }
}
