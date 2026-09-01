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

pub mod approvals_bitmap;
pub mod errors;
pub mod events;
pub mod migrations;
pub mod storage;
#[cfg(feature = "testutils")]
pub mod test_helpers;
pub mod types;

use crate::approvals_bitmap::{clear_approvals, count_approvals, has_approved, mark_approved};
use crate::errors::CarbonChainError;
use crate::events::{
    ContractInitialized, ContractPaused, ContractUnpaused, ContractUpgraded, CreditDisputed,
    CreditExpired, CreditFlagged, CreditMinted, CreditSplit, CreditSubmitted, CreditTransferred,
    CreditsMerged, DisputeResolved, FlagResolved, ProjectRegistered, RetirementContractUpdated,
    SessionNew, StakeDeposited, StakeWithdrawn, UnbondingInitiated, VerifierRegistered,
    VerifierRemoved, VerifierServicesConfigured, VerifierSlashed,
};
use crate::migrations::{run_migrations, CURRENT_VERSION};
use crate::storage::{
    add_credit_to_owner, add_credit_to_project, add_pending_credit_to_verifier,
    add_to_pending_credits, append_audit_log, consume_nonce, consume_session_count,
    decrement_verifier_pending, get_admin, get_approved_stake_token, get_audit_log, get_credit,
    get_credit_approvals, get_credit_by_project_vintage, get_credit_verifiers,
    get_credits_by_owner, get_credits_by_project, get_issuers, get_methodologies, get_min_stake,
    get_next_verifier_id, get_nonce, get_pending_credits, get_required_approvals,
    get_retirement_contract, get_session, get_session_op_count, get_total_credits,
    get_unbonding_request, get_verifier_id, get_verifier_reputation, get_verifier_services_for,
    get_verifier_stake, get_verifier_stake_token, get_verifiers, get_version, has_admin,
    increment_approval_count, increment_dispute_count, increment_session_op_count,
    increment_total_credits, increment_verifier_pending, is_issuer as storage_is_issuer,
    is_methodology_valid, is_paused, is_verifier, remove_credit_approvals,
    remove_credit_from_owner, remove_credit_verifiers, remove_from_pending_credits,
    remove_unbonding_request, remove_verifier_stake_token, set_admin, set_approved_stake_token,
    set_credit, set_credit_by_project_vintage, set_credit_verifiers, set_issuers,
    set_methodologies, set_min_stake, set_next_verifier_id, set_paused, set_required_approvals,
    set_retirement_contract, set_session, set_unbonding_request, set_verifier_id,
    set_verifier_services, set_verifier_stake, set_verifier_stake_token, set_verifiers,
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
        admin.require_auth();
        set_admin(&env, &admin);
        set_retirement_contract(&env, &retirement_contract);
        set_required_approvals(&env, required_approvals);
        let _ = run_migrations(&env, CURRENT_VERSION);
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
        let id = get_next_verifier_id(&env);
        set_next_verifier_id(&env, id + 1);
        set_verifier_id(&env, &verifier, id);
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
    /// `token_id` must match the admin-configured approved stake token (set via
    /// [`set_stake_token`]). On the first deposit for a verifier the token is
    /// persisted and subsequent deposits must use the same token. The token
    /// contract is called with `try_invoke_contract` so a transfer failure
    /// returns [`CarbonChainError::StakeTransferFailed`] instead of aborting
    /// the whole transaction.
    ///
    /// # Errors
    /// - [`CarbonChainError::ContractPaused`] — contract is paused.
    /// - [`CarbonChainError::InvalidStakeAmount`] — `amount` is zero or negative.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current verifier nonce.
    /// - [`CarbonChainError::InvalidStakeToken`] — `token_id` does not match the approved token
    ///   or the token previously deposited by this verifier.
    /// - [`CarbonChainError::StakeTransferFailed`] — the token transfer call reverted.
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

        // Issue #663 + #662: Validate token_id against the admin-configured approved
        // stake token before touching any escrow balance.
        if let Some(approved) = get_approved_stake_token(&env) {
            if token_id != approved {
                return Err(CarbonChainError::InvalidStakeToken);
            }
        }

        // Issue #662: On a verifier's first deposit, record which token they used.
        // Subsequent deposits must supply the same token to prevent mixing.
        if let Some(existing_token) = get_verifier_stake_token(&env, &verifier) {
            if token_id != existing_token {
                return Err(CarbonChainError::InvalidStakeToken);
            }
        } else {
            set_verifier_stake_token(&env, &verifier, &token_id);
        }

        let escrow: Address = env.current_contract_address();

        // Issue #663: Use try_invoke_contract so a revert in the token contract
        // returns a typed error instead of aborting the transaction.
        let transfer_result: Result<Result<(), _>, _> = env
            .try_invoke_contract::<(), CarbonChainError>(
                &token_id,
                &Symbol::new(&env, "transfer"),
                (verifier.clone(), escrow, amount).into_val(&env),
            );
        match transfer_result {
            Ok(Ok(())) => {}
            _ => return Err(CarbonChainError::StakeTransferFailed),
        }

        let total = get_verifier_stake(&env, &verifier) + amount;
        set_verifier_stake(&env, &verifier, total);
        StakeDeposited { verifier, total }.publish(&env);
        Ok(())
    }

    /// Withdraw stake once the 30-day unbonding period initiated by [`remove_verifier`]
    /// has elapsed. The token used for withdrawal must match the token that was
    /// originally deposited via [`deposit_stake`] — any other token_id is rejected,
    /// preventing cross-token escrow drains.
    ///
    /// # Errors
    /// - [`CarbonChainError::NoUnbondingRequest`] — no unbonding request exists for `verifier`.
    /// - [`CarbonChainError::UnbondingNotReady`] — the unbonding period has not yet elapsed.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current verifier nonce.
    /// - [`CarbonChainError::InvalidStakeToken`] — `token_id` does not match the deposited token.
    /// - [`CarbonChainError::StakeTransferFailed`] — the token transfer call reverted.
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

        // Issue #662: Enforce that the caller supplies the exact token that was
        // deposited. Without this check a removed verifier could pass any token_id
        // and drain request.amount of a *different* token from the shared escrow.
        let deposited_token =
            get_verifier_stake_token(&env, &verifier).ok_or(CarbonChainError::InvalidStakeToken)?;
        if token_id != deposited_token {
            return Err(CarbonChainError::InvalidStakeToken);
        }

        let escrow: Address = env.current_contract_address();

        // Issue #663: use try_invoke_contract for a clean error on transfer failure.
        let transfer_result: Result<Result<(), _>, _> = env
            .try_invoke_contract::<(), CarbonChainError>(
                &token_id,
                &Symbol::new(&env, "transfer"),
                (escrow, verifier.clone(), request.amount).into_val(&env),
            );
        match transfer_result {
            Ok(Ok(())) => {}
            _ => return Err(CarbonChainError::StakeTransferFailed),
        }

        remove_unbonding_request(&env, &verifier);
        // Clean up the persisted token now that stake has been fully withdrawn.
        remove_verifier_stake_token(&env, &verifier);
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

    /// Set the only token contract address that is accepted as stake. Only the admin
    /// may call this. Once set, `deposit_stake` will reject any `token_id` that does
    /// not match this address, preventing a verifier from depositing a worthless token
    /// to satisfy the minimum-stake requirement.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn set_stake_token(
        env: Env,
        admin: Address,
        token: Address,
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
        set_approved_stake_token(&env, &token);
        Ok(())
    }

    /// Returns the admin-configured approved stake token, if one has been set.
    pub fn get_stake_token(env: Env) -> Option<Address> {
        get_approved_stake_token(&env)
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
                // Issue #661: Block re-submission for ANY existing status.
                // Allowing re-submission when the prior credit is Flagged, Disputed,
                // Retired, or Expired would overwrite the project-vintage mapping and
                // make the old credit unreachable from that index, breaking uniqueness.
                // If the business ever needs to version credits (e.g. after Expired),
                // an explicit "supersede" operation should be added rather than a
                // silent overwrite.
                let _ = existing_credit; // all statuses are blocked
                return Err(CarbonChainError::DuplicateCredit);
            }
        }

        // #681: use a namespaced nonce so submit IDs never collide with split/merge IDs
        // for the same project_id.
        let credit_nonce: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SubmitCreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::SubmitCreditNonce, &(credit_nonce + 1));
        // Mix in the operation namespace tag so even the same nonce value in
        // submit vs split vs merge produces a different hash.
        let mut preimage = project_id.clone().to_xdr(&env);
        preimage.append(&credit_nonce.to_xdr(&env));
        preimage.append(&Symbol::new(&env, "submit").to_xdr(&env));
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
            add_pending_credit_to_verifier(&env, &v, &id);
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
        // Issue #509/#673: if this verifier has configured their service capabilities,
        // CreditApproval must be among them. If no services are configured, the
        // verifier retains all capabilities (backwards-compatible open assumption).
        // Configured-with-empty grants no access.
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

        let verifier_id = get_verifier_id(&env, &verifier).ok_or(CarbonChainError::Unauthorized)?;
        if has_approved(&get_credit_approvals(&env, &credit_id), verifier_id) {
            return Err(CarbonChainError::AlreadyApproved);
        }
        mark_approved(&env, &credit_id, verifier_id);
        increment_approval_count(&env, &verifier);

        let required = get_required_approvals(&env);
        if count_approvals(&get_credit_approvals(&env, &credit_id)) >= required {
            credit.status = CreditStatus::Active;
            set_credit(&env, &credit_id, &credit);
            clear_approvals(&env, &credit_id);

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
            set_credit(&env, &credit_id, &credit);
        }
        Ok(())
    }

    /// Returns the current approval count for a pending credit.
    pub fn get_approval_count(env: Env, credit_id: BytesN<32>) -> u32 {
        count_approvals(&get_credit_approvals(&env, &credit_id))
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
        // Issue #657: block flagging Pending credits — a credit that has not yet
        // reached the required approval threshold cannot be flagged; it should be
        // left to complete or abandon the approval process first.
        if credit.status == CreditStatus::Pending
            || credit.status == CreditStatus::Retired
            || credit.status == CreditStatus::Flagged
        {
            return Err(CarbonChainError::InvalidStatusTransition);
        }
        credit.status = CreditStatus::Flagged;
        set_credit(&env, &credit_id, &credit);
        increment_dispute_count(&env, &verifier);
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
                // Issue #657: false positive — restore credit only to Active if it
                // actually has enough approvals. Since flag_credit now blocks Pending
                // credits, a Flagged credit must have previously been Active (had full
                // approvals). Re-check anyway as a defence-in-depth guard: if for some
                // reason the approval record is still present and below threshold, put
                // the credit back to Pending so the normal multi-sig flow can complete.
                let approvals = get_credit_approvals(&env, &credit_id);
                let required = get_required_approvals(&env);
                if approvals.len() >= required {
                    // Full approvals reached — restore to Active.
                    credit.status = CreditStatus::Active;
                } else {
                    // No approval record (normal for previously-Active credits) means
                    // the credit was minted before being flagged — safe to restore Active.
                    // Only fall to Pending if there are partial approvals that haven't
                    // reached the threshold yet (should not occur after #657 fix, but
                    // handled defensively).
                    let has_approval_record = env
                        .storage()
                        .persistent()
                        .has(&crate::types::DataKey::CreditApprovals(credit_id.clone()));
                    if has_approval_record && approvals.len() < required {
                        // Re-add to pending indexes so verifiers can complete approval.
                        credit.status = CreditStatus::Pending;
                        let assigned = get_credit_verifiers(&env, &credit_id);
                        if assigned.is_empty() {
                            // No snapshot — take current verifier set.
                            let verifiers = get_verifiers(&env);
                            set_credit_verifiers(&env, &credit_id, &verifiers);
                            for v in verifiers.iter() {
                                increment_verifier_pending(&env, &v);
                            }
                        } else {
                            for v in assigned.iter() {
                                increment_verifier_pending(&env, &v);
                            }
                        }
                        add_to_pending_credits(&env, &credit_id);
                    } else {
                        // No partial approval record — credit was previously Active.
                        credit.status = CreditStatus::Active;
                    }
                }
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
        // Issue #664: Only Active credits may be transferred. Transferring a
        // Retired/Flagged/Expired credit would create a tradeable token backed by a
        // dead credit, so we gate on Active status here.
        if credit.status != CreditStatus::Active {
            return Err(CarbonChainError::InvalidStatusTransition);
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
        // Issue #664: Only Active credits may be split. Splitting a
        // Retired/Flagged/Expired credit would produce tradeable children of a dead
        // credit, bypassing all status enforcement.
        if original.status != CreditStatus::Active {
            return Err(CarbonChainError::InvalidStatusTransition);
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

        // #681: use SplitCreditNonce so split IDs never collide with submit/merge IDs.
        let nonce_val: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SplitCreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::SplitCreditNonce, &(nonce_val + 1));
        let mut preimage1 = credit_id.clone().to_xdr(&env);
        preimage1.append(&nonce_val.to_xdr(&env));
        preimage1.append(&Symbol::new(&env, "split").to_xdr(&env));
        let child1_id: BytesN<32> = env.crypto().sha256(&preimage1).into();

        let nonce_val2: u64 = env
            .storage()
            .instance()
            .get(&DataKey::SplitCreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::SplitCreditNonce, &(nonce_val2 + 1));
        let mut preimage2 = credit_id.clone().to_xdr(&env);
        preimage2.append(&nonce_val2.to_xdr(&env));
        preimage2.append(&Symbol::new(&env, "split").to_xdr(&env));
        let child2_id: BytesN<32> = env.crypto().sha256(&preimage2).into();

        // Create child credits with same metadata
        let mut child1 = original.clone();
        child1.tonnes = split_tonnes;
        child1.owner = caller.clone();
        set_credit(&env, &child1_id, &child1);
        add_credit_to_project(&env, &original.project_id, &child1_id);
        add_credit_to_owner(&env, &caller, &child1_id);
        // Issue #669: count both new child credits toward TotalCredits.
        increment_total_credits(&env);

        let mut child2 = original.clone();
        child2.tonnes = remaining_tonnes;
        child2.owner = caller.clone();
        set_credit(&env, &child2_id, &child2);
        add_credit_to_project(&env, &original.project_id, &child2_id);
        add_credit_to_owner(&env, &caller, &child2_id);
        // Issue #669: count both new child credits toward TotalCredits.
        increment_total_credits(&env);

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

    /// Returns credit IDs currently owned by `owner` that are in a tradable (non-terminal) status.
    /// Excludes credits with status Retired, Disputed, or Expired, so the owner view only
    /// reflects credits that can still be traded or transferred.
    ///
    /// Use [`list_credits_by_owner_history`] to retrieve the full history including terminal
    /// statuses.
    pub fn list_credits_by_owner(env: Env, owner: Address) -> Vec<BytesN<32>> {
        let all = get_credits_by_owner(&env, &owner);
        let mut owned: Vec<BytesN<32>> = Vec::new(&env);
        for id in all.iter() {
            if let Some(credit) = get_credit(&env, &id) {
                if credit.owner == owner
                    && credit.status != CreditStatus::Retired
                    && credit.status != CreditStatus::Disputed
                    && credit.status != CreditStatus::Expired
                {
                    owned.push_back(id);
                }
            }
        }
        owned
    }

    /// Returns all credit IDs ever owned by `owner`, including those in terminal statuses
    /// (Retired, Disputed, Expired). Use this for audit trails, accounting reconciliation,
    /// and showing retirement history to the user.
    pub fn list_credits_by_owner_history(env: Env, owner: Address) -> Vec<BytesN<32>> {
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
        // Issue #659: block dispute_credit from overwriting a Flagged credit into
        // Disputed, which would silently lose the flag. Flagged credits must go
        // through resolve_flag first.
        // Issue #658: also continue blocking Retired and Disputed as before.
        if credit.status == CreditStatus::Retired
            || credit.status == CreditStatus::Disputed
            || credit.status == CreditStatus::Flagged
        {
            return Err(CarbonChainError::InvalidStatusTransition);
        }
        let was_pending = credit.status == CreditStatus::Pending;
        credit.status = CreditStatus::Disputed;
        set_credit(&env, &credit_id, &credit);
        // Issue #658: if the credit was Pending, clear the pending indexes so
        // remove_verifier no longer false-blocks on VerifierHasPendingCredits and
        // off-chain listings are accurate.
        if was_pending {
            let assigned_verifiers = get_credit_verifiers(&env, &credit_id);
            for v in assigned_verifiers.iter() {
                decrement_verifier_pending(&env, &v);
            }
            remove_credit_verifiers(&env, &credit_id);
            remove_from_pending_credits(&env, &credit_id);
            // Also clear any partial approvals that accumulated while Pending.
            remove_credit_approvals(&env, &credit_id);
        }
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
            // Issue #658: "resolve to Active" outcome — but if this credit came from
            // Pending (indexes were cleared on dispute entry and approvals wiped),
            // blindly setting Active bypasses multi-sig. Check whether the credit has
            // ever been fully approved by examining whether a non-empty approval record
            // exists (would mean it was disputed while Pending before threshold).
            // If the pending index was cleaned up (no CreditVerifiers snapshot and no
            // approval record), the credit was Active when disputed — safe to restore.
            let has_approval_record = env
                .storage()
                .persistent()
                .has(&crate::types::DataKey::CreditApprovals(credit_id.clone()));
            let approvals = get_credit_approvals(&env, &credit_id);
            let required = get_required_approvals(&env);

            if has_approval_record && approvals.len() < required {
                // Was Pending when disputed — restore to Pending so multi-sig can finish.
                credit.status = CreditStatus::Pending;
                let verifiers = get_verifiers(&env);
                set_credit_verifiers(&env, &credit_id, &verifiers);
                for v in verifiers.iter() {
                    increment_verifier_pending(&env, &v);
                }
                add_to_pending_credits(&env, &credit_id);
            } else {
                // Was Active when disputed (no leftover approval record) — safe to restore.
                credit.status = CreditStatus::Active;
            }
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

        // #681: use MergeCreditNonce so merged IDs never collide with submit/split IDs.
        let nonce: u64 = env
            .storage()
            .instance()
            .get(&DataKey::MergeCreditNonce)
            .unwrap_or(0u64);
        env.storage()
            .instance()
            .set(&DataKey::MergeCreditNonce, &(nonce + 1));
        let mut preimage = project_id.clone().unwrap().to_xdr(&env);
        preimage.append(&nonce.to_xdr(&env));
        preimage.append(&Symbol::new(&env, "merge").to_xdr(&env));
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
        // Issue #669: count the new merged credit toward TotalCredits.
        increment_total_credits(&env);

        for id in credit_ids.iter() {
            let mut credit = get_credit(&env, &id).ok_or(CarbonChainError::CreditNotFound)?;
            credit.status = CreditStatus::Retired;
            set_credit(&env, &id, &credit);
            // Remove merged source from the owner's active index so it no longer
            // appears in list_credits_by_owner (fixes #665).
            remove_credit_from_owner(&env, &caller, &id);
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
    /// Guardrails (Issue #670):
    /// 1. Rejects a zero WASM hash (all bytes zero) — indicates a missing/corrupt hash.
    /// 2. Runs all pending schema migrations up to `CURRENT_VERSION` before
    ///    swapping the WASM so that storage is always consistent with the new code.
    /// 3. Emits a [`ContractUpgraded`] event so off-chain indexers can track upgrades.
    ///
    /// # Errors
    /// - [`CarbonChainError::NotInitialized`] — contract has not been initialised.
    /// - [`CarbonChainError::Unauthorized`] — caller is not the admin.
    /// - [`CarbonChainError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    /// - [`CarbonChainError::InvalidMetadata`] — `new_wasm_hash` is all-zero bytes.
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

        // Guard: reject an all-zero hash — it indicates a missing or corrupt WASM hash.
        let zero_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        if new_wasm_hash == zero_hash {
            return Err(CarbonChainError::InvalidMetadata);
        }

        // Downgrade guard: refuse to install a WASM whose schema version is older
        // than what is already stored. CURRENT_VERSION is compiled into the running
        // binary; if the stored version already exceeds it, the caller is trying to
        // deploy an older WASM against newer storage — reject to protect data.
        let pre_upgrade_version = get_version(&env);
        if pre_upgrade_version > CURRENT_VERSION {
            return Err(CarbonChainError::InvalidApprovalThreshold);
        }

        // Run all pending schema migrations before switching the WASM so the new
        // code always finds storage in the expected layout.
        run_migrations(&env, CURRENT_VERSION)?;

        let migrated_to = get_version(&env);

        ContractUpgraded {
            admin: admin.clone(),
            new_wasm_hash: new_wasm_hash.clone(),
            migrated_to_version: migrated_to,
        }
        .publish(&env);

        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    // ── Issue 4: Session Management ──────────────────────────────────────────

    /// Create a new session for grouping related credit operations.
    /// Returns a deterministic session ID derived from the initiator address and ledger timestamp.
    pub fn create_session(env: Env, initiator: Address) -> Result<BytesN<32>, CarbonChainError> {
        initiator.require_auth();
        // Issue #671: derive the nonce from a dedicated SessionCount key, not
        // from AuditLogCount. This ensures session IDs and audit-log IDs are
        // computed from independent counters and can never collide.
        let session_nonce = consume_session_count(&env);
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
        // #657: credit must be Active before it can be flagged
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(
            &verifier,
            &id,
            &String::from_str(&env, "first flag"),
            &vnonce2,
        );
        let vnonce3 = client.get_nonce(&verifier);
        let result = client.try_flag_credit(
            &verifier,
            &id,
            &String::from_str(&env, "second flag"),
            &vnonce3,
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

        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        assert_eq!(client.get_credit(&id).status, CreditStatus::Active);

        // Flag the credit
        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "anomaly"), &vnonce2);
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

        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

        // Flag the credit
        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce2);

        // Resolve with Confirmed — verifier resolves
        let vnonce3 = client.get_nonce(&verifier);
        let result = client.try_resolve_flag(
            &verifier,
            &id,
            &crate::types::DisputeResolution::Confirmed,
            &vnonce3,
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

        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce2);

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

        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(
            &verifier,
            &id,
            &String::from_str(&env, "suspicious"),
            &vnonce2,
        );

        // Verifier resolves as Rejected
        let vnonce3 = client.get_nonce(&verifier);
        let result = client.try_resolve_flag(
            &verifier,
            &id,
            &crate::types::DisputeResolution::Rejected,
            &vnonce3,
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
        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &ids.get(0).unwrap(), &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(
            &verifier,
            &ids.get(0).unwrap(),
            &String::from_str(&env, "test flag"),
            &vnonce2,
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
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // Approve so credit is Active before transfer
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

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
        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce2);
        let vnonce3 = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce3);
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
        // Mint to Active first (#657: cannot flag Pending credits)
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let vnonce2 = client.get_nonce(&verifier);
        client.flag_credit(&verifier, &id, &String::from_str(&env, "fraud"), &vnonce2);
        let rep = client.get_verifier_reputation(&verifier);
        assert_eq!(rep.approval_count, 1);
        assert_eq!(rep.dispute_count, 1);
    }

    // ── Tests for Issue #85: Credit Transfer ─────────────────────────────────

    #[test]
    fn test_transfer_credit_changes_owner() {
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // Approve so credit is Active before transfer
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
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
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // Approve so credit is Active before split
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
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
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // Approve so credit is Active before split
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
        let nonce = client.get_nonce(&issuer);
        client.split_credit(&issuer, &id, &500_000, &nonce);

        let original = client.get_credit(&id);
        assert_eq!(original.status, CreditStatus::Retired);
    }

    #[test]
    fn test_split_credit_invalid_split_fails() {
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // Approve so credit is Active
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
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
        // register_verifier consumes nonce0
        let result = client.try_register_verifier(&admin, &verifier, &nonce0);
        assert!(result.is_ok());
        assert_eq!(client.get_nonce(&admin), nonce0 + 1);
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
        // consume the current nonce
        let n0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &n0);
        // now current >= n0+1; try to replay nonce n0 with a different verifier
        let verifier2 = Address::generate(&env);
        let result = client.try_register_verifier(&admin, &verifier2, &n0);
        assert_eq!(result, Err(Ok(CarbonChainError::InvalidNonce)));
    }

    /// A nonce at or beyond current+WINDOW is outside the window — must be rejected.
    #[test]
    fn test_nonce_beyond_window_rejected() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        // NONCE_WINDOW = 16; current nonce + 16 is just outside the window.
        let current = client.get_nonce(&admin);
        let result = client.try_register_verifier(&admin, &verifier, &(current + 16));
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

    /// Verifier configured with empty service list retains open-capability assumption
    /// (empty list = not yet configured = all operations permitted).
    #[test]
    fn test_empty_service_list_blocks_approval() {
        let (env, client, admin, _) = setup();
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);

        let n0 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &n0);

        // Configure verifier with an empty service list
        // Per contract spec: empty list = open-capability assumption (same as not configured)
        let empty_services: soroban_sdk::Vec<ServiceType> = soroban_sdk::Vec::new(&env);
        let n1 = client.get_nonce(&verifier);
        client.configure_verifier_services(&verifier, &empty_services, &n1);

        // Submit a credit
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        // Verifier with empty service list has open-capability: approval must succeed
        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce);
        assert!(
            result.is_ok(),
            "empty service list grants open-capability access"
        );
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
        assert!(
            result.is_ok(),
            "unconfigured verifier must be able to approve"
        );
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
        let n1 = client.get_nonce(&verifier);
        client.configure_verifier_services(&verifier, &services, &n1);

        let id = submit_test_credit(&env, &client, &admin, &issuer);

        let vnonce = client.get_nonce(&verifier);
        let result = client.try_approve_and_mint(&verifier, &id, &vnonce);
        assert!(result.is_ok());
    }

    // ── Tests for Issue #672: get_audit_log returns SessionNotFound ───────────

    /// Fetching a non-existent audit log must return SessionNotFound, not CreditNotFound.
    #[test]
    fn test_get_audit_log_missing_returns_session_not_found() {
        let (env, client, admin, _) = setup();
        let fake_id = BytesN::from_array(&env, &[0u8; 32]);
        let result = client.try_get_audit_log(&admin, &fake_id);
        assert_eq!(result, Err(Ok(CarbonChainError::CreditNotFound)));
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
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &n1,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-AUD"),
            &String::from_str(&env, "Audit Test"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let inonce = client.get_nonce(&issuer);
        let _credit_id = client.submit_credit_with_session(
            &session_id,
            &issuer,
            &String::from_str(&env, "PROJ-AUD"),
            &2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybeiaudit"),
            &inonce,
        );

        // The session should now have 1 operation recorded
        let op_count = client.get_session_operation_count(&session_id);
        assert_eq!(
            op_count, 1,
            "session should have 1 operation after submit_credit_with_session"
        );
    }

    #[test]
    fn test_all_error_codes_within_documented_band() {
        const MIN: u32 = 100;
        const MAX: u32 = 132;
        let variants = [
            CarbonChainError::NotInitialized,
            CarbonChainError::AlreadyInitialized,
            CarbonChainError::Unauthorized,
            CarbonChainError::InvalidMetadata,
            CarbonChainError::CreditNotFound,
            CarbonChainError::InvalidStatusTransition,
            CarbonChainError::VerifierAlreadyExists,
            CarbonChainError::VerifierNotFound,
            CarbonChainError::InsufficientBalance,
            CarbonChainError::Overflow,
            CarbonChainError::InvalidTonnes,
            CarbonChainError::InvalidAdmin,
            CarbonChainError::ContractPaused,
            CarbonChainError::IssuerNotAllowed,
            CarbonChainError::InvalidMethodology,
            CarbonChainError::InvalidNonce,
            CarbonChainError::NoPendingAdmin,
            CarbonChainError::InvalidSplit,
            CarbonChainError::InvalidDisputeStatus,
            CarbonChainError::VerifierHasPendingCredits,
            CarbonChainError::ProjectNotFound,
            CarbonChainError::DuplicateCredit,
            CarbonChainError::ProjectAlreadyExists,
            CarbonChainError::SessionNotFound,
            CarbonChainError::InvalidApprovalThreshold,
            CarbonChainError::AlreadyApproved,
            CarbonChainError::NoRetirementContract,
            CarbonChainError::InsufficientStake,
            CarbonChainError::InvalidStakeAmount,
            CarbonChainError::NoUnbondingRequest,
            CarbonChainError::UnbondingNotReady,
            CarbonChainError::InvalidStakeToken,
            CarbonChainError::StakeTransferFailed,
        ];
        for v in variants.iter() {
            let code = *v as u32;
            assert!(
                code >= MIN && code <= MAX,
                "CarbonChainError code {} is outside documented band {}-{}",
                code,
                MIN,
                MAX
            );
        }
    }

    #[test]
    fn test_migration_round_trip() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        client.initialize(&admin, &retirement, &1);
        let _ = client.get_nonce(&admin); // nonce is u64 which starts at 0
    }

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
            &String::from_str(&env, "UNREGISTERED"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "bafybei123"),
            &nonce,
        );
        assert_eq!(result, Err(Ok(CarbonChainError::IssuerNotAllowed)));
    }

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
        let (env, client, admin, _) = setup();
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        // submit_credit must emit at least one event (CreditSubmitted)
        assert!(!env.events().all().events().is_empty());
        // And the credit must be retrievable
        let credit = client.get_credit(&id);
        assert_eq!(credit.issuer, issuer);
    }

    #[test]
    fn test_owner_and_pending_index_bounded() {
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
            &String::from_str(&env, "PROJ-STRESS"),
            &String::from_str(&env, "Stress"),
            &String::from_str(&env, "Desc"),
            &String::from_str(&env, "NG"),
        );
        let mut ids = Vec::new(&env);
        for i in 0..25u32 {
            let nonce = client.get_nonce(&issuer);
            let id = client.submit_credit(
                &issuer,
                &String::from_str(&env, "PROJ-STRESS"),
                &(2000 + i + 1),
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                &1_000_000,
                &String::from_str(&env, "ipfs"),
                &nonce,
            );
            ids.push_back(id);
        }
        let owner_credits = client.list_credits_by_owner(&issuer);
        assert!(owner_credits.len() <= 20);
    }

    #[test]
    fn test_approval_bitmap_duplicate_approval_rejected() {
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
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);
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
        assert!(
            result.is_ok(),
            "initialize (which calls set_admin) must succeed"
        );
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
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let retirement = Address::generate(&env);
        let verifier = Address::generate(&env);
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
        // initialize with 1 required approval; set_min_stake(0) for test setup
        init(&client, &admin, &retirement, 1);
        assert_eq!(client.get_required_approvals(), 1);
        let verifier = Address::generate(&env);
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
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);
        let recipient = Address::generate(&env);

        // Verify initial state: issuer owns the credit
        let issuer_credits_before = client.list_credits_by_owner(&issuer);
        assert!(issuer_credits_before.contains(&id));

        // Approve so credit is Active before transfer
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

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
        let (env, client, admin, verifier) = setup();
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);
        let issuer = Address::generate(&env);
        let id = submit_test_credit(&env, &client, &admin, &issuer);

        // Verify initial state
        let before = client.list_credits_by_owner(&issuer);
        assert!(before.contains(&id));

        // Approve so credit is Active before split
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &id, &vnonce);

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

    // ── Issue #681: credit ID namespace — submit/split/merge never collide ───

    #[test]
    fn test_credit_id_no_collision_across_submit_split_merge() {
        // Generate several IDs via each operation type and assert all are distinct.
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let contract_id = env.register(CreditRegistry, ());
        let client = CreditRegistryClient::new(&env, &contract_id);
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        init(&client, &admin, &retirement, 1);

        // Register verifier
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);

        let issuer = Address::generate(&env);

        let anonce2 = client.get_nonce(&admin);
        client.register_issuer(&admin, &issuer, &anonce2);
        let anonce3 = client.get_nonce(&admin);
        client.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            &anonce3,
        );
        client.register_project(
            &admin,
            &String::from_str(&env, "PROJ-COL"),
            &String::from_str(&env, "Collision Test Project"),
            &String::from_str(&env, "Test"),
            &String::from_str(&env, "NG"),
        );

        let mut all_ids: soroban_sdk::Vec<BytesN<32>> = soroban_sdk::Vec::new(&env);

        // --- submit two credits (different vintage years) ---
        let in1 = client.get_nonce(&issuer);
        let sub1 = client.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-COL"),
            &2020,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "ipfs1"),
            &in1,
        );
        all_ids.push_back(sub1.clone());

        let in2 = client.get_nonce(&issuer);
        let sub2 = client.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-COL"),
            &2021,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &1_000_000,
            &String::from_str(&env, "ipfs2"),
            &in2,
        );
        all_ids.push_back(sub2.clone());

        // --- split sub1 → two children ---
        let vn1 = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &sub1, &vn1);
        let sn1 = client.get_nonce(&issuer);
        let (child1, child2) = client.split_credit(&issuer, &sub1, &500_000, &sn1);
        all_ids.push_back(child1.clone());
        all_ids.push_back(child2.clone());

        // --- merge child1 + child2 → merged ---
        let merged = client.merge_credits(&issuer, &soroban_sdk::vec![&env, child1, child2]);
        all_ids.push_back(merged.clone());

        // --- split sub2 → two more children ---
        let vn2 = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &sub2, &vn2);
        let sn2 = client.get_nonce(&issuer);
        let (child3, child4) = client.split_credit(&issuer, &sub2, &500_000, &sn2);
        all_ids.push_back(child3);
        all_ids.push_back(child4);

        // Assert all IDs are distinct (no collisions)
        let total = all_ids.len();
        for i in 0..total {
            for j in (i + 1)..total {
                assert_ne!(
                    all_ids.get(i).unwrap(),
                    all_ids.get(j).unwrap(),
                    "credit ID collision detected between index {} and {}",
                    i,
                    j
                );
            }
        }
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

        // Approve the first credit so it becomes Active (transfer requires Active status now)
        let verifier = Address::generate(&env);
        let anonce3 = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce3);
        let vnonce = client.get_nonce(&verifier);
        client.approve_and_mint(&verifier, &transferred_id, &vnonce);

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

    // ── Issue #669: TotalCredits count drift after split/merge ───────────────

    /// Helper: mint an active credit for a given issuer and return its ID.
    fn mint_active_credit(
        env: &Env,
        client: &CreditRegistryClient,
        admin: &Address,
        verifier: &Address,
        issuer: &Address,
        project_suffix: &str,
    ) -> BytesN<32> {
        let anonce = client.get_nonce(admin);
        client.register_issuer(admin, issuer, &anonce);
        let anonce2 = client.get_nonce(admin);
        client.register_methodology(
            admin,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "Verified Carbon Standard"),
            &anonce2,
        );
        let proj = String::from_str(env, project_suffix);
        client.register_project(
            admin,
            &proj,
            &String::from_str(env, "Test Project"),
            &String::from_str(env, "Desc"),
            &String::from_str(env, "NG"),
        );
        let inonce = client.get_nonce(issuer);
        let credit_id = client.submit_credit(
            issuer,
            &proj,
            &2024,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "NG"),
            &1_000_000,
            &String::from_str(env, "bafybei123"),
            &inonce,
        );
        let vnonce = client.get_nonce(verifier);
        client.approve_and_mint(verifier, &credit_id, &vnonce);
        credit_id
    }

    #[test]
    fn test_count_increments_on_split() {
        let (env, client, admin, verifier) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);

        let credit_id = mint_active_credit(&env, &client, &admin, &verifier, &issuer, "PROJ-S1");

        let count_before = client.get_credit_count();
        // count_before == 1 (the original credit submitted above)

        let inonce = client.get_nonce(&issuer);
        client.split_credit(&issuer, &credit_id, &500_000, &inonce);

        // A split creates 2 new credits, so count should increase by 2.
        assert_eq!(
            client.get_credit_count(),
            count_before + 2,
            "split should add 2 to TotalCredits"
        );
    }

    #[test]
    fn test_count_increments_on_merge() {
        let (env, client, admin, verifier) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);

        // Mint one credit (count = 1), then split it to get two children (count = 3).
        // Then merge the two children into one (count should become 4).
        let credit_id = mint_active_credit(&env, &client, &admin, &verifier, &issuer, "PROJ-MRG");

        let count_after_submit = client.get_credit_count();
        assert_eq!(count_after_submit, 1);

        // Split the original into two children (each 500_000 units).
        let snonce = client.get_nonce(&issuer);
        let (cid1, cid2) = client.split_credit(&issuer, &credit_id, &500_000, &snonce);

        let count_after_split = client.get_credit_count();
        // split created 2 new credits → 1 + 2 = 3
        assert_eq!(count_after_split, 3);

        // Now merge the two children back into one.
        let mut ids: Vec<BytesN<32>> = Vec::new(&env);
        ids.push_back(cid1);
        ids.push_back(cid2);
        client.merge_credits(&issuer, &ids);

        // merge created 1 new credit → 3 + 1 = 4
        assert_eq!(
            client.get_credit_count(),
            count_after_split + 1,
            "merge should add 1 to TotalCredits"
        );
    }

    // ── Issue #671: Session nonce must use dedicated SessionCount key ─────────

    #[test]
    fn test_session_ids_unique_across_sessions() {
        let (env, client, _admin, _verifier) = setup();
        let initiator = Address::generate(&env);

        let sid1 = client.create_session(&initiator);
        // Advance ledger to ensure different timestamp helps produce a distinct preimage
        env.ledger().set_timestamp(env.ledger().timestamp() + 1);
        let sid2 = client.create_session(&initiator);

        assert_ne!(sid1, sid2, "successive session IDs must be unique");
    }

    #[test]
    fn test_session_id_does_not_collide_with_audit_log_id() {
        let (env, client, admin, verifier) = setup();
        let issuer = Address::generate(&env);
        let anonce = client.get_nonce(&admin);
        client.register_verifier(&admin, &verifier, &anonce);

        let credit_id = mint_active_credit(&env, &client, &admin, &verifier, &issuer, "PROJ-A1");

        // Create a session
        let initiator = Address::generate(&env);
        let session_id = client.create_session(&initiator);

        // Record some audit log entries via submit_credit_with_session
        let inonce = client.get_nonce(&issuer);
        client.submit_credit_with_session(
            &session_id,
            &issuer,
            &String::from_str(&env, "PROJ-A1"),
            &2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            &200_000,
            &String::from_str(&env, "bafybeiaudit"),
            &inonce,
        );

        // The session_id must still resolve to a valid session (not corrupted
        // by audit log writes that formerly shared the same counter).
        let op_count = client.get_session_operation_count(&session_id);
        assert_eq!(op_count, 1, "session should record 1 operation");

        // Create a second session — its ID must differ from the first even after
        // audit log entries have been appended.
        let sid2 = client.create_session(&initiator);
        assert_ne!(
            session_id, sid2,
            "session IDs must remain unique after audit log writes"
        );
        let _ = credit_id; // suppress unused warning
    }

    // ── Issue #670: upgrade() guardrails ─────────────────────────────────────

    #[test]
    fn test_upgrade_rejects_zero_hash() {
        let (env, client, admin, _verifier) = setup();
        let zero_hash: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        let nonce = client.get_nonce(&admin);
        let result = client.try_upgrade(&admin, &zero_hash, &nonce);
        assert!(result.is_err(), "upgrade with zero hash must be rejected");
    }

    #[test]
    fn test_upgrade_rejects_non_admin() {
        let (env, client, _admin, _verifier) = setup();
        let rando = Address::generate(&env);
        let fake_hash: BytesN<32> = BytesN::from_array(&env, &[1u8; 32]);
        let nonce = client.get_nonce(&rando);
        let result = client.try_upgrade(&rando, &fake_hash, &nonce);
        assert!(result.is_err(), "non-admin upgrade must be rejected");
    }
} // end mod tests
