//! Saving HLS and DASH streams (`docs/NATIVE_CONTRACT.md` section 24.8).
//!
//! - `hls`: the m3u8 parser (hand written, line based).
//! - `dash`: the MPD reader (`roxmltree`).
//! - `plan`: pure decisions: variant order, size estimates, file names, where to resume.
//! - `fetch`: the requests (same client as every download) and AES-128 decryption.
//!
//! This file holds the types they share and the two async entry points, `probe` and `resolve`, which only fetch a
//! playlist or two and hand the text to the pure parsers. The transfer itself lives in `driver/stream_run.rs`.
//!
//! Nothing here logs a link, and no key ever leaves memory.

pub mod dash;
pub mod fetch;
pub mod hls;
pub mod plan;

use serde::{Deserialize, Serialize};

use crate::error::{
    ErrorCode, STREAM_LIVE_MSG, STREAM_PROTECTED_MSG, STREAM_UNSUPPORTED_MSG,
};

/// A playlist (m3u8 or MPD) larger than this is refused.
pub const MAX_PLAYLIST_BYTES: u64 = 2 * 1024 * 1024;
/// More segments than this in one track is refused.
pub const MAX_SEGMENTS: usize = 20_000;
/// Segments fetched at once; they are written strictly in order.
pub const MAX_IN_FLIGHT: usize = 3;
/// One segment is held in memory while it is fetched. A bigger one is refused (`STREAM_UNSUPPORTED`).
pub const MAX_SEGMENT_BYTES: u64 = 48 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Hls,
    Dash,
}

/// `options.stream` of `nativeAddDownload`: which variant (and audio track) to save.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamSpec {
    pub kind: StreamKind,
    #[serde(alias = "variantId")]
    pub variant_id: String,
    #[serde(default, alias = "audioId")]
    pub audio_id: Option<String>,
}

/// What a download record keeps about its stream. Nothing secret: ids and counts only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamRec {
    pub kind: StreamKind,
    pub variant_id: String,
    pub audio_id: Option<String>,
    #[serde(default)]
    pub segments_done: usize,
    #[serde(default)]
    pub segments_total: usize,
}

impl StreamRec {
    pub fn spec(&self) -> StreamSpec {
        StreamSpec { kind: self.kind, variant_id: self.variant_id.clone(), audio_id: self.audio_id.clone() }
    }
}

/// Why a stream can't be saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamError {
    Protected,
    Live,
    Unsupported,
}

impl StreamError {
    pub fn code(&self) -> ErrorCode {
        match self {
            StreamError::Protected => ErrorCode::StreamProtected,
            StreamError::Live => ErrorCode::StreamLive,
            StreamError::Unsupported => ErrorCode::StreamUnsupported,
        }
    }

    pub fn message(&self) -> &'static str {
        match self {
            StreamError::Protected => STREAM_PROTECTED_MSG,
            StreamError::Live => STREAM_LIVE_MSG,
            StreamError::Unsupported => STREAM_UNSUPPORTED_MSG,
        }
    }
}

/// AES-128 key of a segment: where to get it and the IV (explicit, or derived from the media sequence number).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegKey {
    pub uri: String,
    pub iv: [u8; 16],
}

/// One thing to fetch: a segment, an init segment, or (DASH `SegmentBase`) a whole file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub url: String,
    /// `(offset, length)` of a byte range inside `url`.
    pub range: Option<(u64, u64)>,
    pub key: Option<SegKey>,
    /// A whole file that may be big: streamed to disk instead of held in memory. Never encrypted.
    pub whole_file: bool,
}

impl Segment {
    pub fn plain(url: String) -> Segment {
        Segment { url, range: None, key: None, whole_file: false }
    }
}

/// One track read from a media playlist or a DASH representation.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaPlan {
    pub init: Option<Segment>,
    pub segments: Vec<Segment>,
    pub duration_sec: f64,
    /// fMP4 / CMAF (has an init segment or `.m4s`-like names). Otherwise MPEG-TS.
    pub fmp4: bool,
}

impl MediaPlan {
    /// The init segment first, then the media segments.
    pub fn items(&self) -> Vec<Segment> {
        let mut v = Vec::with_capacity(self.segments.len() + 1);
        if let Some(i) = &self.init {
            v.push(i.clone());
        }
        v.extend(self.segments.iter().cloned());
        v
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackRole {
    /// One track holds everything (muxed audio).
    Main,
    Video,
    Audio,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrackPlan {
    pub role: TrackRole,
    /// The init segment (when there is one) first.
    pub items: Vec<Segment>,
    pub fmp4: bool,
}

/// A stream ready to download: what to fetch, in which files.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub tracks: Vec<TrackPlan>,
    pub duration_sec: f64,
    pub est_bytes: Option<u64>,
    pub height: Option<u32>,
}

impl Resolved {
    /// Separate video and audio parts that Kotlin joins.
    pub fn mux_needed(&self) -> bool {
        self.tracks.len() > 1
    }

    /// `ts` only for a single MPEG-TS track; everything else ends up as `mp4`.
    pub fn extension(&self) -> &'static str {
        if self.mux_needed() || self.tracks.iter().any(|t| t.fmp4) {
            "mp4"
        } else {
            "ts"
        }
    }

    pub fn total_items(&self) -> usize {
        self.tracks.iter().map(|t| t.items.len()).sum()
    }
}

/// `rel` resolved against `base`. `None` when either is not a valid link.
pub fn resolve_url(base: &str, rel: &str) -> Option<String> {
    let b = reqwest::Url::parse(base).ok()?;
    b.join(rel.trim()).ok().map(|u| u.to_string())
}

pub fn is_http(url: &str) -> bool {
    let l = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

/// What `probe` could not do.
#[derive(Debug)]
pub enum ResolveFail {
    Fetch(fetch::FetchFail),
    Stream(StreamError),
}

impl From<fetch::FetchFail> for ResolveFail {
    fn from(f: fetch::FetchFail) -> Self {
        ResolveFail::Fetch(f)
    }
}

impl From<StreamError> for ResolveFail {
    fn from(e: StreamError) -> Self {
        ResolveFail::Stream(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detected {
    Hls,
    Dash,
}

/// HLS starts with `#EXTM3U`; a DASH manifest has an `<MPD` element near the top.
pub fn detect(text: &str) -> Result<Detected, StreamError> {
    let t = text.trim_start_matches('\u{feff}').trim_start();
    if t.starts_with("#EXTM3U") {
        return Ok(Detected::Hls);
    }
    if t.starts_with('<') && t.get(..t.len().min(4096)).map(|h| h.contains("<MPD")).unwrap_or(false) {
        return Ok(Detected::Dash);
    }
    Err(StreamError::Unsupported)
}

fn media_of(doc: hls::Doc) -> Result<MediaPlan, StreamError> {
    match doc {
        hls::Doc::Media(m) => Ok(m),
        // Nested playlists go one level deep only.
        hls::Doc::Master(_) => Err(StreamError::Unsupported),
    }
}

async fn fetch_media(ctx: &fetch::ReqCtx, url: &str) -> Result<MediaPlan, ResolveFail> {
    let (text, final_url) = fetch::fetch_text(ctx, url).await?;
    Ok(media_of(hls::parse(&text, &final_url)?)?)
}

fn track_of(role: TrackRole, plan: &MediaPlan) -> TrackPlan {
    TrackPlan { role, items: plan.items(), fmp4: plan.fmp4 }
}

/// Reads the link the user is about to save: kinds, qualities, audio tracks, estimates.
pub async fn probe(ctx: &fetch::ReqCtx, url: &str) -> Result<plan::StreamProbe, ResolveFail> {
    let (text, final_url) = fetch::fetch_text(ctx, url).await?;
    match detect(&text)? {
        Detected::Hls => match hls::parse(&text, &final_url)? {
            hls::Doc::Master(m) => {
                // One media playlist is read for the length (and to refuse a live or encrypted stream early).
                let best = plan::best_hls_variant(&m).ok_or(StreamError::Unsupported)?;
                let media = fetch_media(ctx, &best.uri).await?;
                Ok(plan::probe_hls_master(&m, media.duration_sec))
            }
            hls::Doc::Media(p) => Ok(plan::probe_hls_media(&p)),
        },
        Detected::Dash => {
            let d = dash::parse(&text, &final_url)?;
            Ok(plan::probe_dash(&d))
        }
    }
}

/// Reads the playlists again for the variant (and audio track) the download was added with.
pub async fn resolve(ctx: &fetch::ReqCtx, url: &str, spec: &StreamSpec) -> Result<Resolved, ResolveFail> {
    let (text, final_url) = fetch::fetch_text(ctx, url).await?;
    let found = detect(&text)?;
    let want = match found {
        Detected::Hls => StreamKind::Hls,
        Detected::Dash => StreamKind::Dash,
    };
    if want != spec.kind {
        return Err(StreamError::Unsupported.into());
    }
    match found {
        Detected::Hls => match hls::parse(&text, &final_url)? {
            hls::Doc::Master(m) => {
                let sel = plan::select_hls(&m, spec)?;
                let video = fetch_media(ctx, &sel.video_uri).await?;
                let mut tracks = Vec::new();
                let mut est = plan::est_bytes(sel.bandwidth, video.duration_sec);
                match &sel.audio_uri {
                    Some(a) => {
                        let audio = fetch_media(ctx, a).await?;
                        tracks.push(track_of(TrackRole::Video, &video));
                        tracks.push(track_of(TrackRole::Audio, &audio));
                        // The variant's bandwidth already counts its audio group.
                        est = est.or_else(|| plan::est_bytes(sel.bandwidth, audio.duration_sec));
                    }
                    None => tracks.push(track_of(TrackRole::Main, &video)),
                }
                Ok(Resolved { tracks, duration_sec: video.duration_sec, est_bytes: est, height: sel.height })
            }
            hls::Doc::Media(p) => {
                if spec.variant_id != plan::SINGLE_VARIANT_ID {
                    return Err(StreamError::Unsupported.into());
                }
                Ok(Resolved {
                    tracks: vec![track_of(TrackRole::Main, &p)],
                    duration_sec: p.duration_sec,
                    est_bytes: None,
                    height: None,
                })
            }
        },
        Detected::Dash => {
            let d = dash::parse(&text, &final_url)?;
            let (video, audio) = plan::select_dash(&d, spec)?;
            let vp = video.plan()?;
            let mut tracks = Vec::new();
            let mut est = plan::est_bytes(video.bandwidth, d.duration_sec);
            match audio {
                Some(a) => {
                    let ap = a.plan()?;
                    tracks.push(track_of(TrackRole::Video, &vp));
                    tracks.push(track_of(TrackRole::Audio, &ap));
                    if let (Some(v), Some(x)) = (est, plan::est_bytes(a.bandwidth, d.duration_sec)) {
                        est = Some(v + x);
                    }
                }
                None => tracks.push(track_of(TrackRole::Main, &vp)),
            }
            Ok(Resolved { tracks, duration_sec: d.duration_sec, est_bytes: est, height: video.height })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_two_kinds() {
        assert_eq!(detect("#EXTM3U\n#EXTINF:1,\na.ts"), Ok(Detected::Hls));
        assert_eq!(detect("\u{feff}#EXTM3U\n"), Ok(Detected::Hls));
        assert_eq!(detect("<?xml version=\"1.0\"?>\n<MPD type=\"static\"></MPD>"), Ok(Detected::Dash));
        assert_eq!(detect("<html></html>"), Err(StreamError::Unsupported));
        assert_eq!(detect("hello"), Err(StreamError::Unsupported));
    }

    #[test]
    fn resolves_relative_links() {
        assert_eq!(resolve_url("https://a.test/x/y.m3u8", "z.ts").as_deref(), Some("https://a.test/x/z.ts"));
        assert_eq!(resolve_url("https://a.test/x/y.m3u8", "/z.ts").as_deref(), Some("https://a.test/z.ts"));
        assert_eq!(resolve_url("https://a.test/x/y.m3u8", "https://b.test/q.ts").as_deref(), Some("https://b.test/q.ts"));
        assert_eq!(resolve_url("https://a.test/x/y.m3u8", "../k.key").as_deref(), Some("https://a.test/k.key"));
        assert!(resolve_url("not a url", "z").is_none());
    }

    #[test]
    fn http_check() {
        assert!(is_http("https://a.test/k"));
        assert!(is_http("HTTP://a.test/k"));
        assert!(!is_http("skd://key"));
        assert!(!is_http("data:text/plain;base64,AAAA"));
    }

    #[test]
    fn stream_errors_carry_the_contract_copy() {
        assert_eq!(StreamError::Protected.code(), ErrorCode::StreamProtected);
        assert_eq!(StreamError::Live.message(), "This is a live stream. Maglev can only save videos that have an end.");
        assert_eq!(StreamError::Unsupported.message(), "Maglev can't save this kind of stream yet.");
    }

    #[test]
    fn extension_follows_the_tracks() {
        let seg = Segment::plain("https://a.test/a".into());
        let t = |role, fmp4| TrackPlan { role, items: vec![seg.clone()], fmp4 };
        let one_ts = Resolved { tracks: vec![t(TrackRole::Main, false)], duration_sec: 1.0, est_bytes: None, height: None };
        assert_eq!(one_ts.extension(), "ts");
        assert!(!one_ts.mux_needed());
        let one_mp4 = Resolved { tracks: vec![t(TrackRole::Main, true)], ..one_ts.clone() };
        assert_eq!(one_mp4.extension(), "mp4");
        let two = Resolved { tracks: vec![t(TrackRole::Video, false), t(TrackRole::Audio, false)], ..one_ts.clone() };
        assert_eq!(two.extension(), "mp4");
        assert!(two.mux_needed());
        assert_eq!(two.total_items(), 2);
    }
}
