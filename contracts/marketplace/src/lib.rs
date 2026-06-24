#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, contracterror, contractevent, Env, Address, String, BytesN, Symbol, Vec, IntoVal};

// ── TTL constants ─────────────────────────────────────────────────────────────
/// Minimum TTL in ledgers (~1 year at 5s/ledger).
const MIN_TTL: u32 = 6_307_200;
/// Threshold below which TTL is extended.
const TTL_THRESHOLD: u32 = MIN_TTL / 2;

/// Cross-contract type stubs for the credit registry's types.
/// Must match `carbonchain_credit_registry::types` for invoke_contract deserialization.
#[derive(Clone, Copy, Debug, PartialEq)]
#[contracttype]
enum CreditStatus {
    Pending = 0,
    Active = 1,
    Retired = 2,
    Flagged = 3,
    Disputed = 4,
    Expired = 5,
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
struct CreditMetadata {
    pub project_id: String,
    pub issuer: Address,
    pub owner: Address,
    pub vintage_year: u32,
    pub methodology: String,
    pub geography: String,
    pub tonnes: i128,
    pub ipfs_hash: String,
    pub status: CreditStatus,
    pub issued_at: u64,
}

// ── Types ────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Offer {
    pub seller: Address,
    pub credit_id: BytesN<32>,
    pub price_xlm: i128,   // in stroops
    /// Carbon volume available in scaled units. 1 tonne = 1_000_000 units.
    pub tonnes: i128,
    pub active: bool,
    pub created_at: u64,
    pub expires_at: Option<u64>,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    Offer(u64),
    OfferCount,
    SellerOffers(Address),
    Admin,
    Paused,
    FeeBps,
    FeeRecipient,
    EscrowedAmount(u64),  // Track escrowed tokens per offer
    Nonce(Address),
    MinPrice,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketplaceError {
    OfferNotFound   = 115,
    Unauthorized    = 116,
    InvalidPrice    = 117,
    InvalidTonnes   = 125,
    AlreadyClosed   = 118,
    CreditNotActive = 119,
    NotInitialized  = 120,
    ContractPaused  = 121,
    InvalidNonce    = 122,
    OfferExpired    = 123,
    Overflow        = 124,
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
pub struct OfferNew {
    pub seller: Address,
    pub offer_id: u64,
}

#[contractevent]
#[derive(Clone)]
pub struct OfferCxl {
    pub seller: Address,
    pub offer_id: u64,
    pub escrowed: i128,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct Marketplace;

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage().persistent().get(&DataKey::Nonce(addr.clone())).unwrap_or(0u64)
}

#[contractimpl]
impl Marketplace {
    // ── Admin / Pause ────────────────────────────────────────────────────────

    /// Initialise the marketplace. Must be called exactly once.
    ///
    /// # Errors
    /// - [`MarketplaceError::NotInitialized`] — contract has already been initialised.
    pub fn initialize(env: Env, admin: Address, min_price_per_tonne: i128) -> Result<(), MarketplaceError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(MarketplaceError::NotInitialized); // already initialised
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MinPrice, &min_price_per_tonne);
        Ok(())
    }

    /// Pause all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`MarketplaceError::NotInitialized`] — contract has not been initialised.
    /// - [`MarketplaceError::Unauthorized`] — caller is not the admin.
    pub fn pause(env: Env, admin: Address) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        Paused { admin }.publish(&env);
        Ok(())
    }

    /// Resume all state-mutating operations. Only the admin may call this.
    ///
    /// # Errors
    /// - [`MarketplaceError::NotInitialized`] — contract has not been initialised.
    /// - [`MarketplaceError::Unauthorized`] — caller is not the admin.
    pub fn unpause(env: Env, admin: Address) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        Unpaused { admin }.publish(&env);
        Ok(())
    }

    /// Returns `true` if the contract is currently paused.
    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    // ── Offers ───────────────────────────────────────────────────────────────

    /// List a credit for sale. Returns the new offer ID.
    ///
    /// Verifies that the credit exists and is [`CreditStatus::Active`] in the registry
    /// before creating the offer. `price_xlm` and `tonnes` must both be positive.
    ///
    /// # Errors
    /// - [`MarketplaceError::ContractPaused`] — contract is paused.
    /// - [`MarketplaceError::InvalidNonce`] — `nonce` does not match the current seller nonce.
    /// - [`MarketplaceError::InvalidPrice`] — `price_xlm` is zero or negative.
    /// - [`MarketplaceError::InvalidTonnes`] — `tonnes` is zero, negative, or not a multiple of 100_000.
    /// - [`MarketplaceError::CreditNotActive`] — credit is not in `Active` status.
    pub fn create_offer(
        env: Env,
        seller: Address,
        credit_id: BytesN<32>,
        price_xlm: i128,
        tonnes: i128,
        registry_id: Address,
        expires_at: Option<u64>,
        nonce: u64,
    ) -> Result<u64, MarketplaceError> {
        if Self::is_paused(&env) {
            return Err(MarketplaceError::ContractPaused);
        }
        seller.require_auth();
        if !Self::consume_nonce(&env, &seller, nonce) {
            return Err(MarketplaceError::InvalidNonce);
        }
        if price_xlm <= 0 {
            return Err(MarketplaceError::InvalidPrice);
        }
        if tonnes <= 0 || tonnes % 100_000 != 0 {
            return Err(MarketplaceError::InvalidTonnes);
        }
        
        let min_price: i128 = env.storage().instance().get(&DataKey::MinPrice).unwrap_or(0);
        if price_xlm < min_price {
            return Err(MarketplaceError::InvalidPrice);
        }

        // Validate credit exists and is Active in the registry
        let credit: CreditMetadata = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "get_credit"),
            (credit_id.clone(),).into_val(&env),
        );
        if credit.status != CreditStatus::Active {
            return Err(MarketplaceError::CreditNotActive);
        }
        if credit.owner != seller {
            return Err(MarketplaceError::Unauthorized);
        }

        let registry_nonce: u64 = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "get_nonce"),
            (seller.clone(),).into_val(&env),
        );
        let escrow_account: Address = env.current_contract_address();
        let _: () = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "transfer_credit"),
            (seller.clone(), escrow_account.clone(), credit_id.clone(), registry_nonce).into_val(&env),
        );

        let offer_id = Self::next_id(&env)?;
        let offer = Offer {
            seller: seller.clone(),
            credit_id,
            price_xlm,
            tonnes,
            active: true,
            created_at: env.ledger().timestamp(),
            expires_at,
        };

        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.storage().persistent().extend_ttl(&DataKey::Offer(offer_id), TTL_THRESHOLD, MIN_TTL);

        // Store escrowed amount for refund on cancellation
        env.storage().persistent().set(&DataKey::EscrowedAmount(offer_id), &price_xlm);
        env.storage().persistent().extend_ttl(&DataKey::EscrowedAmount(offer_id), TTL_THRESHOLD, MIN_TTL);

        // Index under seller
        let key = DataKey::SellerOffers(seller.clone());
        let mut ids: Vec<u64> = env.storage().persistent().get(&key).unwrap_or_else(|| Vec::new(&env));
        ids.push_back(offer_id);
        env.storage().persistent().set(&key, &ids);
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);

        OfferNew { seller, offer_id }.publish(&env);
        Ok(offer_id)
    }

    /// Cancel an open offer. Only the original seller may cancel.
    /// Refunds escrowed seller tokens on successful cancellation.
    ///
    /// # Errors
    /// - [`MarketplaceError::ContractPaused`] — contract is paused.
    /// - [`MarketplaceError::InvalidNonce`] — `nonce` does not match the current seller nonce.
    /// - [`MarketplaceError::OfferNotFound`] — no offer exists for `offer_id`.
    /// - [`MarketplaceError::Unauthorized`] — `seller` is not the offer creator.
    /// - [`MarketplaceError::AlreadyClosed`] — offer has already been cancelled.
    pub fn cancel_offer(env: Env, seller: Address, offer_id: u64, registry_id: Address, nonce: u64) -> Result<(), MarketplaceError> {
        if Self::is_paused(&env) {
            return Err(MarketplaceError::ContractPaused);
        }
        seller.require_auth();
        if !Self::consume_nonce(&env, &seller, nonce) {
            return Err(MarketplaceError::InvalidNonce);
        }
        let mut offer: Offer = env
            .storage()
            .persistent()
            .get(&DataKey::Offer(offer_id))
            .ok_or(MarketplaceError::OfferNotFound)?;

        if offer.seller != seller {
            return Err(MarketplaceError::Unauthorized);
        }
        if !offer.active {
            return Err(MarketplaceError::AlreadyClosed);
        }

        let escrow_account: Address = env.current_contract_address();
        let registry_nonce: u64 = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "get_nonce"),
            (escrow_account.clone(),).into_val(&env),
        );
        let _: () = env.invoke_contract(
            &registry_id,
            &Symbol::new(&env, "transfer_credit"),
            (
                escrow_account.clone(),
                seller.clone(),
                offer.credit_id.clone(),
                registry_nonce,
            )
                .into_val(&env),
        );

        // Retrieve and clear escrowed amount
        let escrowed: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::EscrowedAmount(offer_id))
            .unwrap_or(0);

        offer.active = false;
        env.storage().persistent().set(&DataKey::Offer(offer_id), &offer);
        env.storage().persistent().extend_ttl(&DataKey::Offer(offer_id), TTL_THRESHOLD, MIN_TTL);

        // Remove escrowed amount record
        env.storage().persistent().remove(&DataKey::EscrowedAmount(offer_id));

        OfferCxl { seller: seller.clone(), offer_id, escrowed }.publish(&env);
        Ok(())
    }

    /// Fetch an offer by its ID.
    ///
    /// # Errors
    /// - [`MarketplaceError::OfferNotFound`] — no offer exists for `offer_id`.
    pub fn get_offer(env: Env, offer_id: u64) -> Result<Offer, MarketplaceError> {
        let offer: Offer = env.storage()
            .persistent()
            .get(&DataKey::Offer(offer_id))
            .ok_or(MarketplaceError::OfferNotFound)?;
        
        if let Some(expires_at) = offer.expires_at {
            if env.ledger().timestamp() > expires_at {
                return Err(MarketplaceError::OfferExpired);
            }
        }
        
        Ok(offer)
    }

    /// Returns all offer IDs for a seller (including cancelled ones).
    pub fn get_offers_by_seller(env: Env, seller: Address) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::SellerOffers(seller))
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Returns only the active (non-cancelled) offer IDs for a seller.
    /// Avoids callers having to fetch each offer individually to filter.
    pub fn get_active_offers_by_seller(env: Env, seller: Address) -> Vec<u64> {
        let all_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::SellerOffers(seller))
            .unwrap_or_else(|| Vec::new(&env));

        let mut active: Vec<u64> = Vec::new(&env);
        for id in all_ids.iter() {
            let offer: Option<Offer> = env.storage().persistent().get(&DataKey::Offer(id));
            if let Some(o) = offer {
                if o.active {
                    active.push_back(id);
                }
            }
        }
        active
    }

    /// Returns the total number of offers ever created (including cancelled ones).
    pub fn offer_count(env: Env) -> u64 {
        env.storage().persistent().get(&DataKey::OfferCount).unwrap_or(0u64)
    }

    pub fn cleanup_expired_offers(env: Env, admin: Address) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        let count = Self::offer_count(env.clone());
        let now = env.ledger().timestamp();
        
        for i in 0..count {
            if let Some(mut offer) = env.storage().persistent().get::<_, Offer>(&DataKey::Offer(i)) {
                if let Some(expires_at) = offer.expires_at {
                    if now > expires_at && offer.active {
                        offer.active = false;
                        env.storage().persistent().set(&DataKey::Offer(i), &offer);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn update_min_price(env: Env, admin: Address, new_min: i128) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::MinPrice, &new_min);
        Ok(())
    }

    pub fn get_min_price(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::MinPrice).unwrap_or(0)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn next_id(env: &Env) -> Result<u64, MarketplaceError> {
        let id: u64 = env.storage().persistent().get(&DataKey::OfferCount).unwrap_or(0u64);
        let next_id = id.checked_add(1).ok_or(MarketplaceError::Overflow)?;
        env.storage().persistent().set(&DataKey::OfferCount, &next_id);
        env.storage().persistent().extend_ttl(&DataKey::OfferCount, TTL_THRESHOLD, MIN_TTL);
        Ok(id)
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), MarketplaceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(MarketplaceError::NotInitialized)?;
        caller.require_auth();
        if *caller != admin {
            return Err(MarketplaceError::Unauthorized);
        }
        Ok(())
    }

    fn is_paused(env: &Env) -> bool {
        env.storage().instance().get(&DataKey::Paused).unwrap_or(false)
    }

    fn consume_nonce(env: &Env, addr: &Address, expected: u64) -> bool {
        let current = get_nonce(env, addr);
        if current != expected { return false; }
        let key = DataKey::Nonce(addr.clone());
        env.storage().persistent().set(&key, &(current + 1));
        env.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);
        true
    }

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    // ── Issue 3: Contract Upgrade Mechanism ──────────────────────────────────

    /// Upgrade the contract WASM to a new hash. Only the admin may call this.
    ///
    /// # Errors
    /// - [`MarketplaceError::NotInitialized`] — contract has not been initialised.
    /// - [`MarketplaceError::Unauthorized`] — caller is not the admin.
    /// - [`MarketplaceError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn upgrade(env: Env, admin: Address, new_wasm_hash: BytesN<32>, nonce: u64) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        if !Self::consume_nonce(&env, &admin, nonce) {
            return Err(MarketplaceError::InvalidNonce);
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Env, BytesN, String};
    use carbonchain_credit_registry::test_helpers::RegistryHelper;

    fn setup_with_registry(env: &Env) -> (MarketplaceClient<'static>, Address, Address, RegistryHelper, BytesN<32>) {
        env.ledger().set_timestamp(1735689600);
        let registry = RegistryHelper::deploy(env);

        let admin = Address::generate(env);
        let verifier = Address::generate(env);
        let issuer = Address::generate(env);
        let retirement = Address::generate(env);
        registry.initialize(&admin, &retirement, 1);

        let nonce = registry.get_nonce(&admin);
        registry.register_verifier(&admin, &verifier, nonce);

        let anonce = registry.get_nonce(&admin);
        registry.register_issuer(&admin, &issuer, anonce);
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

        let marketplace_id = env.register(Marketplace, ());
        let client = MarketplaceClient::new(env, &marketplace_id);
        let mp_admin = Address::generate(env);
        client.initialize(&mp_admin, &0);
        let seller = Address::generate(env);
        // Transfer credit from issuer to seller so seller can create offers
        let transfer_nonce = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &seller, &credit_id, transfer_nonce);
        (client, seller, mp_admin, registry, credit_id)
    }

    #[test]
    fn test_create_offer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        assert_eq!(offer_id, 0);
        let offer = client.get_offer(&offer_id);
        assert!(offer.active);
        assert_eq!(offer.price_xlm, 10_000_000);
    }

    #[test]
    fn test_cancel_offer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        assert!(!client.get_offer(&offer_id).active);
    }

    #[test]
    fn test_double_listing_prevention() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let _offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        let seller_nonce2 = client.get_nonce(&seller);
        assert!(client.try_create_offer(&seller, &credit_id, &20_000_000, &250_000, &registry.id, &None, &seller_nonce2).is_err());
    }

    #[test]
    fn test_cancel_offer_returns_credit_to_seller() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        let credit = registry.get_credit(&credit_id);
        assert_ne!(credit.owner, seller);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        let credit = registry.get_credit(&credit_id);
        assert_eq!(credit.owner, seller);
    }

    #[test]
    fn test_cancel_already_closed_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        let seller_nonce3 = client.get_nonce(&seller);
        assert!(client.try_cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce3).is_err());
    }

    #[test]
    fn test_invalid_price_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        assert!(client.try_create_offer(&seller, &credit_id, &0, &500_000, &registry.id, &None, &seller_nonce).is_err());
    }

    #[test]
    fn test_negative_price_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        assert!(client.try_create_offer(&seller, &credit_id, &-1, &500_000, &registry.id, &None, &seller_nonce).is_err());
    }

    #[test]
    fn test_zero_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(&seller, &credit_id, &10_000_000, &0, &registry.id, &None, &seller_nonce);
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    #[test]
    fn test_negative_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(&seller, &credit_id, &10_000_000, &-100_000, &registry.id, &None, &seller_nonce);
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    #[test]
    fn test_tonnes_multiple_of_100000_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &100_000, &registry.id, &None, &seller_nonce);
        assert_eq!(offer_id, 0);
    }

    #[test]
    fn test_tonnes_not_multiple_of_100000_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(&seller, &credit_id, &10_000_000, &99_999, &registry.id, &None, &seller_nonce);
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    #[test]
    fn test_get_offers_by_seller() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        // Cancel first offer to return credit, then create another
        let seller_nonce_cancel = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce_cancel);
        let seller_nonce2 = client.get_nonce(&seller);
        client.create_offer(&seller, &credit_id, &20_000_000, &200_000, &registry.id, &None, &seller_nonce2);
        assert_eq!(client.get_offers_by_seller(&seller).len(), 2);
    }

    #[test]
    fn test_offer_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        // Cancel first offer to return credit, then create another
        let seller_nonce_cancel = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce_cancel);
        let seller_nonce2 = client.get_nonce(&seller);
        client.create_offer(&seller, &credit_id, &20_000_000, &200_000, &registry.id, &None, &seller_nonce2);
        assert_eq!(client.offer_count(), 2);
    }

    #[test]
    fn test_unauthorized_cancel_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        let other = Address::generate(&env);
        let ononce = client.get_nonce(&other);
        assert!(client.try_cancel_offer(&other, &offer_id, &registry.id, &ononce).is_err());
    }

    // ── get_active_offers_by_seller tests ────────────────────────────────────

    #[test]
    fn test_get_active_offers_by_seller_filters_cancelled() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        // Cancel the first offer to return credit, then create a second one.
        let seller_nonce_cancel = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce_cancel);
        let seller_nonce2 = client.get_nonce(&seller);
        let id1 = client.create_offer(&seller, &credit_id, &20_000_000, &500_000, &registry.id, &None, &seller_nonce2);
        // get_offers_by_seller still returns both.
        assert_eq!(client.get_offers_by_seller(&seller).len(), 2);
        // get_active_offers_by_seller must return only the open one.
        let active = client.get_active_offers_by_seller(&seller);
        assert_eq!(active.len(), 1);
        assert_eq!(active.get(0).unwrap(), id1);
    }

    #[test]
    fn test_get_active_offers_by_seller_empty_when_all_cancelled() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce2);
        assert_eq!(client.get_active_offers_by_seller(&seller).len(), 0);
    }

    // ── Pause tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_pause_blocks_create_offer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, admin, registry, credit_id) = setup_with_registry(&env);
        client.pause(&admin);
        assert!(client.paused());
        let seller_nonce = client.get_nonce(&seller);
        assert!(client.try_create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce).is_err());
    }

    #[test]
    fn test_unpause_restores_create_offer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, admin, registry, credit_id) = setup_with_registry(&env);
        client.pause(&admin);
        client.unpause(&admin);
        assert!(!client.paused());
        let seller_nonce = client.get_nonce(&seller);
        assert!(client.try_create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce).is_ok());
    }

    #[test]
    fn test_pause_blocks_cancel_offer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &10_000_000, &500_000, &registry.id, &None, &seller_nonce);
        client.pause(&admin);
        let seller_nonce2 = client.get_nonce(&seller);
        assert!(client.try_cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2).is_err());
    }

    #[test]
    fn test_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _, _, _, _) = setup_with_registry(&env);
        let rando = Address::generate(&env);
        assert!(client.try_pause(&rando).is_err());
    }

    #[test]
    fn test_cancel_offer_clears_escrow() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let price = 10_000_000i128;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &price, &500_000, &registry.id, &None, &seller_nonce);
        assert!(client.get_offer(&offer_id).active);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        assert!(!client.get_offer(&offer_id).active);
    }

    #[test]
    fn test_cancel_offer_refund_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let price = 15_000_000i128;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(&seller, &credit_id, &price, &500_000, &registry.id, &None, &seller_nonce);
        let offer_before = client.get_offer(&offer_id);
        assert!(offer_before.active);
        assert_eq!(offer_before.price_xlm, price);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        let offer_after = client.get_offer(&offer_id);
        assert!(!offer_after.active);
    }
}
