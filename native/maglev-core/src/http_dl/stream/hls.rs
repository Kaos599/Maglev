//! A small, line based reader for HLS playlists (RFC 8216). No crate: the format is a list of tags and links.
//!
//! What it refuses (contract section 24.8):
//! - `STREAM_PROTECTED`: any `#EXT-X-KEY` that is not `METHOD=NONE` or plain `METHOD=AES-128` (`SAMPLE-AES`,
//!   `SAMPLE-AES-CTR`, a `KEYFORMAT` other than `identity`, a key link that is not http(s)).
//! - `STREAM_LIVE`: a media playlist without `#EXT-X-ENDLIST`.
//! - `STREAM_UNSUPPORTED`: more than 20,000 segments, no segments, an invalid `IV`, `#EXT-X-I-FRAMES-ONLY`, a
//!   `#EXT-X-BYTERANGE` with no offset and nothing before it.
//!
//! A key link is only resolved here; it is never fetched by the parser.

use super::{is_http, resolve_url, MediaPlan, SegKey, Segment, StreamError, MAX_SEGMENTS};

/// One `#EXT-X-STREAM-INF` entry of a master playlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    /// Position among the stream entries (the id is `v<index>`).
    pub index: usize,
    pub uri: String,
    pub bandwidth: u64,
    pub avg_bandwidth: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub codecs: Option<String>,
    pub audio_group: Option<String>,
}

/// One `#EXT-X-MEDIA:TYPE=AUDIO` entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioEntry {
    /// Position among the audio entries (the id is `a<index>`).
    pub index: usize,
    pub group: String,
    pub name: Option<String>,
    pub lang: Option<String>,
    /// `None` when the audio is inside the video segments.
    pub uri: Option<String>,
    pub default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Master {
    pub variants: Vec<Variant>,
    pub audio: Vec<AudioEntry>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Doc {
    Master(Master),
    Media(MediaPlan),
}

/// `KEY=value,KEY="quoted, value"` into upper-case keys and unquoted values. A comma inside quotes stays.
pub fn parse_attrs(s: &str) -> Vec<(String, String)> {
    let b: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i] == ',' || b[i].is_whitespace()) {
            i += 1;
        }
        let ks = i;
        while i < b.len() && b[i] != '=' && b[i] != ',' {
            i += 1;
        }
        let key: String = b[ks..i].iter().collect();
        if i >= b.len() || b[i] != '=' {
            if !key.trim().is_empty() {
                out.push((key.trim().to_ascii_uppercase(), String::new()));
            }
            continue;
        }
        i += 1;
        let val: String;
        if i < b.len() && b[i] == '"' {
            i += 1;
            let vs = i;
            while i < b.len() && b[i] != '"' {
                i += 1;
            }
            val = b[vs..i].iter().collect();
            if i < b.len() {
                i += 1;
            }
        } else {
            let vs = i;
            while i < b.len() && b[i] != ',' {
                i += 1;
            }
            val = b[vs..i].iter().collect::<String>().trim().to_string();
        }
        out.push((key.trim().to_ascii_uppercase(), val));
    }
    out
}

fn attr<'a>(attrs: &'a [(String, String)], key: &str) -> Option<&'a str> {
    attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `0x...` of up to 32 hex digits as a 16 byte big-endian IV.
pub fn parse_iv(s: &str) -> Option<[u8; 16]> {
    let h = s.trim().strip_prefix("0x").or_else(|| s.trim().strip_prefix("0X"))?;
    if h.is_empty() || h.len() > 32 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(u128::from_str_radix(h, 16).ok()?.to_be_bytes())
}

/// The IV of a segment with no `IV` attribute: its media sequence number as a 128-bit big-endian integer.
pub fn iv_from_sequence(seq: u64) -> [u8; 16] {
    (seq as u128).to_be_bytes()
}

/// `len` or `len@offset`.
fn parse_byterange(s: &str) -> Option<(u64, Option<u64>)> {
    match s.trim().split_once('@') {
        Some((l, o)) => Some((l.trim().parse().ok()?, Some(o.trim().parse().ok()?))),
        None => Some((s.trim().parse().ok()?, None)),
    }
}

#[derive(Clone)]
struct KeyState {
    uri: String,
    iv: Option<[u8; 16]>,
}

/// `Ok(None)` is `METHOD=NONE`.
fn parse_key(attrs: &[(String, String)], base: &str) -> Result<Option<KeyState>, StreamError> {
    match attr(attrs, "METHOD") {
        Some("NONE") => Ok(None),
        Some("AES-128") => {
            if let Some(kf) = attr(attrs, "KEYFORMAT") {
                if !kf.eq_ignore_ascii_case("identity") {
                    return Err(StreamError::Protected);
                }
            }
            let raw = attr(attrs, "URI").ok_or(StreamError::Unsupported)?;
            let abs = resolve_url(base, raw).ok_or(StreamError::Unsupported)?;
            if !is_http(&abs) {
                return Err(StreamError::Protected);
            }
            let iv = match attr(attrs, "IV") {
                Some(v) => Some(parse_iv(v).ok_or(StreamError::Unsupported)?),
                None => None,
            };
            Ok(Some(KeyState { uri: abs, iv }))
        }
        // SAMPLE-AES, SAMPLE-AES-CTR and anything we don't know.
        Some(_) => Err(StreamError::Protected),
        None => Err(StreamError::Unsupported),
    }
}

fn is_fmp4_name(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    [".m4s", ".mp4", ".m4a", ".m4v", ".cmfv", ".cmfa", ".cmf"].iter().any(|e| path.ends_with(e))
}

fn data_lines(text: &str) -> Vec<&str> {
    text.trim_start_matches('\u{feff}').lines().map(str::trim).filter(|l| !l.is_empty()).collect()
}

/// Reads a master or a media playlist. `base` is the playlist's own (final) link; every other link is resolved
/// against it.
pub fn parse(text: &str, base: &str) -> Result<Doc, StreamError> {
    let lines = data_lines(text);
    if lines.first().map(|l| l.starts_with("#EXTM3U")) != Some(true) {
        return Err(StreamError::Unsupported);
    }
    if lines.iter().any(|l| l.starts_with("#EXT-X-STREAM-INF")) {
        return parse_master(&lines, base).map(Doc::Master);
    }
    parse_media(&lines, base).map(Doc::Media)
}

fn parse_master(lines: &[&str], base: &str) -> Result<Master, StreamError> {
    let mut variants: Vec<Variant> = Vec::new();
    let mut audio: Vec<AudioEntry> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        if let Some(rest) = l.strip_prefix("#EXT-X-STREAM-INF:") {
            let attrs = parse_attrs(rest);
            // The link is the next line that is not a tag or comment.
            let mut j = i + 1;
            while j < lines.len() && lines[j].starts_with('#') {
                j += 1;
            }
            let Some(raw) = lines.get(j) else { break };
            let uri = resolve_url(base, raw).ok_or(StreamError::Unsupported)?;
            let (width, height) = match attr(&attrs, "RESOLUTION").and_then(|r| r.split_once(['x', 'X'])) {
                Some((w, h)) => (w.trim().parse().ok(), h.trim().parse().ok()),
                None => (None, None),
            };
            variants.push(Variant {
                index: variants.len(),
                uri,
                bandwidth: attr(&attrs, "BANDWIDTH").and_then(|v| v.parse().ok()).unwrap_or(0),
                avg_bandwidth: attr(&attrs, "AVERAGE-BANDWIDTH").and_then(|v| v.parse().ok()),
                width,
                height,
                codecs: attr(&attrs, "CODECS").map(str::to_string).filter(|c| !c.is_empty()),
                audio_group: attr(&attrs, "AUDIO").map(str::to_string),
            });
            if variants.len() > 200 {
                return Err(StreamError::Unsupported);
            }
            i = j + 1;
            continue;
        }
        if let Some(rest) = l.strip_prefix("#EXT-X-MEDIA:") {
            let attrs = parse_attrs(rest);
            if attr(&attrs, "TYPE") == Some("AUDIO") {
                let uri = match attr(&attrs, "URI").filter(|u| !u.is_empty()) {
                    Some(u) => Some(resolve_url(base, u).ok_or(StreamError::Unsupported)?),
                    None => None,
                };
                audio.push(AudioEntry {
                    index: audio.len(),
                    group: attr(&attrs, "GROUP-ID").unwrap_or("").to_string(),
                    name: attr(&attrs, "NAME").map(str::to_string),
                    lang: attr(&attrs, "LANGUAGE").map(str::to_string),
                    uri,
                    default: attr(&attrs, "DEFAULT") == Some("YES"),
                });
            }
        }
        i += 1;
    }
    if variants.is_empty() {
        return Err(StreamError::Unsupported);
    }
    Ok(Master { variants, audio })
}

fn parse_media(lines: &[&str], base: &str) -> Result<MediaPlan, StreamError> {
    let mut media_seq: u64 = 0;
    let mut key: Option<KeyState> = None;
    let mut map: Option<(String, Option<(u64, u64)>, Option<KeyState>)> = None;
    let mut pending_dur = 0.0_f64;
    let mut pending_range: Option<(u64, Option<u64>)> = None;
    // The resource and end offset of the previous byte range, for a range with no offset.
    let mut last_range_end: Option<(String, u64)> = None;
    let mut endlist = false;
    let mut duration = 0.0_f64;
    let mut segments: Vec<Segment> = Vec::new();
    let mut map_key_seq: Option<u64> = None;

    for l in lines {
        if let Some(rest) = l.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_seq = rest.trim().parse().map_err(|_| StreamError::Unsupported)?;
        } else if let Some(rest) = l.strip_prefix("#EXT-X-KEY:") {
            key = parse_key(&parse_attrs(rest), base)?;
        } else if let Some(rest) = l.strip_prefix("#EXT-X-MAP:") {
            let attrs = parse_attrs(rest);
            let raw = attr(&attrs, "URI").ok_or(StreamError::Unsupported)?;
            let uri = resolve_url(base, raw).ok_or(StreamError::Unsupported)?;
            let range = match attr(&attrs, "BYTERANGE") {
                Some(r) => {
                    let (len, off) = parse_byterange(r).ok_or(StreamError::Unsupported)?;
                    Some((off.unwrap_or(0), len))
                }
                None => None,
            };
            map = Some((uri, range, key.clone()));
            map_key_seq = Some(media_seq + segments.len() as u64);
        } else if let Some(rest) = l.strip_prefix("#EXTINF:") {
            let d = rest.split(',').next().unwrap_or("").trim();
            pending_dur = d.parse().unwrap_or(0.0);
        } else if let Some(rest) = l.strip_prefix("#EXT-X-BYTERANGE:") {
            pending_range = Some(parse_byterange(rest).ok_or(StreamError::Unsupported)?);
        } else if l.starts_with("#EXT-X-ENDLIST") {
            endlist = true;
        } else if l.starts_with("#EXT-X-I-FRAMES-ONLY") {
            return Err(StreamError::Unsupported);
        } else if l.starts_with('#') {
            // #EXT-X-DISCONTINUITY, #EXT-X-TARGETDURATION, #EXT-X-VERSION, comments: nothing to do.
            // TS segments are simply concatenated across a discontinuity.
        } else {
            if segments.len() >= MAX_SEGMENTS {
                return Err(StreamError::Unsupported);
            }
            let url = resolve_url(base, l).ok_or(StreamError::Unsupported)?;
            let seq = media_seq + segments.len() as u64;
            let range = match pending_range.take() {
                Some((len, Some(off))) => Some((off, len)),
                Some((len, None)) => match &last_range_end {
                    Some((u, end)) if *u == url => Some((*end, len)),
                    _ => return Err(StreamError::Unsupported),
                },
                None => None,
            };
            if let Some((off, len)) = range {
                last_range_end = Some((url.clone(), off + len));
            }
            let seg_key = key.as_ref().map(|k| SegKey { uri: k.uri.clone(), iv: k.iv.unwrap_or_else(|| iv_from_sequence(seq)) });
            segments.push(Segment { url, range, key: seg_key, whole_file: false });
            duration += pending_dur;
            pending_dur = 0.0;
        }
    }
    if segments.is_empty() {
        return Err(StreamError::Unsupported);
    }
    if !endlist {
        return Err(StreamError::Live);
    }
    let init = match map {
        Some((url, range, k)) => {
            // The init segment uses the key in effect where the map tag stood; with no IV, the sequence number of
            // the segment that follows it.
            let seq = map_key_seq.unwrap_or(media_seq);
            let seg_key = k.map(|k| SegKey { uri: k.uri, iv: k.iv.unwrap_or_else(|| iv_from_sequence(seq)) });
            Some(Segment { url, range, key: seg_key, whole_file: false })
        }
        None => None,
    };
    let fmp4 = init.is_some() || segments.first().map(|s| is_fmp4_name(&s.url)).unwrap_or(false);
    Ok(MediaPlan { init, segments, duration_sec: duration, fmp4 })
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://cdn.test/v/index.m3u8";

    fn media(text: &str) -> Result<MediaPlan, StreamError> {
        match parse(text, BASE)? {
            Doc::Media(m) => Ok(m),
            Doc::Master(_) => panic!("expected a media playlist"),
        }
    }

    #[test]
    fn attributes_keep_commas_inside_quotes() {
        let a = parse_attrs("BANDWIDTH=800000,CODECS=\"avc1.4d401e,mp4a.40.2\",RESOLUTION=640x360,AUDIO=\"aud\"");
        assert_eq!(attr(&a, "BANDWIDTH"), Some("800000"));
        assert_eq!(attr(&a, "CODECS"), Some("avc1.4d401e,mp4a.40.2"));
        assert_eq!(attr(&a, "RESOLUTION"), Some("640x360"));
        assert_eq!(attr(&a, "AUDIO"), Some("aud"));
        assert_eq!(a.len(), 4);
    }

    #[test]
    fn master_lists_variants_and_audio_groups() {
        let text = "#EXTM3U\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English, main\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"\n\
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID=\"s\",NAME=\"x\",URI=\"s.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS=\"avc1.64001f,mp4a.40.2\",AUDIO=\"aud\"\n\
720/index.m3u8\n\
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100,URI=\"iframe.m3u8\"\n\
#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\n\
# a comment\n\
https://other.test/360.m3u8\n";
        let Doc::Master(m) = parse(text, BASE).unwrap() else { panic!("master") };
        assert_eq!(m.variants.len(), 2);
        assert_eq!(m.variants[0].uri, "https://cdn.test/v/720/index.m3u8");
        assert_eq!(m.variants[0].height, Some(720));
        assert_eq!(m.variants[0].width, Some(1280));
        assert_eq!(m.variants[0].avg_bandwidth, Some(1_800_000));
        assert_eq!(m.variants[0].audio_group.as_deref(), Some("aud"));
        assert_eq!(m.variants[1].uri, "https://other.test/360.m3u8");
        assert_eq!(m.variants[1].index, 1);
        assert_eq!(m.audio.len(), 1);
        assert_eq!(m.audio[0].name.as_deref(), Some("English, main"));
        assert_eq!(m.audio[0].uri.as_deref(), Some("https://cdn.test/v/audio/en.m3u8"));
        assert!(m.audio[0].default);
    }

    #[test]
    fn media_playlist_with_map_and_endlist() {
        let text = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI=\"init.mp4\"\n\
#EXTINF:4.0,\nseg10.m4s\n#EXTINF:3.5,\nhttps://cdn2.test/seg11.m4s\n#EXT-X-ENDLIST\n";
        let m = media(text).unwrap();
        assert_eq!(m.init.as_ref().unwrap().url, "https://cdn.test/v/init.mp4");
        assert_eq!(m.segments.len(), 2);
        assert_eq!(m.segments[0].url, "https://cdn.test/v/seg10.m4s");
        assert_eq!(m.segments[1].url, "https://cdn2.test/seg11.m4s");
        assert!((m.duration_sec - 7.5).abs() < 1e-9);
        assert!(m.fmp4);
        assert_eq!(m.items().len(), 3);
        assert_eq!(m.items()[0].url, "https://cdn.test/v/init.mp4");
    }

    #[test]
    fn ts_playlist_is_not_fmp4_and_discontinuity_is_fine() {
        let text = "#EXTM3U\n#EXTINF:2,\na.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nb.ts\n#EXT-X-ENDLIST";
        let m = media(text).unwrap();
        assert!(!m.fmp4);
        assert_eq!(m.segments.len(), 2);
        assert!(m.init.is_none());
    }

    #[test]
    fn byterange_with_and_without_offset() {
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"f.mp4\",BYTERANGE=\"720@0\"\n\
#EXTINF:2,\n#EXT-X-BYTERANGE:1000@720\nf.mp4\n\
#EXTINF:2,\n#EXT-X-BYTERANGE:500\nf.mp4\n#EXT-X-ENDLIST";
        let m = media(text).unwrap();
        assert_eq!(m.init.as_ref().unwrap().range, Some((0, 720)));
        assert_eq!(m.segments[0].range, Some((720, 1000)));
        assert_eq!(m.segments[1].range, Some((1720, 500)));
    }

    #[test]
    fn byterange_without_offset_and_no_previous_is_unsupported() {
        let text = "#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:500\nf.ts\n#EXT-X-ENDLIST";
        assert_eq!(media(text), Err(StreamError::Unsupported));
    }

    #[test]
    fn no_endlist_is_live() {
        let text = "#EXTM3U\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n";
        assert_eq!(media(text), Err(StreamError::Live));
    }

    #[test]
    fn key_method_none_is_fine() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST";
        let m = media(text).unwrap();
        assert!(m.segments[0].key.is_none());
    }

    #[test]
    fn aes128_gives_a_key_and_an_iv_per_segment() {
        let text = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"keys/k1.bin\"\n#EXTINF:2,\na.ts\n#EXTINF:2,\nb.ts\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"https://k.test/k2\",IV=0x000102030405060708090A0B0C0D0E0F\n#EXTINF:2,\nc.ts\n\
#EXT-X-KEY:METHOD=NONE\n#EXTINF:2,\nd.ts\n#EXT-X-ENDLIST";
        let m = media(text).unwrap();
        let k0 = m.segments[0].key.as_ref().unwrap();
        assert_eq!(k0.uri, "https://cdn.test/v/keys/k1.bin");
        assert_eq!(k0.iv, iv_from_sequence(7));
        assert_eq!(m.segments[1].key.as_ref().unwrap().iv, iv_from_sequence(8));
        let k2 = m.segments[2].key.as_ref().unwrap();
        assert_eq!(k2.uri, "https://k.test/k2");
        assert_eq!(k2.iv[15], 0x0f);
        assert_eq!(k2.iv[0], 0);
        assert_eq!(k2.iv[1], 1);
        assert!(m.segments[3].key.is_none());
    }

    #[test]
    fn iv_from_the_sequence_number_is_128_bit_big_endian() {
        let iv = iv_from_sequence(0x0102);
        assert_eq!(&iv[..14], &[0u8; 14]);
        assert_eq!(iv[14], 1);
        assert_eq!(iv[15], 2);
        let big = iv_from_sequence(u64::MAX);
        assert_eq!(&big[..8], &[0u8; 8]);
        assert_eq!(&big[8..], &[0xff; 8]);
    }

    #[test]
    fn iv_attribute_parsing() {
        assert_eq!(parse_iv("0x1").unwrap()[15], 1);
        assert!(parse_iv("1234").is_none());
        assert!(parse_iv("0x").is_none());
        assert!(parse_iv("0xzz").is_none());
        assert!(parse_iv(&format!("0x{}", "1".repeat(33))).is_none());
    }

    #[test]
    fn the_map_segment_is_decrypted_with_the_key_in_effect() {
        let text = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\"\n#EXT-X-MAP:URI=\"i.mp4\"\n\
#EXTINF:2,\na.m4s\n#EXT-X-ENDLIST";
        let m = media(text).unwrap();
        let ik = m.init.as_ref().unwrap().key.as_ref().unwrap();
        assert_eq!(ik.uri, "https://cdn.test/v/k");
        assert_eq!(ik.iv, iv_from_sequence(3));
    }

    #[test]
    fn sample_aes_and_other_formats_are_protected() {
        for k in [
            "METHOD=SAMPLE-AES,URI=\"skd://x\"",
            "METHOD=SAMPLE-AES-CTR,URI=\"https://k.test/k\"",
            "METHOD=AES-128,URI=\"https://k.test/k\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
            "METHOD=AES-128,URI=\"skd://abc\"",
            "METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"",
            "METHOD=SOMETHING-NEW,URI=\"https://k.test/k\"",
        ] {
            let text = format!("#EXTM3U\n#EXT-X-KEY:{k}\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST");
            assert_eq!(media(&text), Err(StreamError::Protected), "{k}");
        }
    }

    #[test]
    fn keyformat_identity_is_allowed() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\",KEYFORMAT=\"identity\"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST";
        assert!(media(text).unwrap().segments[0].key.is_some());
    }

    #[test]
    fn a_bad_iv_or_missing_uri_is_unsupported() {
        let bad_iv = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k\",IV=nothex\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST";
        assert_eq!(media(bad_iv), Err(StreamError::Unsupported));
        let no_uri = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST";
        assert_eq!(media(no_uri), Err(StreamError::Unsupported));
    }

    #[test]
    fn empty_and_odd_input_is_unsupported() {
        assert_eq!(media("#EXTM3U\n#EXT-X-ENDLIST"), Err(StreamError::Unsupported));
        assert!(parse("<html>", BASE).is_err());
        assert!(parse("#EXTM3U\n#EXT-X-I-FRAMES-ONLY\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST", BASE).is_err());
    }

    #[test]
    fn too_many_segments_are_refused() {
        let mut text = String::from("#EXTM3U\n");
        for i in 0..(MAX_SEGMENTS + 1) {
            text.push_str(&format!("#EXTINF:1,\ns{i}.ts\n"));
        }
        text.push_str("#EXT-X-ENDLIST\n");
        assert_eq!(media(&text), Err(StreamError::Unsupported));
    }
}
