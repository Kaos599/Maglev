//! Files changed outside Maglev (contract section 18.3, SM-32). Pure logic, no session.
//!
//! Two parts:
//! - the sidecar `maglev-filehealth.json`: per torrent, the size and modified time of every included
//!   file, taken when the torrent finishes and after Remove file or Move;
//! - the comparison of what is on disk against what the torrent had: which files are `ok`, `missing`
//!   or `changed`, and the health tag the whole torrent gets from that.
//!
//! The engine gathers the facts (`FileProbe`) and applies the answer; nothing here touches librqbit.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::meta::write_atomic;
use crate::scheduler::{HEALTH_FILES_CHANGED, HEALTH_FILES_MISSING};

pub const SIDECAR_FILE: &str = "maglev-filehealth.json";

/// Size and modified time (milliseconds since the Unix epoch) of one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStamp {
    pub size: u64,
    pub mtime_ms: i64,
}

/// What a look at one path found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnDisk {
    Present(FileStamp),
    /// The path does not exist.
    Absent,
    /// The path could not be read for another reason (permissions, an unmounted volume). Never reported.
    Unknown,
}

/// The state of one file, as `nativeFileHealth` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileState {
    Ok,
    Missing,
    Changed,
}

/// Everything the comparison needs to know about one file of a torrent.
#[derive(Debug, Clone)]
pub struct FileProbe {
    pub index: u32,
    /// In the include set. A skipped file is never checked.
    pub included: bool,
    /// BEP 47 padding file: no file on disk.
    pub padding: bool,
    /// Some of the file's bytes are verified, so a missing file means lost data.
    pub had_data: bool,
    pub on_disk: OnDisk,
}

/// The state of one file. `finished` enables the size and time comparison; `snap` is the stamp taken
/// when the torrent finished (None when there is no snapshot yet, which never counts as a change).
pub fn classify_file(p: &FileProbe, finished: bool, snap: Option<&FileStamp>) -> FileState {
    if p.padding || !p.included {
        return FileState::Ok;
    }
    match p.on_disk {
        OnDisk::Unknown => FileState::Ok,
        OnDisk::Absent => {
            if p.had_data {
                FileState::Missing
            } else {
                FileState::Ok
            }
        }
        OnDisk::Present(now) => match snap {
            Some(s) if finished && *s != now => FileState::Changed,
            _ => FileState::Ok,
        },
    }
}

/// `(index, state)` for every included, non-padding file.
pub fn classify_files(
    probes: &[FileProbe],
    finished: bool,
    snapshot: Option<&BTreeMap<u32, FileStamp>>,
) -> Vec<(u32, FileState)> {
    probes
        .iter()
        .filter(|p| p.included && !p.padding)
        .map(|p| {
            let snap = snapshot.and_then(|s| s.get(&p.index));
            (p.index, classify_file(p, finished, snap))
        })
        .collect()
}

/// The health tag a set of file states gives the torrent. Missing wins over changed.
pub fn rollup(states: &[(u32, FileState)]) -> Option<&'static str> {
    if states.iter().any(|(_, s)| *s == FileState::Missing) {
        Some(HEALTH_FILES_MISSING)
    } else if states.iter().any(|(_, s)| *s == FileState::Changed) {
        Some(HEALTH_FILES_CHANGED)
    } else {
        None
    }
}

/// True when the scan may look at a torrent whose health is `current`. Storage and no-peers tags
/// belong to other owners and are left alone.
pub fn scan_owns(current: Option<&str>) -> bool {
    matches!(
        current,
        None | Some(HEALTH_FILES_MISSING) | Some(HEALTH_FILES_CHANGED)
    )
}

/// What a scan changes in a torrent's health tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealthChange {
    /// Nothing to do.
    Keep,
    /// Put this tag on the torrent.
    Set(&'static str),
    /// `files_missing` is over: every missing file is back. The caller checks the files, then clears.
    ClearMissing,
    /// `files_changed` is over: the files match the snapshot again.
    ClearChanged,
}

pub fn health_change(current: Option<&str>, found: Option<&'static str>) -> HealthChange {
    match (current, found) {
        (Some(c), Some(f)) if c == f => HealthChange::Keep,
        (_, Some(f)) => HealthChange::Set(f),
        (Some(HEALTH_FILES_MISSING), None) => HealthChange::ClearMissing,
        (Some(HEALTH_FILES_CHANGED), None) => HealthChange::ClearChanged,
        _ => HealthChange::Keep,
    }
}

/// True when the folder can be scanned: it, or its nearest existing parent, can be listed. A folder
/// that exists but can't be read (permissions, a volume that is gone) gives false, and the torrent is
/// skipped rather than reported. A folder that was deleted is fine: its files are then missing.
pub fn folder_scannable(folder: &Path) -> bool {
    let mut dir: Option<&Path> = Some(folder);
    while let Some(d) = dir {
        match std::fs::read_dir(d) {
            Ok(_) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => dir = d.parent(),
            Err(_) => return false,
        }
    }
    false
}

/// Looks at one path.
pub fn stat_path(path: &Path) -> OnDisk {
    match std::fs::metadata(path) {
        Ok(md) if md.is_file() => {
            let mtime_ms = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            OnDisk::Present(FileStamp {
                size: md.len(),
                mtime_ms,
            })
        }
        Ok(_) => OnDisk::Unknown,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => OnDisk::Absent,
        Err(_) => OnDisk::Unknown,
    }
}

/// One torrent's entry in the sidecar.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TorrentSnapshot {
    /// File index (as a string, JSON keys are strings) to its stamp.
    pub files: BTreeMap<String, FileStamp>,
}

impl TorrentSnapshot {
    pub fn by_index(&self) -> BTreeMap<u32, FileStamp> {
        self.files
            .iter()
            .filter_map(|(k, v)| k.parse::<u32>().ok().map(|i| (i, *v)))
            .collect()
    }
}

/// The sidecar file `maglev-filehealth.json`. A missing or unreadable file is an empty store.
pub struct HealthStore {
    path: PathBuf,
    map: BTreeMap<String, TorrentSnapshot>,
}

impl HealthStore {
    pub fn load(session_dir: &Path) -> Self {
        let path = session_dir.join(SIDECAR_FILE);
        let map = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<BTreeMap<String, TorrentSnapshot>>(&b).ok())
            .unwrap_or_default();
        Self { path, map }
    }

    pub fn has(&self, id: &str) -> bool {
        self.map.contains_key(id)
    }

    pub fn get(&self, id: &str) -> Option<&TorrentSnapshot> {
        self.map.get(id)
    }

    /// Stores the stamps of a torrent, replacing any earlier ones.
    pub fn set(&mut self, id: &str, stamps: &BTreeMap<u32, FileStamp>) {
        let files = stamps.iter().map(|(i, s)| (i.to_string(), *s)).collect();
        self.map.insert(id.to_string(), TorrentSnapshot { files });
    }

    pub fn remove(&mut self, id: &str) -> bool {
        self.map.remove(id).is_some()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&self.map).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(size: u64, mtime_ms: i64) -> FileStamp {
        FileStamp { size, mtime_ms }
    }

    fn probe(index: u32, on_disk: OnDisk) -> FileProbe {
        FileProbe {
            index,
            included: true,
            padding: false,
            had_data: true,
            on_disk,
        }
    }

    #[test]
    fn absent_file_with_data_is_missing_without_data_is_fine() {
        let p = probe(0, OnDisk::Absent);
        assert_eq!(classify_file(&p, false, None), FileState::Missing);
        let mut empty = probe(0, OnDisk::Absent);
        empty.had_data = false;
        assert_eq!(classify_file(&empty, false, None), FileState::Ok);
    }

    #[test]
    fn skipped_files_are_never_reported() {
        let mut p = probe(3, OnDisk::Absent);
        p.included = false;
        assert_eq!(classify_file(&p, true, Some(&stamp(1, 1))), FileState::Ok);
        // And they are left out of the per-file list entirely.
        let list = classify_files(&[p, probe(1, OnDisk::Present(stamp(5, 5)))], false, None);
        assert_eq!(list, vec![(1, FileState::Ok)]);
    }

    #[test]
    fn padding_files_are_never_reported() {
        let mut p = probe(2, OnDisk::Absent);
        p.padding = true;
        assert_eq!(classify_file(&p, true, None), FileState::Ok);
        assert!(classify_files(&[p], true, None).is_empty());
    }

    #[test]
    fn unreadable_files_are_never_reported() {
        let p = probe(0, OnDisk::Unknown);
        assert_eq!(classify_file(&p, true, Some(&stamp(1, 1))), FileState::Ok);
    }

    #[test]
    fn changed_needs_a_finished_torrent_and_a_snapshot() {
        let p = probe(0, OnDisk::Present(stamp(10, 200)));
        let snap = stamp(10, 100);
        assert_eq!(classify_file(&p, true, Some(&snap)), FileState::Changed);
        // Same size and time: fine. Size differs alone: changed. Time differs alone: changed.
        assert_eq!(classify_file(&p, true, Some(&stamp(10, 200))), FileState::Ok);
        assert_eq!(classify_file(&p, true, Some(&stamp(11, 200))), FileState::Changed);
        // Still downloading: files grow, so nothing is compared.
        assert_eq!(classify_file(&p, false, Some(&snap)), FileState::Ok);
        // No snapshot yet: nothing to compare with.
        assert_eq!(classify_file(&p, true, None), FileState::Ok);
    }

    #[test]
    fn rollup_prefers_missing_over_changed() {
        assert_eq!(rollup(&[]), None);
        assert_eq!(rollup(&[(0, FileState::Ok)]), None);
        assert_eq!(
            rollup(&[(0, FileState::Changed), (1, FileState::Ok)]),
            Some("files_changed")
        );
        assert_eq!(
            rollup(&[(0, FileState::Changed), (1, FileState::Missing)]),
            Some("files_missing")
        );
    }

    #[test]
    fn health_change_table() {
        use HealthChange as C;
        assert_eq!(health_change(None, None), C::Keep);
        assert_eq!(health_change(None, Some("files_missing")), C::Set("files_missing"));
        assert_eq!(health_change(Some("files_missing"), Some("files_missing")), C::Keep);
        assert_eq!(health_change(Some("files_missing"), None), C::ClearMissing);
        assert_eq!(health_change(Some("files_changed"), None), C::ClearChanged);
        assert_eq!(
            health_change(Some("files_changed"), Some("files_missing")),
            C::Set("files_missing")
        );
        // Tags owned by other parts are not touched by a clean scan.
        assert_eq!(health_change(Some("storage_full"), None), C::Keep);
        assert_eq!(health_change(Some("no_peers"), None), C::Keep);
    }

    #[test]
    fn scan_leaves_foreign_health_tags_alone() {
        assert!(scan_owns(None));
        assert!(scan_owns(Some("files_missing")));
        assert!(scan_owns(Some("files_changed")));
        assert!(!scan_owns(Some("storage_full")));
        assert!(!scan_owns(Some("storage_unavailable")));
        assert!(!scan_owns(Some("no_peers")));
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-fh-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn sidecar_round_trips_through_disk() {
        let dir = temp_dir("rt");
        let mut s = HealthStore::load(&dir);
        assert!(!s.has("abc"));
        let mut stamps = BTreeMap::new();
        stamps.insert(0u32, stamp(100, 1_700_000_000_000));
        stamps.insert(2u32, stamp(7, -5));
        s.set("abc", &stamps);
        s.save().unwrap();
        assert!(!dir.join("maglev-filehealth.json.tmp").exists());

        let raw = std::fs::read_to_string(dir.join(SIDECAR_FILE)).unwrap();
        // The shape in the contract: id -> files -> index -> {size, mtime_ms}.
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["abc"]["files"]["0"]["size"], 100);
        assert_eq!(v["abc"]["files"]["2"]["mtime_ms"], -5);

        let s2 = HealthStore::load(&dir);
        assert_eq!(s2.get("abc").unwrap().by_index(), stamps);
        let mut s3 = HealthStore::load(&dir);
        assert!(s3.remove("abc"));
        assert!(!s3.remove("abc"));
        s3.save().unwrap();
        assert!(!HealthStore::load(&dir).has("abc"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_sidecar_is_an_empty_store() {
        let dir = temp_dir("bad");
        std::fs::write(dir.join(SIDECAR_FILE), b"{nope").unwrap();
        assert!(!HealthStore::load(&dir).has("x"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stat_path_tells_present_absent() {
        let dir = temp_dir("stat");
        let f = dir.join("a.bin");
        assert_eq!(stat_path(&f), OnDisk::Absent);
        std::fs::write(&f, b"12345").unwrap();
        match stat_path(&f) {
            OnDisk::Present(s) => assert_eq!(s.size, 5),
            other => panic!("expected a stamp, got {other:?}"),
        }
        // A folder where a file should be is not a file: unknown, never reported.
        assert_eq!(stat_path(&dir), OnDisk::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleted_folder_is_scannable_when_its_parent_is() {
        let dir = temp_dir("scan");
        assert!(folder_scannable(&dir));
        assert!(folder_scannable(&dir.join("deleted").join("deeper")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
