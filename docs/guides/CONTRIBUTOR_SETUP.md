# Contributor Onboarding Quick-Start Guide

Welcome to **CarbonChain**! This guide walks you through setting up a complete local development environment for the Soroban smart contracts, NestJS API, and Angular frontend.

---

## Option A: One-Click Dev Container (Recommended)

The repository includes a pre-configured [`.devcontainer/devcontainer.json`](../../.devcontainer/devcontainer.json) with **Rust**, **`wasm32-unknown-unknown`**, **Stellar/Soroban CLI (`stellar-cli@26.1.0`)**, **Node.js 22**, **Docker-in-Docker**, and recommended VS Code extensions.

### Using GitHub Codespaces
1. Open the repository on GitHub and click **Code → Codespaces → Create codespace on main**.
2. Wait for `postCreateCommand` to finish installing `stellar-cli` and `npm` dependencies.

### Using VS Code Locally
1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and the **Dev Containers** extension (`ms-vscode-remote.remote-containers`).
2. Clone the repo and open it in VS Code:
   ```bash
   git clone git@github.com:legend-esc/carbonchain.git
   cd carbonchain
   code .
   ```
3. Press `F1` → **Dev Containers: Reopen in Container**.

Once inside the container, skip straight to [Step 3: Configure Environment & Start Backing Services](#3-configure-environment--start-backing-services).

---

## Option B: Manual Local Setup

If you prefer installing tools directly on your host machine:

### 1. Install Prerequisites
- **Node.js 20+** (Node 22 recommended) and **npm 9+**
- **Rust (stable)** via [rustup.rs](https://rustup.rs):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  rustup target add wasm32-unknown-unknown
  ```
- **Stellar / Soroban CLI**:
  ```bash
  cargo install --locked stellar-cli@26.1.0 --features opt
  ```
- **Docker & Docker Compose** (for PostgreSQL 16 and Redis 7)

### 2. Install Workspace Dependencies
```bash
npm ci
cd api && npm ci && cd ..
cd frontend && npm ci && cd ..
```

---

## 3. Configure Environment & Start Backing Services

1. Copy the example environment file:
   ```bash
   cp api/.env.example api/.env
   ```
   > Set `REDIS_PASSWORD` in `api/.env` to match your local Redis configuration (default in `docker-compose.yml`: `changeme-local-dev`), and provide a `JWT_SECRET`.

2. Start PostgreSQL and Redis via Docker Compose:
   ```bash
   docker compose up -d postgres redis
   ```

3. Run database migrations:
   ```bash
   cd api && npm run migration:run
   ```

---

## 4. Run Services & Verify Your Setup

### Start the API & Frontend
```bash
# Terminal 1 — NestJS API (http://localhost:3000, Swagger at /api/docs)
cd api && npm run start:dev

# Terminal 2 — Angular Frontend (http://localhost:4200)
cd frontend && npm run start
```

### Run Tests by Layer
- **Soroban Contracts** (`contracts/`):
  ```bash
  cd contracts && cargo test
  ```
- **NestJS API** (`api/`):
  ```bash
  cd api && npm test
  cd api && npm run test:e2e
  ```
- **Angular Frontend** (`frontend/`):
  ```bash
  cd frontend && npm test
  ```

---

## 5. Next Steps & Troubleshooting

- **Environment Diagnostics:** Run the CLI doctor check (see [DOCTOR_COMMAND.md](DOCTOR_COMMAND.md)).
- **Contract Architecture:** Read [docs/contracts/state-machine.md](../contracts/state-machine.md) to understand the carbon credit lifecycle and `DataKey` storage layout.
- **Contributing Guidelines:** Review [CONTRIBUTING.md](../../CONTRIBUTING.md) and [PR_CHECKLIST.md](../../PR_CHECKLIST.md) before opening a pull request.
