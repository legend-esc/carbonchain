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

### Contract upgrade checklist (if modifying smart contracts)
- [ ] Pre-upgrade: Storage layout and event schema verified backward compatible
- [ ] Pre-upgrade: Migration tested on testnet
- [ ] Upgrade: WASM hash verified against built artifact
- [ ] Post-upgrade: Cross-contract consistency & rollback plan documented
- [ ] Approvals: Signed off by at least 2 maintainers + security review

## Breaking changes
<!-- Leave blank if none. -->
