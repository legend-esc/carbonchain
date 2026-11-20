# Windows Setup Guide

CarbonChain is developed primarily on Linux/macOS, but fully supports Windows via **WSL2** (Windows Subsystem for Linux 2). Follow this guide to set up a development environment on Windows.

---

## 1. Install WSL2

Open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu-24.04
```

Restart your machine when prompted. After reboot, Ubuntu will launch automatically — create your Linux username and password.

Verify the installation:

```powershell
wsl -l -v
```

Ensure the output shows `Ubuntu-24.04` with **Version 2**. If it shows Version 1, upgrade it:

```powershell
wsl --set-version Ubuntu-24.04 2
```

---

## 2. Install Rust toolchain

Inside your WSL2 Ubuntu terminal:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
```

Verify:

```bash
rustc --version
cargo --version
```

Install the Soroban CLI:

```bash
cargo install --locked stellar-cli@26.1.0 --features opt
```

---

## 3. Install Node.js

Inside WSL2 Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Verify:

```bash
node --version   # v20+
npm --version    # v9+
```

---

## 4. Install Docker Desktop

1. Download [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
2. During installation, ensure **"Use WSL 2 based engine"** is checked
3. After install, open Docker Desktop and go to **Settings → Resources → WSL Integration**
4. Enable integration with `Ubuntu-24.04`
5. Click **Apply & Restart**

Verify inside WSL2:

```bash
docker --version
docker compose version
```

---

## 5. Clone and configure the repo

Inside WSL2 Ubuntu:

```bash
git clone https://github.com/legend-esc/carbonchain.git
cd carbonchain
```

### Line endings

WSL2 uses Linux line endings (`LF`) by default, which is correct. If you edit files with Windows tools (VS Code on Windows, Notepad++, etc.), configure Git to auto-convert:

```bash
git config core.autocrlf input
```

This keeps `LF` in the repo and converts `CRLF` → `LF` on checkout.

---

## 6. Build and test

```bash
# Build all contracts
cd contracts
cargo build --target wasm32-unknown-unknown --release

# Run contract tests
cargo test

# Start backing services
docker compose up -d postgres redis

# Install API dependencies
cd ../api
npm install

# Run database migrations
npm run migration:run
```

---

## Known Windows gotchas

### Path separators

WSL2 uses Linux paths (`/home/user/...`). Windows paths like `C:\Users\...` do not work inside WSL2. Always use Linux paths when running commands in the WSL2 terminal.

If you need to access Windows files from WSL2, they are mounted at `/mnt/c/Users/...`.

### File permissions

Files created inside WSL2 have Linux permissions. If you clone the repo on the Windows filesystem (e.g., `C:\Users\you\carbonchain`) and access it from WSL2 via `/mnt/c/`, Git operations may be slow and file permissions may be incorrect. **Always clone inside the WSL2 filesystem** (`~/carbonchain`).

### Case sensitivity

The Windows filesystem is case-insensitive by default. The Rust compiler and Soroban CLI expect case-sensitive paths. This is another reason to work inside the WSL2 filesystem.

### Port conflicts

If you have Windows services running on port 5432 (PostgreSQL) or 6379 (Redis), the Docker containers inside WSL2 will fail to bind. Stop the Windows services or change the Docker compose port mappings.

### VS Code remote development

For the best experience, use **VS Code with the "Remote — WSL" extension**:

1. Install VS Code on Windows
2. Install the "Remote — WSL" extension
3. Open a WSL2 terminal, navigate to the repo, and run `code .`

This opens VS Code connected to WSL2, giving you full Linux tooling with the Windows VS Code UI.

### PowerShell scripts

The project includes `.ps1` scripts for Windows (`validate_all.ps1`, `pre_deploy_validate.ps1`). Run them in PowerShell (not WSL2):

```powershell
.\validate_all.ps1
```

These scripts handle path translation and environment checks specific to Windows.
