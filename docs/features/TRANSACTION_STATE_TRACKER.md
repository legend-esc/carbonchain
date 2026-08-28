# Transaction State Tracker

CarbonChain tracks the full lifecycle of every carbon credit via a state machine enforced both on-chain (Soroban contract) and off-chain (API index).

## Credit States

```
              ┌──────────┐
   submit     │          │  approve_and_mint
 ──────────>  │ Pending  │ ──────────────────> Active
              │          │
              └──────────┘
                  │
                  │ flag (verifier)
                  ▼
              ┌──────────┐
              │ Flagged  │ ──> re-review ──> Pending
              └──────────┘
                  │
                  │ dispute
                  ▼
              ┌──────────┐
              │ Disputed │ ──> resolve ──> Active / Flagged
              └──────────┘

Active ──> retire ──> Retired  (terminal)
Active ──> expire ──> Expired  (terminal)
```

## State Transition Rules

| From | To | Trigger | Who |
|------|----|---------|-----|
| — | `Pending` | `submit_credit` | Issuer |
| `Pending` | `Active` | `approve_and_mint` | Verifier |
| `Active` | `Retired` | `retire` / `batch_retire` | Owner |
| `Active` | `Flagged` | `flag_credit` | Verifier |
| `Flagged` | `Pending` | `resubmit_credit` | Issuer |
| `Active` | `Disputed` | `dispute_credit` | Any |
| `Disputed` | `Active` | `resolve_dispute` | Admin |
| `Active` | `Expired` | `expire_credit` | Admin |

## Invalid Transitions

The contract returns `InvalidStatusTransition` (code 105) for any transition not listed above. `Retired` and `Expired` are terminal states — no further transitions are allowed.

## Off-Chain Indexing

The API mirrors credit status in PostgreSQL via the `credits` table. Status is updated whenever a matching contract event (`CreditMinted`, `CreditRetired`, etc.) is processed by the event listener.
