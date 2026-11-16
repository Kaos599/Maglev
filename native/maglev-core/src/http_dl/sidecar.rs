//! The resume record next to a partial download: `<name>.maglev-dl.json` beside `<name>.part`.
//!
//! It holds what resuming needs: the link without credentials or query, the validator, the total size and, per
//! segment, how far it got. The file sits in a public folder, so signed tokens (the query) and request headers are
//! never written here (contract section 17). The `url` field stays for readers of older builds.

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

/// How far one track of a stream download (contract section 24.8) got: `done` segments (a contiguous prefix; the init
/// segment counts as the first) and the byte length of the part file after them. `total` is the segment count of the
/// playlist, so a changed playlist is noticed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrackSide {
    pub done: usize,
    pub bytes: u64,
    pub total: usize,
}

/// The stream part of a resume record: one entry per track (video then audio, or one).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct StreamSide {
    pub tracks: Vec<TrackSide>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sidecar {
    pub version: u32,
    pub url: String,
    pub name: String,
    pub total: Option<u64>,
    pub validator: Option<String>,
    pub segments: Vec<Segment>,
    /// Set by stream downloads only (`segments` then holds one placeholder range).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<StreamSide>,
}

/// `scheme://host[:port]/path`: no user name, password, query or fragment. A string that is not a URL is cut at the
/// first `?` or `#`.
pub fn safe_url(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) if u.host_str().is_some() => {
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!("{}://{}{}{}", u.scheme(), u.host_str().unwrap_or(""), port, u.path())
        }
        _ => url.split(['?', '#']).next().unwrap_or("").to_string(),
    }
}

impl Sidecar {
    /// A single segment covering the whole file (or an open-ended one when the size is unknown).
    pub fn new(url: &str, name: &str, total: Option<u64>, validator: Option<String>) -> Self {
        let end = total.map(|t| t.saturating_sub(1)).unwrap_or(u64::MAX);
        Sidecar {
            version: VERSION,
            url: safe_url(url),
            name: name.to_string(),
            total,
            validator,
            segments: vec![Segment { start: 0, end, pos: 0 }],
            stream: None,
        }
    }

    /// Bytes held by a stream record, summed over its tracks (0 for any other record).
    pub fn stream_held(&self) -> u64 {
        self.stream.as_ref().map(|s| s.tracks.iter().map(|t| t.bytes).sum()).unwrap_or(0)
    }

    /// Bytes already stored, summed over the segments.
    pub fn held(&self) -> u64 {
        held_of(&self.segments)
    }

    /// More than one range: a download split over several connections (contract section 17, Segments). A build
    /// from before splitting reads such a record as "no single offset" (`resume_offset` is 0) and starts over.
    pub fn is_split(&self) -> bool {
        self.segments.len() > 1
    }

    /// Bytes from offset 0 on that are all in the file, whatever the segment layout.
    pub fn contiguous_prefix(&self) -> u64 {
        contiguous_prefix(&self.segments)
    }

    /// Back to one segment that stands at the contiguous prefix (a split download that goes on over one connection).
    pub fn collapse_to_prefix(&mut self) {
        let pos = self.contiguous_prefix();
        let end = self.total.map(|t| t.saturating_sub(1)).unwrap_or(u64::MAX);
        self.segments = vec![Segment { start: 0, end, pos }];
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
        let mut s: Sidecar = serde_json::from_slice(&bytes).ok()?;
        // A record written by an older build may carry a signed query. Drop it; the next save removes it from disk.
        s.url = safe_url(&s.url);
        if s.version != VERSION || s.segments.is_empty() {
            return None;
        }
        Some(s)
    }
}

/// Bytes stored by a set of segments (each counted up to its own end).
pub fn held_of(segments: &[Segment]) -> u64 {
    segments
        .iter()
        .map(|s| s.pos.saturating_sub(s.start).min(s.end.saturating_sub(s.start).saturating_add(1)))
        .sum()
}

/// The length of the run of finished bytes that starts at offset 0. Segments are in file order: a finished one
/// extends the run, the first unfinished one ends it at its own position.
pub fn contiguous_prefix(segments: &[Segment]) -> u64 {
    let mut prefix = 0u64;
    for s in segments {
        if s.start != prefix {
            break;
        }
        let reached = s.pos.clamp(s.start, s.end.saturating_add(1));
        prefix = reached;
        if reached <= s.end {
            break;
        }
    }
    prefix
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
    fn the_stored_url_has_no_query_credentials_or_fragment() {
        let s = Sidecar::new("https://me:pw@x.test:8443/a/b.bin?token=SECRET&sig=1#frag", "b.bin", Some(1), None);
        assert_eq!(s.url, "https://x.test:8443/a/b.bin");
        let json = serde_json::to_string(&s).unwrap();
        for bad in ["SECRET", "token", "sig=", "pw", "frag", "me:"] {
            assert!(!json.contains(bad), "{bad}");
        }
        assert_eq!(safe_url("u?x=1"), "u");
    }

    #[test]
    fn an_old_record_with_a_query_is_cleaned_on_load() {
        let d = temp_dir("old");
        let p = sidecar_path(&d, "a.bin");
        std::fs::write(&p, br#"{"version":1,"url":"https://x.test/a.bin?token=SECRET","name":"a.bin","total":5,"validator":"\"v\"","segments":[{"start":0,"end":4,"pos":2}]}"#).unwrap();
        let s = Sidecar::load(&p).unwrap();
        assert_eq!(s.url, "https://x.test/a.bin");
        assert_eq!(s.resume_offset(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_stream_record_round_trips_and_an_old_one_has_none() {
        let d = temp_dir("stream");
        let p = sidecar_path(&d, "a.mp4");
        let mut s = Sidecar::new("https://x.test/i.m3u8?token=SECRET", "a.mp4", Some(9), None);
        s.stream = Some(StreamSide {
            tracks: vec![TrackSide { done: 3, bytes: 300, total: 10 }, TrackSide { done: 1, bytes: 50, total: 4 }],
        });
        s.save(&p).unwrap();
        let back = Sidecar::load(&p).unwrap();
        assert_eq!(back.stream_held(), 350);
        assert_eq!(back, s);
        assert!(!std::fs::read_to_string(&p).unwrap().contains("SECRET"));
        std::fs::write(&p, br#"{"version":1,"url":"u","name":"n","total":null,"validator":null,"segments":[{"start":0,"end":1,"pos":0}]}"#).unwrap();
        assert_eq!(Sidecar::load(&p).unwrap().stream, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    fn split_record() -> Sidecar {
        let mut s = Sidecar::new("https://x.test/a.bin", "a.bin", Some(1000), Some("\"v\"".into()));
        s.segments = vec![
            Segment { start: 0, end: 249, pos: 250 },
            Segment { start: 250, end: 499, pos: 300 },
            Segment { start: 500, end: 749, pos: 700 },
            Segment { start: 750, end: 999, pos: 750 },
        ];
        s
    }

    #[test]
    fn a_split_record_round_trips_with_every_offset() {
        let d = temp_dir("split");
        let p = sidecar_path(&d, "a.bin");
        let s = split_record();
        assert!(s.is_split());
        s.save(&p).unwrap();
        let back = Sidecar::load(&p).unwrap();
        assert_eq!(back, s);
        assert_eq!(back.held(), 250 + 50 + 200);
        // An older build has no single offset to resume from, so it starts over instead of trusting one.
        assert_eq!(back.resume_offset(), 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_old_single_segment_record_still_loads_and_is_not_split() {
        let d = temp_dir("oldsingle");
        let p = sidecar_path(&d, "a.bin");
        std::fs::write(&p, br#"{"version":1,"url":"https://x.test/a.bin","name":"a.bin","total":10,"validator":"\"v\"","segments":[{"start":0,"end":9,"pos":4}]}"#).unwrap();
        let s = Sidecar::load(&p).unwrap();
        assert!(!s.is_split());
        assert_eq!(s.resume_offset(), 4);
        assert_eq!(s.contiguous_prefix(), 4);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_contiguous_prefix_stops_at_the_first_unfinished_segment() {
        let s = split_record();
        // Segment 0 is done and segment 1 stands at 300; later segments do not extend the run.
        assert_eq!(s.contiguous_prefix(), 300);
        assert_eq!(contiguous_prefix(&[Segment { start: 0, end: 9, pos: 3 }, Segment { start: 10, end: 19, pos: 19 }]), 3);
        assert_eq!(contiguous_prefix(&[Segment { start: 0, end: 9, pos: 10 }, Segment { start: 10, end: 19, pos: 20 }]), 20);
        // A layout that does not start at 0 has no prefix.
        assert_eq!(contiguous_prefix(&[Segment { start: 5, end: 9, pos: 8 }]), 0);
    }

    #[test]
    fn collapsing_keeps_only_the_prefix_over_one_segment() {
        let mut s = split_record();
        s.collapse_to_prefix();
        assert_eq!(s.segments, vec![Segment { start: 0, end: 999, pos: 300 }]);
        assert_eq!(s.resume_offset(), 300);
        assert!(!s.is_split());
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
