use soroban_sdk::{contractevent, Address, BytesN, String};

#[contractevent]
#[derive(Clone)]
pub struct ContractPaused {
    pub admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct ContractUnpaused {
    pub admin: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct VerifierRegistered {
    pub admin: Address,
    pub verifier: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct VerifierRemoved {
    pub admin: Address,
    pub verifier: Address,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditSubmitted {
    pub issuer: Address,
    pub project_id: String,
    pub credit_id: BytesN<32>,
    pub tonnes: i128,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditMinted {
    pub verifier: Address,
    pub id: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditFlagged {
    pub id: BytesN<32>,
    pub reason: String,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditDisputed {
    pub disputer: Address,
    pub credit_id: BytesN<32>,
    pub evidence: String,
}

#[contractevent]
#[derive(Clone)]
pub struct DisputeResolved {
    pub credit_id: BytesN<32>,
    pub outcome: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditExpired {
    pub credit_id: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditsMerged {
    pub new_id: BytesN<32>,
    pub source_count: u32,
}

#[contractevent]
#[derive(Clone)]
pub struct ProjectRegistered {
    pub owner: Address,
    pub project_id: String,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditTransferred {
    pub from: Address,
    pub to: Address,
    pub credit_id: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct CreditSplit {
    pub original_id: BytesN<32>,
    pub child1_id: BytesN<32>,
    pub child2_id: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct SessionNew {
    pub initiator: Address,
    pub session_id: BytesN<32>,
}

#[contractevent]
#[derive(Clone)]
pub struct BatchRetired {
    pub buyer: Address,
    pub count: u32,
}
