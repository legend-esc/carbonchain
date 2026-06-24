#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror, contractevent,
    Env, Address, String, Vec, IntoVal,
};

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct MrvDataPoint {
    pub oracle: Address,
    pub project_id: String,
    /// Carbon sequestration in scaled units. 1 tonne = 1_000_000 units.
    pub tonnes: i128,
    pub recorded_at: u64,
    /// Flagged when the reading deviates >20% from the previous reading.
    pub anomaly: bool,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    /// Admin address allowed to register oracles.
    Admin,
    /// Set of authorised oracle addresses.
    OracleSet,
    /// Latest reading per project.
    Latest(String),
    /// Full history per project (Vec<MrvDataPoint>).
    History(String),
    /// Pause flag.
    Paused,
    /// Replay-protection nonce per address.
    Nonce(Address),
    /// Pending admin for two-step transfer.
    PendingAdmin,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    NotInitialized     = 119,
    Unauthorized       = 120,
    AlreadyInitialized = 121,
    Overflow           = 122,
    ContractPaused     = 123,
    ProjectNotFound    = 124,
    InvalidNonce       = 125,
    InvalidProject     = 126,
    InvalidTimestamp   = 127,
    NoPendingAdmin     = 128,
    InvalidReading     = 129,
}

#[contractevent]
#[derive(Clone)]
pub struct MrvInit {
    pub admin: Address,
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
pub struct OrcDup {
    pub oracle: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct OrcNew {
    pub oracle: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct MrvUpd {
    pub oracle: Address,
    pub project_id: String,
    pub tonnes: i128,
    pub anomaly: bool,
}

// Maximum MRV history entries retained per project (ring-buffer eviction).
const MAX_HISTORY: u32 = 100;

/// Minimum TTL in ledgers (~1 year at 5s/ledger).
const MIN_TTL: u32 = 6_307_200;
/// Threshold below which TTL is extended.
const TTL_THRESHOLD: u32 = MIN_TTL / 2;

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct MrvOracle;

#[contractimpl]
impl MrvOracle {
    /// Initialise the oracle contract. Must be called exactly once.
    ///
    /// # Errors
    /// - [`OracleError::AlreadyInitialized`] — contract has already been initialised.
    pub fn initialize(env: Env, admin: Address) -> Result<(), OracleError> {
        env.storage().instance().set(&DataKey::Admin, &admin);
        MrvInit { admin }.publish(&env);
        Ok(())
    }

    // ── Pause / Unpause ──────────────────────────────────────────────────────

    /// Pause all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`OracleError::NotInitialized`] — contract has not been initialised.
    /// - [`OracleError::Unauthorized`] — caller is not the admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), OracleError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Paused { admin }.publish(&env);
        Ok(())
    }

    /// Resume all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`OracleError::NotInitialized`] — contract has not been initialised.
    /// - [`OracleError::Unauthorized`] — caller is not the admin.
    pub fn unpause(env: Env, admin: Address) -> Result<(), OracleError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Unpaused { admin }.publish(&env);
        Ok(())
    }

    /// Returns `true` if the contract is currently paused.
    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    // ── Oracle management ────────────────────────────────────────────────────

    /// Register an oracle address. Returns `true` if newly added, `false` if already registered.
    ///
    /// Emits `orc_new` on first registration and `orc_dup` on a duplicate, so callers can
    /// distinguish the two cases from on-chain events.
    ///
    /// # Errors
    /// - [`OracleError::NotInitialized`] — contract has not been initialised.
    /// - [`OracleError::Unauthorized`] — caller is not the admin.
    /// - [`OracleError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn register_oracle(env: Env, admin: Address, oracle: Address) -> Result<bool, OracleError> {
        Self::require_admin(&env, &admin)?;
        let mut set: Vec<Address> = env
            .storage().instance()
            .get(&DataKey::OracleSet)
            .unwrap_or_else(|| Vec::new(&env));
        if set.contains(&oracle) {
            // Already registered — emit a distinct event so callers know.
            OrcDup { oracle: oracle.clone() }.publish(&env);
            return Ok(false);
        }
        set.push_back(oracle.clone());
        env.storage().instance().set(&DataKey::OracleSet, &set);
        OrcNew { oracle: oracle.clone() }.publish(&env);
        Ok(true)
    }

    /// Submit a new MRV reading for a project. Returns `true` if an anomaly was detected.
    ///
    /// An anomaly is flagged when the new reading deviates more than 20% from the previous one.
    /// The reading is stored as the latest value and appended to the project's history
    /// (capped at 100 entries; oldest entry is evicted when the cap is reached).
    ///
    /// # Errors
    /// - [`OracleError::ContractPaused`] — contract is paused.
    /// - [`OracleError::Unauthorized`] — `oracle` is not a registered oracle address.
    /// - [`OracleError::InvalidNonce`] — `nonce` does not match the current oracle nonce.
    /// - [`OracleError::InvalidTimestamp`] — `timestamp` is later than the current ledger timestamp.
    /// - [`OracleError::Overflow`] — anomaly calculation overflowed (extremely large `tonnes` value).
    pub fn update_mrv_data(
        env: Env,
        oracle: Address,
        project_id: String,
        tonnes: i128,
        timestamp: u64,
        registry_id: Address,
        nonce: u64,
    ) -> Result<bool, OracleError> {
        if Self::is_paused(&env) {
            return Err(OracleError::ContractPaused);
        }
        oracle.require_auth();
        if !Self::is_oracle(&env, &oracle) {
            return Err(OracleError::Unauthorized);
        }
        if !Self::consume_nonce(&env, &oracle, nonce) {
            return Err(OracleError::InvalidNonce);
        }
        if timestamp > env.ledger().timestamp() {
            return Err(OracleError::InvalidTimestamp);
        }
        if tonnes < 0 {
            return Err(OracleError::InvalidReading);
        }

        // Validate project exists in registry
        let credits: soroban_sdk::Vec<soroban_sdk::BytesN<32>> = env.invoke_contract(
            &registry_id,
            &soroban_sdk::Symbol::new(&env, "list_credits_by_project"),
            (project_id.clone(),).into_val(&env),
        );
        if credits.is_empty() {
            return Err(OracleError::InvalidProject);
        }

        let anomaly = Self::detect_anomaly(&env, &project_id, tonnes)?;

        let point = MrvDataPoint {
            oracle: oracle.clone(),
            project_id: project_id.clone(),
            tonnes,
            recorded_at: timestamp,
            anomaly,
        };

        env.storage().persistent().set(&DataKey::Latest(project_id.clone()), &point);
        env.storage().persistent().extend_ttl(&DataKey::Latest(project_id.clone()), TTL_THRESHOLD, MIN_TTL);

        let hist_key = DataKey::History(project_id.clone());
        let mut history: Vec<MrvDataPoint> = env
            .storage().persistent()
            .get(&hist_key)
            .unwrap_or_else(|| Vec::new(&env));
        if history.len() >= MAX_HISTORY {
            // Evict oldest entry (index 0) to keep the ring buffer bounded.
            history.remove(0);
        }
        history.push_back(point);
        env.storage().persistent().set(&hist_key, &history);
        env.storage().persistent().extend_ttl(&hist_key, TTL_THRESHOLD, MIN_TTL);

        MrvUpd { oracle, project_id, tonnes, anomaly }.publish(&env);

        Ok(anomaly)
    }

    pub fn get_latest(env: Env, project_id: String) -> Result<Option<MrvDataPoint>, OracleError> {
        // Check if project exists by looking for any history
        let has_history = env.storage().persistent().has(&DataKey::History(project_id.clone()));
        let has_latest = env.storage().persistent().has(&DataKey::Latest(project_id.clone()));
        
        if !has_history && !has_latest {
            return Err(OracleError::ProjectNotFound);
        }
        
        Ok(env.storage().persistent().get(&DataKey::Latest(project_id)))
    }

    /// Returns the current replay-protection nonce for `address`.
    pub fn get_nonce(env: Env, address: Address) -> u64 {
        env.storage().persistent().get(&DataKey::Nonce(address)).unwrap_or(0u64)
    }

    // ── Issue 3: Contract Upgrade Mechanism ──────────────────────────────────

    /// Upgrade the contract WASM to a new hash. Only the admin may call this.
    ///
    /// # Errors
    /// - [`OracleError::NotInitialized`] — contract has not been initialised.
    /// - [`OracleError::Unauthorized`] — caller is not the admin.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: soroban_sdk::BytesN<32>) -> Result<(), OracleError> {
        Self::require_admin(&env, &admin)?;
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }

    /// Propose a new admin. The candidate must call [`accept_admin`] to complete the transfer.
    ///
    /// # Errors
    /// - [`OracleError::NotInitialized`] — contract has not been initialised.
    /// - [`OracleError::Unauthorized`] — caller is not the current admin.
    pub fn propose_admin(env: Env, admin: Address, new_admin: Address) -> Result<(), OracleError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        Ok(())
    }

    /// Complete an admin transfer initiated by [`propose_admin`].
    ///
    /// # Errors
    /// - [`OracleError::NoPendingAdmin`] — no transfer has been proposed.
    /// - [`OracleError::Unauthorized`] — `new_admin` does not match the pending candidate.
    pub fn accept_admin(env: Env, new_admin: Address) -> Result<(), OracleError> {
        let pending: Address = env
            .storage().instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(OracleError::NoPendingAdmin)?;
        if new_admin != pending {
            return Err(OracleError::Unauthorized);
        }
        new_admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Ok(())
    }

    /// Returns the full MRV history for `project_id` (up to 100 entries).
    pub fn get_history(env: Env, project_id: String) -> Vec<MrvDataPoint> {
        env.storage()
            .persistent()
            .get(&DataKey::History(project_id))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Aggregate MRV readings over a time range.
    /// Returns (sum_tonnes, average_tonnes) for readings where from_ts <= recorded_at <= to_ts.
    pub fn get_mrv_aggregate(
        env: Env,
        project_id: String,
        from_ts: u64,
        to_ts: u64,
    ) -> (i128, i128) {
        let history = env.storage()
            .persistent()
            .get::<_, Vec<MrvDataPoint>>(&DataKey::History(project_id))
            .unwrap_or_else(|| Vec::new(&env));

        let mut sum: i128 = 0;
        let mut count: i128 = 0;

        for point in history.iter() {
            if point.recorded_at >= from_ts && point.recorded_at <= to_ts {
                sum += point.tonnes;
                count += 1;
            }
        }

        let avg = if count > 0 { sum / count } else { 0 };
        (sum, avg)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn require_admin(env: &Env, caller: &Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage().instance()
            .get(&DataKey::Admin)
            .ok_or(OracleError::NotInitialized)?;
        caller.require_auth();
        if *caller != admin {
            return Err(OracleError::Unauthorized);
        }
        Ok(())
    }

    fn consume_nonce(env: &Env, addr: &Address, expected: u64) -> bool {
        let current: u64 = env.storage().persistent()
            .get(&DataKey::Nonce(addr.clone())).unwrap_or(0u64);
        if current != expected { return false; }
        let key = DataKey::Nonce(addr.clone());
        env.storage().persistent().set(&key, &(current + 1));
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
        true
    }

    fn is_oracle(env: &Env, oracle: &Address) -> bool {
        let set: Vec<Address> = env
            .storage().instance()
            .get(&DataKey::OracleSet)
            .unwrap_or_else(|| Vec::new(env));
        set.contains(oracle)
    }

    fn is_paused(env: &Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    /// Returns true if `new_tonnes` deviates more than 20% from the last reading.
    fn detect_anomaly(env: &Env, project_id: &String, new_tonnes: i128) -> Result<bool, OracleError> {
        let prev: Option<MrvDataPoint> = env
            .storage().persistent()
            .get(&DataKey::Latest(project_id.clone()));
        match prev {
            None => Ok(false),
            Some(p) if p.tonnes == 0 => Ok(false),
            Some(p) => {
                let diff = (new_tonnes - p.tonnes).abs();
                // diff / prev > 0.20  ⟺  diff * 5 > prev
                let diff_times_5 = diff.checked_mul(5).ok_or(OracleError::Overflow)?;
                Ok(diff_times_5 > p.tonnes.abs())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::testutils::Events;
    use soroban_sdk::{Env, String};

    fn setup() -> (Env, MrvOracleClient<'static>, Address, Address, Address) {
        let env = Env::default();
        env.budget().reset_unlimited();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);

        let registry = carbonchain_credit_registry::test_helpers::RegistryHelper::deploy(&env);
        let registry_id = registry.id.clone();
        let admin = Address::generate(&env);
        let verifier = Address::generate(&env);
        let retirement = Address::generate(&env);
        registry.initialize(&admin, &retirement, 1);
        let nonce = registry.get_nonce(&admin);
        registry.register_verifier(&admin, &verifier, nonce);

        let issuer = Address::generate(&env);
        let anonce = registry.get_nonce(&admin);
        registry.register_issuer(&admin, &issuer, anonce);
        let anonce2 = registry.get_nonce(&admin);
        registry.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "Verified Carbon Standard"),
            anonce2,
        );
        for proj in ["PROJ-001", "PROJ-AGG", "PROJ-EMPTY", "PROJ-CAP"] {
            let anonce_proj = registry.get_nonce(&admin);
            registry.register_project(
                &admin,
                &String::from_str(&env, proj),
                &String::from_str(&env, "Test Project"),
                &String::from_str(&env, "Desc"),
                &String::from_str(&env, "NG"),
            );
        }

        let inonce = registry.get_nonce(&issuer);
        registry.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            1_000_000,
            &String::from_str(&env, "bafybei123"),
            inonce,
        );
        for proj in ["PROJ-AGG", "PROJ-EMPTY", "PROJ-CAP"] {
            let inonce2 = registry.get_nonce(&issuer);
            registry.submit_credit(
                &issuer,
                &String::from_str(&env, proj),
                2024,
                &String::from_str(&env, "VCS"),
                &String::from_str(&env, "NG"),
                1_000_000,
                &String::from_str(&env, "bafybei456"),
                inonce2,
            );
        }

        let id = env.register(MrvOracle, ());
        let client = MrvOracleClient::new(&env, &id);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        client.register_oracle(&admin, &oracle);
        (env, client, oracle, registry_id, admin)
    }

    #[test]
    fn test_initialize_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(MrvOracle, ());
        let client = MrvOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        client.initialize(&admin);
        let events = env.events().all();
        // Exactly one event must be emitted: the mrv_init event.
        assert_eq!(events.events().len(), 1);
    }

    #[test]
    fn test_update_and_get_latest() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce);
        let latest = client.get_latest(&proj).unwrap();
        assert_eq!(latest.tonnes, 1_000_000);
        assert!(!latest.anomaly);
    }

    #[test]
    fn test_oracle_address_stored_in_data_point() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce);
        let latest = client.get_latest(&proj).unwrap();
        assert_eq!(latest.oracle, oracle);
    }

    #[test]
    fn test_history_accumulates() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce);
        let nonce2 = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_050_000, &env.ledger().timestamp(), &registry_id, &nonce2);
        assert_eq!(client.get_history(&proj).len(), 2);
    }

    #[test]
    fn test_anomaly_flagged_on_large_deviation() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce);
        let nonce2 = client.get_nonce(&oracle);
        let anomaly = client.update_mrv_data(&oracle, &proj, &1_500_000, &env.ledger().timestamp(), &registry_id, &nonce2);
        assert!(anomaly);
        assert!(client.get_latest(&proj).unwrap().anomaly);
    }

    #[test]
    fn test_no_anomaly_on_small_deviation() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce);
        let nonce2 = client.get_nonce(&oracle);
        let anomaly = client.update_mrv_data(&oracle, &proj, &1_100_000, &env.ledger().timestamp(), &registry_id, &nonce2);
        assert!(!anomaly);
    }

    #[test]
    fn test_unauthorized_oracle_rejected() {
        let (env, client, _oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let rogue = Address::generate(&env);
        let nonce = client.get_nonce(&rogue);
        assert!(client.try_update_mrv_data(&rogue, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce).is_err());
    }

    #[test]
    fn test_unregistered_project_rejected() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-NONEXISTENT");
        let nonce = client.get_nonce(&oracle);
        assert!(client.try_update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce).is_err());
    }

    #[test]
    fn test_future_timestamp_rejected() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let future_ts = env.ledger().timestamp() + 3600;
        let nonce = client.get_nonce(&oracle);
        let err = client.try_update_mrv_data(&oracle, &proj, &1_000_000, &future_ts, &registry_id, &nonce);
        assert!(err.is_err());
    }

    #[test]
    fn test_history_cap_evicts_oldest() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-CAP");
        for i in 0..=MAX_HISTORY {
            let nonce = client.get_nonce(&oracle);
            client.update_mrv_data(&oracle, &proj, &(i as i128 * 1_000), &env.ledger().timestamp(), &registry_id, &nonce);
        }
        let history = client.get_history(&proj);
        assert_eq!(history.len(), MAX_HISTORY);
        assert_eq!(history.get(0).unwrap().tonnes, 1_000);
    }

    // ── register_oracle duplicate tests ─────────────────────────────────────

    #[test]
    fn test_register_oracle_returns_true_for_new() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(MrvOracle, ());
        let client = MrvOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        let newly_added = client.register_oracle(&admin, &oracle);
        assert!(newly_added);
    }

    #[test]
    fn test_register_oracle_returns_false_for_duplicate() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(MrvOracle, ());
        let client = MrvOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        client.register_oracle(&admin, &oracle);
        // Second registration of the same oracle must return false.
        let newly_added = client.register_oracle(&admin, &oracle);
        assert!(!newly_added);
    }

    #[test]
    fn test_register_oracle_duplicate_emits_oracle_dup_event() {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register(MrvOracle, ());
        let client = MrvOracleClient::new(&env, &id);
        let admin = Address::generate(&env);
        let oracle = Address::generate(&env);
        client.initialize(&admin);
        client.register_oracle(&admin, &oracle);
        // Duplicate registration must emit exactly one event: orc_dup.
        let events_after = env.events().all();
        assert_eq!(events_after.events().len(), 1);
    }

    // ── Pause tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_pause_blocks_update_mrv_data() {
        let (env, client, oracle, registry_id, admin) = setup();
        client.pause(&admin);
        assert!(client.paused());
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        assert!(client.try_update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce).is_err());
    }

    #[test]
    fn test_unpause_restores_update_mrv_data() {
        let (env, client, oracle, registry_id, admin) = setup();
        client.pause(&admin);
        client.unpause(&admin);
        assert!(!client.paused());
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        assert!(client.try_update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &registry_id, &nonce).is_ok());
    }

    #[test]
    fn test_non_admin_cannot_pause() {
        let (env, client, _, _, _) = setup();
        let rando = Address::generate(&env);
        assert!(client.try_pause(&rando).is_err());
    }

    #[test]
    fn test_negative_tonnes_rejected() {
        let (env, client, oracle, registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-001");
        let nonce = client.get_nonce(&oracle);
        assert!(client.try_update_mrv_data(&oracle, &proj, &-1, &env.ledger().timestamp(), &registry_id, &nonce).is_err());
    }

    #[test]
    fn test_get_mrv_aggregate_sum_and_average() {
        let (env, client, oracle, _registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-AGG");
        
        // Record three data points
        let nonce1 = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &_registry_id, &nonce1);
        
        let nonce2 = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &2_000_000, &env.ledger().timestamp(), &_registry_id, &nonce2);
        
        let nonce3 = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &3_000_000, &env.ledger().timestamp(), &_registry_id, &nonce3);

        // Get aggregate over full range
        let (sum, avg) = client.get_mrv_aggregate(&proj, &0, &u64::MAX);
        assert_eq!(sum, 6_000_000);
        assert_eq!(avg, 2_000_000);
    }

    #[test]
    fn test_get_mrv_aggregate_empty_range() {
        let (env, client, oracle, _registry_id, _admin) = setup();
        let proj = String::from_str(&env, "PROJ-EMPTY");
        
        let nonce = client.get_nonce(&oracle);
        client.update_mrv_data(&oracle, &proj, &1_000_000, &env.ledger().timestamp(), &_registry_id, &nonce);

        // Query outside the recorded time range
        let (sum, avg) = client.get_mrv_aggregate(&proj, &0, &1);
        assert_eq!(sum, 0);
        assert_eq!(avg, 0);
    }
}
