#![no_main]

use arbitrary::Arbitrary;
use carbonchain_credit_registry::{CreditRegistry, CreditRegistryClient};
use carbonchain_marketplace::{Marketplace, MarketplaceClient};
use libfuzzer_sys::fuzz_target;
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String,
};

#[derive(Arbitrary, Debug)]
struct OfferMatchingInput {
    price_xlm: i128,
    tonnes: i128,
    min_purchase_tonnes: Option<i128>,
    partial_buys: Vec<i128>,
    use_full_buy: bool,
}

fuzz_target!(|input: OfferMatchingInput| {
    let env = Env::default();
    env.mock_all_auths();

    let registry_id = env.register(CreditRegistry, ());
    let registry = CreditRegistryClient::new(&env, &registry_id);
    let reg_admin = Address::generate(&env);
    let issuer = Address::generate(&env);
    let verifier = Address::generate(&env);
    let seller = Address::generate(&env);
    let buyer = Address::generate(&env);

    registry.initialize(&reg_admin);
    let v_nonce = registry.get_nonce(&reg_admin);
    registry.register_verifier(&reg_admin, &verifier, &v_nonce);
    let i_nonce = registry.get_nonce(&reg_admin);
    registry.register_issuer(&reg_admin, &issuer, &i_nonce);
    let m_nonce = registry.get_nonce(&reg_admin);
    registry.register_methodology(
        &reg_admin,
        &String::from_str(&env, "VCS"),
        &String::from_str(&env, "Verified Carbon Standard"),
        &m_nonce,
    );
    registry.register_project(
        &reg_admin,
        &String::from_str(&env, "PROJ-FUZZ"),
        &String::from_str(&env, "Fuzz Project"),
        &String::from_str(&env, "Fuzz testing"),
        &String::from_str(&env, "US"),
    );

    // Mint 1000.000000 tonnes (scaled by 1_000_000) to seller
    let initial_credit_tonnes: i128 = 1_000_000_000;
    let s_nonce = registry.get_nonce(&issuer);
    let credit_id = registry.submit_credit(
        &issuer,
        &String::from_str(&env, "PROJ-FUZZ"),
        &2024,
        &String::from_str(&env, "VCS"),
        &String::from_str(&env, "US"),
        &initial_credit_tonnes,
        &String::from_str(&env, "bafybeifuzz"),
        &s_nonce,
    );
    let a_nonce = registry.get_nonce(&verifier);
    registry.approve_and_mint(&verifier, &credit_id, &a_nonce);
    let t_nonce = registry.get_nonce(&issuer);
    registry.transfer_credit(&issuer, &seller, &credit_id, &t_nonce);

    // Register native-like payment token and fund buyer
    let token_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_id = sac.address();
    let sac_admin = StellarAssetClient::new(&env, &token_id);
    let token_client = TokenClient::new(&env, &token_id);
    sac_admin.mint(&buyer, &1_000_000_000_000_000_i128);

    // Register & initialize Marketplace
    let marketplace_id = env.register(Marketplace, ());
    let client = MarketplaceClient::new(&env, &marketplace_id);
    let mp_admin = Address::generate(&env);
    client.initialize(&mp_admin, &0, &registry_id, &token_id);

    // Fuzz offer creation (must never panic, only return Ok or Err)
    let create_nonce = client.get_nonce(&seller);
    let create_res = if let Some(min_qty) = input.min_purchase_tonnes {
        client.try_create_offer_with_minimum(
            &seller,
            &credit_id,
            &input.price_xlm,
            &carbonchain_marketplace::AssetType::Native,
            &input.tonnes,
            &registry_id,
            &None,
            &Some(min_qty),
            &create_nonce,
        )
    } else {
        client.try_create_offer(
            &seller,
            &credit_id,
            &input.price_xlm,
            &input.tonnes,
            &registry_id,
            &None,
            &create_nonce,
        )
    };

    let Ok(Ok(offer_id)) = create_res else {
        return;
    };

    let mut remaining_tonnes = input.tonnes;
    let initial_offer = client.get_offer(&offer_id);
    assert_eq!(initial_offer.tonnes, remaining_tonnes);
    assert!(initial_offer.active);

    if input.use_full_buy {
        let buyer_nonce = client.get_nonce(&buyer);
        let buy_res = client.try_buy_offer(&buyer, &offer_id, &registry_id, &token_id, &buyer_nonce);
        if let Ok(Ok(())) = buy_res {
            let after = client.get_offer(&offer_id);
            assert!(!after.active);
            assert_eq!(after.tonnes, 0);
        } else {
            let after = client.get_offer(&offer_id);
            assert_eq!(after.tonnes, remaining_tonnes);
        }
        return;
    }

    // Fuzz sequential partial buy calls (bounded to keep fuzz iterations fast)
    for qty in input.partial_buys.into_iter().take(8) {
        let buyer_nonce = client.get_nonce(&buyer);
        let buyer_balance_before = token_client.balance(&buyer);

        let buy_res = client.try_buy_offer_quantity(
            &buyer,
            &offer_id,
            &registry_id,
            &token_id,
            &qty,
            &buyer_nonce,
        );

        let offer_after = client.get_offer(&offer_id);

        if let Ok(Ok(())) = buy_res {
            assert!(qty > 0);
            assert!(qty <= remaining_tonnes);
            remaining_tonnes -= qty;
            assert_eq!(offer_after.tonnes, remaining_tonnes);

            let buyer_balance_after = token_client.balance(&buyer);
            assert!(buyer_balance_after <= buyer_balance_before);

            if remaining_tonnes == 0 {
                assert!(!offer_after.active);
                break;
            } else {
                assert!(offer_after.active);
                assert!(offer_after.price_xlm > 0);
            }
        } else {
            // Failed partial buy must not mutate escrowed tonnes
            assert_eq!(offer_after.tonnes, remaining_tonnes);
        }
    }
});
