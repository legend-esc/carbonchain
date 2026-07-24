# TODO
- [x] Implement Sentry error reporting sink (conditional on SENTRY_DSN)

- [ ] Configure Sentry initialization in Angular via environment (or equivalent) using SENTRY_DSN
- [ ] Report errors only in production mode
- [ ] Ensure graceful no-op when SENTRY_DSN is not set
- [ ] Update relevant code in:
  - [ ] frontend/src/app/core/services/error-reporting.service.ts
  - [ ] frontend/src/app/core/handlers/global-error.handler.ts
- [x] Update/extend tests as needed for production-only reporting and no-op behavior

- [ ] Run frontend tests/lint/build to verify

