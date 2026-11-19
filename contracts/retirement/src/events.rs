use soroban_sdk::{contractevent, Address, BytesN};

/// One summary for the successfully processed credits in a retirement batch.
/// Failed entries are excluded from both the volume and the credit count.
#[contractevent]
#[derive(Clone)]
pub struct RetirementBatchProcessed {
    #[topic]
    pub batch_id: BytesN<32>,
    pub total_tonnes: i128,
    pub credit_count: u32,
    #[topic]
    pub retiree: Address,
}
