use soroban_sdk::{Env, Address, BytesN, String, Symbol, Vec, IntoVal, vec};
use crate::types::CreditMetadata;

/// Helper for cross-contract calls to CreditRegistry when the `library`
/// feature prevents direct use of `#[contract]` / `#[contractimpl]`.
pub struct RegistryHelper {
    env: Env,
    pub id: Address,
}

impl RegistryHelper {
    /// Deploy a fresh CreditRegistry contract from its pre-compiled WASM.
    pub fn deploy(env: &Env) -> Self {
        env.budget().reset_unlimited();
        let wasm: &[u8] = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../target/wasm32v1-none/release/carbonchain_credit_registry.wasm"
        ));
        let id = env.register(wasm, ());
        Self { env: env.clone(), id }
    }

    pub fn initialize(&self, admin: &Address, retirement: &Address, approvals: u32) {
        let args = vec![
            &self.env,
            admin.into_val(&self.env),
            retirement.into_val(&self.env),
            approvals.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(&self.id, &Symbol::new(&self.env, "initialize"), args);
    }

    pub fn get_nonce(&self, address: &Address) -> u64 {
        let args = vec![&self.env, address.into_val(&self.env)];
        self.env
            .invoke_contract(&self.id, &Symbol::new(&self.env, "get_nonce"), args)
    }

    pub fn register_verifier(&self, admin: &Address, verifier: &Address, nonce: u64) {
        let args = vec![
            &self.env,
            admin.into_val(&self.env),
            verifier.into_val(&self.env),
            nonce.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(
                &self.id,
                &Symbol::new(&self.env, "register_verifier"),
                args,
            );
    }

    pub fn register_issuer(&self, admin: &Address, issuer: &Address, nonce: u64) {
        let args = vec![
            &self.env,
            admin.into_val(&self.env),
            issuer.into_val(&self.env),
            nonce.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(&self.id, &Symbol::new(&self.env, "register_issuer"), args);
    }

    pub fn register_methodology(&self, admin: &Address, code: &String, name: &String, nonce: u64) {
        let args = vec![
            &self.env,
            admin.into_val(&self.env),
            code.into_val(&self.env),
            name.into_val(&self.env),
            nonce.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(
                &self.id,
                &Symbol::new(&self.env, "register_methodology"),
                args,
            );
    }

    pub fn register_project(
        &self,
        owner: &Address,
        project_id: &String,
        name: &String,
        description: &String,
        location: &String,
    ) {
        let args = vec![
            &self.env,
            owner.into_val(&self.env),
            project_id.into_val(&self.env),
            name.into_val(&self.env),
            description.into_val(&self.env),
            location.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(&self.id, &Symbol::new(&self.env, "register_project"), args);
    }

    pub fn submit_credit(
        &self,
        issuer: &Address,
        project_id: &String,
        vintage_year: u32,
        methodology: &String,
        geography: &String,
        tonnes: i128,
        ipfs_hash: &String,
        nonce: u64,
    ) -> BytesN<32> {
        let args = vec![
            &self.env,
            issuer.into_val(&self.env),
            project_id.into_val(&self.env),
            vintage_year.into_val(&self.env),
            methodology.into_val(&self.env),
            geography.into_val(&self.env),
            tonnes.into_val(&self.env),
            ipfs_hash.into_val(&self.env),
            nonce.into_val(&self.env),
        ];
        self.env
            .invoke_contract(&self.id, &Symbol::new(&self.env, "submit_credit"), args)
    }

    pub fn approve_and_mint(&self, verifier: &Address, credit_id: &BytesN<32>, nonce: u64) {
        let args = vec![
            &self.env,
            verifier.into_val(&self.env),
            credit_id.into_val(&self.env),
            nonce.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(
                &self.id,
                &Symbol::new(&self.env, "approve_and_mint"),
                args,
            );
    }

    pub fn transfer_credit(&self, from: &Address, to: &Address, credit_id: &BytesN<32>, nonce: u64) {
        let args = vec![
            &self.env,
            from.into_val(&self.env),
            to.into_val(&self.env),
            credit_id.into_val(&self.env),
            nonce.into_val(&self.env),
        ];
        let _: () = self
            .env
            .invoke_contract(
                &self.id,
                &Symbol::new(&self.env, "transfer_credit"),
                args,
            );
    }

    pub fn get_credit(&self, credit_id: &BytesN<32>) -> CreditMetadata {
        let args = vec![&self.env, credit_id.into_val(&self.env)];
        self.env
            .invoke_contract(&self.id, &Symbol::new(&self.env, "get_credit"), args)
    }
}
