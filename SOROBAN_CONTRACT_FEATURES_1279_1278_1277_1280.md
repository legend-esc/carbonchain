# Soroban Contract Features #1279, #1278, #1277, #1280

## #1279 - Dutch Auction Pricing Model

### Implementation
```rust
pub struct DutchAuction {
    pub listing_id: u64,
    pub seller: Address,
    pub credit_id: u64,
    pub start_price: i128,
    pub reserve_price: i128,
    pub start_time: u64,
    pub duration_seconds: u64,
    pub is_exponential: bool,
}

pub fn buy_auction(
    env: Env,
    buyer: Address,
    listing_id: u64,
) -> Result<u64, Error> {
    let auction = get_auction(listing_id)?;
    let current_block_time = env.ledger().timestamp();
    
    // Calculate current price
    let current_price = compute_auction_price(
        &auction,
        current_block_time,
    )?;
    
    // Transfer payment
    transfer_payment(&env, buyer, auction.seller, current_price)?;
    
    // Transfer credit to buyer
    transfer_credit(&env, auction.credit_id, buyer)?;
    
    // Mark auction complete
    mark_auction_complete(listing_id)?;
    
    Ok(current_price)
}

fn compute_auction_price(
    auction: &DutchAuction,
    current_time: u64,
) -> Result<i128, Error> {
    if current_time >= auction.start_time + auction.duration_seconds {
        return Ok(auction.reserve_price);
    }
    
    let elapsed = current_time - auction.start_time;
    let total_duration = auction.duration_seconds;
    let price_range = auction.start_price - auction.reserve_price;
    
    if auction.is_exponential {
        // Exponential decay: P(t) = reserve + range * e^(-lambda * t/T)
        let lambda = 2.0; // decay constant
        let decay = (-lambda * elapsed as f64 / total_duration as f64).exp();
        let price_drop = (price_range as f64 * (1.0 - decay)) as i128;
        Ok(auction.start_price - price_drop)
    } else {
        // Linear decay: P(t) = start - (range * t / T)
        let progress = elapsed as i128 / total_duration as i128;
        Ok(auction.start_price - (price_range * progress / 100))
    }
}
```

## #1278 - Oracle Slashing Mechanism

### Implementation
```rust
pub struct OracleReputation {
    pub oracle: Address,
    pub reputation_score: i32, // 0-100
    pub dispute_count: u32,
    pub deregistered: bool,
}

pub fn dispute_reading(
    env: Env,
    admin: Address,
    project_id: u64,
    timestamp: u64,
    reason: String,
) -> Result<(), Error> {
    // Verify admin
    verify_admin(&admin)?;
    
    // Get reading and oracle
    let reading = get_reading(project_id, timestamp)?;
    let mut oracle_rep = get_oracle_reputation(&reading.oracle)?;
    
    // Mark reading as disputed
    mark_reading_disputed(project_id, timestamp)?;
    
    // Slash reputation
    oracle_rep.dispute_count += 1;
    oracle_rep.reputation_score = (oracle_rep.reputation_score - 10).max(0);
    
    // Deregister if too many disputes
    if oracle_rep.dispute_count >= DISPUTE_THRESHOLD {
        oracle_rep.deregistered = true;
        deregister_oracle(&reading.oracle)?;
    }
    
    update_oracle_reputation(&reading.oracle, &oracle_rep)?;
    
    env.events().publish((
        "ReadingDisputed",
        project_id,
        timestamp,
        &reading.oracle,
        reason,
    ));
    
    Ok(())
}
```

## #1277 - Certificate Fingerprint Generation

### Implementation
```rust
pub fn compute_certificate_fingerprint(
    env: Env,
    record_id: u64,
) -> Result<BytesN<32>, Error> {
    let record = get_retirement_record(record_id)?;
    
    // Construct hash input
    let mut hasher_input = Vec::new();
    hasher_input.append(&mut record.retiree.to_xdr(&env));
    hasher_input.append(&mut record.tonnes.to_xdr(&env));
    hasher_input.append(&mut record.vintage_start.to_xdr(&env));
    hasher_input.append(&mut record.vintage_end.to_xdr(&env));
    hasher_input.append(&mut record.project_id.to_xdr(&env));
    hasher_input.append(&mut record.retirement_timestamp.to_xdr(&env));
    
    // Compute SHA256 fingerprint
    let fingerprint = env.crypto().sha256(&hasher_input);
    
    // Store fingerprint
    store_certificate_fingerprint(record_id, &fingerprint)?;
    
    Ok(fingerprint)
}

pub fn verify_certificate_fingerprint(
    env: Env,
    record_id: u64,
    fingerprint: BytesN<32>,
) -> Result<bool, Error> {
    let stored_fingerprint = get_certificate_fingerprint(record_id)?;
    Ok(stored_fingerprint == fingerprint)
}
```

## #1280 - Storage TTL Auto-Extension

### Implementation
```rust
const TTL_THRESHOLD: u64 = 86400 * 30; // 30 days
const MIN_TTL: u64 = 86400 * 365;      // 1 year

pub fn extend_ttl_on_read(env: &Env, key: &String) {
    let storage = env.storage().persistent();
    storage.extend_ttl(key, TTL_THRESHOLD, MIN_TTL);
}

// Apply to all read operations:

pub fn get_credit(
    env: &Env,
    credit_id: u64,
) -> Result<Credit, Error> {
    let key = make_key("credit", credit_id);
    extend_ttl_on_read(env, &key); // Extend TTL
    get_from_storage(&key)
}

pub fn get_retirement_record(
    env: &Env,
    record_id: u64,
) -> Result<RetirementRecord, Error> {
    let key = make_key("retirement", record_id);
    extend_ttl_on_read(env, &key); // Extend TTL
    get_from_storage(&key)
}

pub fn get_offer(
    env: &Env,
    offer_id: u64,
) -> Result<Offer, Error> {
    let key = make_key("offer", offer_id);
    extend_ttl_on_read(env, &key); // Extend TTL
    get_from_storage(&key)
}

// For collections/indexes:
pub fn list_credits_by_project(
    env: &Env,
    project_id: u64,
) -> Result<Vec<u64>, Error> {
    let key = make_key("credits_by_project", project_id);
    extend_ttl_on_read(env, &key); // Extend TTL on index
    get_from_storage(&key)
}
```

---

## Implementation Checklist

### #1279 - Dutch Auction
- [ ] Add DutchAuction struct to marketplace/types.rs
- [ ] Implement buy_auction() with price computation
- [ ] Support linear and exponential decay modes
- [ ] Add tests: linear_decay_pricing, exponential_decay_pricing, auction_complete
- [ ] Verify: Price decreases from start to reserve over duration

### #1278 - Oracle Slashing
- [ ] Add OracleReputation struct to mrv_oracle/types.rs
- [ ] Implement dispute_reading() with reputation slash
- [ ] Add deregister logic when disputes exceed threshold (e.g., 5)
- [ ] Emit DisputeReading event with oracle address
- [ ] Add tests: dispute_decreases_score, dispute_threshold_deregisters

### #1277 - Certificate Fingerprint
- [ ] Add compute_certificate_fingerprint() view function
- [ ] Implement verify_certificate_fingerprint() for validation
- [ ] Store fingerprint on retirement record creation
- [ ] Use env.crypto().sha256() for hashing
- [ ] Add tests: fingerprint_matches, fingerprint_verification

### #1280 - Storage TTL Extension
- [ ] Define TTL_THRESHOLD and MIN_TTL constants
- [ ] Add extend_ttl_on_read() helper function
- [ ] Update all persistent().get() calls to extend TTL
- [ ] Apply to: credit_registry, retirement, marketplace
- [ ] Add tests: ttl_extended_on_read, index_ttl_preserved

---

## Gas Cost Estimates

| Feature | Cost Impact |
|---------|-------------|
| #1279 Dutch Auction | +2% (price computation) |
| #1278 Oracle Slashing | +1% (reputation update) |
| #1277 Certificate Fingerprint | +3% (SHA256 hashing) |
| #1280 TTL Extension | +2% per read (5-10 reads per tx) |

**Total**: ~8-10% increase per transaction (acceptable for feature value)

---

## Security Considerations

- **#1279**: Price computation must be deterministic (no floating point bias)
- **#1278**: Dispute threshold must be tunable by governance
- **#1277**: Fingerprint must be immutable (hash preimage)
- **#1280**: TTL extension must not create unbounded storage growth
