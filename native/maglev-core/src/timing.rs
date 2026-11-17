//! Download timing (contract section 34.1): how long an item really downloaded, when it finished and how many
//! bytes moved over an unmetered or a metered link. Pure: no clock, no IO. Torrents (`meta.rs`) and link downloads
//! (`http_dl/driver.rs`) both keep one `Timing` and feed it from their own one-second pass.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One pass counts at most this long, so a suspended process does not count the gap as downloading.
pub const MAX_TICK: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Timing {
    /// Milliseconds spent downloading (not paused, queued, waiting, checking or seeding).
    pub active_ms: u64,
    /// Unix seconds when the item first reached done; 0 until then.
    pub finished_at: i64,
    /// Payload bytes this engine downloaded for the item.
    pub session_bytes: u64,
    /// Downloaded (and, for a torrent, uploaded) bytes that moved on an unmetered link.
    pub bytes_wifi: u64,
    /// The same on a metered link.
    pub bytes_mobile: u64,
    /// The engine has seen this item unfinished, so a later finish is a real edge. An item that was already done
    /// when it was first seen (added before 0.26) keeps `finished_at` 0 instead of a made-up time.
    pub tracked: bool,
}

impl Timing {
    /// A fresh item that has never finished.
    pub fn new() -> Self {
        Timing { tracked: true, ..Default::default() }
    }

    pub fn active_secs(&self) -> i64 {
        (self.active_ms / 1000) as i64
    }

    /// Adds the time since the last pass, only while downloading.
    pub fn tick(&mut self, elapsed: Duration, downloading: bool) {
        if downloading {
            self.active_ms = self.active_ms.saturating_add(elapsed.min(MAX_TICK).as_millis() as u64);
        }
    }

    /// Downloaded payload bytes: counts toward the session total and the network split.
    pub fn add_down(&mut self, n: u64, metered: bool) {
        self.session_bytes = self.session_bytes.saturating_add(n);
        self.add_split(n, metered);
    }

    /// Uploaded bytes (torrents): only the network split.
    pub fn add_up(&mut self, n: u64, metered: bool) {
        self.add_split(n, metered);
    }

    fn add_split(&mut self, n: u64, metered: bool) {
        if metered {
            self.bytes_mobile = self.bytes_mobile.saturating_add(n);
        } else {
            self.bytes_wifi = self.bytes_wifi.saturating_add(n);
        }
    }

    /// Call once per pass with whether the item is done right now. `finished_at` is set once, on the first pass
    /// that sees an item done after seeing it unfinished, and never changes again.
    pub fn observe_finished(&mut self, finished: bool, now: i64) {
        if finished {
            if self.tracked && self.finished_at == 0 {
                self.finished_at = now.max(1);
            }
        } else {
            self.tracked = true;
        }
    }

    /// A restart of the same item as a different file (`FILE_CHANGED`): everything counted so far belongs to the old file.
    pub fn reset(&mut self) {
        *self = Timing::new();
    }
}

/// Bytes gained since the previous call, counted only while `counting`. `base` is the previous reading of the
/// counter (`None` before the first). A counter that went down (restart from zero, recheck) is a new baseline,
/// not negative traffic. The baseline always follows the counter, so bytes already on disk when downloading starts
/// are never counted.
pub fn gained(base: &mut Option<u64>, counting: bool, now: u64) -> u64 {
    let prev = base.replace(now);
    match prev {
        Some(p) if counting && now > p => now - p,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn counts_only_while_downloading() {
        let mut t = Timing::new();
        t.tick(s(1), true);
        t.tick(s(1), true);
        t.tick(s(1), false); // paused, queued, waiting, checking, seeding, error
        assert_eq!(t.active_secs(), 2);
        assert_eq!(t.active_ms, 2000);
    }

    #[test]
    fn a_long_gap_is_capped() {
        let mut t = Timing::new();
        t.tick(s(600), true);
        assert_eq!(t.active_ms, 5000);
    }

    #[test]
    fn finished_at_is_set_once_and_survives_everything() {
        let mut t = Timing::new();
        t.observe_finished(false, 100);
        assert_eq!(t.finished_at, 0);
        t.observe_finished(true, 200);
        assert_eq!(t.finished_at, 200);
        t.observe_finished(true, 300);
        t.observe_finished(false, 400); // recheck or a pause
        t.observe_finished(true, 500);
        assert_eq!(t.finished_at, 200);
    }

    #[test]
    fn an_item_done_before_it_was_tracked_keeps_zero() {
        let mut t = Timing::default(); // read from an old file
        t.observe_finished(true, 200);
        assert_eq!(t.finished_at, 0);
        assert_eq!(t.active_secs(), 0);
    }

    #[test]
    fn a_new_item_that_is_done_at_once_is_stamped() {
        // The link engine builds records with `Timing::new()`, so the first pass may already see it done.
        let mut t = Timing::new();
        t.observe_finished(true, 50);
        assert_eq!(t.finished_at, 50);
    }

    #[test]
    fn file_changed_reset_clears_the_three_counters_and_keeps_tracking() {
        let mut t = Timing::new();
        t.tick(s(4), true);
        t.add_down(1000, false);
        t.add_up(10, true);
        t.observe_finished(true, 99);
        t.reset();
        assert_eq!((t.active_ms, t.finished_at, t.session_bytes, t.bytes_wifi, t.bytes_mobile), (0, 0, 0, 0, 0));
        assert!(t.tracked);
        t.observe_finished(true, 120);
        assert_eq!(t.finished_at, 120);
    }

    #[test]
    fn network_split_adds_up_to_session_plus_uploaded() {
        let mut t = Timing::new();
        t.add_down(700, false);
        t.add_down(300, true);
        t.add_up(50, false);
        t.add_up(25, true);
        assert_eq!(t.session_bytes, 1000);
        assert_eq!((t.bytes_wifi, t.bytes_mobile), (750, 325));
        assert_eq!(t.bytes_wifi + t.bytes_mobile, t.session_bytes + 75);
    }

    #[test]
    fn gained_ignores_bytes_already_on_disk_and_drops() {
        let mut base = None;
        assert_eq!(gained(&mut base, true, 5_000), 0); // first reading is the baseline
        assert_eq!(gained(&mut base, true, 5_400), 400);
        assert_eq!(gained(&mut base, false, 6_000), 0); // paused: baseline follows, nothing counted
        assert_eq!(gained(&mut base, true, 6_100), 100);
        assert_eq!(gained(&mut base, true, 0), 0); // restart from zero
        assert_eq!(gained(&mut base, true, 70), 70);
    }

    #[test]
    fn old_records_load_with_zeros() {
        let t: Timing = serde_json::from_str("{}").unwrap();
        assert_eq!(t, Timing::default());
        let t: Timing = serde_json::from_str(r#"{"active_ms":61000,"finished_at":7,"tracked":true}"#).unwrap();
        assert_eq!((t.active_secs(), t.finished_at, t.session_bytes), (61, 7, 0));
    }
}
