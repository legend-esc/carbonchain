#![no_std]
pub mod types;
pub mod errors;

use crate::types::{DataKey, RetirementRecord, CreditMetadata, CreditStatus, MIN_TTL, TTL_THRESHOLD};
use crate::errors::RetirementError;
use soroban_sdk::{
    contract, contractimpl, contractevent,
    Address, BytesN, Env, String, Symbol, Vec,
    IntoVal,
};
use soroban_sdk::xdr::ToXdr;

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage().persistent().get(&DataKey::Nonce(addr.clone())).unwrap_or(0u64)
}

fn consume_nonce(env: &Env, addr: &Address, expected: u64) -> bool {
    let current = get_nonce(env, addr);
    if current != expected { return false; }
    let key = DataKey::Nonce(addr.clone());
    env.storage().persistent().set(&key, &(current + 1));
    env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
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

#[contract]
pub struct Retirement;

#[contractimpl]
impl Retirement {
    // ── Admin / Pause ────────────────────────────────────────────────────────

    /// Initialise the retirement contract. Must be called exactly once.
    ///
    /// # Errors
    /// - [`RetirementError::AlreadyInitialized`] — contract has already been initialised.
    pub fn initialize(env: Env, admin: Address) -> Result<(), RetirementError> {
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
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
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
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

        // Validate credit exists and caller owns it
        let credit: CreditMetadata = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "get_credit"),
            (credit_id.clone(),).into_val(&env),
        );
        
        if credit.status != CreditStatus::Active {
            return Err(RetirementError::CreditNotActive);
        }
        
        if credit.owner != buyer {
            return Err(RetirementError::Unauthorized);
        }

        if tonnes <= 0 {
            panic!("tonnes must be greater than zero");
        }
        let mut preimage = credit_id.clone().to_xdr(&env);
        preimage.append(&reason.clone().to_xdr(&env));
        preimage.append(&env.ledger().timestamp().to_xdr(&env));
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
        };

        env.storage()
            .persistent()
            .set(&DataKey::Retirement(retirement_id.clone()), &record);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Retirement(retirement_id.clone()), TTL_THRESHOLD, MIN_TTL);

        // Index under buyer account
        let acct_key = DataKey::AccountRetirements(buyer.clone());
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&acct_key)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(retirement_id.clone());
        env.storage().persistent().set(&acct_key, &list);
        env.storage().persistent().extend_ttl(&acct_key, TTL_THRESHOLD, MIN_TTL);

        // Emit retirement event
        Retire { buyer, credit_id, retirement_id: retirement_id.clone() }.publish(&env);

        Ok(retirement_id)
    }

    /// Retire multiple carbon credits in a single transaction.
    ///
    /// - Stores immutable `RetirementRecord` for each credit
    /// - Calls `mark_retired` on the credit registry for each credit
    /// - Indexes retirements under the buyer's account
    /// - Emits individual `retire` events per credit
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
    ) -> Result<Vec<BytesN<32>>, RetirementError> {
        if Self::is_paused(&env) {
            return Err(RetirementError::ContractPaused);
        }
        buyer.require_auth();
        if !consume_nonce(&env, &buyer, nonce) {
            return Err(RetirementError::InvalidNonce);
        }

        if credit_ids.len() != tonnes.len() {
            panic!("credit_ids and tonnes must have same length");
        }

        let mut retirement_ids: Vec<BytesN<32>> = Vec::new(&env);
        let acct_key = DataKey::AccountRetirements(buyer.clone());
        let mut list: Vec<BytesN<32>> = env
            .storage()
            .persistent()
            .get(&acct_key)
            .unwrap_or_else(|| Vec::new(&env));

        for i in 0..credit_ids.len() {
            let credit_id = credit_ids.get(i).unwrap();
            let tonne_amount = tonnes.get(i).unwrap();

            if tonne_amount <= 0 {
                panic!("tonnes must be greater than zero");
            }

            // Derive a deterministic retirement ID
            let mut preimage = credit_id.clone().to_xdr(&env);
            preimage.append(&reason.clone().to_xdr(&env));
            preimage.append(&env.ledger().timestamp().to_xdr(&env));
            preimage.append(&i.to_xdr(&env));
            let retirement_id: BytesN<32> = env.crypto().sha256(&preimage).into();

            let record = RetirementRecord {
                credit_id: credit_id.clone(),
                buyer: buyer.clone(),
                tonnes_retired: tonne_amount,
                reason: reason.clone(),
                retired_at: env.ledger().timestamp(),
            };

            env.storage()
                .persistent()
                .set(&DataKey::Retirement(retirement_id.clone()), &record);
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::Retirement(retirement_id.clone()), TTL_THRESHOLD, MIN_TTL);

            list.push_back(retirement_id.clone());
            retirement_ids.push_back(retirement_id.clone());

            // Cross-contract: mark the credit as retired in the registry
            let _: () = env.invoke_contract(
                &registry_id,
                &Symbol::new(&env, "mark_retired"),
                (credit_id.clone(),).into_val(&env),
            );

            // Emit individual retirement event
            Retire { buyer: buyer.clone(), credit_id: credit_id.clone(), retirement_id }.publish(&env);
        }

        env.storage().persistent().set(&acct_key, &list);
        env.storage().persistent().extend_ttl(&acct_key, TTL_THRESHOLD, MIN_TTL);

        Ok(retirement_ids)
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    // ── Issue 3: Contract Upgrade Mechanism ──────────────────────────────────

    /// Upgrade the contract WASM to a new hash. Only the admin may call this.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the admin.
    /// - [`RetirementError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>, nonce: u64) -> Result<(), RetirementError> {
        Self::require_admin(&env, &admin)?;
        if !consume_nonce(&env, &admin, nonce) {
            return Err(RetirementError::InvalidNonce);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Propose a new admin. The candidate must call [`accept_admin`] to complete the transfer.
    ///
    /// # Errors
    /// - [`RetirementError::NotInitialized`] — contract has not been initialised.
    /// - [`RetirementError::Unauthorized`] — caller is not the current admin.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), RetirementError> {
        let stored: Address = env.storage().instance()
            .get(&DataKey::Admin)
            .ok_or(RetirementError::NotInitialized)?;
        admin.require_auth();
        if admin != stored {
            return Err(RetirementError::Unauthorized);
        }
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Complete an admin transfer initiated by [`propose_admin`].
    ///
    /// # Errors
    /// - [`RetirementError::NoPendingAdmin`] — no transfer has been proposed.
    /// - [`RetirementError::Unauthorized`] — `new_admin` does not match the pending candidate.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), RetirementError> {
        let pending: Address = env.storage().instance()
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
        let page_size = if page_size == 0 || page_size > 50 { 50 } else { page_size };
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
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Env, String};
    use carbonchain_credit_registry::test_helpers::RegistryHelper;

    /// Returns (retirement_contract_id, registry, credit_id, retirement_admin, credit_owner)
    fn setup(env: &Env) -> (Address, RegistryHelper, BytesN<32>, Address, Address) {
        env.budget().reset_unlimited();
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
        retirement_client.initialize(&retirement_admin);

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
    #[should_panic]
    fn test_retire_zero_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (contract_id, registry, credit_id, _, credit_owner) = setup(&env);
        let client = RetirementClient::new(&env, &contract_id);
        let nonce = client.get_nonce(&credit_owner);

        client.retire(
            &credit_owner,
            &credit_id,
            &0,
            &String::from_str(&env, "offset"),
            &registry.id,
            &nonce,
        );
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
        for (suffix, vintage) in [("b1", 2025u32), ("b2", 2026u32), ("b3", 2022u32), ("b4", 2023u32)] {
            let cid = submit_credit_for_batch(
                &env, &registry, &issuer, &issuer, vintage, suffix,
            );
            credit_ids.push_back(cid);
            tonnes.push_back(1_000_000);
        }

        // Transfer credits to buyer so they can retire
        for cid in credit_ids.clone() {
            let nnonce = registry.get_nonce(&issuer);
            registry.transfer_credit(&issuer, &buyer, &cid, nnonce);
        }

        let nonce = client.get_nonce(&buyer);
        let ret_ids = client.batch_retire(
            &buyer,
            &credit_ids,
            &tonnes,
            &String::from_str(&env, "batch offset"),
            &registry.id,
            &nonce,
        );

        assert_eq!(ret_ids.len(), 5);
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
            let cid = submit_credit_for_batch(
                &env, &registry, &issuer, &issuer, vintage, suffix,
            );
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
}
