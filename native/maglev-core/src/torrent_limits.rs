//! Per-torrent speed limits (contract section 11.2).
//!
//! Pure helpers plus the JSON sidecar `<sessionDir>/maglev-limits.json`, keyed by info-hash.
//! The engine glue (applying a limit through the vendored `ManagedTorrent::set_ratelimits`) is in `engine.rs`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{EngineError, ErrorCode};
use crate::meta::write_atomic;

pub const LIMITS_FILE: &str = "maglev-limits.json";

/// Smallest limit that is actually applied. librqbit asks its limiter for one 16 KiB chunk at a
/// time, and a limiter whose per-second quota is smaller than that refuses the request outright,
/// which would drop the peer connection. Smaller non-zero values are raised to this.
pub const MIN_LIMIT_BPS: u64 = 16 * 1024;

/// `0` means no limit. Anything else is raised to `MIN_LIMIT_BPS` and capped at `u32::MAX`.
pub fn clamp_limit_bps(v: u64) -> u64 {
    if v == 0 {
        0
    } else {
        v.clamp(MIN_LIMIT_BPS, u64::from(u32::MAX))
    }
}

/// Bytes per second; `0` = no limit in that direction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TorrentLimits {
    pub down_bps: u64,
    pub up_bps: u64,
}

impl TorrentLimits {
    pub fn new(down_bps: u64, up_bps: u64) -> Self {
        Self { down_bps, up_bps }.clamped()
    }

    pub fn clamped(self) -> Self {
        Self {
            down_bps: clamp_limit_bps(self.down_bps),
            up_bps: clamp_limit_bps(self.up_bps),
        }
    }

    pub fn is_unlimited(&self) -> bool {
        self.down_bps == 0 && self.up_bps == 0
    }
}

/// Reads `{"down_bps":123,"up_bps":0}` and clamps both values. A missing key means 0.
pub fn parse_limits(json: &str) -> Result<TorrentLimits, EngineError> {
    serde_json::from_str::<TorrentLimits>(json)
        .map(TorrentLimits::clamped)
        .map_err(|_| {
            EngineError::new(
                ErrorCode::InvalidSource,
                "The speed limit couldn't be read",
            )
        })
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct LimitsFile {
    version: u32,
    torrents: BTreeMap<String, TorrentLimits>,
}

/// `maglev-limits.json`, keyed by lower case info-hash. Only torrents with a limit are stored.
pub struct LimitsStore {
    path: PathBuf,
    data: LimitsFile,
}

impl LimitsStore {
    /// A missing or unreadable file gives an empty store, never an error.
    pub fn load(session_dir: &Path) -> Self {
        let path = session_dir.join(LIMITS_FILE);
        let mut data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<LimitsFile>(&b).ok())
            .unwrap_or_default();
        for l in data.torrents.values_mut() {
            *l = l.clamped();
        }
        data.torrents.retain(|_, l| !l.is_unlimited());
        data.version = 1;
        Self { path, data }
    }

    pub fn get(&self, id: &str) -> Option<TorrentLimits> {
        self.data.torrents.get(id).copied()
    }

    /// Replaces the entry. "No limit" in both directions removes it, because that is the default.
    pub fn set(&mut self, id: &str, limits: TorrentLimits) {
        let limits = limits.clamped();
        if limits.is_unlimited() {
            self.data.torrents.remove(id);
        } else {
            self.data.torrents.insert(id.to_string(), limits);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-limits-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn clamping_keeps_zero_raises_tiny_and_caps_huge() {
        assert_eq!(clamp_limit_bps(0), 0);
        assert_eq!(clamp_limit_bps(1), MIN_LIMIT_BPS);
        assert_eq!(clamp_limit_bps(MIN_LIMIT_BPS - 1), MIN_LIMIT_BPS);
        assert_eq!(clamp_limit_bps(2_000_000), 2_000_000);
        assert_eq!(clamp_limit_bps(u64::from(u32::MAX) + 1), u64::from(u32::MAX));
        assert_eq!(clamp_limit_bps(u64::MAX), u64::from(u32::MAX));
    }

    #[test]
    fn parses_the_contract_json() {
        let l = parse_limits(r#"{"down_bps":2097152,"up_bps":0}"#).unwrap();
        assert_eq!(l, TorrentLimits { down_bps: 2_097_152, up_bps: 0 });
        // missing keys are 0, huge values are clamped
        let l = parse_limits(r#"{"up_bps":99999999999}"#).unwrap();
        assert_eq!(l, TorrentLimits { down_bps: 0, up_bps: u64::from(u32::MAX) });
        assert!(parse_limits("{}").unwrap().is_unlimited());
    }

    #[test]
    fn rejects_junk_and_negative_values() {
        assert_eq!(parse_limits("nope").unwrap_err().code, ErrorCode::InvalidSource);
        assert_eq!(
            parse_limits(r#"{"down_bps":-5}"#).unwrap_err().code,
            ErrorCode::InvalidSource
        );
        assert_eq!(
            parse_limits(r#"{"down_bps":"fast"}"#).unwrap_err().code,
            ErrorCode::InvalidSource
        );
    }

    #[test]
    fn sidecar_round_trips_and_unlimited_removes_the_entry() {
        let dir = temp_dir("rt");
        let mut s = LimitsStore::load(&dir);
        assert!(s.get("abc").is_none());
        s.set("abc", TorrentLimits::new(500_000, 0));
        s.set("def", TorrentLimits::new(0, 100));
        s.set("none", TorrentLimits::new(0, 0));
        s.save().unwrap();
        assert!(!dir.join("maglev-limits.json.tmp").exists());

        let mut s2 = LimitsStore::load(&dir);
        assert_eq!(s2.get("abc"), Some(TorrentLimits { down_bps: 500_000, up_bps: 0 }));
        // 100 was raised to the minimum before it was stored
        assert_eq!(s2.get("def"), Some(TorrentLimits { down_bps: 0, up_bps: MIN_LIMIT_BPS }));
        assert!(s2.get("none").is_none());
        s2.set("abc", TorrentLimits::default());
        assert!(s2.get("abc").is_none());
        assert!(s2.remove("def"));
        assert!(!s2.remove("def"));
        s2.save().unwrap();
        let s3 = LimitsStore::load(&dir);
        assert!(s3.get("abc").is_none() && s3.get("def").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn junk_sidecar_loads_empty() {
        let dir = temp_dir("junk");
        std::fs::write(dir.join(LIMITS_FILE), b"{not json").unwrap();
        assert!(LimitsStore::load(&dir).get("abc").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
