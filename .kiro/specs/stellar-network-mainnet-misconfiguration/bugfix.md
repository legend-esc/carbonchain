# Bugfix Requirements Document

## Introduction

Setting `STELLAR_NETWORK=mainnet` silently connects to the Stellar **testnet** instead of mainnet. This happens because `env-validation.ts` accepts `'mainnet'` as a valid value, but `stellar.service.ts` normalises it to `'MAINNET'` via `toUpperCase()` — a value that matches none of the explicit `switch` cases (`'PUBLIC'`, `'FUTURENET'`), so it silently falls through to the `default:` branch which assigns `Networks.TESTNET`. A production deployment under this misconfiguration would execute transactions against the wrong network, potentially causing permanent fund loss and data inconsistency.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `STELLAR_NETWORK` is set to `'mainnet'` THEN the system silently resolves the network passphrase to `Networks.TESTNET` instead of `Networks.PUBLIC`

1.2 WHEN `STELLAR_NETWORK` is set to any unrecognised value THEN the system silently falls through to `Networks.TESTNET` without any warning or startup error

1.3 WHEN the resolved `networkPassphrase` does not match the intended network THEN the system starts successfully and begins processing transactions against the wrong network

### Expected Behavior (Correct)

2.1 WHEN `STELLAR_NETWORK` is set to `'mainnet'` THEN the system SHALL resolve the network passphrase to `Networks.PUBLIC` (the Stellar mainnet passphrase)

2.2 WHEN `STELLAR_NETWORK` is set to `'PUBLIC'` (case-insensitive) THEN the system SHALL resolve the network passphrase to `Networks.PUBLIC`

2.3 WHEN `STELLAR_NETWORK` is set to an unrecognised or unsupported value THEN the system SHALL throw a startup error and refuse to initialise, failing fast rather than silently falling back to testnet

2.4 WHEN the service initialises THEN the system SHALL assert that the resolved `networkPassphrase` matches the expected passphrase for the configured network name, throwing a startup error if the assertion fails

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `STELLAR_NETWORK` is set to `'testnet'` THEN the system SHALL CONTINUE TO resolve the network passphrase to `Networks.TESTNET`

3.2 WHEN `STELLAR_NETWORK` is set to `'TESTNET'` (case-insensitive) THEN the system SHALL CONTINUE TO resolve the network passphrase to `Networks.TESTNET`

3.3 WHEN `STELLAR_NETWORK` is set to `'FUTURENET'` (case-insensitive) THEN the system SHALL CONTINUE TO resolve the network passphrase to `Networks.FUTURENET`

3.4 WHEN `STELLAR_NETWORK` is omitted from environment configuration THEN the system SHALL CONTINUE TO default to `'testnet'` and use `Networks.TESTNET`

3.5 WHEN all existing `env-validation` tests are run THEN the system SHALL CONTINUE TO pass without modification

---

## Bug Condition Specification

**Bug Condition Function** — identifies inputs that trigger the bug:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type StellarNetworkConfig
  OUTPUT: boolean

  // Returns true when the configured network value would be silently
  // misrouted to TESTNET despite intending a different network
  normalised ← X.STELLAR_NETWORK.toUpperCase()
  RETURN normalised = 'MAINNET'
         OR (normalised ≠ 'PUBLIC' AND normalised ≠ 'TESTNET' AND normalised ≠ 'FUTURENET')
END FUNCTION
```

**Property: Fix Checking** — desired behavior for buggy inputs:

```pascal
// For all inputs that trigger the bug condition, the fixed service
// must either resolve the correct passphrase or throw a startup error
FOR ALL X WHERE isBugCondition(X) DO
  IF X.STELLAR_NETWORK.toUpperCase() = 'MAINNET' THEN
    result ← onModuleInit'(X)
    ASSERT result.networkPassphrase = Networks.PUBLIC
  ELSE
    ASSERT onModuleInit'(X) THROWS startup error
  END IF
END FOR
```

**Property: Preservation Checking** — non-buggy inputs must be unaffected:

```pascal
// For all inputs that do NOT trigger the bug condition,
// the fixed service behaves identically to the original
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT onModuleInit(X).networkPassphrase = onModuleInit'(X).networkPassphrase
END FOR
```
