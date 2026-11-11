//! The resume record next to a partial download: `<name>.maglev-dl.json` beside `<name>.part`.
//!
//! It holds what resuming needs: the final URL (without credentials), the validator, the total size and, per
//! segment, how far it got. Credentials and request headers are never written here (contract section 17).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::meta::write_atomic;

pub const SIDECAR_SUFFIX: &str = ".maglev-dl.json";
pub const PART_SUFFIX: &str = ".part";
const VERSION: u32 = 1;

/// One byte range of the file. `pos` is the next byte to fetch; the range is done when `pos > end`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub start: u64,
    /// Inclusive end offset.
    pub end: u64,
    pub pos: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sidecar {
    pub version: u32,
    pub url: String,
    pub name: String,
    pub total: Option<u64>,
    pub validator: Option<String>,
    pub segments: Vec<Segment>,
}

impl Sidecar {
    /// A single segment covering the whole file (or an open-ended one when the size is unknown).
    pub fn new(url: &str, name: &str, total: Option<u64>, validator: Option<String>) -> Self {
        let end = total.map(|t| t.saturating_sub(1)).unwrap_or(u64::MAX);
        Sidecar {
            version: VERSION,
            url: url.to_string(),
            name: name.to_string(),
            total,
            validator,
            segments: vec![Segment { start: 0, end, pos: 0 }],
        }
    }

    /// Bytes already stored, summed over the segments.
    pub fn held(&self) -> u64 {
        self.segments
            .iter()
            .map(|s| s.pos.saturating_sub(s.start).min(s.end.saturating_sub(s.start).saturating_add(1)))
            .sum()
    }

    /// The single-segment resume offset, or 0 when the layout is anything else.
    pub fn resume_offset(&self) -> u64 {
        match self.segments.as_slice() {
            [s] if s.start == 0 => s.pos,
            _ => 0,
        }
    }

    pub fn set_single_pos(&mut self, pos: u64) {
        if let Some(s) = self.segments.first_mut() {
            s.pos = pos;
        }
    }

    pub fn reset(&mut self) {
        for s in &mut self.segments {
            s.pos = s.start;
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        write_atomic(path, &bytes)
    }

    /// `None` when the file is missing, unreadable, from another version or not a valid record.
    pub fn load(path: &Path) -> Option<Sidecar> {
        let bytes = std::fs::read(path).ok()?;
        let s: Sidecar = serde_json::from_slice(&bytes).ok()?;
        if s.version != VERSION || s.segments.is_empty() {
            return None;
        }
        Some(s)
    }
}

pub fn part_path(folder: &Path, name: &str) -> PathBuf {
    folder.join(format!("{name}{PART_SUFFIX}"))
}

pub fn sidecar_path(folder: &Path, name: &str) -> PathBuf {
    folder.join(format!("{name}{SIDECAR_SUFFIX}"))
}

pub fn final_path(folder: &Path, name: &str) -> PathBuf {
    folder.join(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-sidecar-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn new_sidecar_has_one_segment_over_the_whole_file() {
        let s = Sidecar::new("https://x.test/a.bin", "a.bin", Some(1000), Some("\"v\"".into()));
        assert_eq!(s.segments, vec![Segment { start: 0, end: 999, pos: 0 }]);
        assert_eq!(s.held(), 0);
        assert_eq!(s.resume_offset(), 0);
    }

    #[test]
    fn unknown_size_has_an_open_segment() {
        let s = Sidecar::new("https://x.test/a.bin", "a.bin", None, None);
        assert_eq!(s.segments[0].end, u64::MAX);
        assert_eq!(s.held(), 0);
    }

    #[test]
    fn held_follows_the_position() {
        let mut s = Sidecar::new("u", "n", Some(1000), None);
        s.set_single_pos(400);
        assert_eq!(s.held(), 400);
        assert_eq!(s.resume_offset(), 400);
        s.set_single_pos(1000);
        assert_eq!(s.held(), 1000);
    }

    #[test]
    fn held_sums_several_segments() {
        let mut s = Sidecar::new("u", "n", Some(1000), None);
        s.segments = vec![
            Segment { start: 0, end: 499, pos: 100 },
            Segment { start: 500, end: 999, pos: 700 },
        ];
        assert_eq!(s.held(), 300);
        // A segment layout other than one is not resumed by the single-connection driver.
        assert_eq!(s.resume_offset(), 0);
    }

    #[test]
    fn reset_rewinds_every_segment() {
        let mut s = Sidecar::new("u", "n", Some(10), None);
        s.set_single_pos(7);
        s.reset();
        assert_eq!(s.held(), 0);
    }

    #[test]
    fn round_trips_through_disk() {
        let d = temp_dir("rt");
        let p = sidecar_path(&d, "a.bin");
        let mut s = Sidecar::new("https://x.test/a.bin", "a.bin", Some(5000), Some("\"v1\"".into()));
        s.set_single_pos(1234);
        s.save(&p).unwrap();
        assert_eq!(Sidecar::load(&p), Some(s));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn corrupt_or_missing_files_load_as_none() {
        let d = temp_dir("bad");
        let p = sidecar_path(&d, "a.bin");
        assert_eq!(Sidecar::load(&p), None);
        std::fs::write(&p, b"{not json").unwrap();
        assert_eq!(Sidecar::load(&p), None);
        std::fs::write(&p, br#"{"version":99,"url":"u","name":"n","total":null,"validator":null,"segments":[{"start":0,"end":1,"pos":0}]}"#).unwrap();
        assert_eq!(Sidecar::load(&p), None);
        std::fs::write(&p, br#"{"version":1,"url":"u","name":"n","total":null,"validator":null,"segments":[]}"#).unwrap();
        assert_eq!(Sidecar::load(&p), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn paths_sit_beside_the_final_file() {
        let d = Path::new("/dl");
        assert_eq!(part_path(d, "a.bin"), PathBuf::from("/dl/a.bin.part"));
        assert_eq!(sidecar_path(d, "a.bin"), PathBuf::from("/dl/a.bin.maglev-dl.json"));
        assert_eq!(final_path(d, "a.bin"), PathBuf::from("/dl/a.bin"));
    }

    #[test]
    fn the_record_has_no_credential_fields() {
        let s = Sidecar::new("https://x.test/a.bin", "a.bin", Some(1), None);
        let json = serde_json::to_string(&s).unwrap();
        for bad in ["cookie", "authorization", "referer", "headers", "password"] {
            assert!(!json.to_ascii_lowercase().contains(bad));
        }
    }
}
