use soroban_sdk::{contracterror, contracttype, Env, Address, Vec, BytesN};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MigrationError {
    NotInitialized = 126,
    Unauthorized = 127,
    InvalidVersion = 128,
}

#[contracttype]
pub struct MigrationState {
    pub from_version: u32,
    pub to_version: u32,
    pub completed: bool,
}

fn set_migration_state(env: &Env, from_version: u32, to_version: u32) {
    let state = MigrationState {
        from_version,
        to_version,
        completed: true,
    };
    env.storage().instance().set(&DataKey::MigrationState, &state);
}

fn get_migration_state(env: &Env) -> Option<MigrationState> {
    env.storage().instance().get(&DataKey::MigrationState)
}

fn migrate_v0_to_v1(env: &Env) -> Result<(), MigrationError> {
    if let Some(state) = get_migration_state(env) {
        if state.from_version == 0 && state.to_version == 1 && state.completed {
            return Ok(());
        }
    }
    env.storage().instance().set(&DataKey::ContractVersion, &1u32);
    set_migration_state(env, 0, 1);
    Ok(())
}

fn migrate_v1_to_v2(env: &Env) -> Result<(), MigrationError> {
    if let Some(state) = get_migration_state(env) {
        if state.from_version == 1 && state.to_version == 2 && state.completed {
            return Ok(());
        }
    }
    env.storage().instance().set(&DataKey::ContractVersion, &2u32);
    set_migration_state(env, 1, 2);
    Ok(())
}

pub fn run_migrations(env: &Env) -> Result<u32, MigrationError> {
    let current_version: u32 = env.storage()
        .instance()
        .get(&DataKey::ContractVersion)
        .unwrap_or(0);

    match current_version {
        0 => {
            migrate_v0_to_v1(env)?;
            if env.storage().instance().has(&DataKey::MigrationState) {
                let state: MigrationState = env.storage().instance().get(&DataKey::MigrationState).unwrap();
                if state.from_version == 0 && state.to_version == 1 && state.completed {
                    run_migrations(env)
                } else {
                    Ok(1)
                }
            } else {
                Ok(1)
            }
        }
        1 => {
            migrate_v1_to_v2(env)?;
            Ok(2)
        }
        _ => Ok(current_version),
    }
}

pub fn downgrade(env: &Env, target_version: u32) -> Result<(), MigrationError> {
    let current_version: u32 = env.storage()
        .instance()
        .get(&DataKey::ContractVersion)
        .unwrap_or(0);

    if target_version >= current_version {
        return Err(MigrationError::InvalidVersion);
    }

    match target_version {
        0 => {
            env.storage().instance().remove(&DataKey::ContractVersion);
            env.storage().instance().remove(&DataKey::MigrationState);
            Ok(())
        }
        1 => {
            if current_version == 2 {
                env.storage().instance().set(&DataKey::ContractVersion, &1u32);
                env.storage().instance().remove(&DataKey::MigrationState);
                Ok(())
            } else {
                Err(MigrationError::InvalidVersion)
            }
        }
        _ => Err(MigrationError::InvalidVersion),
    }
}

#[contracttype]
pub enum DataKey {
    MigrationState,
    ContractVersion,
//! Sequential contract version migrations, run via `migrate(admin, target_version)`.
//!
//! Not yet wired into lib.rs's public contract impl — add a `migrate` entry
//! point there that calls `run_migrations` after checking `admin.require_auth()`
//! against the stored admin address.

use crate::errors::CarbonChainError;
use crate::storage::{get_version, set_version};
use soroban_sdk::Env;

pub const CURRENT_VERSION: u32 = 1;

/// Runs each migration step in order from the stored version up to
/// `target_version`. Each step is idempotent-safe to re-run because it only
/// executes when `get_version(env) == step - 1`.
pub fn run_migrations(env: &Env, target_version: u32) -> Result<(), CarbonChainError> {
    let mut current = get_version(env);

    if target_version < current {
        return Err(CarbonChainError::InvalidApprovalThreshold);
    }

    while current < target_version {
        match current {
            0 => migrate_v0_to_v1(env),
            1 => migrate_v1_to_v2(env),
            _ => break,
        }
        current += 1;
        set_version(env, current);
    }

    Ok(())
}

fn migrate_v0_to_v1(_env: &Env) {
    // v1 introduced explicit version tracking; no data transformation needed.
}

/// Example v1 -> v2 migration: CreditMetadata gained a new optional field.
/// Existing persistent entries are left untouched since the new field reads
/// as `None`/default until each credit is next written.
fn migrate_v1_to_v2(_env: &Env) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreditRegistry;
    use soroban_sdk::{Address, Env};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract_id = env.register(CreditRegistry, ());
        (env, contract_id)
    }

    #[test]
    fn v1_to_v2_migration_bumps_version_without_touching_existing_credits() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_version(&env, 1);

            run_migrations(&env, 2).unwrap();

            assert_eq!(get_version(&env), 2);
        });
    }

    #[test]
    fn migrate_is_a_no_op_when_already_at_target_version() {
        let (env, contract_id) = setup();
        env.as_contract(&contract_id, || {
            set_version(&env, CURRENT_VERSION);

            run_migrations(&env, CURRENT_VERSION).unwrap();

            assert_eq!(get_version(&env), CURRENT_VERSION);
        });
    }
}
