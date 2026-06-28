# TODO - Carbonchain Drips

## Implement XLM balance display after wallet connect
- [x] Update `frontend/src/app/core/services/stellar-wallet.service.ts` with:
  - [x] Horizon XLM balance fetch
  - [x] balance state signals
  - [x] polling start/stop at 30s while connected
- [ ] Update `frontend/src/app/core/components/connect-wallet.component.ts` with:
  - [ ] Display abbreviated address + formatted XLM balance
  - [ ] Start polling when authenticated/connected
  - [ ] Stop polling on logout/disconnect

- [ ] Sanity checks:
  - [ ] Typecheck/build
  - [ ] Verify no regressions in existing wallet UI

