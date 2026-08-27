# CarbonChain Quick Start

End-to-end flow: **wallet connect → register project → submit credit → verifier approve → retire**

---

## Prerequisites

Install the Soroban CLI:

```bash
cargo install --locked stellar-cli@26.1.0 --features opt
```

Set up a testnet identity:

```bash
stellar keys generate carbonchain-admin --network testnet
export ADMIN_SECRET_KEY=$(stellar keys show carbonchain-admin)
```

---

## Step 1: Deploy contracts

```bash
cd scripts
./deploy-testnet.sh
```

This funds the admin account, compiles all Soroban contracts, deploys them, and writes contract IDs to `contract-ids.testnet.json`.

---

## Step 2: Initialize registry and register a project

```bash
# Initialize the registry
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  initialize \
  --admin $(stellar keys address carbonchain-admin) \
  --retirement_contract $(jq -r '.retirement' contract-ids.testnet.json) \
  --required_approvals 1

# Register a methodology
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  register_methodology \
  --admin $(stellar keys address carbonchain-admin) \
  --code VCS \
  --name "Verified Carbon Standard" \
  --nonce 0

# Register a project
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  register_project \
  --owner $(stellar keys address carbonchain-admin) \
  --project_id "PROJ-001" \
  --name "Amazon REDD+" \
  --description "Amazon basin REDD+ conservation project" \
  --location "BR"
```

---

## Step 3: Register an issuer and submit a credit

```bash
# Register an issuer
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  register_issuer \
  --admin $(stellar keys address carbonchain-admin) \
  --issuer $(stellar keys address carbonchain-admin) \
  --nonce 1

# Submit a credit (1 tonne = 1_000_000 units, minimum unit = 100_000)
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  submit_credit \
  --issuer $(stellar keys address carbonchain-admin) \
  --project_id "PROJ-001" \
  --vintage_year 2024 \
  --methodology VCS \
  --geography BR \
  --tonnes 1000000 \
  --ipfs_hash "bafybei123" \
  --nonce 0
```

Take note of the returned credit ID (a 32-byte hex value).

---

## Step 4: Register a verifier and approve the credit

```bash
# Register a verifier
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  register_verifier \
  --admin $(stellar keys address carbonchain-admin) \
  --verifier $(stellar keys address carbonchain-admin) \
  --nonce 2

# Approve and mint (use the credit ID from step 3)
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  approve_and_mint \
  --verifier $(stellar keys address carbonchain-admin) \
  --credit_id <CREDIT_ID> \
  --nonce 0

# Verify the credit is now Active
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json') \
  --source carbonchain-admin \
  --network testnet \
  -- \
  get_credit \
  --credit_id <CREDIT_ID>
```

Check the status field — it should be `Active` (1).

---

## Step 5: Retire the credit

```bash
stellar contract invoke \
  --id $(jq -r '.retirement' contract-ids.testnet.json) \
  --source carbonchain-admin \
  --network testnet \
  -- \
  retire \
  --buyer $(stellar keys address carbonchain-admin) \
  --credit_id <CREDIT_ID> \
  --tonnes 1000000 \
  --reason "2024 Scope 3 offset" \
  --registry $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --nonce 1
```

---

## Verifier multi-sig (if `--required_approvals > 1`)

```bash
# Verifier 1 approves
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source verifier1 \
  --network testnet \
  -- \
  approve_and_mint \
  --verifier $(stellar keys address verifier1) \
  --credit_id <CREDIT_ID> \
  --nonce 0

# Verifier 2 approves — credit becomes Active
stellar contract invoke \
  --id $(jq -r '.credit_registry' contract-ids.testnet.json) \
  --source verifier2 \
  --network testnet \
  -- \
  approve_and_mint \
  --verifier $(stellar keys address verifier2) \
  --credit_id <CREDIT_ID> \
  --nonce 0
```

---

## Unit convention

| Unit | Scaled value |
|------|-------------|
| 1 tonne | `1_000_000` |
| 0.1 tonne (minimum) | `100_000` |
| Max supply | `1_000_000_000_000_000` |

All `tonnes` values must be a positive multiple of `100_000`.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `AlreadyInitialized (101)` | Contract already initialized |
| `InvalidTonnes (110)` | Tonnes is not a positive multiple of 100_000 |
| `InvalidNonce (115)` | Stale nonce — call `get_nonce` first |
| `InvalidStatusTransition (105)` | Credit is not in Pending state |
