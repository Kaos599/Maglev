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
pub mod mp4_mux;
pub mod plan;

pub use plan::StreamProbe;

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
/// Concurrent connections for direct chunked pair downloads (e.g. YouTube) with dynamic work-stealing.
pub const PAIR_IN_FLIGHT: usize = 12;
/// One segment is held in memory while it is fetched. A bigger one is refused (`STREAM_UNSUPPORTED`).
pub const MAX_SEGMENT_BYTES: u64 = 48 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamKind {
    Hls,
    Dash,
    Pair,
}

/// One subtitle track to fetch and embed as an MP4 `tx3g` (`sbtl`) track.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtitleSpec {
    pub lang: String,
    pub name: String,
    pub url: String,
}

/// `options.stream` of `nativeAddDownload`: which variant (and audio track) to save.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StreamSpec {
    pub kind: StreamKind,
    #[serde(alias = "variantId")]
    pub variant_id: String,
    #[serde(default, alias = "audioId")]
    pub audio_id: Option<String>,
    #[serde(default, alias = "videoUrl")]
    pub video_url: Option<String>,
    #[serde(default, alias = "audioUrl")]
    pub audio_url: Option<String>,
    #[serde(default, alias = "videoBytes")]
    pub video_bytes: Option<u64>,
    #[serde(default, alias = "audioBytes")]
    pub audio_bytes: Option<u64>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub subtitles: Vec<SubtitleSpec>,
}

/// What a download record keeps about its stream. Nothing secret: ids and counts only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamRec {
    pub kind: StreamKind,
    pub variant_id: String,
    pub audio_id: Option<String>,
    #[serde(default)]
    pub video_url: Option<String>,
    #[serde(default)]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub video_bytes: Option<u64>,
    #[serde(default)]
    pub audio_bytes: Option<u64>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub subtitles: Vec<SubtitleSpec>,
    #[serde(default)]
    pub segments_done: usize,
    #[serde(default)]
    pub segments_total: usize,
}

impl StreamRec {
    pub fn spec(&self) -> StreamSpec {
        StreamSpec {
            kind: self.kind,
            variant_id: self.variant_id.clone(),
            audio_id: self.audio_id.clone(),
            video_url: self.video_url.clone(),
            audio_url: self.audio_url.clone(),
            video_bytes: self.video_bytes,
            audio_bytes: self.audio_bytes,
            height: self.height,
            ext: self.ext.clone(),
            subtitles: self.subtitles.clone(),
        }
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
    /// Exact byte offset in the output part file for out-of-order parallel chunked downloads (`Pair`).
    pub write_offset: Option<u64>,
    /// Expected byte length of this chunk when `write_offset` is set.
    pub expected_len: Option<u64>,
}

impl Segment {
    pub fn plain(url: String) -> Segment {
        Segment { url, range: None, key: None, whole_file: false, write_offset: None, expected_len: None }
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
    /// Original un-ranged URL for `StreamKind::Pair` tracks (enables cursor-resumed retries & work-stealing).
    pub base_url: Option<String>,
    /// Exact total byte length for `StreamKind::Pair` tracks when known.
    pub total_bytes: Option<u64>,
}

/// A stream ready to download: what to fetch, in which files.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    pub tracks: Vec<TrackPlan>,
    pub duration_sec: f64,
    pub est_bytes: Option<u64>,
    pub height: Option<u32>,
    pub ext_override: Option<String>,
}

impl Resolved {
    /// Separate video and audio parts that Kotlin joins.
    pub fn mux_needed(&self) -> bool {
        self.tracks.len() > 1
    }

    /// Explicit extension when provided (e.g. `m4a` for audio-only), else `ts` for a single MPEG-TS track, else `mp4`.
    pub fn extension(&self) -> &str {
        if let Some(ext) = self.ext_override.as_deref() {
            let clean = ext.trim().trim_start_matches('.');
            if !clean.is_empty() {
                return clean;
            }
        }
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

/// Builds the request URL and optional HTTP `Range` header `(offset, length)` for a direct `Pair` byte range.
/// YouTube `googlevideo.com` URLs use `&range=start-end` query params (HTTP 200); other servers use `Range` headers.
pub fn pair_range_request(base_url: &str, start: u64, len: u64) -> (String, Option<(u64, u64)>) {
    let lower = base_url.to_ascii_lowercase();
    let yt_query_range = lower.contains("googlevideo.com/") || lower.contains("/videoplayback");
    if yt_query_range {
        let sep = if base_url.contains('?') { '&' } else { '?' };
        let end = start + len.saturating_sub(1);
        (format!("{base_url}{sep}range={start}-{end}"), None)
    } else {
        (base_url.to_string(), Some((start, len)))
    }
}

/// Slices a direct media URL into parallel byte-range chunks sized for consistent full link speed.
/// Uses ~2 MiB chunks (safely inside YouTube's unthrottled burst window, small enough that paired
/// dynamic work-stealing eliminates tail straggler drops across all `PAIR_IN_FLIGHT` connections).
pub fn chunked_segments(url: &str, total_bytes: u64) -> Vec<Segment> {
    if total_bytes == 0 {
        return vec![Segment {
            url: url.to_string(),
            range: None,
            key: None,
            whole_file: true,
            write_offset: None,
            expected_len: None,
        }];
    }
    const MIN_CHUNK: u64 = 256 * 1024;
    const TARGET_CHUNK: u64 = 2 * 1024 * 1024;
    let lanes = PAIR_IN_FLIGHT as u64;
    let chunk_size = if total_bytes < MIN_CHUNK * lanes {
        let n = total_bytes.div_ceil(MIN_CHUNK).clamp(1, lanes);
        total_bytes.div_ceil(n)
    } else if total_bytes < TARGET_CHUNK * lanes {
        total_bytes.div_ceil(lanes)
    } else {
        TARGET_CHUNK
    };
    let num_chunks = total_bytes.div_ceil(chunk_size) as usize;
    let mut out = Vec::with_capacity(num_chunks);
    let mut offset = 0u64;
    while offset < total_bytes {
        let len = (total_bytes - offset).min(chunk_size);
        let (req_url, range) = pair_range_request(url, offset, len);
        out.push(Segment {
            url: req_url,
            range,
            key: None,
            whole_file: false,
            write_offset: Some(offset),
            expected_len: Some(len),
        });
        offset += len;
    }
    out
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
    TrackPlan { role, items: plan.items(), fmp4: plan.fmp4, base_url: None, total_bytes: None }
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

/// Probes exact byte length of a direct media URL via a 1-byte `Range: bytes=0-0` request
/// so social media links without pre-known `contentLength` still download in parallel 2 MiB chunks.
async fn probe_pair_content_length(ctx: &fetch::ReqCtx, target_url: &str) -> u64 {
    let (req_url, range) = pair_range_request(target_url, 0, 1);
    let Ok(Ok(resp)) = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        ctx.send(&req_url, range),
    )
    .await
    else {
        return 0;
    };
    let status = resp.status().as_u16();
    if status == 206 {
        if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
            // e.g. "bytes 0-0/15728640"
            if let Some(slash) = cr.rfind('/') {
                if let Ok(total) = cr[slash + 1..].trim().parse::<u64>() {
                    if total > 1 {
                        return total;
                    }
                }
            }
        }
    } else if status == 200 && req_url != target_url {
        // YouTube `&range=0-0` returns 200 for the slice only, not total length.
        return 0;
    }
    0
}

/// Reads the playlists again for the variant (and audio track) the download was added with.
pub async fn resolve(ctx: &fetch::ReqCtx, url: &str, spec: &StreamSpec) -> Result<Resolved, ResolveFail> {
    if spec.kind == StreamKind::Pair {
        let primary = spec.video_url.as_deref().filter(|s| !s.is_empty()).unwrap_or(url);
        let mut v_bytes = spec.video_bytes.unwrap_or(0);
        let mut a_bytes = spec.audio_bytes.unwrap_or(0);
        let audio_opt = spec.audio_url.as_deref().filter(|s| !s.is_empty());
        if v_bytes == 0 && audio_opt.is_some() && a_bytes == 0 {
            let (vb, ab) = tokio::join!(
                probe_pair_content_length(ctx, primary),
                probe_pair_content_length(ctx, audio_opt.unwrap())
            );
            v_bytes = vb;
            a_bytes = ab;
        } else if v_bytes == 0 {
            v_bytes = probe_pair_content_length(ctx, primary).await;
        } else if let Some(a_url) = audio_opt {
            if a_bytes == 0 {
                a_bytes = probe_pair_content_length(ctx, a_url).await;
            }
        }
        let mut tracks = Vec::new();
        if let Some(audio) = audio_opt {
            tracks.push(TrackPlan {
                role: TrackRole::Video,
                items: chunked_segments(primary, v_bytes),
                fmp4: true,
                base_url: Some(primary.to_string()),
                total_bytes: (v_bytes > 0).then_some(v_bytes),
            });
            tracks.push(TrackPlan {
                role: TrackRole::Audio,
                items: chunked_segments(audio, a_bytes),
                fmp4: true,
                base_url: Some(audio.to_string()),
                total_bytes: (a_bytes > 0).then_some(a_bytes),
            });
        } else {
            tracks.push(TrackPlan {
                role: TrackRole::Main,
                items: chunked_segments(primary, v_bytes),
                fmp4: true,
                base_url: Some(primary.to_string()),
                total_bytes: (v_bytes > 0).then_some(v_bytes),
            });
        }
        let sum = v_bytes.saturating_add(a_bytes);
        return Ok(Resolved {
            tracks,
            duration_sec: 0.0,
            est_bytes: (sum > 0).then_some(sum),
            height: spec.height,
            ext_override: spec.ext.clone(),
        });
    }
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
                Ok(Resolved { tracks, duration_sec: video.duration_sec, est_bytes: est, height: sel.height, ext_override: None })
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
                    ext_override: None,
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
            Ok(Resolved { tracks, duration_sec: d.duration_sec, est_bytes: est, height: video.height, ext_override: None })
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
        let t = |role, fmp4| TrackPlan { role, items: vec![seg.clone()], fmp4, base_url: None, total_bytes: None };
        let one_ts = Resolved { tracks: vec![t(TrackRole::Main, false)], duration_sec: 1.0, est_bytes: None, height: None, ext_override: None };
        assert_eq!(one_ts.extension(), "ts");
        assert!(!one_ts.mux_needed());
        let one_mp4 = Resolved { tracks: vec![t(TrackRole::Main, true)], ..one_ts.clone() };
        assert_eq!(one_mp4.extension(), "mp4");
        let audio_m4a = Resolved { tracks: vec![t(TrackRole::Main, true)], ext_override: Some("m4a".into()), ..one_ts.clone() };
        assert_eq!(audio_m4a.extension(), "m4a");
        let two = Resolved { tracks: vec![t(TrackRole::Video, false), t(TrackRole::Audio, false)], ..one_ts.clone() };
        assert_eq!(two.extension(), "mp4");
        assert!(two.mux_needed());
        assert_eq!(two.total_items(), 2);
    }

    #[test]
    fn pair_chunks_use_query_range_for_googlevideo() {
        let segs = chunked_segments("https://rr1.googlevideo.com/videoplayback?itag=137", 6 * 1024 * 1024);
        assert_eq!(segs.len(), PAIR_IN_FLIGHT);
        assert!(segs[0].url.ends_with("&range=0-524287"));
        assert!(segs[0].range.is_none());
        assert!(segs[PAIR_IN_FLIGHT - 1].url.ends_with("&range=5767168-6291455"));
        // 80 MiB splits into 40 x 2 MiB chunks well inside YouTube's unthrottled burst window.
        let big = chunked_segments("https://rr1.googlevideo.com/videoplayback?itag=137", 80 * 1024 * 1024);
        assert_eq!(big.len(), 40);
        assert_eq!(big[0].expected_len, Some(2 * 1024 * 1024));
        assert_eq!(big[39].expected_len, Some(2 * 1024 * 1024));
    }
}
