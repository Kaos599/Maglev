//! What Maglev can observe while a magnet resolves (`docs/NATIVE_CONTRACT.md` section 12.1).
//!
//! librqbit reports no progress while it looks for a magnet's metadata, so a side task counts the
//! unique peer addresses the DHT returns. This module is the pure registry behind it: no session,
//! no JNI, unit tested on any host. Entries are keyed by lower case 40 hex info hash.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::Notify;

/// A copy of one entry, as sent over JNI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivitySnapshot {
    pub peers_found: u32,
    pub dht: bool,
    pub elapsed_ms: u64,
}

struct Entry {
    generation: u64,
    peers: HashSet<SocketAddr>,
    dht: bool,
    started: Instant,
    cancel: Arc<Notify>,
}

#[derive(Default)]
struct Inner {
    next_generation: u64,
    entries: HashMap<String, Entry>,
}

/// Registry of running magnet resolves.
#[derive(Default)]
pub struct ResolveRegistry {
    inner: Mutex<Inner>,
}

/// Returned by [`ResolveRegistry::begin`]. `generation` tells `end` which run it belongs to, so a
/// late `end` from an older resolve of the same hash never removes a newer entry.
pub struct Started {
    pub generation: u64,
    pub cancel: Arc<Notify>,
}

impl ResolveRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a resolve. An entry that already exists for the hash is replaced.
    pub fn begin(&self, key: &str, dht: bool) -> Started {
        let mut g = self.inner.lock();
        g.next_generation += 1;
        let generation = g.next_generation;
        let cancel = Arc::new(Notify::new());
        g.entries.insert(
            key.to_string(),
            Entry {
                generation,
                peers: HashSet::new(),
                dht,
                started: Instant::now(),
                cancel: cancel.clone(),
            },
        );
        Started { generation, cancel }
    }

    /// Counts a peer address once. Returns true when the address was new. Ignored (false) when the
    /// entry of that generation is gone.
    pub fn record_peer(&self, key: &str, generation: u64, addr: SocketAddr) -> bool {
        let mut g = self.inner.lock();
        match g.entries.get_mut(key) {
            Some(e) if e.generation == generation => e.peers.insert(addr),
            _ => false,
        }
    }

    pub fn snapshot(&self, key: &str) -> Option<ActivitySnapshot> {
        let g = self.inner.lock();
        g.entries.get(key).map(|e| ActivitySnapshot {
            peers_found: e.peers.len().min(u32::MAX as usize) as u32,
            dht: e.dht,
            elapsed_ms: e.started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        })
    }

    /// Signals the running resolve to stop. False when none is running. The entry stays until the
    /// resolve itself calls `end`, so polling still works for the moment it takes to unwind.
    pub fn cancel(&self, key: &str) -> bool {
        let g = self.inner.lock();
        match g.entries.get(key) {
            Some(e) => {
                // notify_one stores a permit, so a cancel that lands before the resolve starts
                // waiting is not lost.
                e.cancel.notify_one();
                true
            }
            None => false,
        }
    }

    /// Removes the entry, only when it still belongs to `generation`.
    pub fn end(&self, key: &str, generation: u64) {
        let mut g = self.inner.lock();
        if g.entries.get(key).map(|e| e.generation) == Some(generation) {
            g.entries.remove(key);
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const H: &str = "0123456789abcdef0123456789abcdef01234567";

    fn addr(last: u8, port: u16) -> SocketAddr {
        SocketAddr::from(([10, 0, 0, last], port))
    }

    #[test]
    fn insert_snapshot_remove() {
        let r = ResolveRegistry::new();
        assert!(r.snapshot(H).is_none());
        let s = r.begin(H, true);
        let snap = r.snapshot(H).unwrap();
        assert_eq!(snap.peers_found, 0);
        assert!(snap.dht);
        r.end(H, s.generation);
        assert!(r.snapshot(H).is_none());
        assert!(r.is_empty());
    }

    #[test]
    fn counts_unique_addresses_only() {
        let r = ResolveRegistry::new();
        let s = r.begin(H, true);
        assert!(r.record_peer(H, s.generation, addr(1, 6881)));
        assert!(!r.record_peer(H, s.generation, addr(1, 6881)));
        assert!(r.record_peer(H, s.generation, addr(1, 6882)));
        assert!(r.record_peer(H, s.generation, addr(2, 6881)));
        assert_eq!(r.snapshot(H).unwrap().peers_found, 3);
    }

    #[test]
    fn dht_flag_is_kept_and_unknown_key_is_ignored() {
        let r = ResolveRegistry::new();
        let s = r.begin(H, false);
        assert!(!r.snapshot(H).unwrap().dht);
        assert!(!r.record_peer("ffffffffffffffffffffffffffffffffffffffff", s.generation, addr(1, 1)));
        assert_eq!(r.snapshot(H).unwrap().peers_found, 0);
    }

    #[test]
    fn stale_generation_cannot_touch_a_newer_entry() {
        let r = ResolveRegistry::new();
        let old = r.begin(H, true);
        let new = r.begin(H, true);
        assert_ne!(old.generation, new.generation);
        assert!(!r.record_peer(H, old.generation, addr(1, 1)));
        r.end(H, old.generation);
        assert!(r.snapshot(H).is_some());
        assert!(r.record_peer(H, new.generation, addr(1, 1)));
        r.end(H, new.generation);
        assert!(r.snapshot(H).is_none());
    }

    #[test]
    fn elapsed_grows() {
        let r = ResolveRegistry::new();
        let _s = r.begin(H, true);
        std::thread::sleep(Duration::from_millis(20));
        assert!(r.snapshot(H).unwrap().elapsed_ms >= 15);
    }

    #[test]
    fn cancel_unknown_is_false() {
        assert!(!ResolveRegistry::new().cancel(H));
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    }

    #[test]
    fn cancel_wakes_a_waiting_resolve() {
        let r = ResolveRegistry::new();
        let s = r.begin(H, true);
        assert!(r.cancel(H));
        let woke = rt().block_on(async {
            tokio::time::timeout(Duration::from_secs(2), s.cancel.notified())
                .await
                .is_ok()
        });
        assert!(woke);
    }

    #[test]
    fn cancel_before_waiting_is_not_lost_and_entry_stays_until_end() {
        let r = ResolveRegistry::new();
        let s = r.begin(H, true);
        assert!(r.cancel(H));
        assert!(r.snapshot(H).is_some());
        r.end(H, s.generation);
        assert!(!r.cancel(H));
    }

    #[test]
    fn without_cancel_the_wait_times_out() {
        let r = ResolveRegistry::new();
        let s = r.begin(H, true);
        let woke = rt().block_on(async {
            tokio::time::timeout(Duration::from_millis(50), s.cancel.notified())
                .await
                .is_ok()
        });
        assert!(!woke);
    }
}
