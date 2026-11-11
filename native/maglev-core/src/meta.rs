//! Maglev-side torrent metadata, persisted as `sessionDir/maglev_meta.json`.
//!
//! librqbit persists torrents, fastresume bitfields and its own paused flag. This file adds what
//! librqbit does not know: who paused a torrent, queue membership, `added_at`, seeding time,
//! cumulative upload, pending magnet links, the active governance blocks and the last applied config.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::NativeConfig;
use crate::types::ErrorInfo;

pub const META_FILE: &str = "maglev_meta.json";

/// A magnet link that is still looking for its metadata. Survives a restart.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingAdd {
    pub source: String,
    pub name: Option<String>,
    pub only_files: Option<Vec<u32>>,
    pub output_folder: Option<String>,
    pub sequential: bool,
    /// Set when the lookup failed. Cleared on the next start.
    #[serde(default)]
    pub error: Option<ErrorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct TorrentMeta {
    pub added_at: i64,
    pub paused_by: Option<String>,
    pub queued: bool,
    pub seeding_secs: i64,
    pub uploaded_base: u64,
    pub last_uploaded_seen: u64,
    /// Highest verified byte count seen; used to tell "never started" from "files were deleted".
    pub max_progress_bytes: u64,
    pub limits_waived: bool,
    pub sequential: bool,
    pub last_error: Option<ErrorInfo>,
    pub pending: Option<PendingAdd>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MetaFile {
    pub version: u32,
    pub torrents: BTreeMap<String, TorrentMeta>,
    /// Governance reasons that currently block transfers.
    pub blocked: Vec<String>,
    pub config: Option<NativeConfig>,
}

pub struct MetaStore {
    path: PathBuf,
    pub data: MetaFile,
    dirty: bool,
}

impl MetaStore {
    /// Loads the file. A missing or unreadable file gives an empty store, never an error:
    /// librqbit's own persistence still restores the torrents.
    pub fn load(session_dir: &Path) -> Self {
        let path = session_dir.join(META_FILE);
        let data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<MetaFile>(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            data,
            dirty: false,
        }
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn get(&self, id: &str) -> Option<&TorrentMeta> {
        self.data.torrents.get(id)
    }

    /// Mutable access that does not mark the store dirty; call `mark_dirty` after a real change.
    pub fn get_mut(&mut self, id: &str) -> Option<&mut TorrentMeta> {
        self.data.torrents.get_mut(id)
    }

    /// Applies `f` to an entry and marks the store dirty.
    pub fn update<R>(&mut self, id: &str, f: impl FnOnce(&mut TorrentMeta) -> R) -> Option<R> {
        let r = self.data.torrents.get_mut(id).map(f);
        if r.is_some() {
            self.dirty = true;
        }
        r
    }

    pub fn insert(&mut self, id: &str, meta: TorrentMeta) {
        self.dirty = true;
        self.data.torrents.insert(id.to_string(), meta);
    }

    pub fn remove(&mut self, id: &str) -> Option<TorrentMeta> {
        self.dirty = true;
        self.data.torrents.remove(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.data.torrents.contains_key(id)
    }

    /// Atomic write: temp file, flush to disk, rename over the real file.
    pub fn save(&mut self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&self.data).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)?;
        self.dirty = false;
        Ok(())
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-meta-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = temp_dir("rt");
        let mut s = MetaStore::load(&dir);
        assert!(s.data.torrents.is_empty());
        s.insert(
            "abc",
            TorrentMeta {
                added_at: 42,
                paused_by: Some("fgs_timeout".into()),
                queued: true,
                ..Default::default()
            },
        );
        s.data.blocked = vec!["wifi_only".into()];
        let mut cfg = NativeConfig::default();
        cfg.listen_port = 7000;
        s.data.config = Some(cfg);
        s.save().unwrap();
        assert!(!s.is_dirty());
        assert!(!dir.join("maglev_meta.json.tmp").exists());

        let s2 = MetaStore::load(&dir);
        let m = s2.get("abc").unwrap();
        assert_eq!(m.added_at, 42);
        assert_eq!(m.paused_by.as_deref(), Some("fgs_timeout"));
        assert!(m.queued);
        assert_eq!(s2.data.blocked, vec!["wifi_only".to_string()]);
        assert_eq!(s2.data.config.as_ref().unwrap().listen_port, 7000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_gives_empty_store() {
        let dir = temp_dir("bad");
        std::fs::write(dir.join(META_FILE), b"{not json").unwrap();
        let s = MetaStore::load(&dir);
        assert!(s.data.torrents.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_fields_default() {
        let dir = temp_dir("old");
        std::fs::write(
            dir.join(META_FILE),
            br#"{"torrents":{"x":{"added_at":5}}}"#,
        )
        .unwrap();
        let s = MetaStore::load(&dir);
        let m = s.get("x").unwrap();
        assert_eq!(m.added_at, 5);
        assert!(m.paused_by.is_none() && !m.queued);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
