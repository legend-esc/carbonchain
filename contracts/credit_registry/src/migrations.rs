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
}
