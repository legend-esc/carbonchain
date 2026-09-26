# Changelog

All notable changes to CarbonChain are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Open for contributors
- Retirement certificate viewer (`/certificates/:id`)
- `docker-compose.yml` for local PostgreSQL
- `deploy-testnet.sh` implementation
- Mobile-responsive layout

---

## [0.6.0] - 2025-07-24

### Added

**Smart Contracts — `credit_registry`**
- Credit lifecycle operations: `transfer_credit`, `split_credit`, `merge_credits`, `expire_credit`, `dispute_credit`, `resolve_dispute`
- Deterministic SHA-256 credit IDs with project+vintage uniqueness enforcement
- Per-credit verifier snapshots for accurate pending-credit tracking after verifier changes
- Issuer and methodology allowlists (`register_issuer`, `remove_issuer`, `register_methodology`)
- On-chain project registry (`register_project`, `get_project`)
- Session management and audit logging (`create_session`, `submit_credit_with_session`, `get_audit_log`)
- Two-step admin transfer (`propose_admin` → `accept_admin`)
- Contract pause/unpause for all state-mutating operations
- Nonce-based replay protection on every state-mutating call
- Contract WASM upgrade mechanism (`upgrade`)
- Stale-entry filtered `list_credits_by_owner` query
- Credits-by-owner index for efficient lookups
- 27 error codes (100–126) with stable numbering

**Smart Contracts — `retirement`**
- Batch retirement (`batch_retire`) with pre-validation pass for all-or-nothing atomicity
- Deterministic retirement IDs (SHA-256 with buyer nonce for uniqueness)
- Paginated retirement queries (`get_retirements_paginated`)
- Total retired tonnes per account (`get_total_retired_by_account`)
- Two-step admin transfer and contract upgrade mechanism
- 15+ tests including oversized batch guard, double initialize, no partial state, retirement ID uniqueness

**Smart Contracts — `marketplace`**
- Buy offer flow (`buy_offer`) with pre-check buyer XLM balance and escrow-based atomic swap
- Offer repricing (`update_offer_price`) with expiry/min-price validation
- Paginated public marketplace listing (`list_active_offers`)
- Admin cron job for expired offer cleanup (`cleanup_expired_offers`)
- Escrowed amount tracking per seller
- Active offers filtered view (`get_active_offers_by_seller`)
- Minimum price enforcement and update (`update_min_price`, `get_min_price`)
- Two-step admin transfer and contract upgrade mechanism
- 20+ tests including double listing prevention, credit return on cancel, escrow lifecycle

**Smart Contracts — `mrv_oracle`**
- Configurable anomaly threshold (`set_anomaly_threshold`, `get_anomaly_threshold`)
- History range queries (`get_history_range`) and aggregate calculations (`get_mrv_aggregate`)
- Paginated oracle listing (`list_oracles`)
- Best-effort cross-contract flagging of all project credits on anomaly
- Ring-buffer history with MAX_HISTORY=100 cap eviction
- 20+ tests including anomaly detection, history accumulation, aggregate calculations

**API (NestJS) — Credits**
- `POST /credits/issue` — issue new credit (JWT)
- `POST /credits/bulk` — bulk fetch by IDs
- `GET /credits` — paginated list with filters (methodology, geography, vintage_year, status, min/max_tonnes)
- `GET /credits/:id` — credit metadata
- `GET /credits/:id/provenance` — full lifecycle events (JWT)
- `GET /credits/project/:projectId` — list by project
- `POST /credits/:id/transfer` — transfer credit (JWT)
- `POST /credits/:id/split` — split credit (JWT)
- `POST /credits/:id/expire` — expire credit (JWT, admin)
- `POST /credits/:id/dispute` — raise dispute (JWT)
- `POST /credits/:id/resolve` — resolve dispute (JWT, admin)
- `POST /credits/merge` — merge credits (JWT)
- TonnesValidator and MethodologyValidator

**API (NestJS) — Projects**
- `POST /projects` — register project
- `GET /projects` — list all
- `GET /projects/:id` — get by ID
- IPFS upload with retry utility

**API (NestJS) — Retirement**
- `POST /retirement` — retire credit (JWT)
- `POST /retirement/batch` — batch retire (JWT, throttled 5/min)
- `GET /retirement` — paginated list
- `GET /retirement/:id` — get by ID
- `GET /retirement/account/:address` — paginated by account
- `GET /retirement/certificates/:id/download` — PDF certificate download (JWT)
- `GET /retirement/certificates/:id/verify` — certificate verification
- CertificateService for PDF generation

**API (NestJS) — Marketplace**
- `GET /marketplace/listings` — paginated public endpoint with filters
- `POST /marketplace/offer` — create offer (JWT)
- `GET /marketplace/offer/:id` — get offer
- `GET /marketplace/seller/:address` — offers by seller
- `DELETE /marketplace/offer/:id/seller/:address` — cancel offer
- `POST /marketplace/offer/:id/buy` — buy offer (JWT)
- MarketplaceCleanupCron — scheduled expired offer cleanup

**API (NestJS) — Verifiers**
- `GET /verifiers` — list all
- `GET /verifiers/:address` — get by address
- `GET /verifiers/:id/pending` — pending credits (JWT)
- `GET /verifiers/:id/history` — approval history (JWT)
- `POST /verifiers/:address/approve/:creditId` — approve credit (JWT)
- `GET /verifiers/:address/reputation` — reputation with Ed25519 key validation

**API (NestJS) — Admin**
- `GET /admin/stats` — admin statistics (JWT + AdminGuard)
- `POST /admin/verifiers/register` — register verifier
- `POST /admin/verifiers/:id/suspend` — suspend verifier
- `POST /admin/verifiers/:id/configure` — configure capabilities
- `POST /admin/credits/:id/flag` — flag credit

**API (NestJS) — Events**
- `GET /events` — list with filters (contractId, eventType, take, skip)
- `GET /events/:eventId` — get by ID

**API (NestJS) — Webhooks**
- `POST /webhooks` — register webhook (URL + events)
- `GET /webhooks` — list all
- `GET /webhooks/:id` — get by ID
- `DELETE /webhooks/:id` — delete webhook
- WebhookIpAllowlistGuard — IP-based access control
- HMAC webhook delivery

**API (NestJS) — Auth**
- `GET /auth/challenge?account=` — SEP-10 auth challenge generation (throttled 10/min per IP)
- `POST /auth/token` — verify signed challenge → JWT
- `GET /auth/me` — authenticated account info
- Stellar SEP-10 strategy, JWT auth guard

**API (NestJS) — Infrastructure**
- `GET /health` — health check with DB pool health
- `GET /metrics` — Prometheus-format metrics endpoint
- RequestMetricsMiddleware — per-request metrics collection
- RequestIdMiddleware — UUID-based X-Request-ID with correlation propagation
- RequestLoggingMiddleware — structured request logging
- PinoNestLoggerService — Pino-based structured logging
- SequenceNumberManager — optimistic increment with `tx_bad_seq` retry
- CacheModule/CacheService — global caching
- EnvValidation — startup env var validation
- Webhook IP allowlist guard
- Rate limiting (ThrottlerGuard) on auth challenge and batch retire

**Frontend (Angular) — Routes**
- `/dashboard` — DashboardComponent (authGuard)
- `/marketplace` — MarketplaceComponent (authGuard)
- `/retire` — RetireComponent (authGuard)
- `/credits/:id` — CreditDetailComponent (authGuard)
- `/projects` — ProjectsListComponent (lazy-loaded, authGuard)
- `/projects/:id` — ProjectDetailComponent (authGuard)
- `/admin` — AdminVerifiersComponent (authGuard + adminGuard)
- `/connect-wallet` — ConnectWalletComponent
- `/offline` — OfflineComponent (PWA)

**Frontend (Angular) — Services**
- AuthService — SEP-10 wallet login flow
- StellarWalletService — Freighter wallet integration
- ApiService — HTTP client with base URL
- ThemeService — dark mode toggle
- TranslationService — i18n (en/es/fr)
- ToastService — user notifications
- OnlineStatusService — PWA offline detection
- ErrorReportingService — Sentry integration

**Frontend (Angular) — Guards & Interceptors**
- authGuard — JWT authentication guard
- adminGuard — admin role guard
- AuthInterceptor — JWT token injection for HTTP requests
- 401 interceptor — automatic redirect on auth failure

**Frontend (Angular) — State Management**
- CreditStore — credit state management with cache invalidation
- MarketplaceStore — marketplace state management

**Frontend (Angular) — Components**
- ConnectWalletComponent — Freighter connect + install prompt + XLM balance display
- LocaleSwitcherComponent — runtime locale switcher (en/es/fr)
- ToastComponent — toast notifications
- AdminVerifiersComponent — verifier management UI
- CertificatesComponent — certificate viewer
- OfflineComponent — PWA offline page

**Shared Infrastructure**
- `TONNES_SCALE` constant (1,000,000n) for micro-tonne units
- Enums: CreditStatus (Pending/Active/Retired/Flagged/Expired/Disputed)
- Interfaces: CreditMetadata, VerifierReputation, ProjectProfile, RetirementRecord, Offer, MrvDataPoint, OperationContext, AuditLog, InteractionSession
- Dockerfiles for API (Node 18 → production) and Frontend (Node 20 → nginx)
- `scripts/deploy-testnet.sh` — testnet deployment
- `scripts/smoke-test.sh` — post-deploy smoke tests
- `.env.example` — environment variable template

**CI/CD (GitHub Actions)**
- Contracts job — Rust 1.91.0, wasm32v1-none target, `cargo fmt --check`, `cargo clippy -D warnings`, cargo test for all 4 contracts
- API job — Node 20, PostgreSQL 16 service container, lint, build, unit tests, e2e tests, coverage report
- Frontend job — Node 20, lint, build, test:ci
- Security job — cargo-audit dependency vulnerability scan
- Deploy job (main branch only) — stellar-cli contract deployment and smoke tests
- Caching for cargo, npm, stellar-cli, and Rust artifacts

**Testing**
- 50+ contract tests across credit_registry, retirement, marketplace, mrv_oracle
- API unit tests with TypeORM, NestJS, and service mocking
- API e2e tests with real PostgreSQL container
- Frontend component, service, guard, store, and interceptor tests
- SQL injection regression tests
- Security hardening and resilience test suite

**Documentation**
- Mermaid sequence diagrams for credit lifecycle, flag re-review, marketplace buy flow
- Swagger/OpenAPI decorators on all API endpoints
- Prometheus metrics documentation
- Mermaid architecture diagram
- Unit convention documentation (tonnes = micro-tonne units)
- SECURITY.md — responsible disclosure process
- CONTRIBUTING.md — contributing guidelines
- PR template and issue templates
- CODEOWNERS — code ownership
- Dependabot — dependency update automation

---

## [0.5.0] - 2025-06-15

### Added

**Smart Contracts**
- `credit_registry`: verifier management (`register_verifier`, `remove_verifier`, `list_verifiers`), `approve_and_mint`, `flag_credit`, `mark_retired`, `get_credit`, `list_credits_by_project` — 11 tests
- `retirement`: `retire` with cross-contract `mark_retired` call, `get_retirement`, `get_retirements_by_account` — 3 tests
- `marketplace`: `create_offer`, `cancel_offer`, `get_offer`, `get_offers_by_seller`, `offer_count` — 7 tests
- `mrv_oracle`: `initialize`, `register_oracle`, `update_mrv_data` with >20% anomaly detection, `get_latest`, `get_history` — 5 tests

**API (NestJS)**
- `VerifiersModule` — `GET /verifiers`, `GET /verifiers/:address`
- `RetirementModule` — `POST /retirement`, `GET /retirement/:id`, `GET /retirement/account/:address`
- `MarketplaceModule` — `POST /marketplace/offer`, `GET /marketplace/offer/:id`, `GET /marketplace/seller/:address`, `DELETE /marketplace/offer/:id/seller/:address`
- `CreditsModule` — `POST /credits/issue`
- SEP-10 auth (`/auth/challenge`, `/auth/token`, `/auth/me`)

**Frontend (Angular)**
- `AuthService` — full SEP-10 wallet login flow
- `ConnectWalletComponent` — Freighter connect button with install prompt
- Marketplace page (`/marketplace`) — browse and display active listings
- Retire wizard (`/retire`) — 3-step credit retirement form
- Angular dev proxy — `/api` routes to `http://localhost:3000`
