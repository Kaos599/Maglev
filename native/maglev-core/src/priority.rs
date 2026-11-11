//! File priority ("Download first") and the reannounce rate limit.
//!
//! Everything here is pure or touches only a JSON sidecar, so it is unit tested on any host.
//! The engine glue lives in `engine.rs`; see `docs/NATIVE_CONTRACT.md` section 10.
//!
//! The sidecar `<sessionDir>/maglev-priorities.json` stores only the "first" files per info-hash.
//! "Skip" is the same as "not included", and librqbit already persists the included set, so it is
//! not stored twice. Everything that is neither first nor skipped is "normal".

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{EngineError, ErrorCode};
use crate::meta::write_atomic;

pub const PRIORITY_FILE: &str = "maglev-priorities.json";

/// One reannounce per torrent per this long.
pub const REANNOUNCE_MIN_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FilePriority {
    First,
    Normal,
    Skip,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilePriorityEntry {
    pub index: u32,
    pub priority: FilePriority,
}

/// The result of validating a priority list against a torrent's real files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PriorityPlan {
    /// Files to download (everything that is not `skip`). Goes to librqbit `update_only_files`.
    pub included: HashSet<usize>,
    /// Indices marked `first`, ascending. This is what is persisted.
    pub first: Vec<u32>,
    /// Full download order: `first` by index, then the rest by index.
    pub order: Vec<usize>,
}

fn invalid(message: &str) -> EngineError {
    EngineError::new(ErrorCode::InvalidSource, message)
}

/// Reads `[{"index":0,"priority":"first"}, ...]`.
pub fn parse_priorities(json: &str) -> Result<Vec<FilePriorityEntry>, EngineError> {
    serde_json::from_str(json).map_err(|_| invalid("The file choices couldn't be read"))
}

/// The download order for a set of `first` files: those first (by index), then every other
/// index in ascending order. Skipped files sit among the others, which is harmless because
/// librqbit never requests pieces of files that are not selected.
pub fn order_from_first(first: &[u32], file_count: usize) -> Vec<usize> {
    let mut firsts: Vec<usize> = first
        .iter()
        .map(|i| *i as usize)
        .filter(|i| *i < file_count)
        .collect();
    firsts.sort_unstable();
    firsts.dedup();
    let is_first: HashSet<usize> = firsts.iter().copied().collect();
    let mut order = firsts;
    order.extend((0..file_count).filter(|i| !is_first.contains(i)));
    order
}

/// Validates `entries` against the torrent and builds the include set and download order.
///
/// `valid` holds the indices of the real (non-padding) files; `file_count` is the length of
/// librqbit's full file list (padding files included). Files missing from `entries` count as `normal`.
/// Errors, all `INVALID_SOURCE`: an index that is not a file, an index listed twice, or nothing left to download.
pub fn plan_priorities(
    entries: &[FilePriorityEntry],
    valid: &[usize],
    file_count: usize,
) -> Result<PriorityPlan, EngineError> {
    let valid_set: HashSet<usize> = valid.iter().copied().collect();
    let mut chosen: HashMap<usize, FilePriority> = HashMap::with_capacity(entries.len());
    for e in entries {
        let idx = e.index as usize;
        if !valid_set.contains(&idx) {
            return Err(invalid("One of those files isn't in the torrent"));
        }
        if chosen.insert(idx, e.priority).is_some() {
            return Err(invalid("A file was listed twice"));
        }
    }
    let priority_of = |i: usize| chosen.get(&i).copied().unwrap_or(FilePriority::Normal);

    let included: HashSet<usize> = valid
        .iter()
        .copied()
        .filter(|i| priority_of(*i) != FilePriority::Skip)
        .collect();
    if included.is_empty() {
        return Err(invalid("Pick at least one file to download"));
    }
    let mut first: Vec<u32> = valid
        .iter()
        .copied()
        .filter(|i| priority_of(*i) == FilePriority::First)
        .map(|i| i as u32)
        .collect();
    first.sort_unstable();
    first.dedup();
    let order = order_from_first(&first, file_count);
    Ok(PriorityPlan {
        included,
        first,
        order,
    })
}

/// What `files[].priority` shows. `first` must be sorted ascending.
pub fn priority_of_file(index: u32, included: bool, first: &[u32]) -> FilePriority {
    if !included {
        FilePriority::Skip
    } else if first.binary_search(&index).is_ok() {
        FilePriority::First
    } else {
        FilePriority::Normal
    }
}

/// True when `new` differs from what librqbit currently downloads. `current` is
/// `ManagedTorrent::only_files()`, where `None` means every file.
pub fn include_set_changed(
    current: Option<&[usize]>,
    valid: &[usize],
    new: &HashSet<usize>,
) -> bool {
    let valid_set: HashSet<usize> = valid.iter().copied().collect();
    let current_set: HashSet<usize> = match current {
        None => valid_set,
        Some(c) => c.iter().copied().filter(|i| valid_set.contains(i)).collect(),
    };
    current_set != *new
}

/// Validates a "remove these files' data" request (`NATIVE_CONTRACT.md` section 14) and returns the
/// set of file indices to remove.
///
/// `valid` holds the indices of the real (non-padding) files; `current` is `ManagedTorrent::only_files()`
/// (`None` = every file). Errors, all `INVALID_SOURCE`: an empty list, an index that is not a file,
/// or a request that would leave no included file. Repeated indices are merged.
pub fn plan_removal(
    indices: &[u32],
    valid: &[usize],
    current: Option<&[usize]>,
) -> Result<HashSet<usize>, EngineError> {
    if indices.is_empty() {
        return Err(invalid("Pick at least one file to remove"));
    }
    let valid_set: HashSet<usize> = valid.iter().copied().collect();
    let mut remove: HashSet<usize> = HashSet::with_capacity(indices.len());
    for i in indices {
        let idx = *i as usize;
        if !valid_set.contains(&idx) {
            return Err(invalid("One of those files isn't in the torrent"));
        }
        remove.insert(idx);
    }
    let left = match current {
        None => valid_set.iter().filter(|i| !remove.contains(*i)).count(),
        Some(c) => c
            .iter()
            .filter(|i| valid_set.contains(*i) && !remove.contains(*i))
            .count(),
    };
    if left == 0 {
        return Err(invalid("Keep at least one file in the torrent"));
    }
    Ok(remove)
}

// ---- sidecar ---------------------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(default)]
struct PriorityRecord {
    first: Vec<u32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct PriorityFile {
    version: u32,
    torrents: BTreeMap<String, PriorityRecord>,
}

/// `maglev-priorities.json`, keyed by lower case info-hash.
pub struct PriorityStore {
    path: PathBuf,
    data: PriorityFile,
}

impl PriorityStore {
    /// A missing or unreadable file gives an empty store, never an error.
    pub fn load(session_dir: &Path) -> Self {
        let path = session_dir.join(PRIORITY_FILE);
        let mut data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<PriorityFile>(&b).ok())
            .unwrap_or_default();
        for rec in data.torrents.values_mut() {
            rec.first.sort_unstable();
            rec.first.dedup();
        }
        data.version = 1;
        Self { path, data }
    }

    /// The `first` indices (ascending) saved for a torrent, if any.
    pub fn get(&self, id: &str) -> Option<&[u32]> {
        self.data.torrents.get(id).map(|r| r.first.as_slice())
    }

    /// Replaces the entry. An empty list removes it, because "nothing first" is the default.
    pub fn set(&mut self, id: &str, mut first: Vec<u32>) {
        first.sort_unstable();
        first.dedup();
        if first.is_empty() {
            self.data.torrents.remove(id);
        } else {
            self.data.torrents.insert(id.to_string(), PriorityRecord { first });
        }
    }

    /// Returns true when an entry existed.
    pub fn remove(&mut self, id: &str) -> bool {
        self.data.torrents.remove(id).is_some()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&self.data).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

// ---- reannounce rate limit ---------------------------------------------------------------------------

/// One call per torrent per `min_interval`. Time is passed in so tests need no sleeping.
pub struct ReannounceLimiter {
    last: HashMap<String, Instant>,
    min_interval: Duration,
}

impl ReannounceLimiter {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            last: HashMap::new(),
            min_interval,
        }
    }

    /// Records a call at `now` and returns `Ok`, or returns `Err(seconds to wait)` (at least 1,
    /// rounded up) and records nothing.
    pub fn try_acquire(&mut self, id: &str, now: Instant) -> Result<(), u64> {
        if let Some(prev) = self.last.get(id) {
            let elapsed = now.saturating_duration_since(*prev);
            if elapsed < self.min_interval {
                let left = self.min_interval - elapsed;
                let secs = left.as_secs() + u64::from(left.subsec_nanos() > 0);
                return Err(secs.max(1));
            }
        }
        self.last.insert(id.to_string(), now);
        Ok(())
    }

    /// Forgets a call that did not actually happen (for example the torrent was not running).
    pub fn release(&mut self, id: &str) {
        self.last.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(index: u32, priority: FilePriority) -> FilePriorityEntry {
        FilePriorityEntry { index, priority }
    }

    #[test]
    fn order_puts_first_files_ahead_then_the_rest_by_index() {
        assert_eq!(order_from_first(&[3, 1], 5), vec![1, 3, 0, 2, 4]);
        assert_eq!(order_from_first(&[], 3), vec![0, 1, 2]);
        // out of range and repeated entries are ignored
        assert_eq!(order_from_first(&[9, 2, 2], 4), vec![2, 0, 1, 3]);
    }

    #[test]
    fn plan_splits_include_set_and_order() {
        use FilePriority::*;
        let entries = vec![e(0, Normal), e(1, Skip), e(2, First), e(3, Normal), e(4, First)];
        let plan = plan_priorities(&entries, &[0, 1, 2, 3, 4], 5).unwrap();
        assert_eq!(plan.included, HashSet::from([0, 2, 3, 4]));
        assert_eq!(plan.first, vec![2, 4]);
        assert_eq!(plan.order, vec![2, 4, 0, 1, 3]);
    }

    #[test]
    fn plan_ignores_padding_files_and_defaults_unlisted_to_normal() {
        // index 1 is a padding file: not valid, but it still counts in the file list length
        let entries = vec![e(2, FilePriority::First)];
        let plan = plan_priorities(&entries, &[0, 2], 3).unwrap();
        assert_eq!(plan.included, HashSet::from([0, 2]));
        assert_eq!(plan.order, vec![2, 0, 1]);
    }

    #[test]
    fn removal_checks_indices_and_keeps_one_included_file() {
        let valid = [0usize, 2, 3];
        // repeated indices merge
        assert_eq!(plan_removal(&[2, 2], &valid, None).unwrap(), HashSet::from([2]));
        // everything but one included file
        assert_eq!(
            plan_removal(&[0, 2], &valid, None).unwrap(),
            HashSet::from([0, 2])
        );
        // skipped files do not count as "left"
        let only: &[usize] = &[0, 2];
        assert_eq!(plan_removal(&[0], &valid, Some(only)).unwrap(), HashSet::from([0]));
        assert_eq!(
            plan_removal(&[0, 2], &valid, Some(only)).unwrap_err().code,
            ErrorCode::InvalidSource
        );
        assert_eq!(
            plan_removal(&[0, 2, 3], &valid, None).unwrap_err().code,
            ErrorCode::InvalidSource
        );
        // empty list, padding or unknown index
        assert!(plan_removal(&[], &valid, None).is_err());
        assert!(plan_removal(&[1], &valid, None).is_err());
        assert!(plan_removal(&[9], &valid, None).is_err());
    }

    #[test]
    fn plan_rejects_unknown_duplicate_and_all_skipped() {
        use FilePriority::*;
        let valid = [0usize, 1];
        let bad_index = plan_priorities(&[e(5, Normal)], &valid, 2).unwrap_err();
        assert_eq!(bad_index.code, ErrorCode::InvalidSource);
        let padding = plan_priorities(&[e(1, Normal)], &[0], 2).unwrap_err();
        assert_eq!(padding.code, ErrorCode::InvalidSource);
        let dup = plan_priorities(&[e(0, Normal), e(0, First)], &valid, 2).unwrap_err();
        assert_eq!(dup.code, ErrorCode::InvalidSource);
        let none = plan_priorities(&[e(0, Skip), e(1, Skip)], &valid, 2).unwrap_err();
        assert_eq!(none.code, ErrorCode::InvalidSource);
        let empty = plan_priorities(&[], &[], 0).unwrap_err();
        assert_eq!(empty.code, ErrorCode::InvalidSource);
    }

    #[test]
    fn parses_the_contract_json_and_rejects_junk() {
        let v = parse_priorities(
            r#"[{"index":0,"priority":"first"},{"index":1,"priority":"normal"},{"index":2,"priority":"skip"}]"#,
        )
        .unwrap();
        assert_eq!(
            v,
            vec![
                e(0, FilePriority::First),
                e(1, FilePriority::Normal),
                e(2, FilePriority::Skip)
            ]
        );
        assert_eq!(
            parse_priorities(r#"[{"index":0,"priority":"urgent"}]"#).unwrap_err().code,
            ErrorCode::InvalidSource
        );
        assert_eq!(parse_priorities("{").unwrap_err().code, ErrorCode::InvalidSource);
        assert_eq!(
            serde_json::to_string(&FilePriority::Skip).unwrap(),
            "\"skip\""
        );
    }

    #[test]
    fn detail_priority_is_derived_from_inclusion_and_first() {
        assert_eq!(priority_of_file(2, true, &[2, 4]), FilePriority::First);
        assert_eq!(priority_of_file(3, true, &[2, 4]), FilePriority::Normal);
        assert_eq!(priority_of_file(2, false, &[2, 4]), FilePriority::Skip);
    }

    #[test]
    fn include_change_detection() {
        let valid = [0usize, 1, 2];
        let all: HashSet<usize> = HashSet::from([0, 1, 2]);
        assert!(!include_set_changed(None, &valid, &all));
        assert!(!include_set_changed(Some(&[2, 1, 0]), &valid, &all));
        assert!(include_set_changed(Some(&[0, 1]), &valid, &all));
        // a padding index in librqbit's list does not count
        assert!(!include_set_changed(Some(&[0, 1, 2, 7]), &valid, &all));
        assert!(include_set_changed(None, &valid, &HashSet::from([1])));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-prio-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sidecar_round_trips_and_deletes() {
        let dir = temp_dir("rt");
        let mut s = PriorityStore::load(&dir);
        assert!(s.get("abc").is_none());
        s.set("abc", vec![4, 2, 2]);
        s.set("def", vec![1]);
        s.save().unwrap();
        assert!(!dir.join("maglev-priorities.json.tmp").exists());

        let mut s2 = PriorityStore::load(&dir);
        assert_eq!(s2.get("abc"), Some(&[2u32, 4][..]));
        assert_eq!(s2.get("def"), Some(&[1u32][..]));
        assert!(s2.remove("abc"));
        assert!(!s2.remove("abc"));
        s2.save().unwrap();

        let s3 = PriorityStore::load(&dir);
        assert!(s3.get("abc").is_none());
        assert_eq!(s3.get("def"), Some(&[1u32][..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sidecar_empty_first_list_removes_the_entry_and_junk_loads_empty() {
        let dir = temp_dir("junk");
        let mut s = PriorityStore::load(&dir);
        s.set("abc", vec![1]);
        s.set("abc", vec![]);
        assert!(s.get("abc").is_none());
        std::fs::write(dir.join(PRIORITY_FILE), b"{not json").unwrap();
        assert!(PriorityStore::load(&dir).get("abc").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reannounce_is_limited_to_once_per_minute_per_torrent() {
        let mut l = ReannounceLimiter::new(REANNOUNCE_MIN_INTERVAL);
        let t0 = Instant::now();
        assert_eq!(l.try_acquire("a", t0), Ok(()));
        assert_eq!(l.try_acquire("a", t0 + Duration::from_secs(10)), Err(50));
        // a refused call does not move the window
        assert_eq!(l.try_acquire("a", t0 + Duration::from_millis(59_500)), Err(1));
        // another torrent is independent
        assert_eq!(l.try_acquire("b", t0 + Duration::from_secs(10)), Ok(()));
        assert_eq!(l.try_acquire("a", t0 + Duration::from_secs(60)), Ok(()));
        l.release("a");
        assert_eq!(l.try_acquire("a", t0 + Duration::from_secs(61)), Ok(()));
    }
}
