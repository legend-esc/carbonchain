# CarbonChain Quick Start

## Admin Nonce Sequencing

Every admin operation in `credit_registry` consumes one nonce. You must fetch the
current nonce immediately before each call — do **not** reuse a nonce across
multiple calls.

### Verifier service configuration

```typescript
// Step 1: configure initial service set (consumes nonce N)
let n = await contract.get_nonce(admin);
await contract.configure_verifier_services(admin, verifier, [ServiceType.CreditApproval], n);

// Step 2: add an additional service (consumes nonce N+1)
n = await contract.get_nonce(admin);   // now returns N+1
await contract.add_verifier_service(admin, verifier, ServiceType.MRVReview, n);

// Step 3: remove a service (consumes nonce N+2)
n = await contract.get_nonce(admin);   // now returns N+2
await contract.remove_verifier_service(admin, verifier, ServiceType.CreditApproval, n);
```

Passing a stale nonce to any of these functions returns `InvalidNonce` (error 104).

## Credit Issuance Workflow

```typescript
// Register a project
await contract.register_project(admin, "PROJ-001", "Amazon REDD+", "...", "BR");

// Register a verifier
let n = await contract.get_nonce(admin);
await contract.register_verifier(admin, verifier, n);

// Submit a credit for approval
let issuerNonce = await contract.get_nonce(issuer);
const creditId = await contract.submit_credit(
  issuer, "PROJ-001", 2024, "VCS", "BR",
  1_000_000,          // 1 tonne (1 tonne = 1_000_000 units)
  "bafybei...",
  issuerNonce,
);

// Verifier approves and mints
let verifierNonce = await contract.get_nonce(verifier);
await contract.approve_and_mint(verifier, creditId, verifierNonce);
```

## Retirement Workflow

```typescript
// Retire a credit (tonnes must be > 0 and a positive multiple of 100_000)
let buyerNonce = await retirementContract.get_nonce(buyer);
const retirementId = await retirementContract.retire(
  buyer, creditId, 1_000_000, "2024 Scope 3 offset", registryId, buyerNonce,
);

// Batch retire
buyerNonce = await retirementContract.get_nonce(buyer);
const retirementIds = await retirementContract.batch_retire(
  buyer,
  [creditId1, creditId2],
  [1_000_000, 500_000],   // credit_ids.length must equal tonnes.length
  "Q1 2024 offset",
  registryId,
  buyerNonce,
);
```
