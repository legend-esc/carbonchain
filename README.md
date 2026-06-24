# CarbonChain 🌿

Transparent, tamper-proof carbon credit registry and marketplace built on the Stellar network.

CarbonChain is a Soroban-native platform for issuing, trading, and retiring tokenized carbon credits. It enables smart contracts to enforce real-world climate accountability — verifier multi-sig, MRV oracle integration, and permanent on-chain retirement receipts — in a trust-minimized way.

---

## Features

- Credit issuance with verifier multi-sig approval
- Permanent on-chain retirement with tamper-proof certificates
- Stellar DEX integration for liquid secondary market trading
- MRV oracle interface for real-time carbon sequestration monitoring
- IPFS-anchored project documentation (methodology, satellite imagery, audits)
- Session-based audit trail for all credit lifecycle operations
- Replay attack protection on all contract state transitions
- Fractional credits (0.1 tonne resolution via i128 storage)
  - Unit convention: **1 tonne = 1,000,000 units**, minimum unit = 100,000 (= 0.1 tonne)
  - All `tonnes` values must be a positive multiple of 100,000; non-multiples are rejected
- Anchor info discovery for SEP-10 authenticated interactions
- Health monitoring for registered verifier nodes
- Event emission for all state changes
- Comprehensive error handling with stable error codes

---

## Supported Credit Types

Projects can register credits across the following methodologies:

- **REDD+** — Reduced Emissions from Deforestation and Degradation
- **VCS** — Verified Carbon Standard (Verra)
- **Gold Standard** — Gold Standard for the Global Goals
- **CDM** — Clean Development Mechanism
- **Plan Vivo** — Community and ecosystem-based projects
- **Custom** — Configurable methodology string for emerging standards

---

## Usage Example

```rust
// Initialize the registry contract
contract.initialize(&admin);

// Register a verifier
contract.register_verifier(&verifier);

// Configure verifier capabilities
let mut capabilities = Vec::new(&env);
capabilities.push_back(ServiceType::CreditApproval);
capabilities.push_back(ServiceType::MRVReview);
contract.configure_verifier_services(&verifier, &capabilities);

// Submit a credit for approval
let credit_id = contract.submit_credit(
    &issuer,
    &CreditMetadata {
        project_id: String::from_str(&env, "PROJ-001"),
        vintage_year: 2024,
        methodology: String::from_str(&env, "VCS"),
        geography: String::from_str(&env, "NG"),
        tonnes: 1_000_000,   // 1 tonne (1 tonne = 1_000_000 units, i.e. TONNES_SCALE)
        ipfs_hash: String::from_str(&env, "bafybei..."),
    },
);

// Verifier approves and triggers mint
contract.approve_and_mint(&verifier, &credit_id);

// Retire a credit
contract.retire(&buyer, &credit_id, &String::from_str(&env, "2024 Scope 3 offset"));
```

---

## CLI Example

See the complete issuance, trading, and retirement workflow:

```bash
# Run bash demo
./examples/cli_example.sh

# Or run Rust example
cargo run --example cli_example
```

See `docs/guides/DOCTOR_COMMAND.md` for CLI environment diagnostics.

---

## Key Features

- **Credit Registry:** Register projects, submit credits, enforce verifier approval before minting
- **Retirement Engine:** Permanently burn tokens with an immutable on-chain retirement record
- **Marketplace:** Native Stellar DEX listings with fractional credit support
- **MRV Oracle:** Authenticated data ingestion from IoT/satellite feeds with anomaly flagging
- **Session Traceability:** Group operations into auditable sessions for compliance
- **Audit Trail:** Immutable record of all lifecycle events
- **Replay Protection:** Nonce-based multi-level protection on all contract operations
- **Credential Security:** Admin keypair never exposed to frontend — all user ops signed via Freighter

---

## Session Traceability & Audit

CarbonChain includes comprehensive session management and operation tracing to ensure all credit interactions are reproducible and auditable.

**What this means:**

- Every operation is logged with complete context (who, what, when, result)
- Sessions group related operations for logical organization
- Audit trail is immutable for compliance and verification
- Operations can be replayed deterministically for dispute resolution
- Replay attacks are prevented through nonce-based protection

**Quick example:**

```typescript
// Create a session
const sessionId = await contract.create_session(userAddress);

// Submit attestation within session
const creditId = await contract.submit_credit_with_session(
    sessionId,
    issuer,
    metadata,
    ipfsHash,
    signature
);

// Verify session completeness
const opCount = await contract.get_session_operation_count(sessionId);

// Retrieve full audit log
const auditLog = await contract.get_audit_log(0);
```

---

## Project Structure

```
carbonchain/
├── contracts/                  # Soroban smart contracts (Rust)
│   ├── credit_registry/        # Minting, metadata, verifier multi-sig
│   │   ├── src/
│   │   │   ├── lib.rs          # Contract entry points
│   │   │   ├── storage.rs      # Persistent data management
│   │   │   ├── events.rs       # Event definitions
│   │   │   ├── types.rs        # Data structures
│   │   │   └── errors.rs       # Stable error codes
│   │   └── Cargo.toml
│   ├── retirement/             # Burn + retirement certificate logic
│   ├── marketplace/            # Offer creation, Stellar DEX integration
│   └── mrv_oracle/             # Oracle interface for MRV data updates
│
├── api/                        # NestJS backend
│   ├── src/
│   │   ├── stellar/            # Stellar SDK service layer
│   │   ├── credits/            # Credit CRUD, issuance flow
│   │   ├── retirement/         # Retirement endpoint + certificate gen
│   │   ├── marketplace/        # Order book, DEX bridge
│   │   ├── projects/           # Project profiles, IPFS uploads
│   │   ├── verifiers/          # Verifier registry, co-sign requests
│   │   └── oracle/             # MRV data ingestion webhooks
│   ├── test/
│   └── package.json
│
├── frontend/                   # Angular 17+ SPA
│   ├── src/app/
│   │   ├── core/               # Auth, wallet, HTTP services
│   │   ├── shared/             # Reusable components and pipes
│   │   ├── dashboard/          # Portfolio overview
│   │   ├── marketplace/        # Browse & buy credits
│   │   ├── projects/           # Project detail pages
│   │   ├── retire/             # Retirement wizard
│   │   ├── certificates/       # Retirement certificate viewer
│   │   └── admin/              # Verifier & maintainer panel
│   └── package.json
│
├── shared/                     # Shared TypeScript types & constants
├── scripts/                    # Deployment & testnet setup scripts
├── docs/
│   ├── README.md               # Full documentation index
│   ├── architecture.md         # System architecture (this repo)
│   ├── features/               # Feature-specific documentation
│   └── guides/                 # Developer guides
├── CLAUDE.md                   # Claude Code context file
├── CONTRIBUTING.md             # Contribution guide (Stellar Wave)
└── README.md
```

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Smart contracts | Rust + Soroban SDK | Credit registry, retirement, marketplace, oracle |
| Blockchain | Stellar (testnet / mainnet) | Asset issuance, native DEX, claimable balances |
| Backend | NestJS (Node.js 18+) | REST API, Stellar SDK integration, business logic |
| Frontend | Angular 17+ | Marketplace UI, retirement flow, certificate viewer |
| Storage (off-chain) | IPFS / Filecoin via Pinata | Project docs, satellite imagery, audit reports |
| Database | PostgreSQL | Off-chain indexing, user sessions, event cache |
| Auth | Freighter Wallet + JWT (SEP-10) | Stellar wallet-based authentication |
| Testing (contracts) | Soroban test SDK | Unit & integration tests |
| Testing (api) | Jest + Supertest | API endpoint tests |
| Testing (frontend) | Jasmine + Karma | Angular component & E2E tests |
| CI/CD | GitHub Actions | Automated test, lint, testnet deploy |

---

## Prerequisites

- **Node.js** 18+ and **npm** 9+
- **Rust** (stable toolchain) — [rustup.rs](https://rustup.rs)
- **Soroban CLI** — `cargo install --locked stellar-cli@26.1.0 --features opt`
- **Docker** — for local PostgreSQL
- **Freighter browser extension** — [freighter.app](https://freighter.app)
- A **Stellar testnet keypair** — [laboratory.stellar.org](https://laboratory.stellar.org)

---

## Getting Started

### 1. Clone the repository

```bash
git clone git@github.com:legend-esc/carbonchain.git
cd carbonchain
```

### 2. Configure environment variables

```bash
cp api/.env.example api/.env
# Fill in ADMIN_SECRET_KEY, JWT_SECRET, and contract IDs — see Environment Variables below
```

### 3. Start the full stack with Docker Compose

The `docker-compose.yml` starts all four services (PostgreSQL, Redis, API, Frontend) in the correct dependency order with health checks:

```bash
docker compose up -d
```

| Service  | URL                          | Description                  |
|----------|------------------------------|------------------------------|
| Frontend | http://localhost:4200        | Angular SPA (nginx)          |
| API      | http://localhost:3000        | NestJS REST API              |
| Postgres | localhost:5432               | PostgreSQL 16                |
| Redis    | localhost:6379               | Redis 7 (cache + rate limit) |

Check service health:

```bash
docker compose ps
docker compose logs -f api
```

### 4. Run database migrations

```bash
cd api && npm run migration:run
```

### 5. (Optional) Local development without Docker

If you prefer to run services individually:

```bash
# Start only the backing services
docker compose up -d postgres redis

# Install dependencies
cd api && npm install
cd ../frontend && npm install

# Terminal 1 — NestJS API (port 3000)
cd api && npm run start:dev

# Terminal 2 — Angular frontend (port 4200)
cd frontend && ng serve
```

Open [http://localhost:4200](http://localhost:4200) and connect your Freighter wallet on Stellar testnet.

### 6. Deploy contracts to testnet

```bash
cd scripts
./deploy-testnet.sh
```

This funds a testnet account, compiles all four Soroban contracts, deploys them, and writes the resulting contract IDs to `scripts/contract-ids.testnet.json`.

---

## Environment Variables

### `api/.env`

```env
# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_SOROBAN_RPC=https://soroban-testnet.stellar.org
ADMIN_SECRET_KEY=S...

# Contract IDs (populated after deploy-testnet.sh)
CREDIT_REGISTRY_CONTRACT_ID=C...
RETIREMENT_CONTRACT_ID=C...
MARKETPLACE_CONTRACT_ID=C...
MRV_ORACLE_CONTRACT_ID=C...

# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/carbonchain

# Auth
JWT_SECRET=your-jwt-secret-here
JWT_EXPIRES_IN=7d

# IPFS
IPFS_API_URL=https://api.pinata.cloud
IPFS_API_KEY=your-pinata-api-key
IPFS_SECRET_KEY=your-pinata-secret
```

### `frontend/src/environments/environment.ts`

```typescript
export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000',
  stellarNetwork: 'testnet',
  horizonUrl: 'https://horizon-testnet.stellar.org',
};
```

---

## Smart Contracts

All contracts live in `contracts/` and are written in Rust targeting the Soroban SDK.

### Build all contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

### Contracts overview

| Contract | Stable Error Codes | Description |
|---|---|---|
| `credit_registry` | 100–109 | Mint CCR tokens, store metadata, enforce verifier multi-sig |
| `retirement` | 110–114 | Burn tokens on retirement, write immutable retirement records |
| `marketplace` | 115–118 | Manage offer listings, integrate with Stellar DEX |
| `mrv_oracle` | 119–120 | Accept MRV data updates, flag anomalies for re-verification |

See `docs/features/ERROR_CODES_REFERENCE.md` for the full error code reference.

---

## API Reference

Base URL: `http://localhost:3000/api/v1`

Swagger UI available at `http://localhost:3000/api/docs` in development.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/credits` | List credits (filter by type, vintage, geography) |
| `GET` | `/credits/:id` | Credit detail with full provenance chain |
| `POST` | `/credits/issue` | Submit a new credit issuance request |
| `POST` | `/credits/:id/retire` | Retire a credit, generate certificate |
| `GET` | `/projects` | List registered projects |
| `POST` | `/projects` | Register a project (uploads docs to IPFS) |
| `GET` | `/certificates/:id` | Fetch retirement certificate by ID |
| `GET` | `/marketplace/listings` | Active marketplace listings |
| `POST` | `/marketplace/offer` | Create a sell offer |
| `GET` | `/verifiers` | List registered verifiers |
| `POST` | `/auth/challenge` | Request SEP-10 auth challenge |
| `POST` | `/auth/verify` | Verify signed challenge, receive JWT |

### New API Methods

**Session Management**

| Method | Description |
|---|---|
| `create_session(initiator)` | Create new audit session |
| `get_session(session_id)` | Get session details |
| `get_session_operation_count(session_id)` | Get operation count in session |
| `get_audit_log(log_id)` | Get audit log entry |

**Session-Aware Operations**

| Method | Description |
|---|---|
| `submit_credit_with_session(...)` | Submit credit with audit logging |
| `approve_and_mint_with_session(...)` | Approve credit with audit logging |
| `retire_with_session(...)` | Retire credit with audit logging |

---

## Running Tests

```bash
# Smart contract tests
cd contracts && cargo test

# Cross-platform path tests
cd contracts && cargo test cross_platform

# API unit + integration tests
cd api && npm run test
cd api && npm run test:e2e

# Frontend tests
cd frontend && ng test
```

### Configuration Validation

**Linux / macOS**

```bash
./validate_all.sh
./pre_deploy_validate.sh
```

**Windows**

```powershell
.\validate_all.ps1
.\pre_deploy_validate.ps1
```

### Environment Diagnostics

```bash
anchorkit doctor
```

The doctor command checks:

- ✅ Rust toolchain installation
- ✅ WASM target availability
- ✅ Wallet configuration
- ✅ Soroban RPC connectivity
- ✅ Config file validity
- ✅ Network connectivity

See `docs/guides/DOCTOR_COMMAND.md` for complete documentation.

---

## Documentation

### Getting Started

- `QUICK_START.md` — Quick reference with examples
- `CONTRIBUTING.md` — Contribution guidelines (Stellar Wave)
- `CHANGELOG.md` — Version history

### Feature Documentation

- `docs/features/ERROR_CODES_REFERENCE.md` — Stable API error codes
- `docs/features/SEP10_AUTH.md` — SEP-10 Freighter authentication
- `docs/features/ANCHOR_INFO_DISCOVERY.md` — stellar.toml parsing and caching
- `docs/features/METADATA_CACHE.md` — TTL-based metadata caching
- `docs/features/REQUEST_ID_PROPAGATION.md` — UUID request tracing
- `docs/features/RETRY_BACKOFF.md` — Retry and backoff strategies
- `docs/features/WEBHOOK_MONITOR.md` — MRV oracle webhook monitoring
- `docs/features/TRANSACTION_STATE_TRACKER.md` — Credit lifecycle state machine
- `docs/features/STATUS_MONITOR.md` — Verifier node health monitoring
- `docs/features/ROUTING_STRATEGY.md` — DEX routing strategy
- `docs/features/LOGGING.md` — Logging system
- `docs/features/DOMAIN_VALIDATION.md` — Domain validation for anchors

### Guides

- `docs/guides/DOCTOR_COMMAND.md` — CLI diagnostics
- `docs/guides/CONTRIBUTING.md` — Contribution guidelines
- `docs/guides/ERROR_IMPLEMENTATION_GUIDE.md` — Error handling guide
- `docs/guides/RETRY_QUICK_REFERENCE.md` — Retry patterns quick reference

See `docs/README.md` for the complete documentation index.

---

## Contributing

Read `CONTRIBUTING.md` before submitting a PR for code style, commit conventions, and the PR checklist.

> Contributions generated entirely by LLMs without review or understanding are prohibited under Drips Wave terms.

---

## Platform Support

CarbonChain is designed to work seamlessly across all major platforms:

- ✅ Linux (Ubuntu, Debian, Fedora, etc.)
- ✅ macOS (Intel and Apple Silicon)
- ✅ Windows (10/11 with PowerShell + WSL2)

### Platform-specific setup

- Linux / macOS: see main setup instructions above
- Windows: see `WINDOWS_SETUP.md` for detailed WSL2 configuration

---

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting and responsible disclosure process.

- No private keys in the API — all user-facing transactions signed client-side via Freighter
- Stable error codes (100–120) for API compatibility across contract upgrades
- Replay protection at multiple contract levels with nonce-based verification
- Immutable audit logs — no delete functions on retirement or session records
- Authorization checks on all state-mutating operations
- `.claudeignore` excludes `ADMIN_SECRET_KEY` and all secrets from Claude Code context
- `cargo audit` runs in CI on every push/PR — high-severity CVEs in Rust dependencies fail the build

---

## Backward Compatibility

All existing contract methods remain unchanged. Session features are opt-in, allowing gradual adoption without breaking existing integrations.

---

## Roadmap

- [x] Project architecture & documentation
- [ ] Soroban credit registry contract (v1)
- [ ] Soroban retirement contract
- [ ] NestJS API scaffold with Stellar SDK integration
- [ ] Angular marketplace frontend
- [ ] Verifier multi-sig flow
- [ ] IPFS project document upload
- [ ] Retirement certificate PDF generation
- [ ] MRV oracle integration
- [ ] Stellar DEX marketplace listing
- [ ] Mainnet deployment

---

## License

License: MIT Stellar — see the [LICENSE](LICENSE) file for details.

---

## Support

For questions or issues:

- Check the `docs/` documentation files
- Review the API specification at `/api/docs`
- Examine the test cases in `contracts/*/src/lib.rs`
- Open a GitHub issue at [git@github.com:legend-esc/carbonchain.git](mailto:git@github.com)

---

> Built on [Stellar](https://stellar.org)
