# Bugfix Requirements Document

## Introduction

After a Soroban transaction is submitted and polling returns a `FAILED` status, `invokeContractImpl` in `stellar.service.ts` unconditionally returns the result and emits a `CONTRACT_INVOCATION_COMPLETED` success event. This means callers receive a failed transaction reported as successful, and failure metrics are never recorded for this failure path. The fix ensures that a `FAILED` poll result is treated as an error — throwing rather than returning, and letting the existing `catch` block in `invokeContract` emit the failure event.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN `pollTransactionStatus` returns a response with `status === 'FAILED'` THEN the system returns the failed result to the caller without throwing an error

1.2 WHEN `pollTransactionStatus` returns a response with `status === 'FAILED'` THEN the system emits a `CONTRACT_INVOCATION_COMPLETED` event with `status: 'success'`, misreporting the transaction as successful

1.3 WHEN `pollTransactionStatus` returns a response with `status === 'FAILED'` THEN the system does NOT emit a `CONTRACT_INVOCATION_COMPLETED` event with `status: 'failure'`, leaving failure metrics unrecorded

### Expected Behavior (Correct)

2.1 WHEN `pollTransactionStatus` returns a response with `status === 'FAILED'` THEN the system SHALL throw a descriptive error instead of returning the result

2.2 WHEN `pollTransactionStatus` returns a response with `status === 'FAILED'` THEN the system SHALL NOT emit a `CONTRACT_INVOCATION_COMPLETED` event with `status: 'success'`

2.3 WHEN `pollTransactionStatus` returns a response with `status === 'FAILED'` THEN the system SHALL emit a `CONTRACT_INVOCATION_COMPLETED` event with `status: 'failure'` (via the existing `catch` block in `invokeContract` that handles the thrown error)

### Unchanged Behavior (Regression Prevention)

3.1 WHEN `pollTransactionStatus` returns a response with `status === 'SUCCESS'` THEN the system SHALL CONTINUE TO return the result to the caller without throwing

3.2 WHEN `pollTransactionStatus` returns a response with `status === 'SUCCESS'` THEN the system SHALL CONTINUE TO emit a `CONTRACT_INVOCATION_COMPLETED` event with `status: 'success'`

3.3 WHEN the transaction submission is rejected before polling (e.g. `tx_insufficient_fee`, `tx_bad_seq`) THEN the system SHALL CONTINUE TO handle those errors with the existing retry and fallback logic unchanged

3.4 WHEN `pollTransactionStatus` times out waiting for a final status THEN the system SHALL CONTINUE TO throw a timeout error, which propagates to the `catch` block in `invokeContract` and emits a failure event
