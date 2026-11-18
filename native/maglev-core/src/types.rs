//! JSON shapes from `docs/NATIVE_CONTRACT.md` section 3.

use serde::{Deserialize, Serialize};

use crate::error::ErrorCode;
use crate::priority::{FilePriority, FilePriorityEntry};
use crate::scheduler::TorrentState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorInfo {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileEntry {
    pub index: u32,
    pub path: String,
    pub length: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Metadata {
    pub info_hash: String,
    pub name: String,
    pub total_bytes: u64,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub id: String,
    pub name: String,
    pub state: TorrentState,
    pub paused_by: Option<String>,
    /// True once every included piece is present.
    pub finished: bool,
    pub progress_bytes: u64,
    pub total_bytes: u64,
    /// Downloaded bytes of every file, skipped ones too: what deleting the files frees (section 18.4).
    pub held_bytes: u64,
    pub uploaded_bytes: u64,
    pub down_bps: u64,
    pub up_bps: u64,
    pub peers_live: u32,
    pub peers_seen: u32,
    /// Web seeds (BEP 19) configured for the torrent, from `url-list`, `ws=` or added later. 0 when none.
    pub web_seeds: u32,
    pub eta_secs: i64,
    pub ratio: f64,
    pub seeding_secs: i64,
    pub added_at: i64,
    pub output_folder: String,
    pub error: Option<ErrorInfo>,
    /// Per-torrent limits in bytes per second. 0 = none.
    pub down_limit_bps: u64,
    pub up_limit_bps: u64,
    /// 0 to 1 by bytes while the state is `MOVING`, otherwise null.
    pub move_progress: Option<f64>,
    /// Health tag (contract section 18.2), or null.
    pub health: Option<String>,
    /// Sum of the lengths of the included, non-padding files. 0 until the metadata is known.
    pub included_bytes: u64,
    /// File name (last path part) of the largest included, non-padding file (section 38), so the list can
    /// show the file's kind. Null until the metadata is known.
    pub main_file: Option<String>,
    /// Seconds a magnet has been looking for its metadata, or null once it has it (section 20).
    pub resolving_secs: Option<i64>,
    /// Seconds a torrent with metadata has waited with no peer and no byte (section 20.1), or null.
    pub stalled_secs: Option<i64>,
    /// "Resume anyway" (contract section 25): the rule pauses (Wi-Fi only, battery, charging, schedule,
    /// seeding on mobile data) do not apply to this torrent.
    pub allowed_anyway: bool,
    /// Seconds spent downloading, not counting pauses, queue, checking or seeding (section 34.1). 0 for items from before 0.26.
    pub active_secs: i64,
    /// Unix seconds when every wanted piece was first in. 0 until then, and 0 for items that were done before 0.26.
    pub finished_at: i64,
    /// Payload bytes this engine downloaded for the torrent, not counting bytes already on disk.
    pub session_bytes: u64,
    /// Of `session_bytes` plus `uploaded_bytes`: moved on an unmetered link.
    pub bytes_wifi: u64,
    /// The same on a metered link.
    pub bytes_mobile: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDetail {
    pub index: u32,
    pub path: String,
    pub length: u64,
    pub progress_bytes: u64,
    /// Size on disk of a skipped file, 0 when it is not there (and always 0 for an included file). A
    /// skipped file can still hold preallocated or partial data, which Remove deletes (section 14).
    pub on_disk_bytes: u64,
    pub included: bool,
    /// `first`, `normal` or `skip`. `included` is true for the first two.
    pub priority: FilePriority,
    /// Contiguous downloaded bytes from the start of the file (from the piece bitfield).
    pub stream_ready_bytes: u64,
    /// True when the last piece of the file is present.
    pub tail_ready: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PeerDetail {
    pub addr: String,
    pub client: String,
    pub down_bps: u64,
    pub up_bps: u64,
    pub progress: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrackerDetail {
    pub url: String,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Detail {
    pub snapshot: Snapshot,
    pub files: Vec<FileDetail>,
    pub peers: Vec<PeerDetail>,
    pub trackers: Vec<TrackerDetail>,
    pub piece_count: u32,
    pub piece_length: u32,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct AddOptions {
    pub only_files: Option<Vec<u32>>,
    pub paused: bool,
    pub output_folder: Option<String>,
    /// Stored only; librqbit has no sequential switch (streaming reads steer piece order instead).
    pub sequential: bool,
    /// Per-file choices from the add sheet. When present, this replaces `only_files`.
    pub file_priorities: Option<Vec<FilePriorityEntry>>,
    /// Per-torrent speed limits in bytes per second. Missing or 0 = no limit.
    pub down_limit_bps: Option<u64>,
    pub up_limit_bps: Option<u64>,
}

/// Folder name used under a custom output folder, so two multi-file torrents never mix files.
/// librqbit does the same for the default folder; it does not when `output_folder` is given.
pub fn subfolder_for(name: &str, file_count: usize) -> Option<String> {
    let n = name.trim();
    if file_count < 2
        || n.is_empty()
        || n == "."
        || n == ".."
        || n.contains('/')
        || n.contains('\\')
        || n.contains('\0')
    {
        return None;
    }
    Some(n.to_string())
}

/// True when a file of the torrent already sits under `dir` and this app cannot open it for writing.
/// On Android 11+ a file left by an earlier install (or after "Clear data") belongs to another UID, so
/// the open fails with EACCES even though the folder is visible and writable for new files.
fn has_unwritable_file(dir: &std::path::Path, rel_files: &[String], can_write: &dyn Fn(&std::path::Path) -> bool) -> bool {
    rel_files.iter().any(|rel| {
        let p = dir.join(rel);
        p.symlink_metadata().is_ok() && !can_write(&p)
    })
}

/// Picks the folder a torrent downloads into. Returns `dir` unless one of its files already exists and
/// cannot be opened for writing; then it returns the first free `parent/<name> (1)`, `parent/<name> (2)`, ...
/// whose files are all absent or writable. For a multi-file torrent `dir` is `parent/<name>`; for a single
/// file `dir` is `parent` itself and the numbered folder is a new subfolder of it. A file we own is kept, so a partial download still resumes.
/// Gives up after 99 tries and returns `dir`, which then fails with the usual PERMISSION error.
pub fn pick_writable_folder(
    dir: &std::path::Path,
    parent: &std::path::Path,
    name: &str,
    rel_files: &[String],
    can_write: &dyn Fn(&std::path::Path) -> bool,
) -> std::path::PathBuf {
    if !has_unwritable_file(dir, rel_files, can_write) {
        return dir.to_path_buf();
    }
    for n in 1..=99 {
        let cand = parent.join(format!("{name} ({n})"));
        if !has_unwritable_file(&cand, rel_files, can_write) {
            return cand;
        }
    }
    dir.to_path_buf()
}

/// Real write probe: opens the file for writing without creating or truncating it.
pub fn can_open_for_write(p: &std::path::Path) -> bool {
    std::fs::OpenOptions::new().write(true).open(p).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_options_defaults() {
        let o: AddOptions = serde_json::from_str("{}").unwrap();
        assert!(o.only_files.is_none() && !o.paused && !o.sequential && o.output_folder.is_none());
        let o: AddOptions = serde_json::from_str(
            r#"{"only_files":[0,2],"paused":true,"output_folder":"/x","sequential":true}"#,
        )
        .unwrap();
        assert_eq!(o.only_files, Some(vec![0, 2]));
        assert!(o.paused && o.sequential);
        assert!(o.file_priorities.is_none());
        let o: AddOptions = serde_json::from_str(
            r#"{"only_files":[0],"file_priorities":[{"index":0,"priority":"first"},{"index":1,"priority":"skip"}]}"#,
        )
        .unwrap();
        let p = o.file_priorities.unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].priority, FilePriority::First);
        assert!(o.down_limit_bps.is_none() && o.up_limit_bps.is_none());
        let o: AddOptions =
            serde_json::from_str(r#"{"down_limit_bps":1000000,"up_limit_bps":0}"#).unwrap();
        assert_eq!(o.down_limit_bps, Some(1_000_000));
        assert_eq!(o.up_limit_bps, Some(0));
    }

    #[test]
    fn subfolder_rules() {
        assert_eq!(subfolder_for("Show S01", 3).as_deref(), Some("Show S01"));
        assert_eq!(subfolder_for("movie.mkv", 1), None);
        assert_eq!(subfolder_for("../evil", 2), None);
        assert_eq!(subfolder_for("a/b", 2), None);
        assert_eq!(subfolder_for("", 2), None);
    }
    #[test]
    fn foreign_owned_file_moves_to_numbered_folder() {
        use std::path::{Path, PathBuf};
        let root = std::env::temp_dir().join(format!("maglev-pick-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("Sintel");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/a.srt"), b"x").unwrap();
        std::fs::create_dir_all(root.join("Sintel (1)/sub")).unwrap();
        std::fs::write(root.join("Sintel (1)/sub/a.srt"), b"x").unwrap();
        let files = vec!["sub/a.srt".to_string(), "b.mp4".to_string()];
        // Everything writable: keep the folder (resume).
        assert_eq!(pick_writable_folder(&dir, &root, "Sintel", &files, &|_| true), dir);
        // Both Sintel and Sintel (1) hold a foreign file, so the answer is "Sintel (2)".
        let deny_two = |p: &Path| {
            let s = p.to_string_lossy();
            !(s.contains("/Sintel/") || s.contains("/Sintel (1)/"))
        };
        assert_eq!(pick_writable_folder(&dir, &root, "Sintel", &files, &deny_two), root.join("Sintel (2)"));
        // Only the original is foreign: "Sintel (1)" has an owned file, which is fine.
        let deny_one = |p: &Path| !p.to_string_lossy().contains("/Sintel/");
        assert_eq!(pick_writable_folder(&dir, &root, "Sintel", &files, &deny_one), root.join("Sintel (1)"));
        // Single file: dir is the parent itself; a clash makes "parent/<name> (1)".
        let one = vec!["movie.mkv".to_string()];
        std::fs::write(root.join("movie.mkv"), b"x").unwrap();
        assert_eq!(pick_writable_folder(&root, &root, "movie.mkv", &one, &|_| false), root.join("movie.mkv (1)"));
        // A file that does not exist is never a conflict.
        let none: Vec<String> = vec!["missing.bin".into()];
        assert_eq!(pick_writable_folder(&dir, &root, "Sintel", &none, &|_| false), dir);
        // Real probe: an existing file we own is writable; a missing one is not.
        assert!(can_open_for_write(&dir.join("sub/a.srt")));
        assert!(!can_open_for_write(&PathBuf::from(dir.join("nope"))));
        let _ = std::fs::remove_dir_all(&root);
    }
}
