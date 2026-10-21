## Summary
<!-- What does this PR do? One or two sentences. -->

## Changes
<!-- Bullet list of what changed. -->
- 

## Layer(s) affected
- [ ] Smart contracts (Rust / Soroban)
- [ ] API (NestJS)
- [ ] Frontend (Angular)
- [ ] Shared types
- [ ] Docs / config

## Testing
<!-- How was this tested? -->
- [ ] `cargo test` passes
- [ ] `npm run test` passes (api)
- [ ] `npm run test` passes (frontend)
- [ ] Manually tested on testnet

## Checklist
- [ ] No private keys or secrets committed
- [ ] New functions have at least one test
- [ ] Error codes follow the stable range (100–120)
- [ ] Breaking changes documented below

## Contract Upgrade Checklist
<!-- Only applicable when changing Soroban contract code -->
- [ ] Migration tested on testnet against realistic state
- [ ] Storage layout verified (backward-compatible data keys)
- [ ] Event schema compatibility confirmed
- [ ] WASM hash verified against release manifest
- [ ] Admin nonce freshness confirmed
- [ ] Migration execution order documented
- [ ] Post-upgrade event emission verified
- [ ] Post-upgrade state consistency checks passed
- [ ] Rollback plan documented
- [ ] 2+ maintainer approvals obtained
- [ ] Security review completed (logic changes)

## Breaking changes
<!-- Leave blank if none. -->
