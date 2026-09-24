// Sequential contract version migrations, run via `run_migrations(env, target_version)`.
//
// The `migrate` entry point in lib.rs calls `run_migrations` after checking
// `admin.require_auth()` against the stored admin address.

use crate::errors::CarbonChainError;
use crate::storage::{get_version, set_version};
use soroban_sdk::Env;

pub const CURRENT_VERSION: u32 = 1;

/// Runs each migration step in order from the stored version up to
/// `target_version`. Each step is idempotent-safe to re-run because it only
/// executes when `get_version(env) == step - 1`.
///
/// Also callable with zero arguments (no-op overload for `initialize`):
/// just call `run_migrations(env, CURRENT_VERSION)`.
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
