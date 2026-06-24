# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| `main` (testnet) | ✅ Active |
| Older branches | ❌ Not supported |

CarbonChain is currently pre-mainnet. Security fixes are applied to the `main` branch only.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via one of the following channels:

- **GitHub Private Advisory:** [Report a vulnerability](../../security/advisories/new) *(preferred)*
- **Email:** security@carbonchain.io

### What to include

- Description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected contract(s), endpoint(s), or component(s)
- Any suggested mitigations (optional)

## Responsible Disclosure Process

1. **Submit** your report using one of the channels above.
2. **Acknowledgement** — you will receive a response within **48 hours** confirming receipt.
3. **Assessment** — we will assess severity and scope within **7 days** and keep you informed.
4. **Fix & disclosure** — we aim to release a fix within **30 days** for critical issues. We will coordinate the public disclosure date with you.
5. **Credit** — with your permission, we will acknowledge your contribution in the release notes.

We follow a **90-day disclosure deadline**: if a fix is not available within 90 days, we reserve the right to disclose the issue publicly to protect users.

## Scope

In scope:

- Soroban smart contracts (`contracts/`)
- NestJS API (`api/`)
- Authentication and authorization logic (SEP-10, JWT)
- Replay protection and nonce handling
- Admin key exposure or secret leakage

Out of scope:

- Stellar network-level issues (report to [Stellar Bug Bounty](https://www.stellar.org/bug-bounty-program))
- Third-party dependencies (report upstream)
- Issues requiring physical access to infrastructure
- Social engineering attacks

## Security Design Notes

- Private keys are never held server-side — all user transactions are signed client-side via Freighter
- Replay protection is enforced at multiple contract levels via nonce-based verification
- Retirement and audit records are immutable — no delete functions exist on-chain
- All state-mutating contract operations require explicit authorization checks
- Stable error codes (100–120) are maintained across upgrades to avoid information leakage changes
