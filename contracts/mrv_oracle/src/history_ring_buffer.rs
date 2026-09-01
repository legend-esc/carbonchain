//! Bounded ring buffer for per-project MRV history, replacing the
//! Vec<MrvDataPoint> + `history.remove(0)` pattern in `update_mrv_data`.
//!
//! `Vec::remove(0)` shifts every remaining element (O(n)) on each insert
//! once the cap is hit, and the Vec's backing storage is never shrunk, so
//! long-lived projects creep toward Soroban's 64KB value size limit even
//! though only MAX_HISTORY entries are ever live.
//!
//! This stores entries in a fixed-size map keyed by slot index (0..CAP),
//! plus a head pointer and count, so inserts overwrite the oldest slot in
//! O(1) with no reallocation growth over time.

use soroban_sdk::{contracttype, Env, Map};

use crate::MrvDataPoint; // adjust to actual type path in lib.rs

pub const HISTORY_CAPACITY: u32 = 100;

#[contracttype]
#[derive(Clone)]
pub struct RingBufferMeta {
    pub head: u32,  // next slot to write
    pub count: u32, // number of live entries, capped at HISTORY_CAPACITY
}

pub struct HistoryRingBuffer;

impl HistoryRingBuffer {
    /// Push a new reading, overwriting the oldest slot once at capacity.
    pub fn push(
        env: &Env,
        slots: &mut Map<u32, MrvDataPoint>,
        meta: &mut RingBufferMeta,
        entry: MrvDataPoint,
    ) {
        let _ = env;
        slots.set(meta.head, entry);
        meta.head = (meta.head + 1) % HISTORY_CAPACITY;
        if meta.count < HISTORY_CAPACITY {
            meta.count += 1;
        }
    }

    /// Return entries oldest-to-newest.
    pub fn to_vec_ordered(
        slots: &Map<u32, MrvDataPoint>,
        meta: &RingBufferMeta,
    ) -> soroban_sdk::Vec<MrvDataPoint> {
        let env = slots.env();
        let mut out = soroban_sdk::Vec::new(env);
        let start = if meta.count < HISTORY_CAPACITY {
            0
        } else {
            meta.head
        };
        for i in 0..meta.count {
            let idx = (start + i) % HISTORY_CAPACITY;
            if let Some(entry) = slots.get(idx) {
                out.push_back(entry);
            }
        }
        out
    }

    /// One-time migration: convert an existing Vec<MrvDataPoint> (old storage
    /// format) into ring-buffer slots + meta, keeping only the most recent
    /// HISTORY_CAPACITY entries.
    #[allow(dead_code)]
    pub fn migrate_from_vec(
        env: &Env,
        old: &soroban_sdk::Vec<MrvDataPoint>,
    ) -> (Map<u32, MrvDataPoint>, RingBufferMeta) {
        let mut slots: Map<u32, MrvDataPoint> = Map::new(env);
        let mut meta = RingBufferMeta { head: 0, count: 0 };

        let len = old.len();
        let start = if len > HISTORY_CAPACITY {
            len - HISTORY_CAPACITY
        } else {
            0
        };
        for i in start..len {
            Self::push(env, &mut slots, &mut meta, old.get(i).unwrap());
        }
        (slots, meta)
    }
}
