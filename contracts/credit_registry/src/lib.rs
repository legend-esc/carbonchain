#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, IntoVal, String, Symbol, Vec};

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

pub mod errors;
pub mod events;
pub mod migrations;
pub mod storage;
#[cfg(feature = "testutils")]
pub mod test_helpers;
pub mod types;

use crate::errors::CarbonChainError;
use crate::events::{
    ContractInitialized, ContractPaused, ContractUnpaused, CreditDisputed, CreditExpired,
    CreditFlagged, CreditMinted, CreditSplit, CreditSubmitted, CreditTransferred, CreditsMerged,
    DisputeResolved, FlagResolved, ProjectRegistered, RetirementContractUpdated, SessionNew,
    StakeDeposited, StakeWithdrawn, UnbondingInitiated, VerifierRegistered, VerifierRemoved,
    VerifierServicesConfigured, VerifierSlashed,
};
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
    verifier_has_service,
    add_credit_to_owner, add_credit_to_project, add_to_pending_credits, append_audit_log,
    consume_nonce, decrement_verifier_pending, get_admin, get_audit_log, get_credit,
    get_credit_approvals, get_credit_by_project_vintage, get_credit_verifiers,
    get_credits_by_owner, get_credits_by_project, get_issuers, get_methodologies, get_min_stake,
    get_nonce, get_pending_credits, get_required_approvals, get_retirement_contract, get_session,
    get_session_op_count, get_total_credits, get_unbonding_request, get_verifier_reputation,
    get_verifier_services_for, get_verifier_stake, get_verifiers, has_admin,
    increment_approval_count, increment_dispute_count, increment_session_op_count,
    increment_total_credits, increment_verifier_pending, is_issuer as storage_is_issuer,
    is_methodology_valid, is_paused, is_verifier, remove_credit_approvals,
    remove_credit_from_owner, remove_credit_verifiers, remove_from_pending_credits,
    remove_unbonding_request, set_admin, set_credit, set_credit_approvals,
    set_credit_by_project_vintage, set_credit_verifiers, set_issuers, set_methodologies,
    set_min_stake, set_paused, set_required_approvals, set_retirement_contract, set_session,
    set_unbonding_request, set_verifier_services, set_verifier_stake, set_verifiers,
    verifier_has_credit_approval, SLASH_PERCENT, UNBONDING_PERIOD_SECS,
};
use crate::types::{
    AuditLogEntry, CreditMetadata, CreditStatus, DataKey, DisputeResolution, Methodology,
    ProjectMetadata, ServiceType, Session, UnbondingRequest, VerifierReputation,
};

#[cfg_attr(not(feature = "library"), contract)]
pub struct CreditRegistry;

#[allow(clippy::too_many_arguments)]
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
    pub fn initialize(
        env: Env,
        admin: Address,
        retirement_contract: Address,
        required_approvals: u32,
    ) -> Result<(), CarbonChainError> {
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
        crate::storage::set_version(&env, crate::migrations::CURRENT_VERSION);
        ContractInitialized {
            admin: admin.clone(),
            retirement_contract: retirement_contract.clone(),
            required_approvals,
        }
        .publish(&env);
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
    pub fn register_verifier(
        env: Env,
        admin: Address,
        verifier: Address,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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
        // Issue #565: verifier must have locked at least the minimum stake (via
        // `deposit_stake`) before the admin can register them — this gives approvals
        // economic backing so a malicious verifier has capital at risk.
        if get_verifier_stake(&env, &verifier) < get_min_stake(&env) {
            return Err(CarbonChainError::InsufficientStake);
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
    pub fn remove_verifier(
        env: Env,
        admin: Address,
        verifier: Address,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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
        // Issue #481: block removal only if this verifier is specifically assigned to
        // one or more credits that are still in Pending status.  We consult the
        // per-credit CreditVerifiers snapshot (set at submit time) via the global
        // PendingCredits index instead of the inaccurate global counter.
        let pending_credits = get_pending_credits(&env);
        for credit_id in pending_credits.iter() {
            let assigned = get_credit_verifiers(&env, &credit_id);
            if assigned.contains(&verifier) {
                return Err(CarbonChainError::VerifierHasPendingCredits);
            }
        }
        let old = get_verifiers(&env);
        let mut new_list: Vec<Address> = Vec::new(&env);
        for v in old.iter() {
            if v != verifier {
                new_list.push_back(v);
            }
        }
        set_verifiers(&env, &new_list);

        // Issue #565: initiate a 30-day unbonding period for any locked stake rather than
        // returning it immediately — this keeps capital at risk long enough to slash it if
        // misconduct surfaces after removal. Withdraw via `withdraw_stake` once matured.
        let stake = get_verifier_stake(&env, &verifier);
        if stake > 0 {
            let unlock_at = env.ledger().timestamp() + UNBONDING_PERIOD_SECS;
            set_unbonding_request(
                &env,
                &verifier,
                &UnbondingRequest {
                    amount: stake,
                    unlock_at,
                },
            );
            set_verifier_stake(&env, &verifier, 0);
            UnbondingInitiated {
                verifier: verifier.clone(),
                amount: stake,
                unlock_at,
            }
            .publish(&env);
        }

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
        let page_size = if page_size == 0 || page_size > 50 {
            50
        } else {
            page_size
        };
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

    // ── Issue #565: Verifier Staking ─────────────────────────────────────────

    /// Deposit stake toward the minimum required to register as a verifier.
    ///
    /// `token_id` is the address of the token contract to transfer from (e.g. the native
    /// XLM Stellar Asset Contract on the target network). Stake is transferred from
    /// `verifier` into this contract's own balance, acting as an escrow. Deposits
    /// accumulate — call this multiple times to reach `get_min_stake`.
    ///
    /// # Errors
    /// - [`CarbonChainError::ContractPaused`] — contract is paused.
    /// - [`CarbonChainError::InvalidStakeAmount`] — `amount` is zero or negative.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current verifier nonce.
    pub fn deposit_stake(
        env: Env,
        verifier: Address,
        token_id: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        verifier.require_auth();
        if amount <= 0 {
            return Err(CarbonChainError::InvalidStakeAmount);
        }
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }

        let escrow: Address = env.current_contract_address();
        let _: () = env.invoke_contract(
            &token_id,
            &Symbol::new(&env, "transfer"),
            (verifier.clone(), escrow, amount).into_val(&env),
        );

        let total = get_verifier_stake(&env, &verifier) + amount;
        set_verifier_stake(&env, &verifier, total);
        StakeDeposited { verifier, total }.publish(&env);
        Ok(())
    }

    /// Withdraw stake once the 30-day unbonding period initiated by [`remove_verifier`]
    /// has elapsed. `token_id` must match the token originally deposited via
    /// [`deposit_stake`].
    ///
    /// # Errors
    /// - [`CarbonChainError::NoUnbondingRequest`] — no unbonding request exists for `verifier`.
    /// - [`CarbonChainError::UnbondingNotReady`] — the unbonding period has not yet elapsed.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current verifier nonce.
    pub fn withdraw_stake(
        env: Env,
        verifier: Address,
        token_id: Address,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        verifier.require_auth();
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let request =
            get_unbonding_request(&env, &verifier).ok_or(CarbonChainError::NoUnbondingRequest)?;
        if env.ledger().timestamp() < request.unlock_at {
            return Err(CarbonChainError::UnbondingNotReady);
        }

        let escrow: Address = env.current_contract_address();
        let _: () = env.invoke_contract(
            &token_id,
            &Symbol::new(&env, "transfer"),
            (escrow, verifier.clone(), request.amount).into_val(&env),
        );

        remove_unbonding_request(&env, &verifier);
        StakeWithdrawn {
            verifier,
            amount: request.amount,
        }
        .publish(&env);
        Ok(())
    }

    /// Slash 10% of a verifier's currently locked stake as a penalty for approving a credit
    /// that was later flagged as fraudulent. Manually triggered by the admin (MVP mechanism
    /// per issue #565); slashed funds remain forfeited in the contract's escrow balance
    /// rather than being transferred out.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    /// - [`CarbonChainError::InsufficientStake`] — verifier has no stake to slash.
    pub fn slash_verifier(
        env: Env,
        admin: Address,
        verifier: Address,
        credit_id: BytesN<32>,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let stake = get_verifier_stake(&env, &verifier);
        if stake <= 0 {
            return Err(CarbonChainError::InsufficientStake);
        }
        let slash_amount = stake * SLASH_PERCENT / 100;
        set_verifier_stake(&env, &verifier, stake - slash_amount);

        VerifierSlashed {
            admin,
            verifier,
            amount: slash_amount,
            credit_id,
        }
        .publish(&env);
        Ok(())
    }

    /// Returns the stake currently locked by `verifier`.
    pub fn get_verifier_stake(env: Env, verifier: Address) -> i128 {
        get_verifier_stake(&env, &verifier)
    }

    /// Returns the minimum stake required to register as a verifier.
    pub fn get_min_stake(env: Env) -> i128 {
        get_min_stake(&env)
    }

    /// Update the minimum stake required to register as a verifier. Only the admin may
    /// call this.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    /// - [`CarbonChainError::InvalidStakeAmount`] — `amount` is negative.
    pub fn set_min_stake(
        env: Env,
        admin: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        if !consume_nonce(&env, &admin, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        if amount < 0 {
            return Err(CarbonChainError::InvalidStakeAmount);
        }
        set_min_stake(&env, amount);
        Ok(())
    }

    // ── Issuer management ────────────────────────────────────────────────────

    pub fn register_issuer(
        env: Env,
        admin: Address,
        issuer: Address,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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

    pub fn remove_issuer(
        env: Env,
        admin: Address,
        issuer: Address,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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

    pub fn register_methodology(
        env: Env,
        admin: Address,
        code: String,
        name: String,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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
        if env
            .storage()
            .persistent()
            .get::<_, ProjectMetadata>(&DataKey::Project(project_id.clone()))
            .is_none()
        {
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
                if existing_credit.status == CreditStatus::Pending
                    || existing_credit.status == CreditStatus::Active
                {
                    return Err(CarbonChainError::DuplicateCredit);
                }
            }
        }

        // Include a per-contract nonce so two credits for the same project get distinct IDs.
        let credit_nonce: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::CreditNonce, &(credit_nonce + 1));
        let mut preimage = project_id.clone().to_xdr(&env);
        preimage.append(&credit_nonce.to_xdr(&env));
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
        add_credit_to_owner(&env, &issuer, &id);
        // Issue #541: track total credits ever issued for O(1) count reads.
        increment_total_credits(&env);

        // Issue #481: snapshot the current verifier set for THIS credit so that
        // remove_verifier can accurately check per-credit assignment rather than
        // relying on a global over-counting approach.
        let verifiers = get_verifiers(&env);
        set_credit_verifiers(&env, &id, &verifiers);
        for v in verifiers.iter() {
            increment_verifier_pending(&env, &v);
        }
        // Track this credit in the global pending list so remove_verifier can
        // efficiently iterate all pending credits without scanning all storage.
        add_to_pending_credits(&env, &id);

        CreditSubmitted {
            issuer,
            project_id,
            credit_id: id.clone(),
            tonnes,
        }
        .publish(&env);

        Ok(id)
    }

    /// Issue 2: Multi-sig approval. Each registered verifier calls this once per credit.
    /// The credit transitions to Active only when `required_approvals` distinct verifiers
    /// have approved it. Duplicate approvals from the same verifier are rejected.
    pub fn approve_and_mint(
        env: Env,
        verifier: Address,
        credit_id: BytesN<32>,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        verifier.require_auth();
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::Unauthorized);
        }
        // #673: enforce capability check — configured-with-empty grants no access.
        if !verifier_has_service(&env, &verifier, &ServiceType::CreditApproval) {
        // Issue #509: if this verifier has configured their service capabilities,
        // CreditApproval must be among them. If no services are configured, the
        // verifier retains all capabilities (backwards-compatible open assumption).
        if !verifier_has_credit_approval(&env, &verifier) {
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

            // Issue #481: decrement pending count only for verifiers assigned to THIS
            // credit (the snapshot taken at submit time), not for all current verifiers.
            // This prevents over-decrement when new verifiers are added after submission,
            // and correctly handles verifiers removed mid-flight.
            let assigned_verifiers = get_credit_verifiers(&env, &credit_id);
            for v in assigned_verifiers.iter() {
                decrement_verifier_pending(&env, &v);
            }
            // Clean up the per-credit snapshot — no longer needed after minting.
            remove_credit_verifiers(&env, &credit_id);
            // Remove from pending credits index.
            remove_from_pending_credits(&env, &credit_id);

            CreditMinted {
                verifier,
                id: credit_id,
            }
            .publish(&env);
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

    pub fn flag_credit(
        env: Env,
        verifier: Address,
        credit_id: BytesN<32>,
        reason: String,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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
        // Issue #481: decrement pending count using the per-credit snapshot, not the global
        // verifier list, so removed/added verifiers don't cause under/over counts.
        if was_pending {
            let assigned_verifiers = get_credit_verifiers(&env, &credit_id);
            for v in assigned_verifiers.iter() {
                decrement_verifier_pending(&env, &v);
            }
            remove_credit_verifiers(&env, &credit_id);
            remove_from_pending_credits(&env, &credit_id);
        }
        CreditFlagged {
            id: credit_id,
            reason,
        }
        .publish(&env);
        Ok(())
    }

    // ── Issue #550: Resolve a flagged credit ─────────────────────────────────

    /// Resolve a flagged credit's dispute.
    ///
    /// Only the admin or a registered verifier may resolve a flag.  The
    /// `resolution` parameter determines the outcome:
    ///
    /// - [`DisputeResolution::Rejected`] — the flag was a false positive.
    ///   The credit is restored to [`CreditStatus::Active`] so it can be traded.
    /// - [`DisputeResolution::Confirmed`] — the anomaly is validated.
    ///   The credit remains in [`CreditStatus::Flagged`] (blocked from trading).
    ///
    /// Consumes **one caller nonce** to prevent replay attacks.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::ContractPaused`] — contract is paused.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin or a registered verifier.
    /// - [`CarbonChainError::InvalidNonce`] — nonce mismatch.
    /// - [`CarbonChainError::CreditNotFound`] — no credit exists for `credit_id`.
    /// - [`CarbonChainError::InvalidDisputeStatus`] — credit is not in `Flagged` status.
    pub fn resolve_flag(
        env: Env,
        resolver: Address,
        credit_id: BytesN<32>,
        resolution: DisputeResolution,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        resolver.require_auth();

        // Only the admin or a registered verifier may resolve a flag.
        let is_admin_caller = resolver == stored_admin;
        let is_verifier_caller = is_verifier(&env, &resolver);
        if !is_admin_caller && !is_verifier_caller {
            return Err(CarbonChainError::Unauthorized);
        }

        if !consume_nonce(&env, &resolver, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }

        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;

        // Only credits in Flagged status can be resolved via this function.
        if credit.status != CreditStatus::Flagged {
            return Err(CarbonChainError::InvalidDisputeStatus);
        }

        match resolution {
            DisputeResolution::Rejected => {
                // False positive — restore credit to tradeable Active status.
                credit.status = CreditStatus::Active;
            }
            DisputeResolution::Confirmed => {
                // Anomaly confirmed — credit stays Flagged (no status change).
            }
        }

        set_credit(&env, &credit_id, &credit);

        FlagResolved {
            credit_id,
            resolver,
            resolution: resolution as u32,
        }
        .publish(&env);

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
        let retirement_contract =
            get_retirement_contract(&env).ok_or(CarbonChainError::NotInitialized)?;
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

    pub fn transfer_credit(
        env: Env,
        from: Address,
        to: Address,
        credit_id: BytesN<32>,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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
        // Issue #470: Remove from the old owner's index BEFORE updating ownership.
        remove_credit_from_owner(&env, &from, &credit_id);
        credit.owner = to.clone();
        set_credit(&env, &credit_id, &credit);
        // Add to the new owner's index.
        add_credit_to_owner(&env, &to, &credit_id);
        CreditTransferred {
            from,
            to,
            credit_id,
        }
        .publish(&env);
        Ok(())
    }

    // ── Issue #87: Credit Splitting ──────────────────────────────────────────

    pub fn split_credit(
        env: Env,
        caller: Address,
        credit_id: BytesN<32>,
        split_tonnes: i128,
        nonce: u64,
    ) -> Result<(BytesN<32>, BytesN<32>), CarbonChainError> {
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
        if split_tonnes % MIN_CREDIT_UNIT != 0 {
            return Err(CarbonChainError::InvalidSplit);
        }

        let remaining_tonnes = original.tonnes - split_tonnes;
        if remaining_tonnes % MIN_CREDIT_UNIT != 0 {
            return Err(CarbonChainError::InvalidSplit);
        }

        // Generate IDs for child credits
        let nonce_val: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::CreditNonce, &(nonce_val + 1));
        let mut preimage1 = credit_id.clone().to_xdr(&env);
        preimage1.append(&nonce_val.to_xdr(&env));
        let child1_id: BytesN<32> = env.crypto().sha256(&preimage1).into();

        let nonce_val2: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::CreditNonce, &(nonce_val2 + 1));
        let mut preimage2 = credit_id.clone().to_xdr(&env);
        preimage2.append(&nonce_val2.to_xdr(&env));
        let child2_id: BytesN<32> = env.crypto().sha256(&preimage2).into();

        // Create child credits with same metadata
        let mut child1 = original.clone();
        child1.tonnes = split_tonnes;
        child1.owner = caller.clone();
        set_credit(&env, &child1_id, &child1);
        add_credit_to_project(&env, &original.project_id, &child1_id);
        add_credit_to_owner(&env, &caller, &child1_id);

        let mut child2 = original.clone();
        child2.tonnes = remaining_tonnes;
        child2.owner = caller.clone();
        set_credit(&env, &child2_id, &child2);
        add_credit_to_project(&env, &original.project_id, &child2_id);
        add_credit_to_owner(&env, &caller, &child2_id);

        // Issue #470: Remove the original credit from the caller's owner index
        // before retiring it, so get_credits_by_owner returns accurate results.
        remove_credit_from_owner(&env, &caller, &credit_id);

        // Retire original credit
        original.status = CreditStatus::Retired;
        set_credit(&env, &credit_id, &original);
        CreditSplit {
            original_id: credit_id,
            child1_id: child1_id.clone(),
            child2_id: child2_id.clone(),
        }
        .publish(&env);
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

    /// Returns credit IDs currently owned by `owner`.
    /// Filters out stale entries (transferred credits remain in the index of the previous owner).
    pub fn list_credits_by_owner(env: Env, owner: Address) -> Vec<BytesN<32>> {
        let all = get_credits_by_owner(&env, &owner);
        let mut owned: Vec<BytesN<32>> = Vec::new(&env);
        for id in all.iter() {
            if let Some(credit) = get_credit(&env, &id) {
                if credit.owner == owner {
                    owned.push_back(id);
                }
            }
        }
        owned
    }

    /// Returns the total number of credits ever submitted via `submit_credit`.
    /// Never decrements — retired/expired/flagged credits still count toward
    /// this total. Lets callers read a total in O(1) instead of fetching and
    /// counting every credit ID off-chain.
    pub fn get_credit_count(env: Env) -> u64 {
        get_total_credits(&env)
    }

    /// Returns one page of credit IDs currently owned by `owner`. `offset` is
    /// 0-indexed into the owner's *current* (stale-filtered) credit list;
    /// `limit` is capped at 100 per call.
    ///
    /// Equivalent to `list_credits_by_owner(owner)[offset..offset+limit]`, but
    /// callers that only need one page avoid transferring the owner's full
    /// credit list over the wire.
    pub fn get_credits_by_owner_paginated(
        env: Env,
        owner: Address,
        offset: u32,
        limit: u32,
    ) -> Vec<BytesN<32>> {
        let limit = if limit == 0 || limit > 100 {
            100
        } else {
            limit
        };
        let all = get_credits_by_owner(&env, &owner);

        let mut owned: Vec<BytesN<32>> = Vec::new(&env);
        for id in all.iter() {
            if let Some(credit) = get_credit(&env, &id) {
                if credit.owner == owner {
                    owned.push_back(id);
                }
            }
        }

        let mut page: Vec<BytesN<32>> = Vec::new(&env);
        let mut i = offset;
        let end = offset.saturating_add(limit);
        while i < end && i < owned.len() {
            page.push_back(owned.get(i).unwrap());
            i += 1;
        }
        page
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

    pub fn propose_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&crate::types::DataKey::PendingAdmin, &new_admin);
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
            .storage()
            .instance()
            .get(&crate::types::DataKey::PendingAdmin)
            .ok_or(CarbonChainError::NoPendingAdmin)?;
        if new_admin != pending {
            return Err(CarbonChainError::Unauthorized);
        }
        new_admin.require_auth();
        set_admin(&env, &new_admin);
        env.storage()
            .instance()
            .remove(&crate::types::DataKey::PendingAdmin);
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
    pub fn update_retirement_contract(
        env: Env,
        admin: Address,
        new_address: Address,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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

    /// Set the service capabilities for the calling verifier.
    ///
    /// Only the verifier themselves can configure their own services — this is
    /// intentionally NOT an admin operation so verifiers retain autonomy over
    /// their declared capabilities.
    ///
    /// Passing an empty `services` list is allowed and means the verifier has
    /// not yet declared specific capabilities; the open-capability assumption
    /// applies (all operations are permitted). To explicitly restrict a verifier
    /// to no capabilities, pass a list that omits the capability in question.
    ///
    /// Consumes **one verifier nonce** to prevent replay attacks.
    ///
    /// # Errors
    /// - [`CarbonChainError::ContractPaused`] — contract is paused.
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::VerifierNotFound`] — caller is not a registered verifier.
    /// - [`CarbonChainError::InvalidNonce`] — nonce mismatch.
    ///
    /// # Example
    /// ```ignore
    /// let n = contract.get_nonce(&verifier);
    /// let services = vec![ServiceType::CreditApproval, ServiceType::MRVReview];
    /// contract.configure_verifier_services(&verifier, &services, n);
    /// ```
    pub fn configure_verifier_services(
        env: Env,
        verifier: Address,
        services: Vec<ServiceType>,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        // Ensure the contract has been initialised (admin must exist).
        get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        verifier.require_auth();
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }
        let service_count = services.len();
        set_verifier_services(&env, &verifier, &services);
        VerifierServicesConfigured {
            verifier,
            service_count,
        }
        .publish(&env);
        Ok(())
    }

    /// Add a single service capability to the calling verifier's configuration.
    ///
    /// This is a convenience alternative to `configure_verifier_services` when the
    /// verifier wants to add one capability without overwriting the others.
    /// Consumes **one verifier nonce**.
    pub fn add_verifier_service(
        env: Env,
        verifier: Address,
        service: ServiceType,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        verifier.require_auth();
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }

        let mut services = get_verifier_services_for(&env, &verifier);
        if !services.contains(service) {
            services.push_back(service);
            set_verifier_services(&env, &verifier, &services);
        }
        Ok(())
    }

    /// Remove a single service capability from the calling verifier's configuration.
    ///
    /// Consumes **one verifier nonce**.
    pub fn remove_verifier_service(
        env: Env,
        verifier: Address,
        service: ServiceType,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
        if is_paused(&env) {
            return Err(CarbonChainError::ContractPaused);
        }
        get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        verifier.require_auth();
        if !is_verifier(&env, &verifier) {
            return Err(CarbonChainError::VerifierNotFound);
        }
        if !consume_nonce(&env, &verifier, nonce) {
            return Err(CarbonChainError::InvalidNonce);
        }

        let old_services = get_verifier_services_for(&env, &verifier);
        let mut new_services: Vec<ServiceType> = Vec::new(&env);
        for s in old_services.iter() {
            if s != service {
                new_services.push_back(s);
            }
        }
        set_verifier_services(&env, &verifier, &new_services);
        Ok(())
    }

    /// Public read — returns the list of services the verifier has configured.
    /// Returns an empty Vec if no services have been configured yet.
    pub fn get_verifier_services(env: Env, verifier: Address) -> Vec<ServiceType> {
        get_verifier_services_for(&env, &verifier)
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
        if env
            .storage()
            .persistent()
            .get::<_, ProjectMetadata>(&DataKey::Project(project_id.clone()))
            .is_some()
        {
            return Err(CarbonChainError::ProjectAlreadyExists);
        }
        let metadata = ProjectMetadata {
            owner: owner.clone(),
            name,
            description,
            location,
            created_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Project(project_id.clone()), &metadata);
        ProjectRegistered { owner, project_id }.publish(&env);
        Ok(())
    }

    pub fn get_project(env: Env, project_id: String) -> Result<ProjectMetadata, CarbonChainError> {
        env.storage()
            .persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(CarbonChainError::ProjectNotFound)
    }

    // ── Issue #90: Vintage Year Expiry ───────────────────────────────────────

    pub fn expire_credit(
        env: Env,
        admin: Address,
        credit_id: BytesN<32>,
    ) -> Result<(), CarbonChainError> {
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        admin.require_auth();
        if admin != stored_admin {
            return Err(CarbonChainError::Unauthorized);
        }
        let mut credit = get_credit(&env, &credit_id).ok_or(CarbonChainError::CreditNotFound)?;
        if credit.status != CreditStatus::Active && credit.status != CreditStatus::Disputed {
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
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(credit_id.clone()), &evidence_ipfs_hash);
        CreditDisputed {
            disputer,
            credit_id,
            evidence: evidence_ipfs_hash,
        }
        .publish(&env);
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
        env.storage()
            .persistent()
            .remove(&DataKey::Dispute(credit_id.clone()));
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
            total_tonnes = total_tonnes
                .checked_add(credit.tonnes)
                .ok_or(CarbonChainError::Overflow)?;
        }

        let nonce: u64 = env
            .storage()
            .instance()
            .get(&DataKey::CreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::CreditNonce, &(nonce + 1));
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
        add_credit_to_owner(&env, &caller, &merged_id);

        for id in credit_ids.iter() {
            let mut credit = get_credit(&env, &id).ok_or(CarbonChainError::CreditNotFound)?;
            credit.status = CreditStatus::Retired;
            set_credit(&env, &id, &credit);
        }

        CreditsMerged {
            new_id: merged_id.clone(),
            source_count: credit_ids.len(),
        }
        .publish(&env);
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
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<(), CarbonChainError> {
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
        let session_nonce: u64 = env
            .storage()
            .instance()
            .get(&DataKey::AuditLogCount)
            .unwrap_or(0u64);
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
        SessionNew {
            initiator,
            session_id: session_id.clone(),
        }
        .publish(&env);
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
    pub fn get_session_operation_count(
        env: Env,
        session_id: BytesN<32>,
    ) -> Result<u64, CarbonChainError> {
        get_session(&env, &session_id).ok_or(CarbonChainError::SessionNotFound)?;
        Ok(get_session_op_count(&env, &session_id))
    }

    /// Fetch an audit log entry by its ID.
    ///
    /// Only the contract admin or the session initiator for the associated session may read it.
    ///
    /// # Errors
    /// - [`CarbonChainError::SessionNotFound`] — no audit log entry exists for `log_id`.
    pub fn get_audit_log(env: Env, log_id: BytesN<32>) -> Result<AuditLogEntry, CarbonChainError> {
        get_audit_log(&env, &log_id).ok_or(CarbonChainError::SessionNotFound)
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin or session initiator.
    /// - [`CarbonChainError::CreditNotFound`] — no audit log entry exists for `log_id`.
    pub fn get_audit_log(
        env: Env,
        caller: Address,
        log_id: BytesN<32>,
    ) -> Result<AuditLogEntry, CarbonChainError> {
        caller.require_auth();

        let entry = get_audit_log(&env, &log_id).ok_or(CarbonChainError::CreditNotFound)?;
        let stored_admin = get_admin(&env).ok_or(CarbonChainError::NotInitialized)?;
        if caller == stored_admin {
            return Ok(entry);
        }

        let session =
            get_session(&env, &entry.session_id).ok_or(CarbonChainError::CreditNotFound)?;
        if session.initiator == caller {
            return Ok(entry);
        }

        Err(CarbonChainError::Unauthorized)
    }
}

// ── Test module ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;
    use alloc::format;
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
        init(&client, &admin, &retirement, 1);
        (env, client, admin, verifier)
    }

    fn init(
        client: &CreditRegistryClient,
        admin: &Address,
        retirement: &Address,
        required_approvals: u32,
    ) {
        client.initialize(admin, retirement, &required_approvals);
        // Issue #565: register_verifier now requires verifiers to hold at least
        // the minimum stake. Test setup predates staking, so lower the minimum
        // to zero for these unit tests.
        let nonce = client.get_nonce(admin);
        client.set_min_stake(admin, &0, &nonce);
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
        client.flag_credit(
            &verifier,
            &id,
            &String::from_str(&env, "first flag"),
            &vnonce,
        );
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_flag_credit(
            &verifier,
            &id,
            &String::from_str(&env, "second flag"),
            &vnonce2,
        );
        assert!(result.is_err());
    }

    // ── Issue #550: resolve_flag tests ───────────────────────────────────────

    #[test]
    fn test_resolve_flag_rejected_restores_active() {
        // Rejected resolution: false-positive flag → credit returns to Active.
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        // Flag the credit first
        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "anomaly"), &vnonce);
        assert_eq!(client.get_credit(&id).status, CreditStatus::Flagged);

        // Resolve with Rejected (false positive) — admin resolves
        let admin_nonce = client.get_nonce(&admin);
        let result = client.try_resolve_flag(
            &admin,
            &id,
            &crate::types::DisputeResolution::Rejected,
            &admin_nonce,
        );
        assert!(result.is_ok());
        assert_eq!(client.get_credit(&id).status, CreditStatus::Active);
    }

    #[test]
    fn test_resolve_flag_confirmed_stays_flagged() {
        // Confirmed resolution: anomaly validated → credit stays Flagged.
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        // Flag the credit
        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce);

        // Resolve with Confirmed — verifier resolves
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_resolve_flag(
            &verifier,
            &id,
            &crate::types::DisputeResolution::Confirmed,
            &vnonce2,
        );
        assert!(result.is_ok());
        // Credit must remain Flagged
        assert_eq!(client.get_credit(&id).status, CreditStatus::Flagged);
    }

    #[test]
    fn test_resolve_flag_non_flagged_credit_fails() {
        // Attempting to resolve an Active credit returns InvalidDisputeStatus.
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // Credit is still Pending, not Flagged
        let admin_nonce = client.get_nonce(&admin);
        let result = client.try_resolve_flag(
            &admin,
            &id,
            &crate::types::DisputeResolution::Rejected,
            &admin_nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidDisputeStatus)));
    }

    #[test]
    fn test_resolve_flag_unauthorized_caller_fails() {
        // A non-admin, non-verifier address cannot resolve a flag.
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce);

        let rando = Address::generate(&env);
        let rnonce = client.get_nonce(&rando);
        let result = client.try_resolve_flag(
            &rando,
            &id,
            &crate::types::DisputeResolution::Rejected,
            &rnonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::Unauthorized)));
    }

    #[test]
    fn test_resolve_flag_verifier_can_resolve() {
        // A registered verifier (not only admin) can resolve a flagged credit.
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(
            &verifier,
            &id,
            &String::from_str(&env, "suspicious"),
            &vnonce,
        );

        // Verifier resolves as Rejected
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_resolve_flag(
            &verifier,
            &id,
            &crate::types::DisputeResolution::Rejected,
            &vnonce2,
        );
        assert!(result.is_ok());
        assert_eq!(client.get_credit(&id).status, CreditStatus::Active);
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

    // ── Issue #541: get_credit_count / get_credits_by_owner_paginated ────────

    #[test]
    fn test_get_credit_count_increments_and_never_decrements() {
        let (env, client, admin, verifier) = setup();
        assert_eq!(client.get_credit_count(), 0);

        let issuer = Address::generate(&env);
        client.register_issuer(&admin, &issuer, &client.get_nonce(&admin));
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &client.get_nonce(&admin),
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-COUNT"),
            &String::from_str(&env, "Test Project"),
            &String::from_str(&env, "A test project"),
            &String::from_str(&env, "NG"),
        );

        let mut ids = soroban_sdk::Vec::new(&env);
        for year in 2020u32..2023u32 {
            let nonce = client.get_nonce(&issuer);
            let id = client.submit_credit(
                &issuer,
                &String::from_str(&env, "PROJ-COUNT"),
                &year,
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "bafybei123"),
                &nonce,
            );
            ids.push_back(id);
        }
        assert_eq!(client.get_credit_count(), 3);

        // Retiring/flagging a credit must not decrement the total.
        client.register_verifier(&admin, &verifier, &client.get_nonce(&admin));
        let vnonce = client.get_nonce(&verifier);
        client.flag_credit(
            &verifier,
            &ids.get(0).unwrap(),
            &String::from_str(&env, "test flag"),
            &vnonce,
        );
        assert_eq!(client.get_credit_count(), 3);
    }

    #[test]
    fn test_get_credits_by_owner_paginated() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        client.register_issuer(&admin, &issuer, &client.get_nonce(&admin));
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &client.get_nonce(&admin),
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-PAGE"),
            &String::from_str(&env, "Test Project"),
            &String::from_str(&env, "A test project"),
            &String::from_str(&env, "NG"),
        );

        let mut ids = soroban_sdk::Vec::new(&env);
        for year in 2015u32..2020u32 {
            let nonce = client.get_nonce(&issuer);
            let id = client.submit_credit(
                &issuer,
                &String::from_str(&env, "PROJ-PAGE"),
                &year,
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "bafybei123"),
                &nonce,
            );
            ids.push_back(id);
        }

        let page0 = client.get_credits_by_owner_paginated(&issuer, &0, &2);
        assert_eq!(page0.len(), 2);
        assert_eq!(page0.get(0).unwrap(), ids.get(0).unwrap());
        assert_eq!(page0.get(1).unwrap(), ids.get(1).unwrap());

        let page1 = client.get_credits_by_owner_paginated(&issuer, &2, &2);
        assert_eq!(page1.len(), 2);
        assert_eq!(page1.get(0).unwrap(), ids.get(2).unwrap());

        let last_page = client.get_credits_by_owner_paginated(&issuer, &4, &2);
        assert_eq!(last_page.len(), 1);
        assert_eq!(last_page.get(0).unwrap(), ids.get(4).unwrap());

        let past_end = client.get_credits_by_owner_paginated(&issuer, &10, &2);
        assert_eq!(past_end.len(), 0);
    }

    #[test]
    fn test_get_credits_by_owner_paginated_excludes_transferred_credits() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        let recipient = Address::generate(&env);
        let nonce = client.get_nonce(&issuer);
        client.transfer_credit(&issuer, &recipient, &id, &nonce);

        let issuer_page = client.get_credits_by_owner_paginated(&issuer, &0, &10);
        assert_eq!(issuer_page.len(), 0);

        let recipient_page = client.get_credits_by_owner_paginated(&recipient, &0, &10);
        assert_eq!(recipient_page.len(), 1);
        assert_eq!(recipient_page.get(0).unwrap(), id);
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

        init(&client, &admin, &retirement, 1);
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
        let _verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        let new_retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
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
        init(&client, &admin, &retirement, 1);
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

        init(&client, &admin, &retirement, 1);
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
        assert!(client
            .try_submit_credit(
                &issuer,
                &String::from_str(&env, "PROJ-001"),
                &2024,
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "bafybei123"),
                &nonce,
            )
            .is_ok());

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
        assert!(client
            .try_submit_credit(
                &issuer,
                &String::from_str(&env, "PROJ-001"),
                &2024,
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "bafybei123"),
                &nonce,
            )
            .is_ok());

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
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
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
        assert!(client
            .try_submit_credit(
                &issuer,
                &String::from_str(&env, "PROJ-001"),
                &2024,
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "bafybei123"),
                &nonce,
            )
            .is_ok());

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
        assert!(client
            .try_approve_and_mint(&verifier, &id, &vnonce)
            .is_err());
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
    fn test_get_audit_log_allows_admin_and_session_initiator() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);

        let initiator = Address::generate(&env);
        let session_id = client.create_session(&initiator);
        let entry = AuditLogEntry {
            session_id: session_id.clone(),
            credit_id: BytesN::from_array(&env, &[1u8; 32]),
            actor: initiator.clone(),
            action: String::from_str(&env, "submit_credit"),
            timestamp: env.ledger().timestamp(),
        };
        let log_id = env.as_contract(&contract_id, || append_audit_log(&env, &entry));

        let admin_result = client.try_get_audit_log(&admin, &log_id);
        assert!(admin_result.is_ok());
        let admin_entry = admin_result.unwrap().unwrap();
        assert_eq!(admin_entry.session_id, session_id);

        let initiator_result = client.try_get_audit_log(&initiator, &log_id);
        assert!(initiator_result.is_ok());
        let initiator_entry = initiator_result.unwrap().unwrap();
        assert_eq!(initiator_entry.credit_id, entry.credit_id);
    }

    #[test]
    fn test_get_audit_log_rejects_unauthorized_caller() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);

        let initiator = Address::generate(&env);
        let session_id = client.create_session(&initiator);
        let entry = AuditLogEntry {
            session_id: session_id.clone(),
            credit_id: BytesN::from_array(&env, &[2u8; 32]),
            actor: initiator.clone(),
            action: String::from_str(&env, "submit_credit"),
            timestamp: env.ledger().timestamp(),
        };
        let log_id = env.as_contract(&contract_id, || append_audit_log(&env, &entry));

        let unauthorized = Address::generate(&env);
        let result = client.try_get_audit_log(&unauthorized, &log_id);
        assert!(matches!(result, Err(Ok(CarbonChainError::Unauthorized))));
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

    // ── Tests for Issue #509: configure_verifier_services self-auth ──────────

    #[test]
    fn test_verifier_can_self_configure_services() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::CreditApproval);
        // Verifier uses their own nonce to configure their own services
        let vnonce = client.get_nonce(&verifier);
        let result = client.try_configure_verifier_services(&verifier, &services, &vnonce);
        assert!(result.is_ok());
        // Verify the services were stored
        let stored = client.get_verifier_services(&verifier);
        assert_eq!(stored.len(), 1);
        assert!(stored.contains(ServiceType::CreditApproval));
    }

    #[test]
    fn test_non_verifier_cannot_configure_services() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let non_verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::CreditApproval);
        let nonce = client.get_nonce(&non_verifier);
        let result = client.try_configure_verifier_services(&non_verifier, &services, &nonce);
        assert_eq!(result, Err(Ok(CarbonChainError::VerifierNotFound)));
    }

    #[test]
    fn test_approve_and_mint_blocked_without_credit_approval_service() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let nonce2 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &nonce2);
        let nonce3 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &soroban_sdk::String::from_str(&env, "VCS"),
            &soroban_sdk::String::from_str(&env, "Verified Carbon Standard"),
            &nonce3,
        );
        let admin_nonce4 = client.get_nonce(&admin);
        client.register_project(
            &admin,
            &soroban_sdk::String::from_str(&env, "PROJ-001"),
            &soroban_sdk::String::from_str(&env, "Test Project"),
            &soroban_sdk::String::from_str(&env, "A test project"),
            &soroban_sdk::String::from_str(&env, "NG"),
        );
        let _ = admin_nonce4;

        // Configure verifier with only MRVReview (no CreditApproval)
        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::MRVReview);
        let vnonce = client.get_nonce(&verifier);
        client.configure_verifier_services(&verifier, &services, &vnonce);

        // Submit a credit
        let inonce = client.get_nonce(&issuer);
        let credit_id = client.submit_credit(
            &issuer,
            &soroban_sdk::String::from_str(&env, "PROJ-001"),
            &2024u32,
            &soroban_sdk::String::from_str(&env, "VCS"),
            &soroban_sdk::String::from_str(&env, "NG"),
            &1_000_000i128,
            &soroban_sdk::String::from_str(&env, "bafybei"),
            &inonce,
        );

        // Verifier without CreditApproval should be rejected
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &credit_id, &vnonce2);
        assert_eq!(result, Err(Ok(CarbonChainError::Unauthorized)));
    }

    #[test]
    fn test_approve_and_mint_succeeds_with_credit_approval_service() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let nonce2 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &nonce2);
        let nonce3 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &soroban_sdk::String::from_str(&env, "VCS"),
            &soroban_sdk::String::from_str(&env, "Verified Carbon Standard"),
            &nonce3,
        );
        let admin_nonce4 = client.get_nonce(&admin);
        client.register_project(
            &admin,
            &soroban_sdk::String::from_str(&env, "PROJ-001"),
            &soroban_sdk::String::from_str(&env, "Test Project"),
            &soroban_sdk::String::from_str(&env, "A test project"),
            &soroban_sdk::String::from_str(&env, "NG"),
        );
        let _ = admin_nonce4;

        // Configure verifier with CreditApproval
        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::CreditApproval);
        let vnonce = client.get_nonce(&verifier);
        client.configure_verifier_services(&verifier, &services, &vnonce);

        // Submit a credit
        let inonce = client.get_nonce(&issuer);
        let credit_id = client.submit_credit(
            &issuer,
            &soroban_sdk::String::from_str(&env, "PROJ-001"),
            &2024u32,
            &soroban_sdk::String::from_str(&env, "VCS"),
            &soroban_sdk::String::from_str(&env, "NG"),
            &1_000_000i128,
            &soroban_sdk::String::from_str(&env, "bafybei"),
            &inonce,
        );

        // Verifier with CreditApproval should succeed
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &credit_id, &vnonce2);
        assert!(result.is_ok());
    }

    #[test]
    fn test_approve_and_mint_succeeds_with_no_services_configured() {
        // Backwards-compatibility: verifier with no configured services should
        // still be able to call approve_and_mint (open-capability assumption).
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let nonce2 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &nonce2);
        let nonce3 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &soroban_sdk::String::from_str(&env, "VCS"),
            &soroban_sdk::String::from_str(&env, "Verified Carbon Standard"),
            &nonce3,
        );
        let admin_nonce4 = client.get_nonce(&admin);
        client.register_project(
            &admin,
            &soroban_sdk::String::from_str(&env, "PROJ-001"),
            &soroban_sdk::String::from_str(&env, "Test Project"),
            &soroban_sdk::String::from_str(&env, "A test project"),
            &soroban_sdk::String::from_str(&env, "NG"),
        );
        let _ = admin_nonce4;
        // No configure_verifier_services call — open capability

        let inonce = client.get_nonce(&issuer);
        let credit_id = client.submit_credit(
            &issuer,
            &soroban_sdk::String::from_str(&env, "PROJ-001"),
            &2024u32,
            &soroban_sdk::String::from_str(&env, "VCS"),
            &soroban_sdk::String::from_str(&env, "NG"),
            &1_000_000i128,
            &soroban_sdk::String::from_str(&env, "bafybei"),
            &inonce,
        );

        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &credit_id, &vnonce);
        assert!(result.is_ok());
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
        init(&client, &admin, &retirement, 1);

        // Consume the current nonce — registers verifier successfully
        let nonce0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce0);

        // Nonce has advanced; attempting to reuse the same nonce must fail
        let result = client.try_register_verifier(&admin, &verifier, &nonce0);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    // ── #414: InvalidTonnes boundary coverage ────────────────────────────────
    //
    // These tests ensure the contract enforces MIN_CREDIT_UNIT (100_000) at
    // the exact boundaries demanded by the issue.

    /// 99_999 is one unit below the minimum — must return InvalidTonnes.
    #[test]
    fn test_submit_credit_99999_tonnes_fails_invalid_tonnes() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let _ = submit_test_credit(&env, &client, &admin, &issuer);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &99_999,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidTonnes)));
    }

    // ── Issue #398: Core issuance flow — error variant tests ─────────────────

    #[test]
    fn test_initialize_already_initialized() {
        let (env, client, admin, _) = setup();
        let retirement = Address::generate(&env);
        let result = client.try_initialize(&admin, &retirement, &1);
        assert_eq!(result, Err(Ok(CarbonChainError::AlreadyInitialized)));
    }

    #[test]
    fn test_initialize_zero_approvals_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        let result = client.try_initialize(&admin, &retirement, &0);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidApprovalThreshold)));
    }

    #[test]
    fn test_initialize_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        assert!(!env.events().all().events().is_empty());
    }

    #[test]
    fn test_register_verifier_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let result = client.try_register_verifier(&admin, &verifier, &0);
        assert_eq!(result, Err(Ok(CarbonChainError::NotInitialized)));
    }

    #[test]
    fn test_register_verifier_unauthorized() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let rando = Address::generate(&env);
        let verifier = Address::generate(&env);
        let result = client.try_register_verifier(&rando, &verifier, &0);
        assert_eq!(result, Err(Ok(CarbonChainError::Unauthorized)));
    }

    #[test]
    fn test_register_verifier_wrong_nonce() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let result = client.try_register_verifier(&admin, &verifier, &99);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    #[test]
    fn test_register_verifier_already_exists() {
        let (_env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let nonce2 = client.get_nonce(&admin);
        let result = client.try_register_verifier(&admin, &verifier, &nonce2);
        assert_eq!(result, Err(Ok(CarbonChainError::VerifierAlreadyExists)));
    }

    #[test]
    fn test_submit_credit_not_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let issuer = Address::generate(&env);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &0,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::NotInitialized)));
    }

    #[test]
    fn test_submit_credit_wrong_nonce() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &99,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    // ── Tests for Issue #674: Windowed nonce tolerance ────────────────────────

    /// A nonce that is current+0 must be accepted (strict case still works).
    #[test]
    fn test_nonce_sequential_still_works() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let nonce0 = client.get_nonce(&admin);
        // register_verifier consumes nonce 0
        let result = client.try_register_verifier(&admin, &verifier, &nonce0);
        assert!(result.is_ok());
        assert_eq!(client.get_nonce(&admin), 1);
    }

    /// A nonce within the window (e.g. current+2) must be accepted.
    #[test]
    fn test_nonce_windowed_gap_accepted() {
        let (env, client, admin, _) = setup();
        let verifier1 = Address::generate(&env);

        // Current nonce is 0. Use nonce 2 (skip ahead within window of size 16).
        let result = client.try_register_verifier(&admin, &verifier1, &2);
        assert!(result.is_ok(), "nonce within window should be accepted");
    }

    /// A nonce below the current base is a replay — must be rejected.
    #[test]
    fn test_nonce_below_window_rejected() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        // consume nonce 0
        client.register_verifier(&admin, &verifier, &0);
        // now current >= 1; try to replay nonce 0 with a different verifier
        let verifier2 = Address::generate(&env);
        let result = client.try_register_verifier(&admin, &verifier2, &0u64);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    /// A nonce at or beyond current+WINDOW is outside the window — must be rejected.
    #[test]
    fn test_nonce_beyond_window_rejected() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        // NONCE_WINDOW = 16; current is 0; nonce 16 is just outside the window.
        let result = client.try_register_verifier(&admin, &verifier, &16u64);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    /// Replaying an already-consumed nonce within the window must be rejected.
    #[test]
    fn test_nonce_replay_within_window_rejected() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let verifier2 = Address::generate(&env);
        let nonce0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce0);
        // try to replay nonce 0 again with a different operation
        let result = client.try_register_verifier(&admin, &verifier2, &0u64);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    // ── Tests for Issue #673: Empty service list grants no capabilities ────────

    /// Verifier configured with empty service list cannot approve a credit.
    #[test]
    fn test_empty_service_list_blocks_approval() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);

        let n0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &n0);

        // Configure verifier with an empty service list
        let empty_services: soroban_sdk::Vec<ServiceType> = soroban_sdk::Vec::new(&env);
        let n1 = client.get_nonce(&admin);
        client.configure_verifier_services(&admin, &verifier, &empty_services, &n1);

        // Submit a credit
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        // Verifier with empty service list must NOT be able to approve
        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce);
        assert_eq!(result, Err(Ok(CarbonChainError::Unauthorized)));
    }

    /// Unconfigured verifier (no key set at all) retains full backward-compat access.
    #[test]
    fn test_unconfigured_verifier_can_approve() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);

        let n0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &n0);
        // No configure_verifier_services call → unconfigured

        let id = submit_test_credit(&env, &client, &admin, &issuer);

        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce);
        assert!(result.is_ok(), "unconfigured verifier must be able to approve");
    }

    /// Verifier explicitly configured with CreditApproval can approve.
    #[test]
    fn test_configured_credit_approval_service_allows_mint() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);

        let n0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &n0);

        let mut services = soroban_sdk::Vec::new(&env);
        services.push_back(ServiceType::CreditApproval);
        let n1 = client.get_nonce(&admin);
        client.configure_verifier_services(&admin, &verifier, &services, &n1);

        let id = submit_test_credit(&env, &client, &admin, &issuer);

        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce);
        assert!(result.is_ok());
    }

    // ── Tests for Issue #672: get_audit_log returns SessionNotFound ───────────

    /// Fetching a non-existent audit log must return SessionNotFound, not CreditNotFound.
    #[test]
    fn test_get_audit_log_missing_returns_session_not_found() {
        let (env, client, _, _) = setup();
        let fake_id = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_get_audit_log(&fake_id);
        assert_eq!(result, Err(Ok(CarbonChainError::SessionNotFound)));
    }

    /// Fetching an existing audit log must succeed.
    #[test]
    fn test_get_audit_log_existing_succeeds() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);

        // Create a session
        let session_id = client.create_session(&issuer);

        // Submit credit within session to generate an audit log entry
        let n0 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &n0);
        let n1 = client.get_nonce(&admin);
    #[test]
    fn test_submit_credit_issuer_not_allowed() {
        let (env, client, admin, _) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let issuer = Address::generate(&env);
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
        assert_eq!(result, Err(Ok(CarbonChainError::IssuerNotAllowed)));
    }

    /// 100_001 is one unit above the minimum but not a multiple — must return InvalidTonnes.
    #[test]
    fn test_submit_credit_100001_tonnes_fails_invalid_tonnes() {
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
            &100_001,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidTonnes)));
    }

    #[test]
    fn test_submit_credit_project_not_found() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_submit_credit(
            &issuer,
            &String::from_str(&env, "NONEXISTENT"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::ProjectNotFound)));
    }

    #[test]
    fn test_submit_credit_invalid_vintage_year() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce2 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce2,
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
            &1989,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidMetadata)));
    }

    #[test]
    fn test_submit_credit_short_geography_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce2 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce2,
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
            &2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &100_001,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidTonnes)));
    }

    #[test]
    fn test_submit_credit_short_geo_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce2 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce2,
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
            &String::from_str(&env, "X"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidMetadata)));
    }

    #[test]
    fn test_submit_credit_unregistered_methodology_fails() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
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
            &String::from_str(&env, "UNREGISTERED"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidMetadata)));
    }

    #[test]
    fn test_submit_credit_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce2 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &n1,
        );
        client.register_project(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test Project"),
            &String::from_str(&env, "Test Description"),
            &String::from_str(&env, "NG"),
        );
        let inonce = client.get_nonce(&issuer);
        // submit_credit_with_session returns the credit_id.
        // The log_id is derived internally as sha256(session_id_xdr ++ count_xdr).
        // Audit log count before this call is 0.
        client.submit_credit_with_session(
            &session_id,
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024u32,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000i128,
            &String::from_str(&env, "bafybei123"),
            &inonce,
        );

        // Derive the log_id the same way append_audit_log does.
        use soroban_sdk::xdr::ToXdr;
        let mut preimage = session_id.clone().to_xdr(&env);
        preimage.append(&0u64.to_xdr(&env));
        let log_id: BytesN<32> = env.crypto().sha256(&preimage).into();

        let entry = client.get_audit_log(&log_id);
        assert_eq!(entry.session_id, session_id);
    }

    // ── Tests for Issue #675: Instance-storage setters extend TTL ────────────

    /// set_admin must not panic — TTL extension is called internally.
    #[test]
    fn test_set_admin_extends_ttl() {
            &anonce2,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let inonce = client.get_nonce(&issuer);
        client.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &inonce,
        );
        // Events are per-invocation; submit_credit emits at least CreditSubmitted
        assert!(!env.events().all().events().is_empty());
    }

    #[test]
    fn test_approve_and_mint_credit_not_found() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let fake_id = BytesN::from_array(&env, &[0u8; 32]);
        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &fake_id, &vnonce);
        assert_eq!(result, Err(Ok(CarbonChainError::CreditNotFound)));
    }

    #[test]
    fn test_approve_and_mint_wrong_nonce() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let result = client.try_approve_and_mint(&verifier, &id, &99);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    #[test]
    fn test_approve_and_mint_duplicate_approval_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        // initialize calls set_admin internally; if extend_ttl is missing it would panic
        let result = client.try_initialize(&admin, &retirement, &1);
        assert!(result.is_ok(), "initialize (which calls set_admin) must succeed");
    }

    /// set_paused must extend TTL — verified by checking the paused state is observable.
    #[test]
    fn test_set_paused_extends_ttl() {
        let (env, client, admin, _) = setup();
        // pause() calls set_paused(true) which now calls extend_ttl internally.
        client.pause(&admin);
        // The pause effect is observable: submit_credit must now return ContractPaused.
        let result = client.try_submit_credit(
            &Address::generate(&env),
            &String::from_str(&env, "PROJ-001"),
            &2024u32,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000i128,
            &String::from_str(&env, "bafybei123"),
            &0u64,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::ContractPaused)));
    }

    /// set_required_approvals is called by initialize; verify it extends TTL and the
    /// value is readable after the call.
    #[test]
    fn test_set_required_approvals_extends_ttl() {
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        // require 2 approvals so credit stays Pending after first approval
        init(&client, &admin, &retirement, 2);
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        // same verifier approves again — should be AlreadyApproved
        let vnonce2 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce2);
        assert_eq!(result, Err(Ok(CarbonChainError::AlreadyApproved)));
    }

    #[test]
    fn test_approve_and_mint_multi_sig_approval() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier1 = Address::generate(&env);
        let verifier2 = Address::generate(&env);
        let retirement = Address::generate(&env);
        // require 2 approvals
        init(&client, &admin, &retirement, 2);

        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier1, &anonce);
        let anonce2 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier2, &anonce2);

        let issuer = Address::generate(&env);
        let anonce3 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce3);
        let anonce4 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce4,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let inonce = client.get_nonce(&issuer);
        let id = client.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &inonce,
        );

        // First approval — not yet active
        let v1nonce = client.get_nonce(&verifier1);
        client.approve_and_mint(&verifier1, &id, &v1nonce);
        let credit_after_one = client.get_credit(&id);
        assert_eq!(credit_after_one.status, CreditStatus::Pending);

        // Second approval — threshold reached, becomes Active
        let v2nonce = client.get_nonce(&verifier2);
        client.approve_and_mint(&verifier2, &id, &v2nonce);
        let credit_after_two = client.get_credit(&id);
        assert_eq!(credit_after_two.status, CreditStatus::Active);
    }

    #[test]
    fn test_approve_and_mint_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        // initialize calls set_required_approvals(2) with extend_ttl
        client.initialize(&admin, &retirement, &2);
        assert_eq!(client.get_required_approvals(), 2);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        // Events are per-invocation; approve_and_mint emits at least CreditMinted
        assert!(!env.events().all().events().is_empty());
    }

    #[test]
    fn test_submit_credit_happy_path() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let credit = client.get_credit(&id);
        assert_eq!(credit.issuer, issuer);
        assert_eq!(credit.owner, issuer);
        assert_eq!(credit.status, CreditStatus::Pending);
        assert_eq!(credit.tonnes, 1_000_000);
        assert_eq!(credit.project_id, String::from_str(&env, "PROJ-001"));
        assert_eq!(credit.vintage_year, 2024);
        assert_eq!(credit.methodology, String::from_str(&env, "VCS"));
        assert_eq!(credit.geography, String::from_str(&env, "NG"));
        assert_eq!(credit.ipfs_hash, String::from_str(&env, "bafybei123"));
    }

    #[test]
    fn test_get_credit_happy_path() {
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let credit = client.get_credit(&id);
        assert_eq!(credit.issuer, issuer);
        assert_eq!(credit.owner, issuer);
        assert_eq!(credit.status, CreditStatus::Pending);
        assert_eq!(credit.tonnes, 1_000_000);
    }

    #[test]
    fn test_register_verifier_happy_path() {
        let (_env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        assert!(client.is_verifier(&verifier));
    }

    #[test]
    fn test_approve_and_mint_happy_path() {
        let (env, client, admin, verifier) = setup();
        let nonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &nonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let credit = client.get_credit(&id);
        assert_eq!(credit.status, CreditStatus::Active);
    }

    // ── Issue #470: CreditsByOwner index correctness ──────────────────────────

    #[test]
    fn test_transfer_credit_updates_owner_index() {
        // After transfer_credit, the new owner's index includes the credit and
        // the old owner's index does NOT include it.
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let recipient = Address::generate(&env);

        // Verify initial state: issuer owns the credit
        let issuer_credits_before = client.list_credits_by_owner(&issuer);
        assert!(issuer_credits_before.contains(&id));

        let nonce = client.get_nonce(&issuer);
        client.transfer_credit(&issuer, &recipient, &id, &nonce);

        // After transfer: recipient's index has the credit
        let recipient_credits = client.list_credits_by_owner(&recipient);
        assert!(
            recipient_credits.contains(&id),
            "recipient should own the credit after transfer"
        );

        // After transfer: issuer's index no longer has the credit
        let issuer_credits_after = client.list_credits_by_owner(&issuer);
        assert!(
            !issuer_credits_after.contains(&id),
            "old owner's index should not contain transferred credit"
        );
    }

    #[test]
    fn test_split_credit_updates_owner_index() {
        // After split_credit:
        // - original credit ID is removed from caller's index
        // - both child IDs are present in caller's index
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        // Verify initial state
        let before = client.list_credits_by_owner(&issuer);
        assert!(before.contains(&id));

        let nonce = client.get_nonce(&issuer);
        let (child1, child2) = client.split_credit(&issuer, &id, &500_000, &nonce);

        let after = client.list_credits_by_owner(&issuer);

        // Original should be removed
        assert!(
            !after.contains(&id),
            "original credit should be removed from owner index after split"
        );

        // Both children should be present
        assert!(
            after.contains(&child1),
            "child1 should be in owner index after split"
        );
        assert!(
            after.contains(&child2),
            "child2 should be in owner index after split"
        );
    }

    #[test]
    fn test_owner_index_correct_for_large_portfolio() {
        // Verify that remove_credit_from_owner stays within budget for ~10 credits
        // (representative of typical portfolios; actual budget is verified at runtime).
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);

        // Register issuer and methodology once
        let anonce = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce);
        let anonce2 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce2,
        );

        // Register multiple projects and submit one credit per project
        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        for i in 0u32..10u32 {
            let proj = soroban_sdk::String::from_str(&env, &format!("PROJ-{:03}", i));
            client.register_project(
                &admin,
                &proj,
                &String::from_str(&env, "Test"),
                &String::from_str(&env, "Desc"),
                &String::from_str(&env, "NG"),
            );
            let nonce = client.get_nonce(&issuer);
            // Use unique vintage years within the valid window to avoid duplicate project-vintage check
            let cid = client.submit_credit(
                &issuer,
                &proj,
                &(2010 + i),
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "bafybei"),
                &nonce,
            );
            credit_ids.push_back(cid);
        }

        let before = client.list_credits_by_owner(&issuer);
        assert_eq!(before.len(), 10, "should have 10 credits before transfer");

        // Transfer the first credit to a new owner
        let recipient = Address::generate(&env);
        let nonce = client.get_nonce(&issuer);
        let transferred_id = credit_ids.get(0).unwrap();
        client.transfer_credit(&issuer, &recipient, &transferred_id, &nonce);

        let after = client.list_credits_by_owner(&issuer);
        assert_eq!(
            after.len(),
            9,
            "issuer should have 9 credits after transferring one"
        );
        assert!(
            !after.contains(&transferred_id),
            "transferred credit should not appear in issuer index"
        );

        let recipient_credits = client.list_credits_by_owner(&recipient);
        assert_eq!(recipient_credits.len(), 1, "recipient should have 1 credit");
        assert!(recipient_credits.contains(&transferred_id));
    }
}
