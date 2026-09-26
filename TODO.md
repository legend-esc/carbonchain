# TODO - Carbonchain Drips

## Implement XLM balance display after wallet connect
- [x] Update `frontend/src/app/core/services/stellar-wallet.service.ts` with:
  - [x] Horizon XLM balance fetch
  - [x] balance state signals
  - [x] polling start/stop at 30s while connected
- [x] Update `frontend/src/app/core/components/connect-wallet.component.ts` with:
  - [x] Display abbreviated address + formatted XLM balance
  - [x] Start polling when authenticated/connected
  - [x] Stop polling on logout/disconnect

- [x] Sanity checks:
  - [x] Typecheck/build
  - [x] Verify no regressions in existing wallet UI
