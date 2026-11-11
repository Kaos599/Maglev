//! JSON shapes from `docs/NATIVE_CONTRACT.md` section 3.

use serde::{Deserialize, Serialize};

use crate::error::ErrorCode;
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
    pub eta_secs: i64,
    pub ratio: f64,
    pub seeding_secs: i64,
    pub added_at: i64,
    pub output_folder: String,
    pub error: Option<ErrorInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDetail {
    pub index: u32,
    pub path: String,
    pub length: u64,
    pub progress_bytes: u64,
    pub included: bool,
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
