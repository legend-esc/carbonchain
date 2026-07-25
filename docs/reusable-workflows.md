# Reusable Workflow Interface

This document describes the reusable GitHub Actions workflows and their interfaces.

## Overview

The CI/CD pipeline is composed of three reusable workflows:

1. **reusable-test.yml** - Test workflow for contracts, API, and frontend
2. **reusable-build.yml** - Build workflow for contracts, API, frontend, and Docker
3. **reusable-deploy.yml** - Deploy workflow for different environments

## Reusable Test Workflow

**File:** `.github/workflows/reusable-test.yml`

### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `rust-toolchain` | string | No | `1.91.0` | Rust toolchain version |
| `node-version` | string | No | `20` | Node.js version |
| `skip-contracts` | boolean | No | `false` | Skip contract tests |
| `skip-api` | boolean | No | `false` | Skip API tests |
| `skip-frontend` | boolean | No | `false` | Skip frontend tests |
| `run-e2e` | boolean | No | `false` | Run API e2e tests |

### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `DATABASE_URL` | No | Database URL for e2e tests |
| `JWT_SECRET` | No | JWT secret for e2e tests |
| `ADMIN_SECRET_KEY` | No | Admin secret key |
| `STELLAR_NETWORK` | No | Stellar network |
| `STELLAR_HORIZON_URL` | No | Stellar Horizon URL |
| `STELLAR_SOROBAN_RPC` | No | Stellar Soroban RPC URL |
| `IPFS_API_KEY` | No | IPFS API key |
| `IPFS_SECRET_KEY` | No | IPFS secret key |

### Example Usage

```yaml
jobs:
  test:
    uses: ./.github/workflows/reusable-test.yml
    with:
      skip-contracts: false
      skip-api: false
      skip-frontend: false
      run-e2e: true
    secrets:
      DATABASE_URL: ${{ secrets.DATABASE_URL }}
      JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

## Reusable Build Workflow

**File:** `.github/workflows/reusable-build.yml`

### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `rust-toolchain` | string | No | `1.91.0` | Rust toolchain version |
| `node-version` | string | No | `20` | Node.js version |
| `docker-registry` | string | No | `ghcr.io` | Docker registry |
| `docker-image-name` | string | No | `carbonchain` | Docker image name |
| `docker-tag` | string | No | `latest` | Docker image tag |
| `push-docker` | boolean | No | `false` | Push Docker image |

### Outputs

| Output | Description |
|--------|-------------|
| `docker-image` | Built Docker image URI |

### Example Usage

```yaml
jobs:
  build:
    uses: ./.github/workflows/reusable-build.yml
    with:
      push-docker: true
      docker-tag: production-${{ github.sha }}
```

## Reusable Deploy Workflow

**File:** `.github/workflows/reusable-deploy.yml`

### Inputs

| Input | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `environment` | string | Yes | - | Deployment environment (testnet, staging, production) |
| `rust-toolchain` | string | No | `stable` | Rust toolchain version |
| `stellar-cli-version` | string | No | `26.1.0` | Stellar CLI version |
| `run-smoke-tests` | boolean | No | `true` | Run smoke tests after deployment |

### Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `ADMIN_SECRET_KEY` | Yes | Admin secret key for deployment |

### Example Usage

```yaml
jobs:
  deploy:
    uses: ./.github/workflows/reusable-deploy.yml
    with:
      environment: testnet
      run-smoke-tests: true
    secrets:
      ADMIN_SECRET_KEY: ${{ secrets.TESTNET_ADMIN_SECRET_KEY }}
```

## Caller Workflows

The repository includes the following caller workflows:

| Workflow | File | Description |
|----------|------|-------------|
| CI | `ci.yml` | Main CI pipeline (test + security scan) |
| Deploy Testnet | `deploy-testnet.yml` | Deploy to testnet environment |
| Deploy Staging | `deploy-staging.yml` | Deploy to staging environment |
| Deploy Production | `deploy-production.yml` | Deploy to production environment |

## Action Version Pinning

All GitHub Actions are pinned to specific commit SHAs for security and reproducibility:

| Action | Pinned Version |
|--------|----------------|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` (v4.2.2) |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` (v4) |
| `actions/cache` | `5a3ec84eff668545956fd18022155c47e93e2684` (v4.2.3) |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` (v4) |
| `dtolnay/rust-toolchain` | `008f31fc1bef098acda5bc0f83cc6714a485c3d8` (stable) |
| `Swatinem/rust-cache` | `e18b497796c12c097a38f9edb9d0641fb99eee32` (v2) |
| `docker/setup-buildx-action` | `b5ca514318bd6ebac0fb2aedd5d36ec1b5c232a2` (v3.10.0) |
| `docker/login-action` | `74a5d142397b4f367a81961eba4e8cd7edddf772` (v3.4.0) |
| `docker/metadata-action` | `902fa8ec7d6ecbf8d84d538b9b233a880e428804` (v5.7.0) |
| `docker/build-push-action` | `14487ce63c7a62a4a324b0bfb37086795e31c6c1` (v6.16.0) |

## Environment Configuration

Each environment requires the following GitHub repository secrets:

### Testnet
- `TESTNET_ADMIN_SECRET_KEY`

### Staging
- `STAGING_ADMIN_SECRET_KEY`

### Production
- `PRODUCTION_ADMIN_SECRET_KEY`

## Creating a New Caller Workflow

To create a new caller workflow for a custom environment:

1. Create a new file in `.github/workflows/` (e.g., `deploy-dev.yml`)
2. Use the `workflow_call` trigger to invoke reusable workflows
3. Configure the appropriate secrets for the environment

Example:

```yaml
name: Deploy to Dev

on:
  workflow_dispatch:

jobs:
  test:
    uses: ./.github/workflows/reusable-test.yml
    with:
      run-e2e: false

  build:
    uses: ./.github/workflows/reusable-build.yml

  deploy:
    needs: [test, build]
    uses: ./.github/workflows/reusable-deploy.yml
    with:
      environment: testnet
      run-smoke-tests: false
    secrets:
      ADMIN_SECRET_KEY: ${{ secrets.DEV_ADMIN_SECRET_KEY }}
```
