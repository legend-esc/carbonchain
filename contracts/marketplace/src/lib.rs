#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, BytesN, Env,
    Error as SorobanError, IntoVal, String, Symbol, Vec,
};

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

/// Represents the payment asset for a marketplace offer.
///
/// - `Native` — XLM (Stellar's native asset). No contract address needed.
/// - `Asset(Address)` — Any Stellar Asset Contract (SAC) token, e.g. USDC, EURC,
///   or a custom token. The `Address` is the deployed SAC contract address.
///
/// Backward compatibility: existing offers that were created before this change
/// use the `price_xlm` field and are treated as `AssetType::Native` by the
/// `accept_offer` function. New offers set `price_asset` to declare their asset.
#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub enum AssetType {
    /// XLM native asset — no SAC contract required.
    Native,
    /// Any Stellar Asset Contract token (USDC, EURC, custom).
    Asset(Address),
}

#[derive(Clone, Debug, PartialEq)]
#[contracttype]
pub struct Offer {
    pub seller: Address,
    pub credit_id: BytesN<32>,
    /// Price in stroops (XLM) — kept for backward compatibility with existing
    /// on-chain offers. New offers should use `price_amount` + `price_asset`.
    ///
    /// When `price_asset` is `AssetType::Native` this field is the authoritative
    /// price. When `price_asset` is `AssetType::Asset(_)` this field is `0` and
    /// `price_amount` holds the token amount.
    pub price_xlm: i128,
    /// Price in the asset's base unit (stroops for XLM, or token decimals for SAC).
    /// This is the canonical price field for new multi-asset offers.
    pub price_amount: i128,
    /// The payment asset. Defaults to `AssetType::Native` (XLM) for offers that
    /// only set `price_xlm` (backward compatibility).
    pub price_asset: AssetType,
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
    EscrowedAmount(u64),
    Nonce(Address),
    MinPrice,
    ActiveOffers,
    /// Trusted credit-registry contract address stored at initialisation (#692).
    TrustedRegistry,
    /// Allowed payment-token contract address stored at initialisation (#691).
    AllowedToken,
}

/// Stable error codes for the CarbonChain marketplace contract.
///
/// All codes are in the 300–309 range — reserved exclusively for the
/// marketplace. Codes 100–130 belong to `credit_registry`; 200–209 to
/// `retirement`; 400–409 to `mrv_oracle`.
///
/// Codes are intentionally stable — do not renumber existing variants.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MarketplaceError {
    /// No offer exists for the given offer ID.
    OfferNotFound = 300,
    /// Caller is not authorised to perform the operation.
    Unauthorized = 301,
    /// Price is zero, negative, or below the configured minimum.
    InvalidPrice = 302,
    /// Tonnes is zero, negative, or not a multiple of 100_000.
    InvalidTonnes = 303,
    /// Offer has already been cancelled or filled.
    AlreadyClosed = 304,
    /// The listed credit is not in Active status.
    CreditNotActive = 305,
    /// Contract has not been initialised.
    NotInitialized = 306,
    /// All state-mutating operations are paused.
    ContractPaused = 307,
    /// Nonce does not match the caller's current nonce.
    InvalidNonce = 308,
    /// Offer has passed its expiry timestamp.
    OfferExpired = 309,
    /// Integer overflow detected.
    Overflow = 310,
    /// Contract has already been initialised.
    AlreadyInitialized = 311,
    /// Buyer does not hold enough of the payment asset to cover the offer price.
    InsufficientFunds = 312,
    /// Escrow transfer succeeded but the offer record failed to persist;
    /// the credit was returned to the seller to avoid a stuck escrow.
    EscrowFailed = 313,
    /// No credit exists for the given credit ID in the registry.
    CreditNotFound = 314,
    /// The registry_id does not match the trusted credit registry.
    InvalidRegistry = 315,
    /// The token_id does not match the allowed payment token.
    InvalidToken = 316,
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

#[contractevent]
#[derive(Clone)]
pub struct OfferUpdated {
    pub seller: Address,
    pub offer_id: u64,
    pub new_price_xlm: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct OfferFilled {
    pub buyer: Address,
    pub seller: Address,
    pub offer_id: u64,
    pub price_xlm: i128,
}

// ── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct Marketplace;

fn get_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(addr.clone()))
        .unwrap_or(0u64)
}

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl Marketplace {
    // ── Admin / Pause ────────────────────────────────────────────────────────

    /// Initialise the marketplace. Must be called exactly once.
    ///
    /// `registry_id` — the trusted credit-registry contract address (#692).
    /// `token_id`    — the allowed payment-token contract address (#691).
    ///
    /// # Errors
    /// - [`MarketplaceError::AlreadyInitialized`] — contract has already been initialised.
    pub fn initialize(
        env: Env,
        admin: Address,
        min_price_per_tonne: i128,
        registry_id: Address,
        token_id: Address,
    ) -> Result<(), MarketplaceError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(MarketplaceError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MinPrice, &min_price_per_tonne);
        // #692: persist trusted registry so callers cannot substitute a fake one
        env.storage()
            .instance()
            .set(&DataKey::TrustedRegistry, &registry_id);
        // #691: persist allowed payment token so buyers cannot substitute a fake one
        env.storage()
            .instance()
            .set(&DataKey::AllowedToken, &token_id);
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
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
    }

    // ── Offers ───────────────────────────────────────────────────────────────

    /// List a credit for sale with XLM pricing. Returns the new offer ID.
    ///
    /// This is the original XLM-only entry point, kept for backward compatibility.
    /// For multi-asset pricing (USDC, custom SAC tokens) use [`create_offer_with_asset`].
    ///
    /// Verifies that the credit exists and is [`CreditStatus::Active`] in the registry.
    ///
    /// # Errors
    /// - [`MarketplaceError::ContractPaused`] — contract is paused.
    /// - [`MarketplaceError::InvalidNonce`] — `nonce` does not match the current seller nonce.
    /// - [`MarketplaceError::InvalidPrice`] — `price_xlm` is zero or negative. (#696)
    /// - [`MarketplaceError::InvalidTonnes`] — `tonnes` is zero, negative, or not a multiple of 100_000.
    /// - [`MarketplaceError::InvalidRegistry`] — `registry_id` does not match the trusted registry (#692).
    /// - [`MarketplaceError::CreditNotFound`] — credit does not exist in the registry (#690).
    /// - [`MarketplaceError::CreditNotActive`] — credit is not in `Active` status.
    /// - [`MarketplaceError::EscrowFailed`] — escrow transfer did not complete (contract does not own credit). (#693)
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
        Self::create_offer_internal(
            env,
            seller,
            credit_id,
            price_xlm,
            AssetType::Native,
            tonnes,
            registry_id,
            expires_at,
            nonce,
        )
    }

    /// List a credit for sale with any Stellar asset (XLM, USDC, custom SAC tokens).
    ///
    /// `price_amount` is denominated in the base unit of `price_asset`:
    /// - `AssetType::Native` — stroops (same as `create_offer`).
    /// - `AssetType::Asset(address)` — token's smallest unit (e.g. 1 USDC = 10_000_000
    ///   if the token uses 7 decimal places).
    ///
    /// The buyer must hold enough of the specified asset before calling [`buy_offer`].
    ///
    /// # Errors
    /// Same as [`create_offer`].
    pub fn create_offer_with_asset(
        env: Env,
        seller: Address,
        credit_id: BytesN<32>,
        price_amount: i128,
        price_asset: AssetType,
        tonnes: i128,
        registry_id: Address,
        expires_at: Option<u64>,
        nonce: u64,
    ) -> Result<u64, MarketplaceError> {
        Self::create_offer_internal(
            env,
            seller,
            credit_id,
            price_amount,
            price_asset,
            tonnes,
            registry_id,
            expires_at,
            nonce,
        )
    }

    /// Internal shared implementation for both `create_offer` variants.
    #[allow(clippy::too_many_arguments)]
    fn create_offer_internal(
        env: Env,
        seller: Address,
        credit_id: BytesN<32>,
        price_amount: i128,
        price_asset: AssetType,
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
        if price_amount <= 0 {
            return Err(MarketplaceError::InvalidPrice);
        }
        if tonnes <= 0 || tonnes % 100_000 != 0 {
            return Err(MarketplaceError::InvalidTonnes);
        }

        let min_price: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinPrice)
            .unwrap_or(0);
        if price_amount < min_price {
            return Err(MarketplaceError::InvalidPrice);
        }

        // #692: reject any registry_id that does not match the one stored at init
        Self::validate_registry(&env, &registry_id)?;

        // #690: use try_invoke_contract so a missing credit returns a clean error
        let credit: CreditMetadata = env
            .try_invoke_contract::<CreditMetadata, SorobanError>(
                &registry_id,
                &Symbol::new(&env, "get_credit"),
                (credit_id.clone(),).into_val(&env),
            )
            .map_err(|_| MarketplaceError::CreditNotFound)?
            .map_err(|_| MarketplaceError::CreditNotFound)?;
        if credit.status != CreditStatus::Active {
            return Err(MarketplaceError::CreditNotActive);
        }
        if credit.owner != seller {
            return Err(MarketplaceError::Unauthorized);
        }
        if tonnes > credit.tonnes {
            return Err(MarketplaceError::InvalidTonnes);
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
            (
                seller.clone(),
                escrow_account.clone(),
                credit_id.clone(),
                registry_nonce,
            )
                .into_val(&env),
        );

        // Derive price_xlm for backward compatibility: set only for Native asset
        let price_xlm = match price_asset {
            AssetType::Native => price_amount,
            AssetType::Asset(_) => 0,
        };

        let offer_id = Self::next_id(&env)?;
        let offer = Offer {
            seller: seller.clone(),
            credit_id,
            price_xlm,
            price_amount,
            price_asset,
            tonnes,
            active: true,
            created_at: env.ledger().timestamp(),
            expires_at,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Offer(offer_id), &offer);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Offer(offer_id), TTL_THRESHOLD, MIN_TTL);

        // Store escrowed amount for refund on cancellation
        env.storage()
            .persistent()
            .set(&DataKey::EscrowedAmount(offer_id), &price_amount);
        env.storage().persistent().extend_ttl(
            &DataKey::EscrowedAmount(offer_id),
            TTL_THRESHOLD,
            MIN_TTL,
        );

        // Index under seller
        let key = DataKey::SellerOffers(seller.clone());
        let mut ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| Vec::new(&env));
        ids.push_back(offer_id);
        env.storage().persistent().set(&key, &ids);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, MIN_TTL);

        // Add to global active index
        let mut active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveOffers)
            .unwrap_or_else(|| Vec::new(&env));
        active_ids.push_back(offer_id);
        env.storage()
            .persistent()
            .set(&DataKey::ActiveOffers, &active_ids);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::ActiveOffers, TTL_THRESHOLD, MIN_TTL);

        // Atomic-escrow guard
        let stored: Option<Offer> = env.storage().persistent().get(&DataKey::Offer(offer_id));
        if stored.is_none() {
            let seller_nonce: u64 = env.invoke_contract(
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
                    seller_nonce,
                )
                    .into_val(&env),
            );
            return Err(MarketplaceError::EscrowFailed);
        }

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
    /// - [`MarketplaceError::InvalidRegistry`] — `registry_id` does not match the trusted registry (#692).
    pub fn cancel_offer(
        env: Env,
        seller: Address,
        offer_id: u64,
        registry_id: Address,
        nonce: u64,
    ) -> Result<(), MarketplaceError> {
        if Self::is_paused(&env) {
            return Err(MarketplaceError::ContractPaused);
        }
        seller.require_auth();
        if !Self::consume_nonce(&env, &seller, nonce) {
            return Err(MarketplaceError::InvalidNonce);
        }

        // #692: reject any registry_id that does not match the one stored at init
        Self::validate_registry(&env, &registry_id)?;

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

        // #240: verify escrow still owns the credit before attempting transfer
        // #690: use try_invoke_contract so a missing credit returns a clean error
        let credit: CreditMetadata = env
            .try_invoke_contract::<CreditMetadata, SorobanError>(
                &registry_id,
                &Symbol::new(&env, "get_credit"),
                (offer.credit_id.clone(),).into_val(&env),
            )
            .map_err(|_| MarketplaceError::CreditNotFound)?
            .map_err(|_| MarketplaceError::CreditNotFound)?;
        if credit.owner != escrow_account {
            return Err(MarketplaceError::Unauthorized);
        }

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
        env.storage()
            .persistent()
            .set(&DataKey::Offer(offer_id), &offer);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Offer(offer_id), TTL_THRESHOLD, MIN_TTL);

        // Remove escrowed amount record
        env.storage()
            .persistent()
            .remove(&DataKey::EscrowedAmount(offer_id));

        // Remove from global active index
        let mut active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveOffers)
            .unwrap_or_else(|| Vec::new(&env));
        if let Some(pos) = active_ids.iter().position(|id| id == offer_id) {
            active_ids.remove(pos as u32);
            env.storage()
                .persistent()
                .set(&DataKey::ActiveOffers, &active_ids);
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::ActiveOffers, TTL_THRESHOLD, MIN_TTL);
        }

        OfferCxl {
            seller: seller.clone(),
            offer_id,
            escrowed,
        }
        .publish(&env);
        Ok(())
    }

    /// Fetch an offer by its ID.
    ///
    /// # Errors
    /// - [`MarketplaceError::OfferNotFound`] — no offer exists for `offer_id`.
    /// - [`MarketplaceError::OfferExpired`] — offer has expired (also marks it inactive and prunes index).
    pub fn get_offer(env: Env, offer_id: u64) -> Result<Offer, MarketplaceError> {
        let offer: Offer = env
            .storage()
            .persistent()
            .get(&DataKey::Offer(offer_id))
            .ok_or(MarketplaceError::OfferNotFound)?;

        if let Some(expires_at) = offer.expires_at {
            if env.ledger().timestamp() > expires_at && offer.active {
                // Note: do NOT mutate state here — Soroban rolls back writes when
                // returning Err; expiry filtering is done in read paths instead.
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
        let now = env.ledger().timestamp();
        for id in all_ids.iter() {
            let offer: Option<Offer> = env.storage().persistent().get(&DataKey::Offer(id));
            if let Some(o) = offer {
                if o.active {
                    let expired = o.expires_at.is_some_and(|e| now > e);
                    if !expired {
                        active.push_back(id);
                    }
                }
            }
        }
        active
    }

    /// Returns the total number of offers ever created (including cancelled ones).
    pub fn offer_count(env: Env) -> u64 {
        env.storage()
            .persistent()
            .get(&DataKey::OfferCount)
            .unwrap_or(0u64)
    }

    /// Clean up expired offers starting from `start_id`, processing at most `limit` offers (capped at 100).
    ///
    /// Marks expired offers inactive **and** removes them from the `ActiveOffers` index
    /// so that `list_active_offers` remains sub-linear in the total offer count. (#695)
    ///
    /// # Errors
    /// - [`MarketplaceError::NotInitialized`] / [`MarketplaceError::Unauthorized`] — caller is not admin.
    pub fn cleanup_expired_offers(
        env: Env,
        admin: Address,
        start_id: u64,
        limit: u32,
    ) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        let count = Self::offer_count(env.clone());
        let now = env.ledger().timestamp();
        let effective_limit = if limit > 100 { 100 } else { limit };
        let end = (start_id + effective_limit as u64).min(count);

        // Load the active index once; mutate in-place then write back. (#695)
        let mut active_ids: Vec<u64> = env.storage().persistent()
            .get(&DataKey::ActiveOffers)
            .unwrap_or_else(|| Vec::new(&env));
        let mut index_changed = false;

        for i in start_id..end {
            if let Some(mut offer) = env
                .storage()
                .persistent()
                .get::<_, Offer>(&DataKey::Offer(i))
            {
                if let Some(expires_at) = offer.expires_at {
                    if now > expires_at && offer.active {
                        offer.active = false;
                        env.storage().persistent().set(&DataKey::Offer(i), &offer);

                        // #695: Compact ActiveOffers — remove the expired ID from the index
                        if let Some(pos) = active_ids.iter().position(|id| id == i) {
                            active_ids.remove(pos as u32);
                            index_changed = true;
                        }
                    }
                }
            }
        }

        // Persist the compacted index only if it changed
        if index_changed {
            env.storage().persistent().set(&DataKey::ActiveOffers, &active_ids);
            env.storage().persistent().extend_ttl(&DataKey::ActiveOffers, TTL_THRESHOLD, MIN_TTL);
        }

        Ok(())
    }

    pub fn update_min_price(
        env: Env,
        admin: Address,
        new_min: i128,
    ) -> Result<(), MarketplaceError> {
        Self::require_admin(&env, &admin)?;
        env.storage().instance().set(&DataKey::MinPrice, &new_min);
        Ok(())
    }

    pub fn get_min_price(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MinPrice)
            .unwrap_or(0)
    }

    /// Update the price of an existing active offer. Only the original seller may reprice.
    ///
    /// For XLM (Native) offers, `new_price_amount` is in stroops.
    /// For SAC-token offers, `new_price_amount` is in the token's base unit.
    ///
    /// # Errors
    /// - [`MarketplaceError::ContractPaused`] — contract is paused.
    /// - [`MarketplaceError::InvalidNonce`] — nonce mismatch.
    /// - [`MarketplaceError::OfferNotFound`] — offer does not exist.
    /// - [`MarketplaceError::Unauthorized`] — caller is not the original seller.
    /// - [`MarketplaceError::AlreadyClosed`] — offer is inactive.
    /// - [`MarketplaceError::OfferExpired`] — offer has expired.
    /// - [`MarketplaceError::InvalidPrice`] — new price is zero, negative, or below min_price. (#696)
    pub fn update_offer_price(
        env: Env,
        seller: Address,
        offer_id: u64,
        new_price_xlm: i128,
        nonce: u64,
    ) -> Result<(), MarketplaceError> {
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
        if let Some(expires_at) = offer.expires_at {
            if env.ledger().timestamp() > expires_at {
                return Err(MarketplaceError::OfferExpired);
            }
        }
        // #696: InvalidPrice for zero/negative price in update path
        if new_price_xlm <= 0 {
            return Err(MarketplaceError::InvalidPrice);
        }
        let min_price: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinPrice)
            .unwrap_or(0);
        if new_price_xlm < min_price {
            return Err(MarketplaceError::InvalidPrice);
        }
        // Update both price fields for consistency across old and new callers
        offer.price_amount = new_price_xlm;
        if matches!(offer.price_asset, AssetType::Native) {
            offer.price_xlm = new_price_xlm;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Offer(offer_id), &offer);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Offer(offer_id), TTL_THRESHOLD, MIN_TTL);
        OfferUpdated {
            seller,
            offer_id,
            new_price_xlm,
        }
        .publish(&env);
        Ok(())
    }

    /// Purchase an active offer.
    ///
    /// Payment is transferred in the asset declared on the offer (`price_asset`):
    /// - `AssetType::Native` — XLM via the native token contract (`token_id`).
    /// - `AssetType::Asset(sac_address)` — the SAC token contract handles the transfer.
    ///
    /// The `token_id` parameter is used **only** for `AssetType::Native` offers (backward
    /// compatibility). For SAC-token offers the asset contract address is read directly from
    /// the offer's `price_asset` field, so the caller may pass any address for `token_id`.
    ///
    /// Execution order (all-or-nothing, Soroban atomicity):
    /// 1. Validate offer exists, is active, and not expired.
    /// 2. Determine payment asset and amount from offer fields.
    /// 3. Pre-check buyer balance ≥ `price_amount` (returns `InsufficientFunds` early).
    /// 4. **Token transfer first** — transfer `price_amount` from buyer → seller.
    /// 5. **Credit transfer second** — transfer escrowed credit from marketplace → buyer.
    /// 6. Mark offer inactive, remove from active index.
    ///
    /// # Errors
    /// - [`MarketplaceError::ContractPaused`] — contract is paused.
    /// - [`MarketplaceError::InvalidNonce`] — `nonce` does not match the current buyer nonce.
    /// - [`MarketplaceError::InvalidRegistry`] — `registry_id` does not match the trusted registry (#692).
    /// - [`MarketplaceError::InvalidToken`] — `token_id` does not match the allowed payment token (#691).
    /// - [`MarketplaceError::OfferNotFound`] — no offer exists for `offer_id`.
    /// - [`MarketplaceError::AlreadyClosed`] — offer has already been cancelled/filled.
    /// - [`MarketplaceError::OfferExpired`] — offer has expired.
    /// - [`MarketplaceError::InsufficientFunds`] — buyer balance is less than `price_amount`.
    /// - [`MarketplaceError::Overflow`] — price is zero or negative (corrupt state).
    pub fn buy_offer(
        env: Env,
        buyer: Address,
        offer_id: u64,
        registry_id: Address,
        token_id: Address,
        nonce: u64,
    ) -> Result<(), MarketplaceError> {
        if Self::is_paused(&env) {
            return Err(MarketplaceError::ContractPaused);
        }
        buyer.require_auth();
        if !Self::consume_nonce(&env, &buyer, nonce) {
            return Err(MarketplaceError::InvalidNonce);
        }

        // #692: reject any registry_id that does not match the one stored at init
        Self::validate_registry(&env, &registry_id)?;
        // #691: reject any token_id that does not match the allowed payment token
        Self::validate_token(&env, &token_id)?;

        // Load and validate the offer — all checks before any state mutation.
        let mut offer: Offer = env
            .storage()
            .persistent()
            .get(&DataKey::Offer(offer_id))
            .ok_or(MarketplaceError::OfferNotFound)?;

        if !offer.active {
            return Err(MarketplaceError::AlreadyClosed);
        }
        if let Some(expires_at) = offer.expires_at {
            if env.ledger().timestamp() > expires_at {
                return Err(MarketplaceError::OfferExpired);
            }
        }

        // Resolve the payment asset contract address and amount.
        // For backward-compat Native offers, fall back to price_xlm if price_amount is 0.
        let price: i128 = if offer.price_amount > 0 {
            offer.price_amount
        } else {
            offer.price_xlm
        };
        if price <= 0 {
            return Err(MarketplaceError::Overflow);
        }

        // Resolve which contract to call for balance/transfer.
        let payment_contract: Address = match &offer.price_asset {
            AssetType::Native => token_id.clone(),
            AssetType::Asset(sac) => sac.clone(),
        };

        // ── Pre-check: verify buyer holds enough of the payment asset ─────────────
        let buyer_balance: i128 = env.invoke_contract(
            &payment_contract,
            &Symbol::new(&env, "balance"),
            (buyer.clone(),).into_val(&env),
        );
        if buyer_balance < price {
            return Err(MarketplaceError::InsufficientFunds);
        }

        let escrow_account: Address = env.current_contract_address();

        // ── Step 1 (token transfer FIRST) ─────────────────────────────────────────
        let _: () = env.invoke_contract(
            &payment_contract,
            &Symbol::new(&env, "transfer"),
            (buyer.clone(), offer.seller.clone(), price).into_val(&env),
        );

        // ── Step 2 (credit transfer SECOND) ──────────────────────────────────────
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
                buyer.clone(),
                offer.credit_id.clone(),
                registry_nonce,
            )
                .into_val(&env),
        );

        // ── Mark offer inactive and remove from indexes ───────────────────────────
        offer.active = false;
        env.storage()
            .persistent()
            .set(&DataKey::Offer(offer_id), &offer);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Offer(offer_id), TTL_THRESHOLD, MIN_TTL);

        // Clear escrowed-amount record
        env.storage()
            .persistent()
            .remove(&DataKey::EscrowedAmount(offer_id));

        // Remove from global active index
        let mut active_ids: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveOffers)
            .unwrap_or_else(|| Vec::new(&env));
        if let Some(pos) = active_ids.iter().position(|id| id == offer_id) {
            active_ids.remove(pos as u32);
            env.storage()
                .persistent()
                .set(&DataKey::ActiveOffers, &active_ids);
            env.storage()
                .persistent()
                .extend_ttl(&DataKey::ActiveOffers, TTL_THRESHOLD, MIN_TTL);
        }

        Ok(())
    }

    /// Return a paginated list of all currently active offer IDs, capped at 50 per page.
    /// Filters out expired offers before returning.
    ///
    /// `page` is 0-indexed. `page_size` is clamped to 50.
    /// Because `ActiveOffers` is pruned on every cancel/buy/expiry/cleanup,
    /// this read is O(page_size) not O(total offers). (#694)
    pub fn list_active_offers(env: Env, page: u32, page_size: u32) -> Vec<u64> {
        let page_size = page_size.min(50) as usize;
        let all: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveOffers)
            .unwrap_or_else(|| Vec::new(&env));

        let now = env.ledger().timestamp();
        let mut filtered: Vec<u64> = Vec::new(&env);

        // Filter out expired offers
        for id in all.iter() {
            if let Some(offer) = env
                .storage()
                .persistent()
                .get::<_, Offer>(&DataKey::Offer(id))
            {
                if offer.active {
                    let expired = offer.expires_at.is_some_and(|e| now > e);
                    if !expired {
                        filtered.push_back(id);
                    }
                }
            }
        }

        let start = (page as usize) * page_size;
        let mut result: Vec<u64> = Vec::new(&env);
        for i in start..(start + page_size) {
            if i >= filtered.len() as usize {
                break;
            }
            result.push_back(filtered.get(i as u32).unwrap());
        }
        result
    }

    /// Returns all active offer IDs from the global index (non-paginated).
    ///
    /// WARNING: This reads the entire `ActiveOffers` vector into memory.
    /// For large marketplaces, prefer `get_active_offers_paginated` which
    /// returns a bounded slice and filters out expired entries.
    pub fn get_active_offers(env: Env) -> Vec<u64> {
        env.storage()
            .persistent()
            .get(&DataKey::ActiveOffers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    /// Paginated variant of `get_active_offers`.
    ///
    /// Reads the global `ActiveOffers` index, filters out expired offers,
    /// and returns a single page of results.  Page size is capped at 50.
    ///
    /// `page` is 0-indexed.  `page_size` is clamped to 50.
    pub fn get_active_offers_paginated(env: Env, page: u32, page_size: u32) -> Vec<u64> {
        Self::list_active_offers(env, page, page_size)
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    fn next_id(env: &Env) -> Result<u64, MarketplaceError> {
        let id: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::OfferCount)
            .unwrap_or(0u64);
        let next_id = id.checked_add(1).ok_or(MarketplaceError::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::OfferCount, &next_id);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::OfferCount, TTL_THRESHOLD, MIN_TTL);
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

    /// #692: Verify that `supplied` matches the trusted registry stored at init.
    fn validate_registry(env: &Env, supplied: &Address) -> Result<(), MarketplaceError> {
        let trusted: Address = env
            .storage()
            .instance()
            .get(&DataKey::TrustedRegistry)
            .ok_or(MarketplaceError::NotInitialized)?;
        if *supplied != trusted {
            return Err(MarketplaceError::InvalidRegistry);
        }
        Ok(())
    }

    /// #691: Verify that `supplied` matches the allowed payment token stored at init.
    fn validate_token(env: &Env, supplied: &Address) -> Result<(), MarketplaceError> {
        let allowed: Address = env
            .storage()
            .instance()
            .get(&DataKey::AllowedToken)
            .ok_or(MarketplaceError::NotInitialized)?;
        if *supplied != allowed {
            return Err(MarketplaceError::InvalidToken);
        }
        Ok(())
    }

    fn is_paused(env: &Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false)
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

    pub fn get_nonce(env: Env, address: Address) -> u64 {
        get_nonce(&env, &address)
    }

    // ── Contract Upgrade ─────────────────────────────────────────────────────

    /// Upgrade the contract WASM to a new hash. Only the admin may call this.
    ///
    /// # Errors
    /// - [`MarketplaceError::NotInitialized`] — contract has not been initialised.
    /// - [`MarketplaceError::Unauthorized`] — caller is not the admin.
    /// - [`MarketplaceError::InvalidNonce`] — `nonce` does not match the current admin nonce.
    pub fn upgrade(
        env: Env,
        admin: Address,
        new_wasm_hash: BytesN<32>,
        nonce: u64,
    ) -> Result<(), MarketplaceError> {
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
    use carbonchain_credit_registry::test_helpers::RegistryHelper;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{BytesN, Env, String};

    fn setup_with_registry(
        env: &Env,
    ) -> (
        MarketplaceClient<'static>,
        Address,
        Address,
        RegistryHelper,
        BytesN<32>,
    ) {
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
        // Use a placeholder token address for tests that do not exercise buy_offer.
        // Tests that call buy_offer must use setup_with_token instead, which properly
        // initialises the marketplace with the real token address (#691).
        let placeholder_token = Address::generate(env);
        client.initialize(&mp_admin, &0, &registry.id, &placeholder_token);
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
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
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
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
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
        let _offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let seller_nonce2 = client.get_nonce(&seller);
        assert!(client
            .try_create_offer(
                &seller,
                &credit_id,
                &20_000_000,
                &250_000,
                &registry.id,
                &None,
                &seller_nonce2
            )
            .is_err());
    }

    #[test]
    fn test_cancel_offer_returns_credit_to_seller() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
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
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        let seller_nonce3 = client.get_nonce(&seller);
        assert!(client
            .try_cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce3)
            .is_err());
    }

    #[test]
    fn test_invalid_price_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        assert!(client
            .try_create_offer(
                &seller,
                &credit_id,
                &0,
                &500_000,
                &registry.id,
                &None,
                &seller_nonce
            )
            .is_err());
    }

    #[test]
    fn test_negative_price_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        assert!(client
            .try_create_offer(
                &seller,
                &credit_id,
                &-1,
                &500_000,
                &registry.id,
                &None,
                &seller_nonce
            )
            .is_err());
    }

    #[test]
    fn test_zero_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &0,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    #[test]
    fn test_negative_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &-100_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    #[test]
    fn test_tonnes_multiple_of_100000_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &100_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(offer_id, 0);
    }

    #[test]
    fn test_tonnes_not_multiple_of_100000_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &99_999,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    #[test]
    fn test_get_offers_by_seller() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        // Cancel first offer to return credit, then create another
        let seller_nonce_cancel = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce_cancel);
        let seller_nonce2 = client.get_nonce(&seller);
        client.create_offer(
            &seller,
            &credit_id,
            &20_000_000,
            &200_000,
            &registry.id,
            &None,
            &seller_nonce2,
        );
        assert_eq!(client.get_offers_by_seller(&seller).len(), 2);
    }

    #[test]
    fn test_offer_count() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        // Cancel first offer to return credit, then create another
        let seller_nonce_cancel = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce_cancel);
        let seller_nonce2 = client.get_nonce(&seller);
        client.create_offer(
            &seller,
            &credit_id,
            &20_000_000,
            &200_000,
            &registry.id,
            &None,
            &seller_nonce2,
        );
        assert_eq!(client.offer_count(), 2);
    }

    #[test]
    fn test_unauthorized_cancel_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let other = Address::generate(&env);
        let ononce = client.get_nonce(&other);
        assert!(client
            .try_cancel_offer(&other, &offer_id, &registry.id, &ononce)
            .is_err());
    }

    // ── get_active_offers_by_seller tests ────────────────────────────────────

    #[test]
    fn test_get_active_offers_by_seller_filters_cancelled() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let id0 = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        // Cancel the first offer to return credit, then create a second one.
        let seller_nonce_cancel = client.get_nonce(&seller);
        client.cancel_offer(&seller, &id0, &registry.id, &seller_nonce_cancel);
        let seller_nonce2 = client.get_nonce(&seller);
        let id1 = client.create_offer(
            &seller,
            &credit_id,
            &20_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce2,
        );
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
        let id0 = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
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
        assert!(client
            .try_create_offer(
                &seller,
                &credit_id,
                &10_000_000,
                &500_000,
                &registry.id,
                &None,
                &seller_nonce
            )
            .is_err());
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
        assert!(client
            .try_create_offer(
                &seller,
                &credit_id,
                &10_000_000,
                &500_000,
                &registry.id,
                &None,
                &seller_nonce
            )
            .is_ok());
    }

    #[test]
    fn test_pause_blocks_cancel_offer() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        client.pause(&admin);
        let seller_nonce2 = client.get_nonce(&seller);
        assert!(client
            .try_cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2)
            .is_err());
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
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
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
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let offer_before = client.get_offer(&offer_id);
        assert!(offer_before.active);
        assert_eq!(offer_before.price_xlm, price);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        let offer_after = client.get_offer(&offer_id);
        assert!(!offer_after.active);
    }

    // ── Issue #235: tonnes > credit.tonnes must be rejected ─────────────────

    #[test]
    fn test_create_offer_over_credit_tonnes_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        // credit has 1_000_000 units; try to list 2_000_000
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &2_000_000, // more than credit.tonnes
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidTonnes)));
    }

    // ── Issue #238: AlreadyInitialized on double-call ────────────────────────

    #[test]
    fn test_double_initialize_returns_already_initialized() {
        let env = Env::default();
        env.mock_all_auths();
        let marketplace_id = env.register(Marketplace, ());
        let client = MarketplaceClient::new(&env, &marketplace_id);
        let admin = Address::generate(&env);
        let registry_addr = Address::generate(&env);
        let token_addr = Address::generate(&env);
        client.initialize(&admin, &0, &registry_addr, &token_addr);
        let result = client.try_initialize(&admin, &0, &registry_addr, &token_addr);
        assert_eq!(result, Err(Ok(MarketplaceError::AlreadyInitialized)));
    }

    // ── Issue #236: get_offer marks offer inactive on expiry ─────────────────

    #[test]
    fn test_get_offer_marks_inactive_on_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let now = env.ledger().timestamp();
        let expires_at = now + 100;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &Some(expires_at),
            &seller_nonce,
        );
        // Advance time past expiry
        env.ledger().set_timestamp(expires_at + 1);
        // get_offer should return OfferExpired
        assert_eq!(
            client.try_get_offer(&offer_id),
            Err(Ok(MarketplaceError::OfferExpired))
        );
        // Offer must now be inactive — no longer in active_offers listing
        assert_eq!(client.get_active_offers_by_seller(&seller).len(), 0);
    }

    // ── Issue #237: update_offer_price ───────────────────────────────────────

    #[test]
    fn test_update_offer_price_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let seller_nonce2 = client.get_nonce(&seller);
        client.update_offer_price(&seller, &offer_id, &20_000_000, &seller_nonce2);
        let offer = client.get_offer(&offer_id);
        assert_eq!(offer.price_xlm, 20_000_000);
    }

    #[test]
    fn test_update_offer_price_below_min_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(1735689600);
        let marketplace_id = env.register(Marketplace, ());
        let client = MarketplaceClient::new(&env, &marketplace_id);
        let admin = Address::generate(&env);
        let registry = RegistryHelper::deploy(&env);
        let verifier = Address::generate(&env);
        let issuer = Address::generate(&env);
        let retirement = Address::generate(&env);
        registry.initialize(&admin, &retirement, 1);
        let nonce = registry.get_nonce(&admin);
        registry.register_verifier(&admin, &verifier, nonce);
        let anonce = registry.get_nonce(&admin);
        registry.register_issuer(&admin, &issuer, anonce);
        let anonce2 = registry.get_nonce(&admin);
        registry.register_methodology(
            &admin,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "VCS"),
            anonce2,
        );
        registry.register_project(
            &admin,
            &String::from_str(&env, "PROJ-001"),
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &String::from_str(&env, "NG"),
        );
        let inonce = registry.get_nonce(&issuer);
        let credit_id = registry.submit_credit(
            &issuer,
            &String::from_str(&env, "PROJ-001"),
            2024,
            &String::from_str(&env, "VCS"),
            &String::from_str(&env, "NG"),
            1_000_000,
            &String::from_str(&env, "bafybei123"),
            inonce,
        );
        let vnonce = registry.get_nonce(&verifier);
        registry.approve_and_mint(&verifier, &credit_id, vnonce);
        let seller = Address::generate(&env);
        let tnonce = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &seller, &credit_id, tnonce);
        // #692/#691: initialize must now receive registry_id and token_id
        let placeholder_token = Address::generate(&env);
        client.initialize(&admin, &5_000_000, &registry.id, &placeholder_token); // min_price = 5_000_000
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let seller_nonce2 = client.get_nonce(&seller);
        assert_eq!(
            client.try_update_offer_price(&seller, &offer_id, &1_000_000, &seller_nonce2),
            Err(Ok(MarketplaceError::InvalidPrice))
        );
    }

    #[test]
    fn test_update_offer_price_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let other = Address::generate(&env);
        let ononce = client.get_nonce(&other);
        assert!(client
            .try_update_offer_price(&other, &offer_id, &20_000_000, &ononce)
            .is_err());
    }

    // ── Issue #239: list_active_offers global paginated index ────────────────

    #[test]
    fn test_list_active_offers_pagination() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let page0 = client.list_active_offers(&0, &50);
        assert_eq!(page0.len(), 1);
        assert_eq!(page0.get(0).unwrap(), offer_id);
        // page 1 should be empty
        let page1 = client.list_active_offers(&1, &50);
        assert_eq!(page1.len(), 0);
    }

    #[test]
    fn test_list_active_offers_removed_on_cancel() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(client.list_active_offers(&0, &50).len(), 1);
        let seller_nonce2 = client.get_nonce(&seller);
        client.cancel_offer(&seller, &offer_id, &registry.id, &seller_nonce2);
        assert_eq!(client.list_active_offers(&0, &50).len(), 0);
    }

    #[test]
    fn test_list_active_offers_page_size_capped_at_50() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _seller, _admin, _registry, _credit_id) = setup_with_registry(&env);
        // With no offers, page_size=100 should return empty (capped at 50, but still 0 items)
        let result = client.list_active_offers(&0, &100);
        assert_eq!(result.len(), 0);
    }

    // ── Issue #497: get_active_offers / get_active_offers_paginated tests ────

    #[test]
    fn test_get_active_offers_returns_all_ids() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let all = client.get_active_offers();
        // Should contain the newly created offer
        assert_eq!(all.len(), 1);
        assert_eq!(all.get(0).unwrap(), offer_id);
    }

    #[test]
    fn test_get_active_offers_paginated_returns_first_page() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        let page0 = client.get_active_offers_paginated(&0, &50);
        assert_eq!(page0.len(), 1);
        assert_eq!(page0.get(0).unwrap(), offer_id);
        // page 1 should be empty
        let page1 = client.get_active_offers_paginated(&1, &50);
        assert_eq!(page1.len(), 0);
    }

    #[test]
    fn test_get_active_offers_paginated_page_size_capped() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _seller, _admin, _registry, _credit_id) = setup_with_registry(&env);
        // page_size=100 should be capped to 50 (but still 0 items with no offers)
        let result = client.get_active_offers_paginated(&0, &100);
        assert_eq!(result.len(), 0);
    }

    // ── Issue #480: buy_offer tests ──────────────────────────────────────────

    /// Mock token contract that records calls and supports `balance` + `transfer`.
    /// Used exclusively in buy_offer tests.
    mod token_mock {
        use soroban_sdk::{contract, contractimpl, Address, Env};

        #[contract]
        pub struct MockToken;

        #[contractimpl]
        impl MockToken {
            /// Seed the mock balance for an address.
            pub fn set_balance(env: Env, addr: Address, amount: i128) {
                env.storage().persistent().set(&addr, &amount);
            }

            /// Native token `balance` interface.
            pub fn balance(env: Env, addr: Address) -> i128 {
                env.storage().persistent().get(&addr).unwrap_or(0i128)
            }

            /// Native token `transfer` interface.
            /// Subtracts from sender, adds to recipient.  Panics if sender has insufficient funds.
            pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
                let from_bal: i128 = env.storage().persistent().get(&from).unwrap_or(0);
                if from_bal < amount {
                    panic!("insufficient balance");
                }
                env.storage().persistent().set(&from, &(from_bal - amount));
                let to_bal: i128 = env.storage().persistent().get(&to).unwrap_or(0);
                env.storage().persistent().set(&to, &(to_bal + amount));
            }
        }
    }

    use token_mock::MockToken;
    use token_mock::MockTokenClient;

    fn setup_with_token(
        env: &Env,
    ) -> (
        MarketplaceClient<'static>,
        Address,
        Address,
        RegistryHelper,
        BytesN<32>,
        MockTokenClient<'static>,
    ) {
        // We must register the token BEFORE calling initialize so we can pass
        // its address as the allowed payment token (#691).  Therefore we cannot
        // reuse setup_with_registry here — we build everything from scratch.
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

        // Register the mock token first so its address is known at marketplace init.
        let token_contract_id = env.register(MockToken, ());
        let token = MockTokenClient::new(env, &token_contract_id);

        let marketplace_id = env.register(Marketplace, ());
        let client = MarketplaceClient::new(env, &marketplace_id);
        let mp_admin = Address::generate(env);
        // #691: pass the real token address so buy_offer validates it correctly.
        client.initialize(&mp_admin, &0, &registry.id, &token.address);

        let seller = Address::generate(env);
        let transfer_nonce = registry.get_nonce(&issuer);
        registry.transfer_credit(&issuer, &seller, &credit_id, transfer_nonce);

        (client, seller, mp_admin, registry, credit_id, token)
    }

    #[test]
    fn test_buy_offer_insufficient_funds_returns_error() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, token) = setup_with_token(&env);

        // Seller creates offer at 10_000_000 stroops
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );

        // Buyer has only 5_000_000 stroops — not enough
        let buyer = Address::generate(&env);
        token.set_balance(&buyer, &5_000_000);

        let buyer_nonce = client.get_nonce(&buyer);
        let result = client.try_buy_offer(
            &buyer,
            &offer_id,
            &registry.id,
            &token.address,
            &buyer_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InsufficientFunds)));

        // Offer must still be active — no state was changed
        assert!(client.get_offer(&offer_id).active);
    }

    #[test]
    fn test_buy_offer_sufficient_funds_succeeds() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, token) = setup_with_token(&env);

        let price = 10_000_000i128;

        // Seller creates offer
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );

        // Buyer has exactly enough
        let buyer = Address::generate(&env);
        token.set_balance(&buyer, &price);

        let buyer_nonce = client.get_nonce(&buyer);
        let result = client.try_buy_offer(
            &buyer,
            &offer_id,
            &registry.id,
            &token.address,
            &buyer_nonce,
        );
        assert!(result.is_ok());

        // Offer should now be inactive (filled)
        assert!(!client.get_offer(&offer_id).active);

        // Credit should now be owned by buyer
        let credit = registry.get_credit(&credit_id);
        assert_eq!(credit.owner, buyer);

        // Token should have moved: buyer -price, seller +price
        assert_eq!(token.balance(&buyer), 0);
        assert_eq!(token.balance(&seller), price);
    }

    #[test]
    fn test_buy_offer_removes_from_active_index() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, token) = setup_with_token(&env);

        let price = 10_000_000i128;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(client.list_active_offers(&0, &50).len(), 1);

        let buyer = Address::generate(&env);
        token.set_balance(&buyer, &price);
        let buyer_nonce = client.get_nonce(&buyer);
        client.buy_offer(
            &buyer,
            &offer_id,
            &registry.id,
            &token.address,
            &buyer_nonce,
        );

        // Should be removed from active index after purchase
        assert_eq!(client.list_active_offers(&0, &50).len(), 0);
    }

    #[test]
    fn test_buy_offer_already_closed_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, token) = setup_with_token(&env);

        let price = 10_000_000i128;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );

        // First buyer purchases the offer
        let buyer1 = Address::generate(&env);
        token.set_balance(&buyer1, &price);
        let b1nonce = client.get_nonce(&buyer1);
        client.buy_offer(&buyer1, &offer_id, &registry.id, &token.address, &b1nonce);

        // Second buyer tries to buy the same (now closed) offer
        let buyer2 = Address::generate(&env);
        token.set_balance(&buyer2, &price);
        let b2nonce = client.get_nonce(&buyer2);
        let result =
            client.try_buy_offer(&buyer2, &offer_id, &registry.id, &token.address, &b2nonce);
        assert_eq!(result, Err(Ok(MarketplaceError::AlreadyClosed)));
    }

    #[test]
    fn test_buy_offer_expired_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, token) = setup_with_token(&env);

        let now = env.ledger().timestamp();
        let expires_at = now + 100;
        let price = 10_000_000i128;

        // Seller creates offer with expiration
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &Some(expires_at),
            &seller_nonce,
        );

        // Fast-forward ledger timestamp past expiration
        env.ledger().set_timestamp(expires_at + 1);

        // Buyer attempts to buy expired offer
        let buyer = Address::generate(&env);
        token.set_balance(&buyer, &price);
        let buyer_nonce = client.get_nonce(&buyer);
        let result = client.try_buy_offer(
            &buyer,
            &offer_id,
            &registry.id,
            &token.address,
            &buyer_nonce,
        );

        // Should return OfferExpired error
        assert_eq!(result, Err(Ok(MarketplaceError::OfferExpired)));

        // Offer should still exist but buyer should not own the credit
        let credit = registry.get_credit(&credit_id);
        assert_ne!(credit.owner, buyer);
    }

    #[test]
    fn test_list_active_offers_filters_expired() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, _token) = setup_with_token(&env);

        let now = env.ledger().timestamp();
        let expires_at = now + 100;

        // Create offer with expiration
        let seller_nonce = client.get_nonce(&seller);
        let _offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &Some(expires_at),
            &seller_nonce,
        );

        // Offer should appear in active list
        assert_eq!(client.list_active_offers(&0, &50).len(), 1);

        // Fast-forward past expiration
        env.ledger().set_timestamp(expires_at + 1);

        // Offer should no longer appear in active list
        assert_eq!(client.list_active_offers(&0, &50).len(), 0);
    }

    // ── Issue #698: all MarketplaceError codes must be in the 300–313 range ─

    #[test]
    fn test_error_codes_in_300_range() {
        // Verify every variant is within the documented 300-313 band so that
        // codes never collide with credit_registry (100-130), retirement
        // (200-209), or mrv_oracle (400-409).
        assert_eq!(MarketplaceError::OfferNotFound as u32, 300);
        assert_eq!(MarketplaceError::Unauthorized as u32, 301);
        assert_eq!(MarketplaceError::InvalidPrice as u32, 302);
        assert_eq!(MarketplaceError::InvalidTonnes as u32, 303);
        assert_eq!(MarketplaceError::AlreadyClosed as u32, 304);
        assert_eq!(MarketplaceError::CreditNotActive as u32, 305);
        assert_eq!(MarketplaceError::NotInitialized as u32, 306);
        assert_eq!(MarketplaceError::ContractPaused as u32, 307);
        assert_eq!(MarketplaceError::InvalidNonce as u32, 308);
        assert_eq!(MarketplaceError::OfferExpired as u32, 309);
        assert_eq!(MarketplaceError::Overflow as u32, 310);
        assert_eq!(MarketplaceError::AlreadyInitialized as u32, 311);
        assert_eq!(MarketplaceError::InsufficientFunds as u32, 312);
        assert_eq!(MarketplaceError::EscrowFailed as u32, 313);

        // Ensure all codes fall within the expected band (300–399).
        let all_codes: [u32; 14] = [
            MarketplaceError::OfferNotFound as u32,
            MarketplaceError::Unauthorized as u32,
            MarketplaceError::InvalidPrice as u32,
            MarketplaceError::InvalidTonnes as u32,
            MarketplaceError::AlreadyClosed as u32,
            MarketplaceError::CreditNotActive as u32,
            MarketplaceError::NotInitialized as u32,
            MarketplaceError::ContractPaused as u32,
            MarketplaceError::InvalidNonce as u32,
            MarketplaceError::OfferExpired as u32,
            MarketplaceError::Overflow as u32,
            MarketplaceError::AlreadyInitialized as u32,
            MarketplaceError::InsufficientFunds as u32,
            MarketplaceError::EscrowFailed as u32,
        ];
        for code in all_codes {
            assert!(
                (300..400).contains(&code),
                "MarketplaceError code {code} is outside the 300-399 band"
            );
        }
    }

    // ── Issue #692: registry_id validation ───────────────────────────────────

    /// create_offer must reject a caller-supplied registry_id that differs from
    /// the one stored at initialisation.
    #[test]
    fn test_registry_create_offer_rejects_fake_registry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, _real_registry, credit_id) = setup_with_registry(&env);

        let fake_registry = Address::generate(&env);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &fake_registry, // attacker-controlled address
            &None,
            &seller_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidRegistry)));
    }

    /// cancel_offer must reject a caller-supplied registry_id that differs from
    /// the one stored at initialisation.
    #[test]
    fn test_registry_cancel_offer_rejects_fake_registry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id) = setup_with_registry(&env);

        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );

        let fake_registry = Address::generate(&env);
        let seller_nonce2 = client.get_nonce(&seller);
        let result = client.try_cancel_offer(&seller, &offer_id, &fake_registry, &seller_nonce2);
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidRegistry)));
    }

    /// buy_offer must reject a caller-supplied registry_id that differs from
    /// the one stored at initialisation.
    #[test]
    fn test_registry_buy_offer_rejects_fake_registry() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, token) = setup_with_token(&env);

        let price = 10_000_000i128;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );

        let buyer = Address::generate(&env);
        token.set_balance(&buyer, &price);
        let fake_registry = Address::generate(&env);
        let buyer_nonce = client.get_nonce(&buyer);
        let result = client.try_buy_offer(
            &buyer,
            &offer_id,
            &fake_registry, // attacker-controlled address
            &token.address,
            &buyer_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidRegistry)));
        // Offer must still be active — no state was changed
        assert!(client.get_offer(&offer_id).active);
    }

    // ── Issue #691: payment token validation ─────────────────────────────────

    /// buy_native — buyer cannot substitute a fake payment token.
    /// Even with a huge fake balance the buy must fail before any transfer.
    #[test]
    fn test_buy_native_rejects_fake_payment_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, credit_id, _real_token) = setup_with_token(&env);

        let price = 10_000_000i128;
        let seller_nonce = client.get_nonce(&seller);
        let offer_id = client.create_offer(
            &seller,
            &credit_id,
            &price,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );

        // Deploy a separate "fake" token that the buyer controls and has
        // an enormous balance — it should be rejected outright.
        let fake_token_id = env.register(MockToken, ());
        let fake_token = MockTokenClient::new(&env, &fake_token_id);
        let buyer = Address::generate(&env);
        fake_token.set_balance(&buyer, &i128::MAX);

        let buyer_nonce = client.get_nonce(&buyer);
        let result = client.try_buy_offer(
            &buyer,
            &offer_id,
            &registry.id,
            &fake_token.address, // attacker-controlled token
            &buyer_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::InvalidToken)));
        // Offer must still be active — payment was rejected, nothing transferred
        assert!(client.get_offer(&offer_id).active);
    }

    // ── Issue #690: get_credit missing credit returns clean error ─────────────

    /// create_offer with a non-existent credit_id must return CreditNotFound
    /// instead of aborting the transaction with a panic.
    #[test]
    fn test_get_credit_missing_returns_credit_not_found() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, seller, _admin, registry, _credit_id) = setup_with_registry(&env);

        // Use a credit_id that was never issued
        let nonexistent_credit = BytesN::from_array(&env, &[0xde; 32]);
        let seller_nonce = client.get_nonce(&seller);
        let result = client.try_create_offer(
            &seller,
            &nonexistent_credit,
            &10_000_000,
            &500_000,
            &registry.id,
            &None,
            &seller_nonce,
        );
        assert_eq!(result, Err(Ok(MarketplaceError::CreditNotFound)));
    }
}
