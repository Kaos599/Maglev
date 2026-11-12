//! Pure decisions for stream downloads: what the probe reports, which variant a download uses, file names, size
//! estimates and where a stopped download continues. No IO.

use serde::Serialize;

use super::dash::{Dash, DashRep};
use super::hls::{AudioEntry, Master, Variant};
use super::{MediaPlan, StreamError, StreamKind, StreamSpec, TrackRole, MAX_SEGMENTS};
use crate::http_dl::sidecar::TrackSide;

/// The id of the only variant of a media playlist opened on its own.
pub const SINGLE_VARIANT_ID: &str = "v0";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VariantOut {
    pub id: String,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub bandwidth: u64,
    pub codecs: Option<String>,
    pub est_bytes: Option<u64>,
    /// `muxed` (audio inside), `separate` (its own track, joined at the end) or `none`.
    pub audio: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AudioOut {
    pub id: String,
    pub lang: Option<String>,
    pub name: Option<String>,
    pub bandwidth: Option<u64>,
}

/// The answer of `nativeProbeStream` (snake_case here; the module turns it into camelCase for JS).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StreamProbe {
    pub kind: StreamKind,
    pub title: Option<String>,
    pub duration_sec: f64,
    pub variants: Vec<VariantOut>,
    pub audio_tracks: Vec<AudioOut>,
}

/// `bandwidth / 8 x duration`, or `None` when either is unknown.
pub fn est_bytes(bandwidth_bps: u64, duration_sec: f64) -> Option<u64> {
    if bandwidth_bps == 0 || !(duration_sec > 0.0) {
        return None;
    }
    Some((bandwidth_bps as f64 / 8.0 * duration_sec) as u64)
}

/// Height first (tallest on top, unknown last), then bandwidth. Stable.
pub fn sort_variants(v: &mut [VariantOut]) {
    v.sort_by(|a, b| b.height.cmp(&a.height).then(b.bandwidth.cmp(&a.bandwidth)));
}

/// More than 20,000 segments in a track is not supported.
pub fn check_count(n: usize) -> Result<(), StreamError> {
    if n > MAX_SEGMENTS {
        Err(StreamError::Unsupported)
    } else {
        Ok(())
    }
}

fn has_audio_codec(codecs: &str) -> bool {
    let c = codecs.to_ascii_lowercase();
    ["mp4a", "ac-3", "ec-3", "opus", "flac", "mp3", "vorbis"].iter().any(|p| c.contains(p))
}

// ---- HLS ----

/// The variant a probe reads a media playlist from: tallest, then highest bandwidth.
pub fn best_hls_variant(m: &Master) -> Option<&Variant> {
    m.variants.iter().max_by_key(|v| (v.height.unwrap_or(0), v.bandwidth))
}

fn group_audio<'a>(m: &'a Master, v: &Variant) -> Vec<&'a AudioEntry> {
    match &v.audio_group {
        Some(g) => m.audio.iter().filter(|a| &a.group == g && a.uri.is_some()).collect(),
        None => Vec::new(),
    }
}

pub fn probe_hls_master(m: &Master, duration_sec: f64) -> StreamProbe {
    let mut variants: Vec<VariantOut> = m
        .variants
        .iter()
        .map(|v| {
            let audio = if !group_audio(m, v).is_empty() {
                "separate"
            } else if v.codecs.as_deref().map(|c| !has_audio_codec(c)).unwrap_or(false) {
                "none"
            } else {
                "muxed"
            };
            VariantOut {
                id: format!("v{}", v.index),
                height: v.height,
                width: v.width,
                bandwidth: v.bandwidth,
                codecs: v.codecs.clone(),
                est_bytes: est_bytes(v.avg_bandwidth.unwrap_or(v.bandwidth), duration_sec),
                audio,
            }
        })
        .collect();
    sort_variants(&mut variants);
    let mut audio_tracks: Vec<AudioOut> = Vec::new();
    let mut seen: Vec<(Option<String>, Option<String>)> = Vec::new();
    for a in m.audio.iter().filter(|a| a.uri.is_some()) {
        let key = (a.lang.clone(), a.name.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        audio_tracks.push(AudioOut { id: format!("a{}", a.index), lang: a.lang.clone(), name: a.name.clone(), bandwidth: None });
    }
    StreamProbe { kind: StreamKind::Hls, title: None, duration_sec, variants, audio_tracks }
}

/// A media playlist opened on its own: one variant.
pub fn probe_hls_media(p: &MediaPlan) -> StreamProbe {
    StreamProbe {
        kind: StreamKind::Hls,
        title: None,
        duration_sec: p.duration_sec,
        variants: vec![VariantOut {
            id: SINGLE_VARIANT_ID.to_string(),
            height: None,
            width: None,
            bandwidth: 0,
            codecs: None,
            est_bytes: None,
            audio: "muxed",
        }],
        audio_tracks: vec![],
    }
}

/// What a download of an HLS master playlist fetches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    pub video_uri: String,
    pub audio_uri: Option<String>,
    pub height: Option<u32>,
    pub bandwidth: u64,
}

/// The variant for `spec.variant_id` (`v<index>`), and its audio track: the one asked for when its group has it
/// (or one with the same language), else the default, else the first. A variant with no audio group has none.
pub fn select_hls(m: &Master, spec: &StreamSpec) -> Result<Selected, StreamError> {
    let v = m
        .variants
        .iter()
        .find(|v| format!("v{}", v.index) == spec.variant_id)
        .ok_or(StreamError::Unsupported)?;
    let group = group_audio(m, v);
    let audio_uri = if group.is_empty() {
        None
    } else {
        let wanted = spec.audio_id.as_deref().and_then(|id| m.audio.iter().find(|a| format!("a{}", a.index) == id));
        let pick = wanted
            .and_then(|w| group.iter().copied().find(|g| g.index == w.index).or_else(|| group.iter().copied().find(|g| g.lang.is_some() && g.lang == w.lang)))
            .or_else(|| group.iter().copied().find(|g| g.default))
            .or_else(|| group.first().copied());
        pick.and_then(|a| a.uri.clone())
    };
    Ok(Selected { video_uri: v.uri.clone(), audio_uri, height: v.height, bandwidth: v.avg_bandwidth.unwrap_or(v.bandwidth) })
}

// ---- DASH ----

pub fn probe_dash(d: &Dash) -> StreamProbe {
    let has_sets = !d.audio.is_empty();
    let mut variants: Vec<VariantOut> = d
        .video
        .iter()
        .map(|r| VariantOut {
            id: r.id.clone(),
            height: r.height,
            width: r.width,
            bandwidth: r.bandwidth,
            codecs: r.codecs.clone(),
            est_bytes: est_bytes(r.bandwidth, d.duration_sec),
            audio: if has_sets {
                "separate"
            } else if r.codecs.as_deref().map(has_audio_codec).unwrap_or(false) {
                "muxed"
            } else {
                "none"
            },
        })
        .collect();
    // A manifest with audio only: one entry per audio set, so the user can still save it.
    if d.video.is_empty() {
        for a in &d.audio {
            if let Some(best) = a.best() {
                variants.push(VariantOut {
                    id: best.id.clone(),
                    height: None,
                    width: None,
                    bandwidth: best.bandwidth,
                    codecs: best.codecs.clone(),
                    est_bytes: est_bytes(best.bandwidth, d.duration_sec),
                    audio: "muxed",
                });
            }
        }
    }
    sort_variants(&mut variants);
    let audio_tracks = if d.video.is_empty() {
        vec![]
    } else {
        d.audio
            .iter()
            .map(|a| AudioOut {
                id: format!("a{}", a.index),
                lang: a.lang.clone(),
                name: a.label.clone(),
                bandwidth: a.best().map(|r| r.bandwidth),
            })
            .collect()
    };
    StreamProbe { kind: StreamKind::Dash, title: d.title.clone(), duration_sec: d.duration_sec, variants, audio_tracks }
}

/// The video representation for `spec.variant_id` and the audio one (the best of the set `spec.audio_id` names,
/// else of the first audio set). `None` audio when the manifest has no audio set.
pub fn select_dash<'a>(d: &'a Dash, spec: &StreamSpec) -> Result<(&'a DashRep, Option<&'a DashRep>), StreamError> {
    if d.video.is_empty() {
        // Audio only: the variant is one of the audio representations.
        let rep = d
            .audio
            .iter()
            .flat_map(|a| a.reps.iter())
            .find(|r| r.id == spec.variant_id)
            .ok_or(StreamError::Unsupported)?;
        return Ok((rep, None));
    }
    let video = d.video.iter().find(|r| r.id == spec.variant_id).ok_or(StreamError::Unsupported)?;
    if d.audio.is_empty() {
        return Ok((video, None));
    }
    let set = spec
        .audio_id
        .as_deref()
        .and_then(|id| d.audio.iter().find(|a| format!("a{}", a.index) == id))
        .or_else(|| d.audio.first())
        .ok_or(StreamError::Unsupported)?;
    Ok((video, set.best()))
}

// ---- names and files ----

/// The name part of a download: the name the app gave (page title), else the link's last path segment, else
/// `Video`. A trailing extension of a playlist or a video is removed.
pub fn base_name(requested: Option<&str>, url: &str) -> String {
    let from_url = || {
        super::super::content_disposition::filename_from_url(url).filter(|n| !n.trim().is_empty())
    };
    let raw = requested.map(str::to_string).filter(|n| !n.trim().is_empty()).or_else(from_url).unwrap_or_else(|| "Video".to_string());
    let lower = raw.to_ascii_lowercase();
    for ext in [".m3u8", ".mpd", ".mp4", ".m4v", ".ts", ".mkv", ".webm"] {
        if lower.ends_with(ext) && raw.len() > ext.len() {
            return raw[..raw.len() - ext.len()].trim().to_string();
        }
    }
    raw.trim().to_string()
}

/// `<base> <height>p.<ext>` (no height: `<base>.<ext>`).
pub fn output_name(base: &str, height: Option<u32>, ext: &str) -> String {
    match height {
        Some(h) if h > 0 => format!("{base} {h}p.{ext}"),
        _ => format!("{base}.{ext}"),
    }
}

/// The part file of a track: `<name>.part` for a single track, `<name>.video.part` / `<name>.audio.part` otherwise.
pub fn part_file_name(name: &str, role: TrackRole) -> String {
    match role {
        TrackRole::Main => format!("{name}.part"),
        TrackRole::Video => format!("{name}.video.part"),
        TrackRole::Audio => format!("{name}.audio.part"),
    }
}

/// Where a track continues. `saved` is what the sidecar says (`done` segments, `bytes` after them); `file_len` is
/// the part file's length. The file is cut to the returned byte length before writing goes on. Anything that does
/// not fit (another segment count, a file shorter than the record) starts the track over.
pub fn resume_point(saved: Option<&TrackSide>, total_items: usize, file_len: u64) -> (usize, u64) {
    match saved {
        Some(s) if s.total == total_items && s.done <= total_items && s.bytes <= file_len => (s.done, s.bytes),
        _ => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::super::hls::{self, Doc};
    use super::*;

    fn spec(kind: StreamKind, v: &str, a: Option<&str>) -> StreamSpec {
        StreamSpec { kind, variant_id: v.to_string(), audio_id: a.map(str::to_string) }
    }

    fn master(text: &str) -> Master {
        match hls::parse(text, "https://cdn.test/m.m3u8").unwrap() {
            Doc::Master(m) => m,
            _ => panic!("master"),
        }
    }

    const MASTER: &str = "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"en.m3u8\"\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=\"Francais\",LANGUAGE=\"fr\",URI=\"fr.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\",AUDIO=\"a\"\n360.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\",AUDIO=\"a\"\n1080.m3u8\n\
#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720,CODECS=\"avc1.64001f\"\n720.m3u8\n";

    #[test]
    fn estimate_is_bandwidth_over_eight_times_duration() {
        assert_eq!(est_bytes(8_000_000, 100.0), Some(100_000_000));
        assert_eq!(est_bytes(0, 100.0), None);
        assert_eq!(est_bytes(100, 0.0), None);
        assert_eq!(est_bytes(100, f64::NAN), None);
    }

    #[test]
    fn variants_sort_by_height_then_bandwidth() {
        let v = |id: &str, h: Option<u32>, b: u64| VariantOut {
            id: id.into(),
            height: h,
            width: None,
            bandwidth: b,
            codecs: None,
            est_bytes: None,
            audio: "muxed",
        };
        let mut list = vec![v("a", Some(360), 500), v("b", None, 9999), v("c", Some(1080), 100), v("d", Some(360), 900)];
        sort_variants(&mut list);
        let ids: Vec<&str> = list.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "d", "a", "b"]);
    }

    #[test]
    fn segment_cap() {
        assert!(check_count(20_000).is_ok());
        assert_eq!(check_count(20_001), Err(StreamError::Unsupported));
    }

    #[test]
    fn master_probe_lists_sorted_variants_audio_kinds_and_tracks() {
        let m = master(MASTER);
        let p = probe_hls_master(&m, 600.0);
        assert_eq!(p.variants.iter().map(|v| v.id.as_str()).collect::<Vec<_>>(), vec!["v1", "v2", "v0"]);
        assert_eq!(p.variants[0].audio, "separate");
        assert_eq!(p.variants[0].est_bytes, Some(225_000_000));
        // The 720p entry has no audio group and no audio codec listed.
        assert_eq!(p.variants[1].audio, "none");
        assert_eq!(p.audio_tracks.len(), 2);
        assert_eq!(p.audio_tracks[0].id, "a0");
        assert_eq!(p.audio_tracks[1].lang.as_deref(), Some("fr"));
        assert_eq!(best_hls_variant(&m).unwrap().index, 1);
    }

    #[test]
    fn hls_selection_picks_variant_and_audio() {
        let m = master(MASTER);
        let s = select_hls(&m, &spec(StreamKind::Hls, "v1", None)).unwrap();
        assert_eq!(s.video_uri, "https://cdn.test/1080.m3u8");
        assert_eq!(s.audio_uri.as_deref(), Some("https://cdn.test/en.m3u8"));
        assert_eq!(s.height, Some(1080));
        let s = select_hls(&m, &spec(StreamKind::Hls, "v0", Some("a1"))).unwrap();
        assert_eq!(s.audio_uri.as_deref(), Some("https://cdn.test/fr.m3u8"));
        // No audio group: nothing separate, whatever audio id came.
        let s = select_hls(&m, &spec(StreamKind::Hls, "v2", Some("a1"))).unwrap();
        assert_eq!(s.audio_uri, None);
        assert_eq!(select_hls(&m, &spec(StreamKind::Hls, "v9", None)), Err(StreamError::Unsupported));
    }

    #[test]
    fn media_playlist_alone_is_one_variant() {
        let Doc::Media(p) = hls::parse("#EXTM3U\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST", "https://a.test/x.m3u8").unwrap() else {
            panic!("media")
        };
        let probe = probe_hls_media(&p);
        assert_eq!(probe.variants.len(), 1);
        assert_eq!(probe.variants[0].id, SINGLE_VARIANT_ID);
        assert_eq!(probe.duration_sec, 5.0);
    }

    #[test]
    fn names() {
        assert_eq!(base_name(Some("My Show.mp4"), "https://a.test/x.m3u8"), "My Show");
        assert_eq!(base_name(Some("  "), "https://a.test/path/clip.m3u8"), "clip");
        assert_eq!(base_name(None, "https://a.test/"), "Video");
        assert_eq!(output_name("Film", Some(1080), "mp4"), "Film 1080p.mp4");
        assert_eq!(output_name("Film", None, "ts"), "Film.ts");
        assert_eq!(part_file_name("Film 1080p.mp4", TrackRole::Main), "Film 1080p.mp4.part");
        assert_eq!(part_file_name("Film 1080p.mp4", TrackRole::Video), "Film 1080p.mp4.video.part");
        assert_eq!(part_file_name("Film 1080p.mp4", TrackRole::Audio), "Film 1080p.mp4.audio.part");
    }

    #[test]
    fn resume_cuts_to_the_recorded_length() {
        let side = TrackSide { done: 12, bytes: 5000, total: 100 };
        // The file has more bytes than the record (the last segments were written, the sidecar lagged): cut back.
        assert_eq!(resume_point(Some(&side), 100, 5600), (12, 5000));
        assert_eq!(resume_point(Some(&side), 100, 5000), (12, 5000));
        // A shorter file than the record, another segment count, or no record: start over.
        assert_eq!(resume_point(Some(&side), 100, 4999), (0, 0));
        assert_eq!(resume_point(Some(&side), 99, 6000), (0, 0));
        assert_eq!(resume_point(None, 100, 6000), (0, 0));
        let odd = TrackSide { done: 101, bytes: 1, total: 100 };
        assert_eq!(resume_point(Some(&odd), 100, 10), (0, 0));
    }

    fn dash(body: &str) -> Dash {
        let text = format!(
            "<MPD type=\"static\" mediaPresentationDuration=\"PT100S\">{body}</MPD>"
        );
        super::super::dash::parse(&text, "https://cdn.test/m.mpd").unwrap()
    }

    const DASH_BODY: &str = "<Period>\
<AdaptationSet mimeType=\"video/mp4\"><SegmentTemplate timescale=\"1\" duration=\"10\" media=\"v$RepresentationID$-$Number$.m4s\"/>\
<Representation id=\"lo\" bandwidth=\"800000\" height=\"360\"/><Representation id=\"hi\" bandwidth=\"4000000\" height=\"1080\"/></AdaptationSet>\
<AdaptationSet mimeType=\"audio/mp4\" lang=\"en\"><SegmentTemplate timescale=\"1\" duration=\"10\" media=\"a-$Number$.m4s\"/>\
<Representation id=\"a\" bandwidth=\"128000\"/></AdaptationSet>\
<AdaptationSet mimeType=\"audio/mp4\" lang=\"de\"><SegmentTemplate timescale=\"1\" duration=\"10\" media=\"d-$Number$.m4s\"/>\
<Representation id=\"d\" bandwidth=\"96000\"/></AdaptationSet></Period>";

    #[test]
    fn dash_probe_and_selection() {
        let d = dash(DASH_BODY);
        let p = probe_dash(&d);
        assert_eq!(p.variants[0].id, "v0.1");
        assert_eq!(p.variants[0].est_bytes, Some(50_000_000));
        assert_eq!(p.variants[0].audio, "separate");
        assert_eq!(p.audio_tracks.len(), 2);
        assert_eq!(p.audio_tracks[1].id, "a2");
        let (v, a) = select_dash(&d, &spec(StreamKind::Dash, "v0.0", Some("a2"))).unwrap();
        assert_eq!(v.height, Some(360));
        assert_eq!(a.unwrap().id, "a2.0");
        let (_, a) = select_dash(&d, &spec(StreamKind::Dash, "v0.1", None)).unwrap();
        assert_eq!(a.unwrap().id, "a1.0");
        assert!(select_dash(&d, &spec(StreamKind::Dash, "nope", None)).is_err());
    }
}
