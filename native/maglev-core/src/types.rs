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
    /// Seconds a magnet has been looking for its metadata, or null once it has it (section 20).
    pub resolving_secs: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDetail {
    pub index: u32,
    pub path: String,
    pub length: u64,
    pub progress_bytes: u64,
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
}
