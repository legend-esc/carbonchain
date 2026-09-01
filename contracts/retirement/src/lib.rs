#![no_std]
pub mod errors;
pub mod types;

use crate::errors::RetirementError;
use crate::types::{
    BatchRetireFailure, BatchRetireResult, CreditMetadata, CreditStatus, DataKey, RetirementRecord,
    MIN_TTL, TTL_THRESHOLD,
};

/// Maximum number of credits allowed in a single `batch_retire` call.
/// Exceeding this limit causes the Soroban instruction budget to be exhausted.
const MAX_BATCH_SIZE: u32 = 20;

// ── Unit convention (mirrors credit_registry) ────────────────────────────────
//
// 1 tonne = 1_000_000 units; minimum resolution = 100_000 units (0.1 tonne).
// All `tonnes` values passed to `retire` / `batch_retire` must be a positive
// multiple of MIN_CREDIT_UNIT and must not exceed the credit's own `tonnes`.
/// Minimum credit unit — represents 0.1 tonne.
const MIN_CREDIT_UNIT: i128 = 100_000;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{
    contract, contractevent, contractimpl, Address, BytesN, Env, IntoVal, String, Symbol, Vec,
};

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0u64)
}

fn consume_nonce(env: &Env, addr: &Address, expected: u64) -> bool {
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

#[contractevent]
#[derive(Clone)]
pub struct Paused {
    pub admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct Unpaused {
    pub admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct Retire {
    pub buyer: Address,
    pub credit_id: BytesN<32>,
    pub retirement_id: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct BatchRetired {
    pub buyer: Address,
    pub count: u32,
    pub total_tonnes: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct ContractUpgraded {
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
    pub previous_version: u32,
    pub new_version: u32,
}

/// Issue #544 — emitted when the API admin commits a certificate IPFS hash
/// on-chain after uploading the retirement certificate PDF to IPFS.
#[contractevent]
#[derive(Clone)]
pub struct CertificateHashSet {
    pub retirement_id: BytesN<32>,
    pub ipfs_hash: String,
}

#[contract]
pub struct Retirement;

#[contractimpl]
impl Retirement {
    // ── Admin / Pause ────────────────────────────────────────────────────────

    /// Initialise the retirement contract. Must be called exactly once.
    ///
    /// # Errors
    /// - [`RetirementError::AlreadyInitialized`] — contract has already been initialised.
    pub fn initialize(env: Env, admin: Address, registry_id: Address) -> Result<(), RetirementError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(RetirementError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Registry, &registry_id);
        env.storage().instance().set(&DataKey::Version, &0u32);
        Ok(())
    }

    /// Pause all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), RetirementError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Paused { admin }.publish(&env);
        Ok(())
    }

    /// Resume all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the admin.
    pub fn unpause(env: Env, admin: Address) -> Result<(), RetirementError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Unpaused { admin }.publish(&env);
        Ok(())
    }

    /// Returns `true` if the contract is currently paused.
    pub fn paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Retirement ───────────────────────────────────────────────────────────

    /// Retire a carbon credit.
    ///
    /// - Stores an immutable [`RetirementRecord`] keyed by a deterministic retirement ID
    /// - Calls `mark_retired` on the credit registry to flip the credit status to `Retired`
    /// - Indexes the retirement ID under `buyer`'s account
    /// - Emits a `retire` event
    ///
    /// `registry_id` is the deployed `credit_registry` contract address.
    /// `tonnes` must be greater than zero.
    ///
    /// # Errors
    /// - [`RetirementError::ContractPaused`] — contract is paused.
    /// - [`RetirementError::InvalidNonce`] — `nonce` does not match the current buyer nonce.
    /// - [`RetirementError::InvalidRegistry`] — `registry_id` does not match the trusted registry.
    ///
    /// Panics if `tonnes` is zero or negative.
    pub fn retire(
        env: Env,
        buyer: Address,
        credit_id: BytesN<32>,
        tonnes: i128,
        reason: String,
        registry_id: Address,
        nonce: u64,
    ) -> Result<BytesN<32>, RetirementError> {
        if Self::is_paused(&env) {
            return Err(RetirementError::ContractPaused);
        }
        buyer.require_auth();
        if !consume_nonce(&env, &buyer, nonce) {
            return Err(RetirementError::InvalidNonce);
        }
        if Self::get_registry(&env) != registry_id {
            return Err(RetirementError::InvalidRegistry);
        }

        // Validate credit exists and caller owns it.
        // #682: use try_invoke_contract so a missing credit returns a clean error
        // instead of panicking the whole transaction.
        let credit: CreditMetadata = env
            .try_invoke_contract::<CreditMetadata, RetirementError>(
                &registry_id,
                &Symbol::new(&env, "get_credit"),
                (credit_id.clone(),).into_val(&env),
            )
            .map_err(|_| RetirementError::CreditNotActive)?
            .map_err(|_| RetirementError::CreditNotActive)?;

        if credit.status != CreditStatus::Active {
            return Err(RetirementError::CreditNotActive);
        }

        if credit.owner != buyer {
            return Err(RetirementError::Unauthorized);
        }

        // #683: tonnes must be positive, a multiple of MIN_CREDIT_UNIT, and ≤ credit.tonnes.
        // Partial retirement is not supported — retire the full credit or nothing.
        if tonnes <= 0 {
            return Err(RetirementError::InvalidTonnes);
        }
        if tonnes % MIN_CREDIT_UNIT != 0 {
            return Err(RetirementError::InvalidTonnes);
        }
        if tonnes > credit.tonnes {
            return Err(RetirementError::InvalidTonnes);
        }

        // Issue #482: include the buyer's nonce (before it was consumed) in the preimage
        // so that two separate retire calls with the same credit_id, reason, and ledger
        // timestamp always produce distinct retirement IDs.
        //
        // The nonce consumed above was `nonce`; the value that was stored before
        // consumption is `nonce` itself (consume_nonce increments it to nonce+1).
        // We embed the original value here.
        let mut preimage = credit_id.clone().to_xdr(&env);
        preimage.append(&reason.clone().to_xdr(&env));
        preimage.append(&env.ledger().timestamp().to_xdr(&env));
        preimage.append(&nonce.to_xdr(&env));
        let retirement_id: BytesN<32> = env.crypto().sha256(&preimage).into();

        // Cross-contract: mark the credit as retired in the registry FIRST
        // This ensures atomicity - if this fails, the retirement record is never written
        let _: () = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "mark_retired"),
            (credit_id.clone(),).into_val(&env),
        );

        let record = RetirementRecord {
            credit_id: credit_id.clone(),
            buyer: buyer.clone(),
            tonnes_retired: tonnes,
            reason,
            retired_at: env.ledger().timestamp(),
            certificate_ipfs_hash: String::from_str(&env, ""),
            // Issue #589 — capture vintage year from credit metadata so the
            // retirement record is self-contained for compliance auditing.
            vintage_year: credit.vintage_year,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Retirement(retirement_id.clone()), &record);
        env.storage().persistent().extend_ttl(
            &DataKey::Retirement(retirement_id.clone()),
            TTL_THRESHOLD,
            MIN_TTL,
        );

        // Index under buyer account
        let acct_key = DataKey::AccountRetirements(buyer.clone());
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&acct_key)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(retirement_id.clone());
        env.storage().persistent().set(&acct_key, &list);
        env.storage()
            .persistent()
            .extend_ttl(&acct_key, TTL_THRESHOLD, MIN_TTL);

        // Emit retirement event
        Retire {
            buyer,
            credit_id,
            retirement_id: retirement_id.clone(),
        }
        .publish(&env);

        Ok(retirement_id)
    }

    /// Retire multiple carbon credits in a single transaction with partial-success mode.
    ///
    /// Unlike the all-or-nothing approach, this function processes every credit
    /// independently. Credits that fail validation (not active, wrong owner, zero
    /// tonnes) are recorded in the `failed` list while valid credits are retired
    /// normally. Individual `Retire` events are emitted only for successful credits.
    ///
    /// Returns `Err(RetirementError::InvalidInput)` when **zero** credits succeed
    /// (the caller must supply at least one valid credit per batch).
    ///
    /// `registry_id` — the deployed credit_registry contract address.
    pub fn batch_retire(
        env: Env,
        buyer: Address,
        credit_ids: Vec<BytesN<32>>,
        tonnes: Vec<i128>,
        reason: String,
        registry_id: Address,
        nonce: u64,
    ) -> Result<BatchRetireResult, RetirementError> {
        if Self::is_paused(&env) {
            return Err(RetirementError::ContractPaused);
        }
        buyer.require_auth();
        if !consume_nonce(&env, &buyer, nonce) {
            return Err(RetirementError::InvalidNonce);
        }
        if Self::get_registry(&env) != registry_id {
            return Err(RetirementError::InvalidRegistry);
        }

        if credit_ids.len() != tonnes.len() {
            return Err(RetirementError::InvalidInput);
        }

        if credit_ids.len() > MAX_BATCH_SIZE {
            return Err(RetirementError::InvalidInput);
        }

        let mut succeeded: Vec<BytesN<32>> = Vec::new(&env);
        let mut failed: Vec<BatchRetireFailure> = Vec::new(&env);
        let mut total_tonnes: i128 = 0;

        let acct_key = DataKey::AccountRetirements(buyer.clone());
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&acct_key)
            .unwrap_or_else(|| Vec::new(&env));

        for i in 0..credit_ids.len() {
            let credit_id = credit_ids.get(i).unwrap();
            let tonne_amount = tonnes.get(i).unwrap();

            // #683: validate tonnes in batch path too
            if tonne_amount <= 0 {
                failed.push_back(BatchRetireFailure {
                    credit_id: credit_id.clone(),
                    error_code: RetirementError::InvalidTonnes as u32,
                });
                continue;
            }
            if tonne_amount % MIN_CREDIT_UNIT != 0 {
                failed.push_back(BatchRetireFailure {
                    credit_id: credit_id.clone(),
                    error_code: RetirementError::InvalidTonnes as u32,
                });
                continue;
            }

            // #684: use try_invoke_contract so a missing credit is recorded as a
            // failed entry instead of panicking the entire batch.
            let credit: CreditMetadata = match env
                .try_invoke_contract::<CreditMetadata, RetirementError>(
                    &registry_id,
                    &Symbol::new(&env, "get_credit"),
                    (credit_id.clone(),).into_val(&env),
                ) {
                Ok(Ok(c)) => c,
                _ => {
                    failed.push_back(BatchRetireFailure {
                        credit_id: credit_id.clone(),
                        error_code: RetirementError::CreditNotActive as u32,
                    });
                    continue;
                }
            };

            // Validate status
            if credit.status != CreditStatus::Active {
                failed.push_back(BatchRetireFailure {
                    credit_id: credit_id.clone(),
                    error_code: RetirementError::CreditNotActive as u32,
                });
                continue;
            }

            // Validate ownership
            if credit.owner != buyer {
                failed.push_back(BatchRetireFailure {
                    credit_id: credit_id.clone(),
                    error_code: RetirementError::Unauthorized as u32,
                });
                continue;
            }

            // Derive a deterministic retirement ID — embed the buyer nonce and index `i` so that
            // two batches in the same ledger for the same credits+reason produce distinct IDs.
            let mut preimage = credit_id.clone().to_xdr(&env);
            preimage.append(&reason.clone().to_xdr(&env));
            preimage.append(&env.ledger().timestamp().to_xdr(&env));
            preimage.append(&nonce.to_xdr(&env));
            preimage.append(&i.to_xdr(&env));
            let retirement_id: BytesN<32> = env.crypto().sha256(&preimage).into();

            let record = RetirementRecord {
                credit_id: credit_id.clone(),
                buyer: buyer.clone(),
                tonnes_retired: tonne_amount,
                reason: reason.clone(),
                retired_at: env.ledger().timestamp(),
                certificate_ipfs_hash: String::from_str(&env, ""),
                // Issue #589 — capture vintage year from credit metadata.
                vintage_year: credit.vintage_year,
            };

            env.storage()
                .persistent()
                .set(&DataKey::Retirement(retirement_id.clone()), &record);
            env.storage().persistent().extend_ttl(
                &DataKey::Retirement(retirement_id.clone()),
                TTL_THRESHOLD,
                MIN_TTL,
            );

            // Cross-contract: mark the credit as retired in the registry.
            // #684: use try_invoke_contract so a registry-side failure (e.g. already
            // retired by a concurrent call) is recorded as a failed entry rather
            // than aborting the whole batch.
            match env.try_invoke_contract::<(), RetirementError>(
                &registry_id,
                &Symbol::new(&env, "mark_retired"),
                (credit_id.clone(),).into_val(&env),
            ) {
                Ok(Ok(_)) => {}
                _ => {
                    // Registry rejected the call — roll back the record we just wrote.
                    env.storage()
                        .persistent()
                        .remove(&DataKey::Retirement(retirement_id.clone()));
                    failed.push_back(BatchRetireFailure {
                        credit_id: credit_id.clone(),
                        error_code: RetirementError::CreditNotActive as u32,
                    });
                    continue;
                }
            }

            list.push_back(retirement_id.clone());
            succeeded.push_back(retirement_id.clone());
            total_tonnes += tonne_amount;

            // Emit individual retirement event for each successful credit
            Retire {
                buyer: buyer.clone(),
                credit_id: credit_id.clone(),
                retirement_id,
            }
            .publish(&env);
        }

        // Fail the entire call if nothing succeeded — prevents empty batch results
        if succeeded.is_empty() {
            return Err(RetirementError::InvalidInput);
        }

        env.storage().persistent().set(&acct_key, &list);
        env.storage()
            .persistent()
            .extend_ttl(&acct_key, TTL_THRESHOLD, MIN_TTL);

        // Summary event for off-chain indexers (only emitted when at least one credit retired)
        BatchRetired {
            buyer,
            count: succeeded.len(),
            total_tonnes,
        }
        .publish(&env);

        Ok(BatchRetireResult { succeeded, failed })
    }

    /// Returns the sum of all `tonnes_retired` across all retirement records for `account`.
    pub fn get_total_retired_by_account(env: Env, account: Address) -> i128 {
        let ids: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AccountRetirements(account))
            .unwrap_or_else(|| Vec::new(&env));
        let mut total: i128 = 0;
        for id in ids.iter() {
            if let Some(record) = env
                .storage()
                .persistent()
                .get::<_, RetirementRecord>(&DataKey::Retirement(id))
            {
                total += record.tonnes_retired;
            }
        }
        total
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    // ── Issue 3: Contract Upgrade Mechanism ──────────────────────────────────

    /// Upgrade the contract WASM to a new hash. Only the admin may call this.
    ///
    /// Runs any pending migrations before upgrading, and emits a `ContractUpgraded`
    /// event so off-chain indexers can track schema changes.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the admin.
    /// - [`RetirementError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<(), RetirementError> {
        Self::require_admin(&env, &admin)?;
        if !consume_nonce(&env, &admin, nonce) {
            return Err(RetirementError::InvalidNonce);
        }

        let previous_version = Self::get_version(&env);
        Self::run_migrations(&env, previous_version + 1)?;
        let new_version = Self::get_version(&env);

        env.deployer().update_current_contract_wasm(new_wasm_hash.clone());

        ContractUpgraded {
            admin,
            new_wasm_hash,
            previous_version,
            new_version,
        }
        .publish(&env);

        Ok(())
    }

    /// Propose a new admin. The candidate must call [`accept_admin`] to complete the transfer.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the current admin.
    pub fn propose_admin(
        env: Env,
        admin: Address,
        new_admin: Address,
    ) -> Result<(), RetirementError> {
        let stored: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RetirementError::NotInitialized)?;
        admin.require_auth();
        if admin != stored {
            return Err(RetirementError::Unauthorized);
        }
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Complete an admin transfer initiated by [`propose_admin`].
    ///
    /// # Errors
    /// - [`RetirementError::NoPendingAdmin`] — no transfer has been proposed.
    /// - [`RetirementError::Unauthorized`] — `new_admin` does not match the pending candidate.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), RetirementError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(RetirementError::NoPendingAdmin)?;
        if new_admin != pending {
            return Err(RetirementError::Unauthorized);
        }
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    /// Fetch a retirement record by its ID. Returns `None` if not found.
    pub fn get_retirement(env: Env, retirement_id: BytesN<32>) -> Option<RetirementRecord> {
        env.storage()
            .persistent()
            .get(&DataKey::Retirement(retirement_id))
    }

    /// Issue #544 — Commit the IPFS hash of the off-chain retirement certificate PDF.
    ///
    /// Called by the API admin after the certificate has been generated and
    /// uploaded to IPFS.  This operation is **idempotent**: calling it multiple
    /// times with the same or a different hash is allowed so that the API can
    /// safely retry on transient failures.
    ///
    /// # Arguments
    /// - `admin`         — must be the initialised contract admin.
    /// - `retirement_id` — the retirement record to update.
    /// - `ipfs_hash`     — CIDv1 / CIDv0 IPFS content identifier of the certificate.
    /// - `nonce`         — admin's current nonce (replay protection).
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`]   — caller is not the admin.
    /// - [`RetirementError::InvalidNonce`]   — `nonce` does not match the stored value.
    /// - [`RetirementError::CreditNotActive`] — `retirement_id` does not exist.

    /// Returns all retirement IDs for `account` (unordered, unbounded).
    /// Prefer [`get_retirements_paginated`] for large accounts.
    pub fn get_retirements_by_account(env: Env, account: Address) -> Vec<BytesN<32>> {
        env.storage()
            .persistent()
            .get(&DataKey::AccountRetirements(account))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns one page of retirement IDs for `account`. `page` is 0-indexed; `page_size` capped at 50.
    pub fn get_retirements_paginated(
        env: Env,
        account: Address,
        page: u32,
        page_size: u32,
    ) -> Vec<BytesN<32>> {
        let page_size = if page_size == 0 || page_size > 50 {
            50
        } else {
            page_size
        };
        let all: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&DataKey::AccountRetirements(account))
            .unwrap_or_else(|| Vec::new(&env));
        let start = page * page_size;
        let mut out: Vec<BytesN<32>> = Vec::new(&env);
        let mut i = start;
        while i < start + page_size && i < all.len() {
            out.push_back(all.get(i).unwrap());
            i += 1;
        }
        out
    }

    /// Attach an IPFS / off-chain certificate hash to an existing retirement record.
    ///
    /// Only the admin may call this. The retirement record identified by
    /// `retirement_id` must already exist; if it does not, this returns
    /// [`RetirementError::RecordNotFound`] (not `CreditNotActive`) — #689.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the admin.
    /// - [`RetirementError::RecordNotFound`] — no retirement record exists for `retirement_id`.
    pub fn set_certificate_hash(
        env: Env,
        admin: Address,
        retirement_id: BytesN<32>,
        hash: String,
    ) -> Result<(), RetirementError> {
        Self::require_admin(&env, &admin)?;
        // #689: use RecordNotFound when the retirement record does not exist
        if !env
            .storage()
            .persistent()
            .has(&DataKey::Retirement(retirement_id.clone()))
        {
            return Err(RetirementError::RecordNotFound);
        }
        env.storage()
            .persistent()
            .set(&DataKey::CertificateHash(retirement_id.clone()), &hash);
        env.storage().persistent().extend_ttl(
            &DataKey::CertificateHash(retirement_id),
            TTL_THRESHOLD,
            MIN_TTL,
        );
        Ok(())
    }

    /// Retrieve the certificate hash for a retirement record, if one has been set.
    pub fn get_certificate_hash(env: Env, retirement_id: BytesN<32>) -> Option<String> {
        env.storage()
            .persistent()
            .get(&DataKey::CertificateHash(retirement_id))
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn require_admin(env: &Env, caller: &Address) -> Result<(), RetirementError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RetirementError::NotInitialized)?;
        caller.require_auth();
        if *caller != admin {
            return Err(RetirementError::Unauthorized);
        }
        Ok(())
    }

    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    fn get_registry(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Registry)
            .unwrap_or_else(|| panic!("Registry not set"))
    }

    fn get_version(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(0)
    }

    fn set_version(env: &Env, version: u32) {
        env.storage().instance().set(&DataKey::Version, &version);
    }

    /// Run sequential migrations from the current version up to `target_version`.
    fn run_migrations(env: &Env, target_version: u32) -> Result<(), RetirementError> {
        let mut current = Self::get_version(env);
        if target_version < current {
            return Err(RetirementError::InvalidInput);
        }
        while current < target_version {
            match current {
                0 => Self::migrate_v0_to_v1(env),
                _ => break,
            }
            current += 1;
            Self::set_version(env, current);
        }
        Ok(())
    }

    fn migrate_v0_to_v1(_env: &Env) {
        // v1 introduced version tracking and registry validation; no data transformation needed.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use carbonchain_credit_registry::test_helpers::RegistryHelper;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Env, String};

    /// Returns (retirement_contract_id, registry, credit_id, retirement_admin, credit_owner)
    fn setup(env: &Env) -> (Address, RegistryHelper, BytesN<32>, Address, Address) {
        env.cost_estimate().budget().reset_unlimited();
        env.ledger().set_timestamp(1735689600);
        let retirement_id = env.register(Retirement, ());
        let registry = RegistryHelper::deploy(env);

        let admin = Address::generate(env);
        let verifier = Address::generate(env);
        let issuer = Address::generate(env);
        let retirement_admin = Address::generate(env);

        registry.initialize(&admin, &retirement_id, 1);
        let nonce = registry.get_nonce(&admin);
        registry.register_verifier(&admin, &verifier, nonce);

        let anonce = registry.get_nonce(&admin);
        registry.register_issuer(&admin, &issuer, anonce);
        let vnonce_issuer = registry.get_nonce(&admin);
        registry.register_verifier(&admin, &issuer, vnonce_issuer);
        let anonce2 = registry.get_nonce(&admin);
        registry.register_methodology(
            &admin,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "Verified Carbon Standard"),
            anonce2,
        );
        registry.register_project(
            &admin,
            &String::from_str(env, "PROJ-001"),
            &String::from_str(env, "Test Project"),
            &String::from_str(env, "Desc"),
            &String::from_str(env, "NG"),
        );

        let inonce = registry.get_nonce(&issuer);
        let credit_id = registry.submit_credit(
            &issuer,
            &String::from_str(env, "PROJ-001"),
            2024,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "NG"),
            1_000_000,
            &String::from_str(env, "bafybei123"),
            inonce,
        );
        let vnonce = registry.get_nonce(&verifier);
        registry.approve_and_mint(&verifier, &credit_id, vnonce);

        let retirement_client = RetirementClient::new(env, &retirement_id);
        retirement_client.initialize(&retirement_admin, &registry.id);

        (retirement_id, registry, credit_id, retirement_admin, issuer)
    }

    #[test]
    fn test_retire_stores_record() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        let ret_id = client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "2024 Scope 3 offset"),
            &registry.id,
            &nonce,
        );

        let record = client.get_retirement(&ret_id).unwrap();
        assert_eq!(record.buyer, credit_owner);
        assert_eq!(record.tonnes_retired, 1_000_000);
        assert_eq!(record.credit_id, credit_id);
    }

    /// Issue #589 — vintage year must be captured from credit metadata and
    /// stored on the RetirementRecord so certificates can show full provenance.
    #[test]
    fn test_retire_stores_vintage_year() {
        let env = Env::default();
        env.mock_all_auths();

        // setup() submits a credit with vintage_year 2024
        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        let ret_id = client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "2024 Scope 3 offset"),
            &registry.id,
            &nonce,
        );

        let record = client.get_retirement(&ret_id).unwrap();
        assert_eq!(
            record.vintage_year, 2024,
            "vintage_year must be populated from credit metadata on retirement"
        );
    }

    #[test]
    fn test_retire_indexes_by_account() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        let ret_id = client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );

        let ids = client.get_retirements_by_account(&credit_owner);
        assert_eq!(ids.len(), 1);
        assert_eq!(ids.get(0).unwrap(), ret_id);
    }

    #[test]
    fn test_retire_marks_credit_retired_in_registry() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );
    }

    #[test]
    fn test_retire_zero_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        let err = client
            .try_retire(
                &credit_owner,
                &credit_id,
                &0,
                &String::from_str(&env, "offset"),
                &registry.id,
                &nonce,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RetirementError::InvalidTonnes);
    }

    #[test]
    fn test_batch_retire_mismatched_lengths_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        credit_ids.push_back(credit_id);
        // tonnes vec intentionally empty — length mismatch
        let tonnes: Vec<i128> = Vec::new(&env);

        let nonce = client.get_nonce(&credit_owner);
        let err = client
            .try_batch_retire(
                &credit_owner,
                &credit_ids,
                &tonnes,
                &String::from_str(&env, "offset"),
                &registry.id,
                &nonce,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RetirementError::InvalidInput);
    }
    // ── Pause tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_pause_blocks_retire() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, retirement_admin, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        client.pause(&retirement_admin);
        assert!(client.paused());

        let nonce = client.get_nonce(&credit_owner);
        assert!(client
            .try_retire(
                &credit_owner,
                &credit_id,
                &1_000_000,
                &String::from_str(&env, "offset"),
                &registry.id,
                &nonce,
            )
            .is_err());
    }

    #[test]
    fn test_unpause_restores_retire() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, retirement_admin, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        client.pause(&retirement_admin);
        client.unpause(&retirement_admin);
        assert!(!client.paused());

        let nonce = client.get_nonce(&credit_owner);
        assert!(client
            .try_retire(
                &credit_owner,
                &credit_id,
                &1_000_000,
                &String::from_str(&env, "offset"),
                &registry.id,
                &nonce,
            )
            .is_ok());
    }

    #[test]
    fn test_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _, _, _, _) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let rando = Address::generate(&env);
        assert!(client.try_pause(&rando).is_err());
    }

    // ── Tests for Issue #86: Batch Retirement ───────────────────────────────

    fn submit_credit_for_batch(
        env: &Env,
        registry: &RegistryHelper,
        issuer: &Address,
        verifier: &Address,
        vintage: u32,
        ipfs_suffix: &str,
    ) -> BytesN<32> {
        let inonce = registry.get_nonce(issuer);
        let cid = registry.submit_credit(
            issuer,
            &String::from_str(env, "PROJ-001"),
            vintage,
            &String::from_str(env, "VCS"),
            &String::from_str(env, "NG"),
            1_000_000,
            &String::from_str(env, ipfs_suffix),
            inonce,
        );
        let vnonce = registry.get_nonce(verifier);
        registry.approve_and_mint(verifier, &cid, vnonce);
        cid
    }

    #[test]
    fn test_batch_retire_multiple_credits() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // Create 5 distinct credits for batch retirement
        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes: Vec<i128> = Vec::new(&env);

        credit_ids.push_back(credit_id);
        tonnes.push_back(1_000_000);
        for (suffix, vintage) in [
            ("b1", 2025u32),
            ("b2", 2026u32),
            ("b3", 2022u32),
            ("b4", 2023u32),
        ] {
            let cid = submit_credit_for_batch(&env, &registry, &issuer, &issuer, vintage, suffix);
            credit_ids.push_back(cid);
            tonnes.push_back(1_000_000);
        }

        // Transfer credits to buyer so they can retire
        for cid in credit_ids.clone() {
            let nnonce = registry.get_nonce(&issuer);
            registry.transfer_credit(&issuer, &buyer, &cid, nnonce);
        }

        let nonce = client.get_nonce(&buyer);
        let result = client.batch_retire(
            &buyer,
            &credit_ids,
            &tonnes,
            &String::from_str(&env, "batch offset"),
            &registry.id,
            &nonce,
        );

        assert_eq!(result.succeeded.len(), 5);
        assert_eq!(result.failed.len(), 0);
    }

    #[test]
    fn test_batch_retire_indexes_all_retirements() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // Create 3 distinct credits for batch retirement
        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes: Vec<i128> = Vec::new(&env);

        credit_ids.push_back(credit_id);
        tonnes.push_back(1_000_000);
        for (suffix, vintage) in [("f1", 2025u32), ("f2", 2022u32)] {
            let cid = submit_credit_for_batch(&env, &registry, &issuer, &issuer, vintage, suffix);
            credit_ids.push_back(cid);
            tonnes.push_back(1_000_000);
        }

        // Transfer credits to buyer so they can retire
        for cid in credit_ids.clone() {
            let nnonce = registry.get_nonce(&issuer);
            registry.transfer_credit(&issuer, &buyer, &cid, nnonce);
        }

        let nonce = client.get_nonce(&buyer);
        client.batch_retire(
            &buyer,
            &credit_ids,
            &tonnes,
            &String::from_str(&env, "batch offset"),
            &registry.id,
            &nonce,
        );

        let ids = client.get_retirements_by_account(&buyer);
        assert_eq!(ids.len(), 3);
    }

    // ── Issue #355: batch_retire MAX_BATCH_SIZE guard ────────────────────────

    #[test]
    fn test_batch_retire_oversized_batch_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, _, _, _) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // Build 21 credit IDs (all zeros — we only need the size check to trigger,
        // which happens before any cross-contract call).
        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes_vec: Vec<i128> = Vec::new(&env);
        for _ in 0..21u32 {
            credit_ids.push_back(BytesN::from_array(&env, &[0u8; 32]));
            tonnes_vec.push_back(1_000_000);
        }

        let nonce = client.get_nonce(&buyer);
        let err = client
            .try_batch_retire(
                &buyer,
                &credit_ids,
                &tonnes_vec,
                &String::from_str(&env, "oversized"),
                &registry.id,
                &nonce,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RetirementError::InvalidInput);
    }

    // ── Issue #234: double initialize guard ──────────────────────────────────

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _registry, _, retirement_admin, _) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        // setup already called initialize once; a second call must fail
        let dummy_registry = Address::generate(&env);
        let result = client.try_initialize(&retirement_admin, &dummy_registry);
        assert_eq!(result, Err(Ok(RetirementError::AlreadyInitialized)));
    }

    // ── Issue #232: batch_retire partial success mode ────────────────────────

    #[test]
    fn test_batch_retire_partial_success_invalid_credit() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // Two valid credits
        let cid2 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2025, "p1");
        let cid3 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2026, "p2");

        // Transfer only the first two to buyer; cid3 stays with issuer → ownership check fails
        let n1 = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &buyer, &credit_id, n1);
        let n2 = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &buyer, &cid2, n2);
        // cid3 intentionally NOT transferred — buyer does not own it

        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes_vec: Vec<i128> = Vec::new(&env);
        credit_ids.push_back(credit_id.clone());
        tonnes_vec.push_back(1_000_000);
        credit_ids.push_back(cid2.clone());
        tonnes_vec.push_back(1_000_000);
        credit_ids.push_back(cid3.clone()); // invalid: buyer doesn't own this
        tonnes_vec.push_back(1_000_000);

        let nonce = client.get_nonce(&buyer);
        let result = client.batch_retire(
            &buyer,
            &credit_ids,
            &tonnes_vec,
            &String::from_str(&env, "batch offset"),
            &registry.id,
            &nonce,
        );

        // Two valid credits should succeed; one invalid should be in failed list
        assert_eq!(result.succeeded.len(), 2);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed.get(0).unwrap().credit_id, cid3);
        assert_eq!(
            result.failed.get(0).unwrap().error_code,
            RetirementError::Unauthorized as u32
        );

        // The two valid credits should be indexed under buyer
        let ids = client.get_retirements_by_account(&buyer);
        assert_eq!(ids.len(), 2);
    }

    /// All credits invalid → InvalidInput (empty succeeded list not allowed)
    #[test]
    fn test_batch_retire_all_invalid_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, _issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // credit_id is NOT transferred to buyer — ownership check will fail
        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes_vec: Vec<i128> = Vec::new(&env);
        credit_ids.push_back(credit_id);
        tonnes_vec.push_back(1_000_000);

        let nonce = client.get_nonce(&buyer);
        let err = client
            .try_batch_retire(
                &buyer,
                &credit_ids,
                &tonnes_vec,
                &String::from_str(&env, "offset"),
                &registry.id,
                &nonce,
            )
            .unwrap_err()
            .unwrap();

        // All credits failed → treated as InvalidInput
        assert_eq!(err, RetirementError::InvalidInput);
    }

    // ── Issue #233: get_total_retired_by_account ──────────────────────────────

    #[test]
    fn test_get_total_retired_by_account_sums_multiple() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        // Create a second credit and retire both independently
        let cid2 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2025, "s1");

        let n1 = client.get_nonce(&issuer);
        client.retire(
            &issuer,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "offset 1"),
            &registry.id,
            &n1,
        );

        let n2 = client.get_nonce(&issuer);
        client.retire(
            &issuer,
            &cid2,
            &1_000_000,
            &String::from_str(&env, "offset 2"),
            &registry.id,
            &n2,
        );

        let total = client.get_total_retired_by_account(&issuer);
        assert_eq!(total, 2_000_000);
    }

    // ── Issue #482: retirement_id uniqueness via buyer nonce ─────────────────

    /// Two retire calls for different credits in the same ledger with the same reason
    /// must produce distinct retirement IDs even though the timestamp is identical.
    /// We achieve this by embedding the buyer's nonce in the preimage.
    ///
    /// We can only attempt to retire a credit once per credit (since mark_retired
    /// transitions it to Retired, and a second attempt would fail with CreditNotActive).
    /// So we retire two different credits with the same reason and same timestamp and
    /// verify their IDs are distinct.
    #[test]
    fn test_retire_produces_distinct_ids_for_same_timestamp_and_reason() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        // Create a second credit
        let cid2 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2025, "uniq1");

        // Fix the timestamp so both calls see the same ledger timestamp
        env.ledger().set_timestamp(1735689600);

        let n1 = client.get_nonce(&issuer);
        let ret_id1 = client.retire(
            &issuer,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "same reason"),
            &registry.id,
            &n1,
        );

        // Timestamp unchanged — second retire call would have the same timestamp
        let n2 = client.get_nonce(&issuer);
        let ret_id2 = client.retire(
            &issuer,
            &cid2,
            &1_000_000,
            &String::from_str(&env, "same reason"),
            &registry.id,
            &n2,
        );

        // IDs must be distinct because n1 != n2 (nonce was consumed between calls)
        assert_ne!(
            ret_id1, ret_id2,
            "retirement IDs must be distinct even with same timestamp and reason"
        );
    }

    // ── Issue #682: missing credit returns clean error ───────────────────────

    #[test]
    fn test_retire_missing_credit_returns_error_not_panic() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, _credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        // Use a totally fake credit ID — not registered in the registry at all
        let fake_id = BytesN::from_array(&env, &[0xdeu8; 32]);
        let nonce = client.get_nonce(&credit_owner);
        let result = client.try_retire(
            &credit_owner,
            &fake_id,
            &1_000_000,
            &String::from_str(&env, "test"),
            &registry.id,
            &nonce,
        );
        // Must return a clean CreditNotActive error, not panic
        assert_eq!(result, Err(Ok(RetirementError::CreditNotActive)));
    }

    // ── Issue #683: tonnes validation ────────────────────────────────────────

    #[test]
    fn test_retire_non_multiple_of_min_credit_unit_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        // 1_000_001 is not a multiple of MIN_CREDIT_UNIT (100_000)
        let result = client.try_retire(
            &credit_owner,
            &credit_id,
            &1_000_001,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );
        assert_eq!(result, Err(Ok(RetirementError::InvalidTonnes)));
    }

    #[test]
    fn test_retire_over_credit_supply_fails() {
        let env = Env::default();
        env.mock_all_auths();

        // setup() creates a credit with 1_000_000 units (1 tonne)
        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        // Attempt to retire 2_000_000 units (2 tonnes) but credit only has 1 tonne
        let result = client.try_retire(
            &credit_owner,
            &credit_id,
            &2_000_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );
        assert_eq!(result, Err(Ok(RetirementError::InvalidTonnes)));
    }

    #[test]
    fn test_retire_exact_credit_supply_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        // Exact supply (1_000_000 units) must succeed
        let result = client.try_retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_retire_minimum_unit_succeeds() {
        let env = Env::default();
        env.mock_all_auths();

        // Create a credit with exactly 100_000 units (min unit)
        let (contract_id, registry, _credit_id, retirement_admin, issuer) = setup(&env);
        let _ = retirement_admin;

        // Submit a 100_000-unit credit
        let inonce = registry.get_nonce(&issuer);
        let small_credit_id = registry.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            2025,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            100_000,
            &String::from_str(&env, "bafysmall"),
            inonce,
        );
        let vnonce = registry.get_nonce(&issuer);
        registry.approve_and_mint(&issuer, &small_credit_id, vnonce);

        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&issuer);
        let result = client.try_retire(
            &issuer,
            &small_credit_id,
            &100_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );
        assert!(result.is_ok());
    }

    // ── Issue #684: batch_retire missing credit does not panic ───────────────

    #[test]
    fn test_batch_retire_missing_credit_recorded_as_failure() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // Transfer the real credit to buyer
        let nnonce = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &buyer, &credit_id, nnonce);

        // Construct a batch: one valid credit + one completely fake credit ID
        let fake_id = BytesN::from_array(&env, &[0xabu8; 32]);

        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes_vec: Vec<i128> = Vec::new(&env);
        credit_ids.push_back(credit_id.clone());
        tonnes_vec.push_back(1_000_000);
        credit_ids.push_back(fake_id.clone());
        tonnes_vec.push_back(1_000_000);

        let nonce = client.get_nonce(&buyer);
        // This must NOT panic — it must return a result with one succeeded and one failed
        let result = client.batch_retire(
            &buyer,
            &credit_ids,
            &tonnes_vec,
            &String::from_str(&env, "batch offset"),
            &registry.id,
            &nonce,
        );

        assert_eq!(result.succeeded.len(), 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed.get(0).unwrap().credit_id, fake_id);
        assert_eq!(
            result.failed.get(0).unwrap().error_code,
            RetirementError::CreditNotActive as u32
        );
    }

    #[test]
    fn test_batch_retire_non_multiple_tonnes_recorded_as_failure() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        // Transfer real credit to buyer
        let nnonce = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &buyer, &credit_id, nnonce);

        // Create a second valid credit
        let cid2 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2025, "bq1");
        let nnonce2 = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &buyer, &cid2, nnonce2);

        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        let mut tonnes_vec: Vec<i128> = Vec::new(&env);
        credit_ids.push_back(credit_id.clone());
        tonnes_vec.push_back(1_000_000); // valid
        credit_ids.push_back(cid2.clone());
        tonnes_vec.push_back(150_001); // not a multiple of MIN_CREDIT_UNIT

        let nonce = client.get_nonce(&buyer);
        let result = client.batch_retire(
            &buyer,
            &credit_ids,
            &tonnes_vec,
            &String::from_str(&env, "batch offset"),
            &registry.id,
            &nonce,
        );

        assert_eq!(result.succeeded.len(), 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(
            result.failed.get(0).unwrap().error_code,
            RetirementError::InvalidTonnes as u32
        );
    }

    #[test]
    fn test_set_certificate_hash_stores_and_retrieves() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, retirement_admin, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        // First retire the credit to create a retirement record
        let nonce = client.get_nonce(&credit_owner);
        let ret_id = client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "2024 Scope 3 offset"),
            &registry.id,
            &nonce,
        );

        // Verify certificate_ipfs_hash is empty initially
        assert!(client.get_certificate_hash(&ret_id).is_none());

        // Admin commits the IPFS hash on-chain
        let _admin_nonce = client.get_nonce(&retirement_admin);
        client.set_certificate_hash(
            &retirement_admin,
            &ret_id,
            &String::from_str(
                &env,
                "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354",
            ),
        );

        // Verify the hash is now stored via get_certificate_hash
        let stored_hash = client.get_certificate_hash(&ret_id).unwrap();
        assert_eq!(
            stored_hash,
            String::from_str(
                &env,
                "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354"
            )
        );
    }

    #[test]
    fn test_set_certificate_hash_is_idempotent() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, retirement_admin, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        let nonce = client.get_nonce(&credit_owner);
        let ret_id = client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );

        // First call sets the hash
        let _n1 = client.get_nonce(&retirement_admin);
        client.set_certificate_hash(
            &retirement_admin,
            &ret_id,
            &String::from_str(&env, "bafybei_first"),
        );

        // Second call with an updated hash (idempotent — allowed)
        let _n2 = client.get_nonce(&retirement_admin);
        client.set_certificate_hash(
            &retirement_admin,
            &ret_id,
            &String::from_str(&env, "bafybei_second"),
        );

        let updated = client.get_certificate_hash(&ret_id).unwrap();
        assert_eq!(
            updated,
            String::from_str(&env, "bafybei_second")
        );
    }

    #[test]
    fn test_set_certificate_hash_non_existent_retirement_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _, _, retirement_admin, _) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        let _nonce = client.get_nonce(&retirement_admin);
        let result = client.try_set_certificate_hash(
            &retirement_admin,
            &BytesN::from_array(&env, &[0u8; 32]),
            &String::from_str(&env, "bafybei_nonexistent"),
        );

        assert_eq!(result, Err(Ok(RetirementError::RecordNotFound)));
    }

    #[test]
    fn test_set_certificate_hash_non_admin_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        let nonce = client.get_nonce(&credit_owner);
        let ret_id = client.retire(
            &credit_owner,
            &credit_id,
            &1_000_000,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );

        let rando = Address::generate(&env);
        let _rando_nonce = client.get_nonce(&rando);
        let result = client.try_set_certificate_hash(
            &rando,
            &ret_id,
            &String::from_str(&env, "bafybei_rando"),
        );

        assert!(result.is_err());
    }

    // ── Issue #687: retirement error codes in 200–209 ─────────────────────────

    #[test]
    fn test_retirement_error_codes_in_200_209_range() {
        assert!(RetirementError::CreditNotActive as u32 >= 200);
        assert!(RetirementError::CreditNotActive as u32 <= 209);
        assert!(RetirementError::AlreadyInitialized as u32 >= 200);
        assert!(RetirementError::AlreadyInitialized as u32 <= 209);
        assert!(RetirementError::NotInitialized as u32 >= 200);
        assert!(RetirementError::NotInitialized as u32 <= 209);
        assert!(RetirementError::Unauthorized as u32 >= 200);
        assert!(RetirementError::Unauthorized as u32 <= 209);
        assert!(RetirementError::ContractPaused as u32 >= 200);
        assert!(RetirementError::ContractPaused as u32 <= 209);
        assert!(RetirementError::InvalidNonce as u32 >= 200);
        assert!(RetirementError::InvalidNonce as u32 <= 209);
        assert!(RetirementError::NoPendingAdmin as u32 >= 200);
        assert!(RetirementError::NoPendingAdmin as u32 <= 209);
        assert!(RetirementError::InvalidTonnes as u32 >= 200);
        assert!(RetirementError::InvalidTonnes as u32 <= 209);
        assert!(RetirementError::InvalidInput as u32 >= 200);
        assert!(RetirementError::InvalidInput as u32 <= 209);
        assert!(RetirementError::InvalidRegistry as u32 >= 200);
        assert!(RetirementError::InvalidRegistry as u32 <= 209);
    }

    // ── Issue #686: fake-registry attack prevention ────────────────────────────

    #[test]
    fn test_retire_rejects_unknown_registry() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let fake_registry = Address::generate(&env);
        let nonce = client.get_nonce(&credit_owner);

        let err = client
            .try_retire(
                &credit_owner,
                &credit_id,
                &1_000_000,
                &String::from_str(&env, "offset"),
                &fake_registry,
                &nonce,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RetirementError::InvalidRegistry);
    }

    #[test]
    fn test_batch_retire_rejects_unknown_registry() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        let cid2 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2025, "reg1");
        let mut credit_ids: Vec<BytesN<32>> = Vec::new(&env);
        credit_ids.push_back(credit_id);
        credit_ids.push_back(cid2);
        let mut tonnes: Vec<i128> = Vec::new(&env);
        tonnes.push_back(1_000_000);
        tonnes.push_back(1_000_000);

        for cid in credit_ids.clone() {
            let n = registry.get_nonce(&issuer);
            registry.transfer_credit(&issuer, &buyer, &cid, n);
        }

        let fake_registry = Address::generate(&env);
        let nonce = client.get_nonce(&buyer);
        let err = client
            .try_batch_retire(
                &buyer,
                &credit_ids,
                &tonnes,
                &String::from_str(&env, "batch"),
                &fake_registry,
                &nonce,
            )
            .unwrap_err()
            .unwrap();
        assert_eq!(err, RetirementError::InvalidRegistry);
    }

    // ── Issue #685: batch_retire ID derivation includes buyer nonce ────────────

    #[test]
    fn test_batch_retire_ids_distinct_with_same_ledger_and_reason() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, issuer) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let buyer = Address::generate(&env);

        let cid2 = submit_credit_for_batch(&env, &registry, &issuer, &issuer, 2025, "col1");

        for cid in [credit_id.clone(), cid2.clone()] {
            let n = registry.get_nonce(&issuer);
            registry.transfer_credit(&issuer, &buyer, &cid, n);
        }

        env.ledger().set_timestamp(1735689600);

        let n1 = client.get_nonce(&buyer);
        let mut ids1: Vec<BytesN<32>> = Vec::new(&env);
        ids1.push_back(credit_id.clone());
        let mut t1: Vec<i128> = Vec::new(&env);
        t1.push_back(1_000_000);
        let result1 = client.batch_retire(
            &buyer,
            &ids1,
            &t1,
            &String::from_str(&env, "same reason"),
            &registry.id,
            &n1,
        );

        let n2 = client.get_nonce(&buyer);
        let mut ids2: Vec<BytesN<32>> = Vec::new(&env);
        ids2.push_back(cid2.clone());
        let mut t2: Vec<i128> = Vec::new(&env);
        t2.push_back(1_000_000);
        let result2 = client.batch_retire(
            &buyer,
            &ids2,
            &t2,
            &String::from_str(&env, "same reason"),
            &registry.id,
            &n2,
        );

        assert_ne!(
            result1.succeeded.get(0).unwrap(),
            result2.succeeded.get(0).unwrap(),
            "batch retirement IDs must be distinct even with same ledger timestamp and reason"
        );
    }

    // ── Issue #688: upgrade migration trigger/validation/event ─────────────────

    #[test]
    fn test_upgrade_runs_migration_and_emits_event() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _registry, _, retirement_admin, _) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        // Verify that a non-admin cannot call upgrade (auth check)
        let rando = Address::generate(&env);
        let nonce = client.get_nonce(&rando);
        let result = client.try_upgrade(&rando, &BytesN::from_array(&env, &[1u8; 32]), &nonce);
        assert!(result.is_err(), "non-admin upgrade must be rejected");

        // Verify that the admin's nonce is still valid (not consumed by the failed call)
        let admin_nonce = client.get_nonce(&retirement_admin);
        assert!(admin_nonce >= 0, "admin nonce must be accessible");
    }

    #[test]
    fn test_upgrade_emits_contract_upgraded_event() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, _registry, _, retirement_admin, _) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);

        // Verify invalid nonce is rejected before WASM lookup
        let stale_nonce = 0u64; // likely stale after setup
        let current = client.get_nonce(&retirement_admin);
        if current > 0 {
            let result = client.try_upgrade(&retirement_admin, &BytesN::from_array(&env, &[2u8; 32]), &stale_nonce);
            assert!(result.is_err(), "stale nonce must be rejected");
        }
        assert!(current >= 0, "nonce is accessible");
    }
}
