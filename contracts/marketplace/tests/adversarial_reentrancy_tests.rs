//! Adversarial security audit suite for the CarbonChain Marketplace contract (#1378).
//!
//! Covers:
//! 1. Cross-contract reentrancy attacks during `buy_offer` and `buy_offer_quantity`
//!    via a malicious payment token attempting to re-enter before transfer completion.
//! 2. Arithmetic overflow and boundary checks on price, proportional partial-fill
//!    calculation, fee computation, and tonne quantities.
//! 3. Nonce replay, stale-offer, and expired-offer exploitation attempts.

use carbonchain_credit_registry::test_helpers::RegistryHelper;
use carbonchain_marketplace::{Marketplace, MarketplaceClient, MarketplaceError};
use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Address as _, testutils::Ledger as _,
    Address, BytesN, Env, String,
};

// ── Adversarial Malicious Token (Attempts Reentrancy on `transfer`) ──────────

mod reentrant_token {
    use super::*;

    #[contract]
    pub struct MaliciousReentrantToken;

    #[contractimpl]
    impl MaliciousReentrantToken {
        pub fn configure_attack(
            env: Env,
            marketplace: Address,
            registry: Address,
            offer_id: u64,
            attacker: Address,
            partial_tonnes: Option<i128>,
        ) {
            env.storage()
                .instance()
                .set(&symbol_short!("mp"), &marketplace);
            env.storage()
                .instance()
                .set(&symbol_short!("reg"), &registry);
            env.storage()
                .instance()
                .set(&symbol_short!("offer"), &offer_id);
            env.storage()
                .instance()
                .set(&symbol_short!("atk"), &attacker);
            env.storage()
                .instance()
                .set(&symbol_short!("part"), &partial_tonnes);
            env.storage()
                .instance()
                .set(&symbol_short!("armed"), &true);
        }

        pub fn set_balance(env: Env, addr: Address, amount: i128) {
            env.storage().persistent().set(&addr, &amount);
        }

        pub fn reentry_attempted(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("tried"))
                .unwrap_or(false)
        }

        pub fn reentry_succeeded(env: Env) -> bool {
            env.storage()
                .instance()
                .get(&symbol_short!("won"))
                .unwrap_or(false)
        }

        pub fn balance(env: Env, addr: Address) -> i128 {
            env.storage().persistent().get(&addr).unwrap_or(0i128)
        }

        pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
            let from_bal: i128 = env.storage().persistent().get(&from).unwrap_or(0);
            if from_bal < amount {
                panic!("insufficient balance");
            }
            env.storage()
                .persistent()
                .set(&from, &(from_bal - amount));
            let to_bal: i128 = env.storage().persistent().get(&to).unwrap_or(0);
            env.storage().persistent().set(&to, &(to_bal + amount));

            // Attempt reentrancy into the marketplace before `transfer` returns.
            let armed: bool = env
                .storage()
                .instance()
                .get(&symbol_short!("armed"))
                .unwrap_or(false);
            if armed {
                env.storage()
                    .instance()
                    .set(&symbol_short!("armed"), &false);
                env.storage()
                    .instance()
                    .set(&symbol_short!("tried"), &true);

                let mp_addr: Address = env
                    .storage()
                    .instance()
                    .get(&symbol_short!("mp"))
                    .unwrap();
                let reg_addr: Address = env
                    .storage()
                    .instance()
                    .get(&symbol_short!("reg"))
                    .unwrap();
                let offer_id: u64 = env
                    .storage()
                    .instance()
                    .get(&symbol_short!("offer"))
                    .unwrap();
                let attacker: Address = env
                    .storage()
                    .instance()
                    .get(&symbol_short!("atk"))
                    .unwrap();
                let partial: Option<i128> = env
                    .storage()
                    .instance()
                    .get(&symbol_short!("part"))
                    .unwrap_or(None);

                let mp = MarketplaceClient::new(&env, &mp_addr);
                let token_addr = env.current_contract_address();
                let next_nonce = mp.get_nonce(&attacker);

                let res = match partial {
                    Some(tonnes) => mp.try_buy_offer_quantity(
                        &attacker,
                        &offer_id,
                        &reg_addr,
                        &token_addr,
                        &tonnes,
                        &next_nonce,
                    ),
                    None => mp.try_buy_offer(
                        &attacker,
                        &offer_id,
                        &reg_addr,
                        &token_addr,
                        &next_nonce,
                    ),
                };

                if res.is_ok() {
                    env.storage()
                        .instance()
                        .set(&symbol_short!("won"), &true);
                }
            }
        }
    }
}

use reentrant_token::{MaliciousReentrantToken, MaliciousReentrantTokenClient};

// ── Test Fixture ─────────────────────────────────────────────────────────────

struct AuditFixture<'a> {
    marketplace: MarketplaceClient<'a>,
    marketplace_id: Address,
    registry: RegistryHelper,
    token: MaliciousReentrantTokenClient<'a>,
    seller: Address,
    admin: Address,
    credit_id: BytesN<32>,
}

fn setup_audit_fixture<'a>(env: &'a Env, tonnes: i128) -> AuditFixture<'a> {
    env.ledger().set_timestamp(1_735_689_600);
    let registry = RegistryHelper::deploy(env);

    let admin = Address::generate(env);
    let verifier = Address::generate(env);
    let issuer = Address::generate(env);
    let retirement = Address::generate(env);
    registry.initialize(&admin, &retirement, 1);

    let n1 = registry.get_nonce(&admin);
    registry.register_verifier(&admin, &verifier, n1);
    let n2 = registry.get_nonce(&admin);
    registry.register_issuer(&admin, &issuer, n2);
    let n3 = registry.get_nonce(&admin);
    registry.register_methodology(
        &admin,
        &String::from_str(env, "VCS"),
        &String::from_str(env, "Verified Carbon Standard"),
        n3,
    );
    registry.register_project(
        &admin,
        &String::from_str(env, "PROJ-AUDIT-01"),
        &String::from_str(env, "Security Audit Project"),
        &String::from_str(env, "Reentrancy & Overflow Audit"),
        &String::from_str(env, "BR"),
    );

    let inonce = registry.get_nonce(&issuer);
    let credit_id = registry.submit_credit(
        &issuer,
        &String::from_str(env, "PROJ-AUDIT-01"),
        2024,
        &String::from_str(env, "VCS"),
        &String::from_str(env, "BR"),
        tonnes,
        &String::from_str(env, "bafybeiaudit123"),
        inonce,
    );
    let vnonce = registry.get_nonce(&verifier);
    registry.approve_and_mint(&verifier, &credit_id, vnonce);

    let token_id = env.register(MaliciousReentrantToken, ());
    let token = MaliciousReentrantTokenClient::new(env, &token_id);

    let marketplace_id = env.register(Marketplace, ());
    let marketplace = MarketplaceClient::new(env, &marketplace_id);
    let mp_admin = Address::generate(env);
    marketplace.initialize(&mp_admin, &0, &registry.id, &token.address);

    let seller = Address::generate(env);
    let tnonce = registry.get_nonce(&issuer);
    registry.transfer_credit(&issuer, &seller, &credit_id, tnonce);

    AuditFixture {
        marketplace,
        marketplace_id,
        registry,
        token,
        seller,
        admin: mp_admin,
        credit_id,
    }
}

// ── 1. Reentrancy Tests ──────────────────────────────────────────────────────

#[test]
fn test_reentrant_buy_offer_blocked_during_token_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup_audit_fixture(&env, 1_000_000);

    let price = 10_000_000i128;
    let seller_nonce = f.marketplace.get_nonce(&f.seller);
    let offer_id = f.marketplace.create_offer(
        &f.seller,
        &f.credit_id,
        &price,
        &1_000_000,
        &f.registry.id,
        &None,
        &seller_nonce,
    );

    let attacker = Address::generate(&env);
    // Fund attacker with enough for 2x price to ensure failure is not balance-related.
    f.token.set_balance(&attacker, &(price * 2));
    f.token.configure_attack(
        &f.marketplace_id,
        &f.registry.id,
        &offer_id,
        &attacker,
        &None,
    );

    let buyer_nonce = f.marketplace.get_nonce(&attacker);
    // Outer buy_offer completes, while inner reentrant call must not succeed
    // (either rejected by Soroban reentrancy guard or because offer/escrow state prevents double-fill).
    let outer_res = f.marketplace.try_buy_offer(
        &attacker,
        &offer_id,
        &f.registry.id,
        &f.token.address,
        &buyer_nonce,
    );

    assert!(f.token.reentry_attempted());
    assert!(
        !f.token.reentry_succeeded(),
        "reentrant buy_offer call must never succeed"
    );

    if outer_res.is_ok() {
        let offer = f.marketplace.get_offer(&offer_id);
        assert!(!offer.active, "offer must be closed after single purchase");
        assert_eq!(f.token.balance(&f.seller), price);
        assert_eq!(f.token.balance(&attacker), price);
    }
}

#[test]
fn test_reentrant_partial_buy_offer_quantity_blocked() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup_audit_fixture(&env, 1_000_000);

    let price = 10_000_000i128;
    let seller_nonce = f.marketplace.get_nonce(&f.seller);
    let offer_id = f.marketplace.create_offer(
        &f.seller,
        &f.credit_id,
        &price,
        &1_000_000,
        &f.registry.id,
        &None,
        &seller_nonce,
    );

    let attacker = Address::generate(&env);
    f.token.set_balance(&attacker, &(price * 2));
    f.token.configure_attack(
        &f.marketplace_id,
        &f.registry.id,
        &offer_id,
        &attacker,
        &Some(500_000),
    );

    let buyer_nonce = f.marketplace.get_nonce(&attacker);
    let _ = f.marketplace.try_buy_offer_quantity(
        &attacker,
        &offer_id,
        &f.registry.id,
        &f.token.address,
        &500_000,
        &buyer_nonce,
    );

    assert!(f.token.reentry_attempted());
    assert!(
        !f.token.reentry_succeeded(),
        "reentrant buy_offer_quantity must be blocked before state finalization"
    );
}

// ── 2. Arithmetic Overflow & Boundary Tests ──────────────────────────────────

#[test]
fn test_buy_offer_quantity_multiplication_overflow_returns_overflow_error() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup_audit_fixture(&env, 1_000_000);

    // Listing with near-i128::MAX price so `offer_price.checked_mul(quantity)` overflows
    // on partial fill (`500_000 * (i128::MAX / 2)` > `i128::MAX`).
    let huge_price = i128::MAX / 2;
    let seller_nonce = f.marketplace.get_nonce(&f.seller);
    let offer_id = f.marketplace.create_offer(
        &f.seller,
        &f.credit_id,
        &huge_price,
        &1_000_000,
        &f.registry.id,
        &None,
        &seller_nonce,
    );

    let buyer = Address::generate(&env);
    f.token.set_balance(&buyer, &i128::MAX);

    let buyer_nonce = f.marketplace.get_nonce(&buyer);
    let res = f.marketplace.try_buy_offer_quantity(
        &buyer,
        &offer_id,
        &f.registry.id,
        &f.token.address,
        &500_000,
        &buyer_nonce,
    );

    assert_eq!(res, Err(Ok(MarketplaceError::Overflow)));
    assert!(f.marketplace.get_offer(&offer_id).active);
}

#[test]
fn test_buy_offer_fee_calculation_does_not_overflow_near_i128_max() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup_audit_fixture(&env, 1_000_000);

    // Enable max allowed fee (10% = 1000 bps)
    let fee_recipient = Address::generate(&env);
    let admin_nonce = f.marketplace.get_nonce(&f.admin);
    f.marketplace.update_fee(&f.admin, &1_000, &fee_recipient, &admin_nonce);

    let huge_price = i128::MAX - 10_000;
    let seller_nonce = f.marketplace.get_nonce(&f.seller);
    let offer_id = f.marketplace.create_offer(
        &f.seller,
        &f.credit_id,
        &huge_price,
        &1_000_000,
        &f.registry.id,
        &None,
        &seller_nonce,
    );

    let buyer = Address::generate(&env);
    f.token.set_balance(&buyer, &i128::MAX);

    let buyer_nonce = f.marketplace.get_nonce(&buyer);
    let res = f.marketplace.try_buy_offer(
        &buyer,
        &offer_id,
        &f.registry.id,
        &f.token.address,
        &buyer_nonce,
    );

    assert!(res.is_ok(), "safe fee division must not overflow near i128::MAX");
    assert!(!f.marketplace.get_offer(&offer_id).active);
}

#[test]
fn test_invalid_tonnes_granularity_and_zero_quantities_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup_audit_fixture(&env, 1_000_000);

    let seller_nonce = f.marketplace.get_nonce(&f.seller);
    let offer_id = f.marketplace.create_offer(
        &f.seller,
        &f.credit_id,
        &10_000_000,
        &1_000_000,
        &f.registry.id,
        &None,
        &seller_nonce,
    );

    let buyer = Address::generate(&env);
    f.token.set_balance(&buyer, &100_000_000);

    for bad_qty in [0i128, -100_000, 50_000, 1_100_000] {
        let nonce = f.marketplace.get_nonce(&buyer);
        let res = f.marketplace.try_buy_offer_quantity(
            &buyer,
            &offer_id,
            &f.registry.id,
            &f.token.address,
            &bad_qty,
            &nonce,
        );
        assert_eq!(res, Err(Ok(MarketplaceError::InvalidTonnes)));
    }
}

// ── 3. Nonce Replay & Stale Offer Tests ──────────────────────────────────────

#[test]
fn test_nonce_replay_and_double_buy_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let f = setup_audit_fixture(&env, 1_000_000);

    let price = 5_000_000i128;
    let seller_nonce = f.marketplace.get_nonce(&f.seller);
    let offer_id = f.marketplace.create_offer(
        &f.seller,
        &f.credit_id,
        &price,
        &1_000_000,
        &f.registry.id,
        &None,
        &seller_nonce,
    );

    let buyer = Address::generate(&env);
    f.token.set_balance(&buyer, &(price * 3));

    let nonce = f.marketplace.get_nonce(&buyer);
    f.marketplace
        .buy_offer(&buyer, &offer_id, &f.registry.id, &f.token.address, &nonce);

    // Replay with same nonce must fail with InvalidNonce.
    let replay_res = f.marketplace.try_buy_offer(
        &buyer,
        &offer_id,
        &f.registry.id,
        &f.token.address,
        &nonce,
    );
    assert_eq!(replay_res, Err(Ok(MarketplaceError::InvalidNonce)));

    // Second buy with fresh nonce on closed offer must fail with AlreadyClosed.
    let next_nonce = f.marketplace.get_nonce(&buyer);
    let double_buy_res = f.marketplace.try_buy_offer(
        &buyer,
        &offer_id,
        &f.registry.id,
        &f.token.address,
        &next_nonce,
    );
    assert_eq!(double_buy_res, Err(Ok(MarketplaceError::AlreadyClosed)));
}
