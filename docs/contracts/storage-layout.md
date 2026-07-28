# Credit Registry Storage Layout

`contracts/credit_registry/src/types.rs::DataKey` is a Soroban contract enum.
Its variant **order determines the storage discriminant** used as the ledger
key prefix — inserting a variant anywhere except the end changes the
discriminant of every variant after it, silently breaking storage layout
compatibility with already-deployed data.

## Rules

1. Only ever append new `DataKey` variants at the end of the enum.
2. Never reorder or remove existing variants.
3. Any schema change to a stored type (e.g. `CreditMetadata`) must ship with a
   migration step in `migrations.rs` and a version bump.

## Version tracking

- `DataKey::Version` stores a `u32` schema version (instance storage).
- `initialize()` sets it to `migrations::CURRENT_VERSION`.
- `migrations::run_migrations(env, target_version)` walks each version step
  sequentially (v1→v2→v3, ...) so upgrades never skip a transformation.

## Current versions

| Version | Notes |
|---------|-------|
| 1 | Initial versioned schema (baseline `DataKey` layout as of this doc). |

## Adding a migration

1. Bump `migrations::CURRENT_VERSION`.
2. Add a `migrate_vN_to_vN+1` function in `migrations.rs` and a `match` arm in
   `run_migrations`.
3. Add a test covering the new step (see `migrations.rs` tests).
