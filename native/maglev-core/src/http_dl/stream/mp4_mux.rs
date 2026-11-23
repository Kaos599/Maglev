//! Fast pure-Rust zero-re-encode fMP4 + `tx3g` multi-language subtitle muxer.
//!
//! Combines YouTube fragmented MP4 video and/or audio part files plus any number of
//! subtitle tracks (parsed from YouTube `srv3` XML) into a single fast-start standard
//! ISO/IEC 14496-12 `.mp4` with embedded `tx3g` (`sbtl`) subtitle tracks selectable in
//! 3rd-party players (VLC, MX Player, mpv, Nova, ExoPlayer, etc.).
//!
//! Pass 1 scans only the small `moov` and `moof` headers by seeking over every `mdat`
//! (~3 ms even for a 500 MB file). Pass 2 writes `ftyp` + `moov` (with 64-bit `co64`
//! offsets) followed by a bulk-buffered sequential copy of interleaved `mdat` slices
//! (4 MiB buffer), completing in well under a second.

use std::fs::File;
use std::io::{self, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

/// One parsed subtitle cue in milliseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// One subtitle language track to embed as an MP4 `tx3g` (`sbtl`) track.
#[derive(Debug, Clone)]
pub struct SubtitleTrack {
    /// BCP-47 language code from YouTube (e.g. "en", "ms", "id", "ja", "zh-Hans").
    pub lang: String,
    /// Human-readable display name (e.g. "English", "Malay", "Japanese").
    pub name: String,
    pub cues: Vec<SubCue>,
}

/// Parses YouTube `srv3` XML (`<timedtext format="3">`) into clean, non-overlapping cues.
pub fn parse_srv3_xml(xml: &str) -> Vec<SubCue> {
    let Ok(doc) = roxmltree::Document::parse(xml) else {
        return Vec::new();
    };
    let mut raw: Vec<SubCue> = Vec::new();
    for node in doc.descendants() {
        if !node.is_element() || node.tag_name().name() != "p" {
            continue;
        }
        let Some(start_ms) = node.attribute("t").and_then(|v| v.parse::<u64>().ok()) else {
            continue;
        };
        let dur_ms = node.attribute("d").and_then(|v| v.parse::<u64>().ok()).unwrap_or(2000);
        if dur_ms == 0 {
            continue;
        }
        let mut text = String::new();
        for desc in node.descendants() {
            if desc.is_text() {
                if let Some(t) = desc.text() {
                    text.push_str(t);
                }
            }
        }
        let cleaned = text
            .replace("\r\n", "\n")
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if cleaned.is_empty() {
            continue;
        }
        raw.push(SubCue { start_ms, end_ms: start_ms.saturating_add(dur_ms), text: cleaned });
    }
    raw.sort_by_key(|c| c.start_ms);

    // Clamp overlapping cues (common in YouTube ASR auto-captions) and drop zero-length ones.
    let mut out: Vec<SubCue> = Vec::with_capacity(raw.len());
    for i in 0..raw.len() {
        let mut c = raw[i].clone();
        if let Some(next) = raw.get(i + 1) {
            if c.end_ms > next.start_ms {
                c.end_ms = next.start_ms;
            }
        }
        if c.end_ms > c.start_ms {
            out.push(c);
        }
    }
    out
}

/// Maps BCP-47 language codes (YouTube `languageCode`) to ISO 639-2/T 3-letter codes for MP4 `mdhd`.
pub fn bcp47_to_iso639_2(code: &str) -> [u8; 3] {
    let primary = code.trim().to_ascii_lowercase();
    let base = primary.split(['-', '_']).next().unwrap_or("");
    let iso: &[u8; 3] = match base {
        "en" => b"eng",
        "ms" | "zsm" => b"msa",
        "id" | "in" => b"ind",
        "ja" => b"jpn",
        "ko" => b"kor",
        "zh" => b"zho",
        "es" => b"spa",
        "fr" => b"fra",
        "de" => b"deu",
        "ar" => b"ara",
        "pt" => b"por",
        "ru" => b"rus",
        "hi" => b"hin",
        "bn" => b"ben",
        "th" => b"tha",
        "vi" => b"vie",
        "tr" => b"tur",
        "it" => b"ita",
        "nl" => b"nld",
        "pl" => b"pol",
        "uk" => b"ukr",
        "sv" => b"swe",
        "no" | "nb" | "nn" => b"nor",
        "da" => b"dan",
        "fi" => b"fin",
        "cs" => b"ces",
        "ro" => b"ron",
        "hu" => b"hun",
        "el" => b"ell",
        "he" | "iw" => b"heb",
        "fa" => b"fas",
        "ur" => b"urd",
        "ta" => b"tam",
        "te" => b"tel",
        "ml" => b"mal",
        "kn" => b"kan",
        "mr" => b"mar",
        "gu" => b"guj",
        "pa" => b"pan",
        "tl" | "fil" => b"fil",
        "my" => b"mya",
        "km" => b"khm",
        "lo" => b"lao",
        "jv" => b"jav",
        "su" => b"sun",
        "sw" => b"swa",
        "af" => b"afr",
        "bg" => b"bul",
        "hr" => b"hrv",
        "sr" => b"srp",
        "sk" => b"slk",
        "sl" => b"slv",
        "et" => b"est",
        "lv" => b"lav",
        "lt" => b"lit",
        "ca" => b"cat",
        "eu" => b"eus",
        "gl" => b"glg",
        "is" => b"isl",
        "ga" => b"gle",
        "cy" => b"cym",
        "ka" => b"kat",
        "hy" => b"hye",
        "az" => b"aze",
        "kk" => b"kaz",
        "uz" => b"uzb",
        "mn" => b"mon",
        "ne" => b"nep",
        "si" => b"sin",
        other if other.len() == 3 && other.bytes().all(|b| b.is_ascii_lowercase()) => {
            let b = other.as_bytes();
            return [b[0], b[1], b[2]];
        }
        _ => b"und",
    };
    *iso
}

fn pack_iso639(lang: [u8; 3]) -> u16 {
    let c0 = (lang[0].saturating_sub(0x60) & 0x1F) as u16;
    let c1 = (lang[1].saturating_sub(0x60) & 0x1F) as u16;
    let c2 = (lang[2].saturating_sub(0x60) & 0x1F) as u16;
    (c0 << 10) | (c1 << 5) | c2
}

// ---- Low-level MP4 box reading/writing helpers ----

fn u16_be(b: &[u8], off: usize) -> io::Result<u16> {
    let s = b.get(off..off + 2).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "u16"))?;
    Ok(u16::from_be_bytes([s[0], s[1]]))
}

fn u32_be(b: &[u8], off: usize) -> io::Result<u32> {
    let s = b.get(off..off + 4).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "u32"))?;
    Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn i32_be(b: &[u8], off: usize) -> io::Result<i32> {
    let s = b.get(off..off + 4).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "i32"))?;
    Ok(i32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn u64_be(b: &[u8], off: usize) -> io::Result<u64> {
    let s = b.get(off..off + 8).ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "u64"))?;
    Ok(u64::from_be_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
}

fn iter_boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 8 <= data.len() {
        let size32 = u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]) as u64;
        let typ = [data[off + 4], data[off + 5], data[off + 6], data[off + 7]];
        let (hdr, total) = if size32 == 1 {
            if off + 16 > data.len() {
                break;
            }
            let sz64 = u64::from_be_bytes([
                data[off + 8], data[off + 9], data[off + 10], data[off + 11],
                data[off + 12], data[off + 13], data[off + 14], data[off + 15],
            ]);
            (16usize, sz64 as usize)
        } else if size32 == 0 {
            (8usize, data.len() - off)
        } else {
            (8usize, size32 as usize)
        };
        if total < hdr || off + total > data.len() {
            break;
        }
        out.push((typ, &data[off + hdr..off + total]));
        off += total;
    }
    out
}

fn find_box<'a>(data: &'a [u8], target: &[u8; 4]) -> Option<&'a [u8]> {
    iter_boxes(data).into_iter().find(|(t, _)| t == target).map(|(_, body)| body)
}

fn find_box_raw<'a>(data: &'a [u8], target: &[u8; 4]) -> Option<&'a [u8]> {
    let mut off = 0usize;
    while off + 8 <= data.len() {
        let size32 = u32::from_be_bytes([data[off], data[off + 1], data[off + 2], data[off + 3]]) as usize;
        let typ = &data[off + 4..off + 8];
        let total = if size32 == 0 { data.len() - off } else { size32 };
        if total < 8 || off + total > data.len() {
            break;
        }
        if typ == target {
            return Some(&data[off..off + total]);
        }
        off += total;
    }
    None
}

fn wrap_box(typ: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let total = (8 + payload.len()) as u32;
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(typ);
    out.extend_from_slice(payload);
    out
}

fn wrap_fullbox(typ: &[u8; 4], version: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let total = (12 + body.len()) as u32;
    let mut out = Vec::with_capacity(total as usize);
    out.extend_from_slice(&total.to_be_bytes());
    out.extend_from_slice(typ);
    out.push(version);
    out.push(((flags >> 16) & 0xFF) as u8);
    out.push(((flags >> 8) & 0xFF) as u8);
    out.push((flags & 0xFF) as u8);
    out.extend_from_slice(body);
    out
}

// ---- Parsed input fMP4 structures ----

struct SampleMeta {
    size: u32,
    duration: u32,
    cto: i32,
    is_sync: bool,
}

struct FragChunk {
    src_offset: u64,
    byte_len: u64,
    sample_count: u32,
}

struct ParsedFmp4 {
    is_video: bool,
    timescale: u32,
    lang_packed: u16,
    width_fp: u32,
    height_fp: u32,
    matrix: [u8; 36],
    hdlr_type: [u8; 4],
    hdlr_name: Vec<u8>,
    media_header_raw: Vec<u8>,
    stsd_raw: Vec<u8>,
    elst_media_time: Option<i64>,
    samples: Vec<SampleMeta>,
    chunks: Vec<FragChunk>,
    total_duration: u64,
}

fn read_box_header<R: Read>(r: &mut R) -> io::Result<Option<([u8; 4], u64, u64)>> {
    let mut h = [0u8; 8];
    match r.read_exact(&mut h) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let sz32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let typ = [h[4], h[5], h[6], h[7]];
    if sz32 == 1 {
        let mut ext = [0u8; 8];
        r.read_exact(&mut ext)?;
        let sz64 = u64::from_be_bytes(ext);
        Ok(Some((typ, 16, sz64)))
    } else {
        Ok(Some((typ, 8, sz32)))
    }
}

fn parse_stbl_samples(
    stbl: &[u8],
    file_len: u64,
) -> io::Result<(Vec<SampleMeta>, Vec<FragChunk>, u64)> {
    // 1. stsz (sample sizes)
    let stsz = find_box(stbl, b"stsz")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing stsz"))?;
    if stsz.len() < 12 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "short stsz"));
    }
    let fixed_size = u32_be(stbl_slice(stsz, 0, 12)?, 4)?;
    let sample_count = u32_be(stsz, 8)? as usize;
    if sample_count == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "zero samples in stsz"));
    }
    let mut sizes = Vec::with_capacity(sample_count);
    if fixed_size > 0 {
        sizes.resize(sample_count, fixed_size);
    } else {
        if stsz.len() < 12 + sample_count * 4 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "truncated stsz table"));
        }
        for i in 0..sample_count {
            sizes.push(u32_be(stsz, 12 + i * 4)?);
        }
    }

    // 2. stts (decoding time-to-sample deltas)
    let stts = find_box(stbl, b"stts")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing stts"))?;
    if stts.len() < 8 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "short stts"));
    }
    let stts_count = u32_be(stts, 4)? as usize;
    let mut durations = Vec::with_capacity(sample_count);
    let mut total_duration = 0u64;
    for i in 0..stts_count {
        let off = 8 + i * 8;
        if off + 8 > stts.len() {
            break;
        }
        let cnt = u32_be(stts, off)? as usize;
        let delta = u32_be(stts, off + 4)?;
        let take = cnt.min(sample_count.saturating_sub(durations.len()));
        for _ in 0..take {
            durations.push(delta);
            total_duration += delta as u64;
        }
    }
    while durations.len() < sample_count {
        let last = durations.last().copied().unwrap_or(1024);
        durations.push(last);
        total_duration += last as u64;
    }

    // 3. ctts (optional composition time offsets)
    let mut ctos = vec![0i32; sample_count];
    if let Some(ctts) = find_box(stbl, b"ctts") {
        if ctts.len() >= 8 {
            let ver = ctts[0];
            let entry_count = u32_be(ctts, 4)? as usize;
            let mut idx = 0usize;
            for i in 0..entry_count {
                let off = 8 + i * 8;
                if off + 8 > ctts.len() || idx >= sample_count {
                    break;
                }
                let cnt = u32_be(ctts, off)? as usize;
                let val = if ver == 0 {
                    u32_be(ctts, off + 4)? as i32
                } else {
                    i32_be(ctts, off + 4)?
                };
                let take = cnt.min(sample_count - idx);
                for j in 0..take {
                    ctos[idx + j] = val;
                }
                idx += take;
            }
        }
    }

    // 4. stss (optional sync sample table; if absent, all samples are sync)
    let mut is_sync = vec![true; sample_count];
    if let Some(stss) = find_box(stbl, b"stss") {
        if stss.len() >= 8 {
            is_sync.fill(false);
            let sync_count = u32_be(stss, 4)? as usize;
            for i in 0..sync_count {
                let off = 8 + i * 4;
                if off + 4 > stss.len() {
                    break;
                }
                let s_idx = (u32_be(stss, off)? as usize).saturating_sub(1);
                if s_idx < sample_count {
                    is_sync[s_idx] = true;
                }
            }
        }
    }

    // 5. stco (32-bit) or co64 (64-bit) chunk offsets
    let mut chunk_offsets: Vec<u64> = Vec::new();
    if let Some(stco) = find_box(stbl, b"stco") {
        if stco.len() >= 8 {
            let cnt = u32_be(stco, 4)? as usize;
            chunk_offsets.reserve(cnt);
            for i in 0..cnt {
                let off = 8 + i * 4;
                if off + 4 > stco.len() {
                    break;
                }
                chunk_offsets.push(u32_be(stco, off)? as u64);
            }
        }
    } else if let Some(co64) = find_box(stbl, b"co64") {
        if co64.len() >= 8 {
            let cnt = u32_be(co64, 4)? as usize;
            chunk_offsets.reserve(cnt);
            for i in 0..cnt {
                let off = 8 + i * 8;
                if off + 8 > co64.len() {
                    break;
                }
                chunk_offsets.push(u64_be(co64, off)?);
            }
        }
    }
    if chunk_offsets.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "missing stco/co64"));
    }

    // 6. stsc (sample-to-chunk RLE table)
    let stsc = find_box(stbl, b"stsc")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing stsc"))?;
    if stsc.len() < 8 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "short stsc"));
    }
    let stsc_count = u32_be(stsc, 4)? as usize;
    let mut stsc_runs: Vec<(usize, u32)> = Vec::with_capacity(stsc_count);
    for i in 0..stsc_count {
        let off = 8 + i * 12;
        if off + 12 > stsc.len() {
            break;
        }
        let first_chunk = (u32_be(stsc, off)? as usize).saturating_sub(1);
        let spc = u32_be(stsc, off + 4)?;
        stsc_runs.push((first_chunk, spc));
    }
    if stsc_runs.is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "empty stsc"));
    }

    let mut chunks: Vec<FragChunk> = Vec::with_capacity(chunk_offsets.len());
    let mut sample_cursor = 0usize;
    for (ci, &src_offset) in chunk_offsets.iter().enumerate() {
        if sample_cursor >= sample_count {
            break;
        }
        let mut spc = stsc_runs[0].1;
        for &(fc, count) in &stsc_runs {
            if ci >= fc {
                spc = count;
            } else {
                break;
            }
        }
        let take = (spc as usize).min(sample_count - sample_cursor);
        if take == 0 {
            continue;
        }
        let mut byte_len = 0u64;
        for s in &sizes[sample_cursor..sample_cursor + take] {
            byte_len += *s as u64;
        }
        if src_offset + byte_len > file_len {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "stco chunk past EOF"));
        }
        chunks.push(FragChunk {
            src_offset,
            byte_len,
            sample_count: take as u32,
        });
        sample_cursor += take;
    }

    let used_samples = sample_cursor.min(sample_count);
    let mut samples = Vec::with_capacity(used_samples);
    for i in 0..used_samples {
        samples.push(SampleMeta {
            size: sizes[i],
            duration: durations[i],
            cto: ctos[i],
            is_sync: is_sync[i],
        });
    }
    Ok((samples, chunks, total_duration))
}

fn stbl_slice(b: &[u8], start: usize, end: usize) -> io::Result<&[u8]> {
    b.get(start..end)
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "stbl slice"))
}

fn find_trak_by_handler<'a>(moov: &'a [u8], want_handler: Option<&[u8; 4]>) -> Option<&'a [u8]> {
    let mut first_trak: Option<&'a [u8]> = None;
    for (typ, body) in iter_boxes(moov) {
        if &typ != b"trak" {
            continue;
        }
        if first_trak.is_none() {
            first_trak = Some(body);
        }
        let Some(want) = want_handler else {
            return Some(body);
        };
        if let Some(mdia) = find_box(body, b"mdia") {
            if let Some(hdlr) = find_box(mdia, b"hdlr") {
                if hdlr.len() >= 12 && &hdlr[8..12] == want {
                    return Some(body);
                }
            }
        }
    }
    if want_handler.is_none() {
        first_trak
    } else {
        None
    }
}

fn parse_fmp4(path: &Path) -> io::Result<ParsedFmp4> {
    parse_fmp4_for_handler(path, None)
}

fn parse_fmp4_for_handler(path: &Path, want_handler: Option<&[u8; 4]>) -> io::Result<ParsedFmp4> {
    let mut f = File::open(path)?;
    let file_len = f.metadata()?.len();

    let mut moov_bytes: Option<Vec<u8>> = None;
    let mut trex_dur = 0u32;
    let mut trex_size = 0u32;
    let mut trex_flags = 0u32;

    let mut samples: Vec<SampleMeta> = Vec::new();
    let mut chunks: Vec<FragChunk> = Vec::new();
    let mut total_duration = 0u64;

    let mut pos = 0u64;
    while pos + 8 <= file_len {
        f.seek(SeekFrom::Start(pos))?;
        let Some((typ, hdr_len, raw_sz)) = read_box_header(&mut f)? else {
            break;
        };
        let box_len = if raw_sz == 0 { file_len - pos } else { raw_sz };
        if box_len < hdr_len || pos + box_len > file_len {
            break;
        }
        let body_len = (box_len - hdr_len) as usize;

        if &typ == b"moov" {
            if body_len > 32 * 1024 * 1024 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "moov too large"));
            }
            let mut buf = vec![0u8; body_len];
            f.read_exact(&mut buf)?;
            if let Some(mvex) = find_box(&buf, b"mvex") {
                if let Some(trex) = find_box(mvex, b"trex") {
                    if trex.len() >= 24 {
                        trex_dur = u32_be(trex, 12)?;
                        trex_size = u32_be(trex, 16)?;
                        trex_flags = u32_be(trex, 20)?;
                    }
                }
            }
            moov_bytes = Some(buf);
        } else if &typ == b"moof" {
            if body_len > 8 * 1024 * 1024 {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "moof too large"));
            }
            let mut buf = vec![0u8; body_len];
            f.read_exact(&mut buf)?;
            for (ctyp, cbody) in iter_boxes(&buf) {
                if &ctyp != b"traf" {
                    continue;
                }
                let Some(tfhd) = find_box(cbody, b"tfhd") else {
                    continue;
                };
                if tfhd.len() < 8 {
                    continue;
                }
                let tfhd_flags = ((tfhd[1] as u32) << 16) | ((tfhd[2] as u32) << 8) | (tfhd[3] as u32);
                let mut toff = 8usize;
                let base_data_offset = if tfhd_flags & 0x000001 != 0 {
                    let v = u64_be(tfhd, toff)?;
                    toff += 8;
                    Some(v)
                } else {
                    None
                };
                if tfhd_flags & 0x000002 != 0 {
                    toff += 4; // sample_description_index
                }
                let def_dur = if tfhd_flags & 0x000008 != 0 {
                    let v = u32_be(tfhd, toff)?;
                    toff += 4;
                    v
                } else {
                    trex_dur
                };
                let def_size = if tfhd_flags & 0x000010 != 0 {
                    let v = u32_be(tfhd, toff)?;
                    toff += 4;
                    v
                } else {
                    trex_size
                };
                let def_flags = if tfhd_flags & 0x000020 != 0 {
                    u32_be(tfhd, toff)?
                } else {
                    trex_flags
                };

                let base = base_data_offset.unwrap_or(pos);
                let mut implicit_off = base;

                for (ttyp, trun) in iter_boxes(cbody) {
                    if &ttyp != b"trun" || trun.len() < 8 {
                        continue;
                    }
                    let version = trun[0];
                    let flags = ((trun[1] as u32) << 16) | ((trun[2] as u32) << 8) | (trun[3] as u32);
                    let count = u32_be(trun, 4)?;
                    if count == 0 {
                        continue;
                    }
                    let mut roff = 8usize;
                    let data_off = if flags & 0x000001 != 0 {
                        let d = i32_be(trun, roff)?;
                        roff += 4;
                        (base as i128 + d as i128) as u64
                    } else {
                        implicit_off
                    };
                    let first_flags = if flags & 0x000004 != 0 {
                        let fl = u32_be(trun, roff)?;
                        roff += 4;
                        Some(fl)
                    } else {
                        None
                    };

                    let mut chunk_bytes = 0u64;
                    samples.reserve(count as usize);
                    for i in 0..count {
                        let duration = if flags & 0x000100 != 0 {
                            let v = u32_be(trun, roff)?;
                            roff += 4;
                            v
                        } else {
                            def_dur
                        };
                        let size = if flags & 0x000200 != 0 {
                            let v = u32_be(trun, roff)?;
                            roff += 4;
                            v
                        } else {
                            def_size
                        };
                        let sflags = if flags & 0x000400 != 0 {
                            let v = u32_be(trun, roff)?;
                            roff += 4;
                            v
                        } else if i == 0 {
                            first_flags.unwrap_or(def_flags)
                        } else {
                            def_flags
                        };
                        let cto = if flags & 0x000800 != 0 {
                            let v = if version == 0 { u32_be(trun, roff)? as i32 } else { i32_be(trun, roff)? };
                            roff += 4;
                            v
                        } else {
                            0
                        };
                        let is_sync = (sflags & 0x0001_0000) == 0;
                        chunk_bytes += size as u64;
                        total_duration += duration as u64;
                        samples.push(SampleMeta { size, duration, cto, is_sync });
                    }
                    if data_off + chunk_bytes > file_len {
                        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "trun chunk past EOF"));
                    }
                    chunks.push(FragChunk { src_offset: data_off, byte_len: chunk_bytes, sample_count: count });
                    implicit_off = data_off + chunk_bytes;
                }
            }
        }
        pos += box_len;
    }

    let moov = moov_bytes.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing moov"))?;
    let trak = find_trak_by_handler(&moov, want_handler)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing trak"))?;
    let tkhd = find_box(trak, b"tkhd").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing tkhd"))?;
    let (matrix_off, wh_off) = if tkhd[0] == 1 { (52usize, 88usize) } else { (40usize, 76usize) };
    let mut matrix = [0u8; 36];
    if let Some(m) = tkhd.get(matrix_off..matrix_off + 36) {
        matrix.copy_from_slice(m);
    } else {
        // Identity matrix
        matrix[0..4].copy_from_slice(&0x00010000u32.to_be_bytes());
        matrix[16..20].copy_from_slice(&0x00010000u32.to_be_bytes());
        matrix[32..36].copy_from_slice(&0x40000000u32.to_be_bytes());
    }
    let width_fp = u32_be(tkhd, wh_off).unwrap_or(0);
    let height_fp = u32_be(tkhd, wh_off + 4).unwrap_or(0);

    // Optional edit list (preserves B-frame / AAC priming offset).
    let elst_media_time = find_box(trak, b"edts")
        .and_then(|edts| find_box(edts, b"elst"))
        .and_then(|elst| {
            if elst.len() < 8 {
                return None;
            }
            let ver = elst[0];
            let entry_count = u32_be(elst, 4).ok()?;
            if entry_count == 0 {
                return None;
            }
            if ver == 1 && elst.len() >= 28 {
                let mt = i64::from_be_bytes(elst[16..24].try_into().ok()?);
                if mt > 0 { Some(mt) } else { None }
            } else if ver == 0 && elst.len() >= 20 {
                let mt = i32_be(elst, 12).ok()? as i64;
                if mt > 0 { Some(mt) } else { None }
            } else {
                None
            }
        });

    let mdia = find_box(trak, b"mdia").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing mdia"))?;
    let mdhd = find_box(mdia, b"mdhd").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing mdhd"))?;
    let (timescale, lang_packed) = if mdhd[0] == 1 {
        (u32_be(mdhd, 20)?, u16_be(mdhd, 32).unwrap_or(0x55C4))
    } else {
        (u32_be(mdhd, 12)?, u16_be(mdhd, 20).unwrap_or(0x55C4))
    };
    if timescale == 0 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "zero timescale"));
    }

    let hdlr = find_box(mdia, b"hdlr").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing hdlr"))?;
    if hdlr.len() < 24 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "short hdlr"));
    }
    let hdlr_type = [hdlr[8], hdlr[9], hdlr[10], hdlr[11]];
    if let Some(want) = want_handler {
        if &hdlr_type != want {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "requested track handler not found"));
        }
    }
    let is_video = &hdlr_type == b"vide";
    let hdlr_name = hdlr[24..].to_vec();

    let minf = find_box(mdia, b"minf").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing minf"))?;
    let media_header_raw = if is_video {
        find_box_raw(minf, b"vmhd").map(|s| s.to_vec()).unwrap_or_else(default_vmhd)
    } else {
        find_box_raw(minf, b"smhd").map(|s| s.to_vec()).unwrap_or_else(default_smhd)
    };
    let stbl = find_box(minf, b"stbl").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing stbl"))?;
    let stsd_raw = find_box_raw(stbl, b"stsd")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "missing stsd"))?
        .to_vec();

    // If no fMP4 `moof` fragments were present (or a specific track in a progressive MP4 was requested),
    // parse sample tables directly from `stbl`.
    if samples.is_empty() || chunks.is_empty() {
        let (s, c, td) = parse_stbl_samples(stbl, file_len)?;
        samples = s;
        chunks = c;
        total_duration = td;
    }

    Ok(ParsedFmp4 {
        is_video,
        timescale,
        lang_packed,
        width_fp,
        height_fp,
        matrix,
        hdlr_type,
        hdlr_name,
        media_header_raw,
        stsd_raw,
        elst_media_time,
        samples,
        chunks,
        total_duration,
    })
}

fn default_vmhd() -> Vec<u8> {
    wrap_fullbox(b"vmhd", 0, 1, &[0u8; 8])
}

fn default_smhd() -> Vec<u8> {
    wrap_fullbox(b"smhd", 0, 0, &[0u8; 4])
}

fn build_dinf() -> Vec<u8> {
    let url = wrap_fullbox(b"url ", 0, 1, &[]);
    let mut dref_body = Vec::with_capacity(4 + url.len());
    dref_body.extend_from_slice(&1u32.to_be_bytes());
    dref_body.extend_from_slice(&url);
    let dref = wrap_fullbox(b"dref", 0, 0, &dref_body);
    wrap_box(b"dinf", &dref)
}

fn build_ftyp() -> Vec<u8> {
    let mut body = Vec::with_capacity(24);
    body.extend_from_slice(b"isom");
    body.extend_from_slice(&0x0000_0200u32.to_be_bytes());
    body.extend_from_slice(b"isom");
    body.extend_from_slice(b"iso2");
    body.extend_from_slice(b"avc1");
    body.extend_from_slice(b"mp41");
    wrap_box(b"ftyp", &body)
}

fn build_mvhd(movie_dur_ms: u64, next_track_id: u32) -> Vec<u8> {
    let mut b = Vec::with_capacity(108);
    b.extend_from_slice(&0u64.to_be_bytes()); // creation_time
    b.extend_from_slice(&0u64.to_be_bytes()); // modification_time
    b.extend_from_slice(&1000u32.to_be_bytes()); // timescale = 1000 ms
    b.extend_from_slice(&movie_dur_ms.to_be_bytes());
    b.extend_from_slice(&0x0001_0000u32.to_be_bytes()); // rate 1.0
    b.extend_from_slice(&0x0100u16.to_be_bytes()); // volume 1.0
    b.extend_from_slice(&[0u8; 10]); // reserved
    // Identity matrix (36 bytes)
    let mut m = [0u8; 36];
    m[0..4].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    m[16..20].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    m[32..36].copy_from_slice(&0x4000_0000u32.to_be_bytes());
    b.extend_from_slice(&m);
    b.extend_from_slice(&[0u8; 24]); // pre_defined
    b.extend_from_slice(&next_track_id.to_be_bytes());
    wrap_fullbox(b"mvhd", 1, 0, &b)
}

fn build_tkhd(
    track_id: u32,
    dur_ms: u64,
    alt_group: u16,
    volume: u16,
    matrix: &[u8; 36],
    width_fp: u32,
    height_fp: u32,
) -> Vec<u8> {
    let mut b = Vec::with_capacity(92);
    b.extend_from_slice(&0u64.to_be_bytes()); // creation
    b.extend_from_slice(&0u64.to_be_bytes()); // modification
    b.extend_from_slice(&track_id.to_be_bytes());
    b.extend_from_slice(&0u32.to_be_bytes()); // reserved
    b.extend_from_slice(&dur_ms.to_be_bytes());
    b.extend_from_slice(&[0u8; 8]); // reserved
    b.extend_from_slice(&0u16.to_be_bytes()); // layer
    b.extend_from_slice(&alt_group.to_be_bytes());
    b.extend_from_slice(&volume.to_be_bytes());
    b.extend_from_slice(&0u16.to_be_bytes()); // reserved
    b.extend_from_slice(matrix);
    b.extend_from_slice(&width_fp.to_be_bytes());
    b.extend_from_slice(&height_fp.to_be_bytes());
    wrap_fullbox(b"tkhd", 1, 0x000003, &b)
}

fn build_mdhd(timescale: u32, duration: u64, lang_packed: u16) -> Vec<u8> {
    let mut b = Vec::with_capacity(32);
    b.extend_from_slice(&0u64.to_be_bytes()); // creation
    b.extend_from_slice(&0u64.to_be_bytes()); // modification
    b.extend_from_slice(&timescale.to_be_bytes());
    b.extend_from_slice(&duration.to_be_bytes());
    b.extend_from_slice(&lang_packed.to_be_bytes());
    b.extend_from_slice(&0u16.to_be_bytes());
    wrap_fullbox(b"mdhd", 1, 0, &b)
}

fn build_hdlr(handler_type: &[u8; 4], name: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(20 + name.len() + 1);
    b.extend_from_slice(&0u32.to_be_bytes()); // pre_defined
    b.extend_from_slice(handler_type);
    b.extend_from_slice(&[0u8; 12]); // reserved
    b.extend_from_slice(name);
    if !name.ends_with(&[0]) {
        b.push(0);
    }
    wrap_fullbox(b"hdlr", 0, 0, &b)
}

fn build_media_trak(t: &ParsedFmp4, track_id: u32, chunk_offsets: &[u64]) -> Vec<u8> {
    let dur_ms = (t.total_duration as u128 * 1000 / t.timescale as u128) as u64;
    let volume = if t.is_video { 0 } else { 0x0100 };
    let tkhd = build_tkhd(track_id, dur_ms, 0, volume, &t.matrix, t.width_fp, t.height_fp);

    let edts = t.elst_media_time.map(|mt| {
        let mut eb = Vec::with_capacity(24);
        eb.extend_from_slice(&1u32.to_be_bytes()); // entry_count
        eb.extend_from_slice(&dur_ms.to_be_bytes()); // segment_duration
        eb.extend_from_slice(&mt.to_be_bytes()); // media_time
        eb.extend_from_slice(&1u16.to_be_bytes()); // media_rate_integer
        eb.extend_from_slice(&0u16.to_be_bytes()); // media_rate_fraction
        let elst = wrap_fullbox(b"elst", 1, 0, &eb);
        wrap_box(b"edts", &elst)
    });

    // stts (RLE)
    let mut stts_entries: Vec<(u32, u32)> = Vec::new();
    for s in &t.samples {
        if let Some(last) = stts_entries.last_mut() {
            if last.1 == s.duration {
                last.0 += 1;
                continue;
            }
        }
        stts_entries.push((1, s.duration));
    }
    let mut stts_body = Vec::with_capacity(4 + stts_entries.len() * 8);
    stts_body.extend_from_slice(&(stts_entries.len() as u32).to_be_bytes());
    for (c, d) in &stts_entries {
        stts_body.extend_from_slice(&c.to_be_bytes());
        stts_body.extend_from_slice(&d.to_be_bytes());
    }
    let stts = wrap_fullbox(b"stts", 0, 0, &stts_body);

    // ctts (if any composition time offset != 0)
    let has_cto = t.samples.iter().any(|s| s.cto != 0);
    let ctts = if has_cto {
        let has_neg = t.samples.iter().any(|s| s.cto < 0);
        let mut entries: Vec<(u32, i32)> = Vec::new();
        for s in &t.samples {
            if let Some(last) = entries.last_mut() {
                if last.1 == s.cto {
                    last.0 += 1;
                    continue;
                }
            }
            entries.push((1, s.cto));
        }
        let mut body = Vec::with_capacity(4 + entries.len() * 8);
        body.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for (c, o) in &entries {
            body.extend_from_slice(&c.to_be_bytes());
            body.extend_from_slice(&o.to_be_bytes());
        }
        Some(wrap_fullbox(b"ctts", if has_neg { 1 } else { 0 }, 0, &body))
    } else {
        None
    };

    // stss (keyframes for video)
    let stss = if t.is_video {
        let syncs: Vec<u32> = t
            .samples
            .iter()
            .enumerate()
            .filter(|(_, s)| s.is_sync)
            .map(|(i, _)| (i + 1) as u32)
            .collect();
        if !syncs.is_empty() && syncs.len() < t.samples.len() {
            let mut body = Vec::with_capacity(4 + syncs.len() * 4);
            body.extend_from_slice(&(syncs.len() as u32).to_be_bytes());
            for idx in syncs {
                body.extend_from_slice(&idx.to_be_bytes());
            }
            Some(wrap_fullbox(b"stss", 0, 0, &body))
        } else {
            None
        }
    } else {
        None
    };

    // stsc (RLE over chunks)
    let mut stsc_entries: Vec<(u32, u32)> = Vec::new();
    for (ci, ch) in t.chunks.iter().enumerate() {
        let first_chunk = (ci + 1) as u32;
        if stsc_entries.last().map(|(_, n)| *n == ch.sample_count).unwrap_or(false) {
            continue;
        }
        stsc_entries.push((first_chunk, ch.sample_count));
    }
    let mut stsc_body = Vec::with_capacity(4 + stsc_entries.len() * 12);
    stsc_body.extend_from_slice(&(stsc_entries.len() as u32).to_be_bytes());
    for (fc, spc) in stsc_entries {
        stsc_body.extend_from_slice(&fc.to_be_bytes());
        stsc_body.extend_from_slice(&spc.to_be_bytes());
        stsc_body.extend_from_slice(&1u32.to_be_bytes()); // sample_description_index
    }
    let stsc = wrap_fullbox(b"stsc", 0, 0, &stsc_body);

    // stsz
    let mut stsz_body = Vec::with_capacity(8 + t.samples.len() * 4);
    stsz_body.extend_from_slice(&0u32.to_be_bytes()); // variable size
    stsz_body.extend_from_slice(&(t.samples.len() as u32).to_be_bytes());
    for s in &t.samples {
        stsz_body.extend_from_slice(&s.size.to_be_bytes());
    }
    let stsz = wrap_fullbox(b"stsz", 0, 0, &stsz_body);

    // co64 (fixed 8 bytes per chunk so moov size never changes after computing offsets!)
    let mut co64_body = Vec::with_capacity(4 + chunk_offsets.len() * 8);
    co64_body.extend_from_slice(&(chunk_offsets.len() as u32).to_be_bytes());
    for off in chunk_offsets {
        co64_body.extend_from_slice(&off.to_be_bytes());
    }
    let co64 = wrap_fullbox(b"co64", 0, 0, &co64_body);

    let mut stbl_body = Vec::new();
    stbl_body.extend_from_slice(&t.stsd_raw);
    stbl_body.extend_from_slice(&stts);
    if let Some(c) = ctts {
        stbl_body.extend_from_slice(&c);
    }
    if let Some(s) = stss {
        stbl_body.extend_from_slice(&s);
    }
    stbl_body.extend_from_slice(&stsc);
    stbl_body.extend_from_slice(&stsz);
    stbl_body.extend_from_slice(&co64);
    let stbl = wrap_box(b"stbl", &stbl_body);

    let dinf = build_dinf();
    let mut minf_body = Vec::with_capacity(t.media_header_raw.len() + dinf.len() + stbl.len());
    minf_body.extend_from_slice(&t.media_header_raw);
    minf_body.extend_from_slice(&dinf);
    minf_body.extend_from_slice(&stbl);
    let minf = wrap_box(b"minf", &minf_body);

    let mdhd = build_mdhd(t.timescale, t.total_duration, t.lang_packed);
    let hdlr = build_hdlr(&t.hdlr_type, &t.hdlr_name);
    let mut mdia_body = Vec::with_capacity(mdhd.len() + hdlr.len() + minf.len());
    mdia_body.extend_from_slice(&mdhd);
    mdia_body.extend_from_slice(&hdlr);
    mdia_body.extend_from_slice(&minf);
    let mdia = wrap_box(b"mdia", &mdia_body);

    let mut trak_body = Vec::new();
    trak_body.extend_from_slice(&tkhd);
    if let Some(e) = edts {
        trak_body.extend_from_slice(&e);
    }
    trak_body.extend_from_slice(&mdia);
    wrap_box(b"trak", &trak_body)
}

// ---- tx3g (3GPP Timed Text / ISO 14496-12) embedded subtitle track builder ----

struct CompiledSubTrack {
    lang_iso3: [u8; 3],
    name: String,
    sample_durations: Vec<u32>,
    sample_sizes: Vec<u32>,
    mdat_blob: Vec<u8>,
    total_dur_ms: u64,
}

fn compile_subtitle_track(sub: &SubtitleTrack, movie_dur_ms: u64) -> Option<CompiledSubTrack> {
    if sub.cues.is_empty() {
        return None;
    }
    let mut sample_durations: Vec<u32> = Vec::new();
    let mut sample_sizes: Vec<u32> = Vec::new();
    let mut mdat_blob: Vec<u8> = Vec::new();
    let mut cur_ms = 0u64;

    let push_sample = |durs: &mut Vec<u32>, sizes: &mut Vec<u32>, blob: &mut Vec<u8>, dur: u64, text: &str| {
        if dur == 0 {
            return;
        }
        // Split very long gaps (> u32::MAX ms won't happen, safe clamp).
        let d32 = dur.min(u32::MAX as u64) as u32;
        let bytes = text.as_bytes();
        let len = bytes.len().min(u16::MAX as usize);
        // Ensure valid UTF-8 boundary if truncated at 65535 bytes.
        let mut end = len;
        while end > 0 && !text.is_char_boundary(end) {
            end -= 1;
        }
        blob.extend_from_slice(&(end as u16).to_be_bytes());
        blob.extend_from_slice(&bytes[..end]);
        durs.push(d32);
        sizes.push((2 + end) as u32);
    };

    for cue in &sub.cues {
        if cue.end_ms <= cur_ms {
            continue;
        }
        let start = cue.start_ms.max(cur_ms);
        if start > cur_ms {
            push_sample(&mut sample_durations, &mut sample_sizes, &mut mdat_blob, start - cur_ms, "");
        }
        push_sample(&mut sample_durations, &mut sample_sizes, &mut mdat_blob, cue.end_ms - start, &cue.text);
        cur_ms = cue.end_ms;
    }
    if movie_dur_ms > cur_ms {
        push_sample(&mut sample_durations, &mut sample_sizes, &mut mdat_blob, movie_dur_ms - cur_ms, "");
        cur_ms = movie_dur_ms;
    }
    if sample_durations.is_empty() {
        return None;
    }
    Some(CompiledSubTrack {
        lang_iso3: bcp47_to_iso639_2(&sub.lang),
        name: if sub.name.trim().is_empty() { sub.lang.clone() } else { sub.name.trim().to_string() },
        sample_durations,
        sample_sizes,
        mdat_blob,
        total_dur_ms: cur_ms,
    })
}

fn build_tx3g_stsd(video_w: u16, sub_h: u16) -> Vec<u8> {
    // Font table (`ftab`): 1 font entry (id=1, "Sans-Serif")
    let font_name = b"Sans-Serif";
    let mut ftab_body = Vec::with_capacity(5 + font_name.len());
    ftab_body.extend_from_slice(&1u16.to_be_bytes()); // entry count
    ftab_body.extend_from_slice(&1u16.to_be_bytes()); // font ID
    ftab_body.push(font_name.len() as u8);
    ftab_body.extend_from_slice(font_name);
    let ftab = wrap_box(b"ftab", &ftab_body);

    // tx3g sample entry body (38 bytes + ftab)
    let mut tx3g = Vec::with_capacity(38 + ftab.len());
    tx3g.extend_from_slice(&[0u8; 6]); // reserved
    tx3g.extend_from_slice(&1u16.to_be_bytes()); // data_reference_index
    tx3g.extend_from_slice(&0u32.to_be_bytes()); // displayFlags
    tx3g.push(1); // horizontal justification: center
    tx3g.push(0xFF); // vertical justification: bottom
    tx3g.extend_from_slice(&[0, 0, 0, 0]); // bg color RGBA (transparent)
    // default text box: top, left, bottom, right
    tx3g.extend_from_slice(&0i16.to_be_bytes());
    tx3g.extend_from_slice(&0i16.to_be_bytes());
    tx3g.extend_from_slice(&(sub_h as i16).to_be_bytes());
    tx3g.extend_from_slice(&(video_w as i16).to_be_bytes());
    // default style record (12 bytes)
    tx3g.extend_from_slice(&0u16.to_be_bytes()); // startChar
    tx3g.extend_from_slice(&0u16.to_be_bytes()); // endChar
    tx3g.extend_from_slice(&1u16.to_be_bytes()); // fontID
    tx3g.push(0); // faceStyleFlags (plain)
    tx3g.push(18); // fontSize
    tx3g.extend_from_slice(&[255, 255, 255, 255]); // text color RGBA (white)
    tx3g.extend_from_slice(&ftab);

    let entry = wrap_box(b"tx3g", &tx3g);
    let mut stsd_body = Vec::with_capacity(4 + entry.len());
    stsd_body.extend_from_slice(&1u32.to_be_bytes());
    stsd_body.extend_from_slice(&entry);
    wrap_fullbox(b"stsd", 0, 0, &stsd_body)
}

fn build_sub_trak(sub: &CompiledSubTrack, track_id: u32, video_w_fp: u32, video_h_fp: u32, chunk_offset: u64) -> Vec<u8> {
    let vw = (video_w_fp >> 16).max(640) as u16;
    let vh = (video_h_fp >> 16).max(360) as u16;
    let sub_h = (vh as u32 * 15 / 100).max(60) as u16;
    let ty_fp = ((vh.saturating_sub(sub_h)) as u32) << 16;

    let mut matrix = [0u8; 36];
    matrix[0..4].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    matrix[16..20].copy_from_slice(&0x0001_0000u32.to_be_bytes());
    matrix[28..32].copy_from_slice(&ty_fp.to_be_bytes()); // translate Y to bottom of video
    matrix[32..36].copy_from_slice(&0x4000_0000u32.to_be_bytes());

    // alternate_group = 2 marks all subtitle tracks as mutually exclusive language alternatives.
    let tkhd = build_tkhd(track_id, sub.total_dur_ms, 2, 0, &matrix, (vw as u32) << 16, (sub_h as u32) << 16);
    let mdhd = build_mdhd(1000, sub.total_dur_ms, pack_iso639(sub.lang_iso3));
    let hdlr = build_hdlr(b"sbtl", sub.name.as_bytes());
    let nmhd = wrap_fullbox(b"nmhd", 0, 0, &[]);
    let dinf = build_dinf();

    let stsd = build_tx3g_stsd(vw, sub_h);
    let mut stts_body = Vec::with_capacity(4 + sub.sample_durations.len() * 8);
    stts_body.extend_from_slice(&(sub.sample_durations.len() as u32).to_be_bytes());
    for d in &sub.sample_durations {
        stts_body.extend_from_slice(&1u32.to_be_bytes());
        stts_body.extend_from_slice(&d.to_be_bytes());
    }
    let stts = wrap_fullbox(b"stts", 0, 0, &stts_body);

    let mut stsc_body = Vec::with_capacity(16);
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    stsc_body.extend_from_slice(&(sub.sample_sizes.len() as u32).to_be_bytes());
    stsc_body.extend_from_slice(&1u32.to_be_bytes());
    let stsc = wrap_fullbox(b"stsc", 0, 0, &stsc_body);

    let mut stsz_body = Vec::with_capacity(8 + sub.sample_sizes.len() * 4);
    stsz_body.extend_from_slice(&0u32.to_be_bytes());
    stsz_body.extend_from_slice(&(sub.sample_sizes.len() as u32).to_be_bytes());
    for sz in &sub.sample_sizes {
        stsz_body.extend_from_slice(&sz.to_be_bytes());
    }
    let stsz = wrap_fullbox(b"stsz", 0, 0, &stsz_body);

    let mut co64_body = Vec::with_capacity(12);
    co64_body.extend_from_slice(&1u32.to_be_bytes());
    co64_body.extend_from_slice(&chunk_offset.to_be_bytes());
    let co64 = wrap_fullbox(b"co64", 0, 0, &co64_body);

    let mut stbl_body = Vec::new();
    stbl_body.extend_from_slice(&stsd);
    stbl_body.extend_from_slice(&stts);
    stbl_body.extend_from_slice(&stsc);
    stbl_body.extend_from_slice(&stsz);
    stbl_body.extend_from_slice(&co64);
    let stbl = wrap_box(b"stbl", &stbl_body);

    let mut minf_body = Vec::new();
    minf_body.extend_from_slice(&nmhd);
    minf_body.extend_from_slice(&dinf);
    minf_body.extend_from_slice(&stbl);
    let minf = wrap_box(b"minf", &minf_body);

    let mut mdia_body = Vec::new();
    mdia_body.extend_from_slice(&mdhd);
    mdia_body.extend_from_slice(&hdlr);
    mdia_body.extend_from_slice(&minf);
    let mdia = wrap_box(b"mdia", &mdia_body);

    // `udta -> name` lets players like VLC/MX/mpv display the language title cleanly.
    let name_box = wrap_box(b"name", sub.name.as_bytes());
    let udta = wrap_box(b"udta", &name_box);

    let mut trak_body = Vec::new();
    trak_body.extend_from_slice(&tkhd);
    trak_body.extend_from_slice(&mdia);
    trak_body.extend_from_slice(&udta);
    wrap_box(b"trak", &trak_body)
}

/// Muxes a primary fMP4/MP4 track (video or audio), an optional secondary fMP4/MP4 track (audio),
/// and any number of subtitle tracks into `output_path` via a temp file + atomic rename.
pub fn mux_fmp4(
    primary_path: &Path,
    secondary_path: Option<&Path>,
    subtitles: &[SubtitleTrack],
    output_path: &Path,
) -> io::Result<()> {
    let primary = parse_fmp4(primary_path)?;
    let secondary = match secondary_path {
        Some(p) => Some(parse_fmp4(p)?),
        None => None,
    };
    mux_parsed_tracks(primary_path, primary, secondary_path, secondary, subtitles, output_path)
}

/// Extracts only the `soun` audio track from an fMP4 or progressive muxed video+audio `.mp4`
/// (e.g. TikTok, Instagram Reels, Facebook, Threads, Pinterest) and writes a clean,
/// fast-start `.m4a` audio-only container to `output_path`.
pub fn extract_audio_only_m4a(input_path: &Path, output_path: &Path) -> io::Result<()> {
    let audio_track = parse_fmp4_for_handler(input_path, Some(b"soun"))
        .or_else(|_| parse_fmp4_for_handler(input_path, None))?;
    mux_parsed_tracks(input_path, audio_track, None, None, &[], output_path)
}

/// Ensures a downloaded single-file `.mp4` (progressive or fragmented) has its `moov` atom
/// placed before `mdat` (`+faststart`) for instant progressive playback and seeking.
/// If `input_path` is a muxed progressive MP4 (`vide` + `soun`), both tracks are preserved
/// and re-muxed into a fast-start `.mp4`. If `moov` is already before `mdat` (and not fragmented),
/// it performs a zero-copy atomic rename.
pub fn ensure_faststart_mp4(
    input_path: &Path,
    subtitles: &[SubtitleTrack],
    output_path: &Path,
) -> io::Result<()> {
    let mut f = File::open(input_path)?;
    let file_len = f.metadata()?.len();
    let mut seen_moov = false;
    let mut seen_mdat = false;
    let mut moov_before_mdat = false;
    let mut has_moof = false;

    let mut pos = 0u64;
    while pos + 8 <= file_len {
        f.seek(SeekFrom::Start(pos))?;
        let Some((typ, hdr_len, raw_sz)) = read_box_header(&mut f)? else {
            break;
        };
        let box_len = if raw_sz == 0 { file_len - pos } else { raw_sz };
        if box_len < hdr_len || pos + box_len > file_len {
            break;
        }
        if &typ == b"moov" {
            seen_moov = true;
            if !seen_mdat {
                moov_before_mdat = true;
            }
        } else if &typ == b"mdat" {
            seen_mdat = true;
        } else if &typ == b"moof" {
            has_moof = true;
        }
        pos += box_len;
    }
    drop(f);

    if !seen_moov {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "not an MP4 file"));
    }

    // Already fast-start progressive MP4 with no subtitles to embed -> zero-copy atomic rename!
    if moov_before_mdat && !has_moof && subtitles.is_empty() {
        if input_path != output_path {
            if output_path.exists() {
                let _ = std::fs::remove_file(output_path);
            }
            std::fs::rename(input_path, output_path)?;
        }
        return Ok(());
    }

    // Remux into fast-start MP4 (preserving both `vide` and `soun` if muxed in one progressive file)
    if !has_moof {
        let vid = parse_fmp4_for_handler(input_path, Some(b"vide")).ok();
        let aud = parse_fmp4_for_handler(input_path, Some(b"soun")).ok();
        match (vid, aud) {
            (Some(v), Some(a)) => {
                return mux_parsed_tracks(
                    input_path,
                    v,
                    Some(input_path),
                    Some(a),
                    subtitles,
                    output_path,
                );
            }
            (Some(v), None) => {
                return mux_parsed_tracks(input_path, v, None, None, subtitles, output_path);
            }
            (None, Some(a)) => {
                return mux_parsed_tracks(input_path, a, None, None, subtitles, output_path);
            }
            (None, None) => {}
        }
    }

    mux_fmp4(input_path, None, subtitles, output_path)
}

fn mux_parsed_tracks(
    primary_path: &Path,
    primary: ParsedFmp4,
    secondary_path: Option<&Path>,
    secondary: Option<ParsedFmp4>,
    subtitles: &[SubtitleTrack],
    output_path: &Path,
) -> io::Result<()> {

    let dur1_ms = (primary.total_duration as u128 * 1000 / primary.timescale as u128) as u64;
    let dur2_ms = secondary
        .as_ref()
        .map(|s| (s.total_duration as u128 * 1000 / s.timescale as u128) as u64)
        .unwrap_or(0);
    let movie_dur_ms = dur1_ms.max(dur2_ms);

    let (video_w_fp, video_h_fp) = if primary.is_video {
        (primary.width_fp, primary.height_fp)
    } else {
        (1280 << 16, 720 << 16)
    };

    let compiled_subs: Vec<CompiledSubTrack> = subtitles
        .iter()
        .filter_map(|s| compile_subtitle_track(s, movie_dur_ms))
        .collect();

    // Plan interleaved chunk layout inside `mdat` so video and audio stay localized for smooth seeking.
    enum CopyOp {
        Primary(usize),
        Secondary(usize),
    }
    let mut ops: Vec<CopyOp> = Vec::with_capacity(
        primary.chunks.len() + secondary.as_ref().map(|s| s.chunks.len()).unwrap_or(0),
    );
    let mut p_rel_offsets = vec![0u64; primary.chunks.len()];
    let mut s_rel_offsets = vec![0u64; secondary.as_ref().map(|s| s.chunks.len()).unwrap_or(0)];
    let mut rel_pos = 0u64;

    if let Some(sec) = &secondary {
        let mut pi = 0usize;
        let mut si = 0usize;
        let p_len = primary.chunks.len().max(1);
        let s_len = sec.chunks.len().max(1);
        while pi < primary.chunks.len() || si < sec.chunks.len() {
            let take_p = if pi >= primary.chunks.len() {
                false
            } else if si >= sec.chunks.len() {
                true
            } else {
                pi * s_len <= si * p_len
            };
            if take_p {
                p_rel_offsets[pi] = rel_pos;
                rel_pos += primary.chunks[pi].byte_len;
                ops.push(CopyOp::Primary(pi));
                pi += 1;
            } else {
                s_rel_offsets[si] = rel_pos;
                rel_pos += sec.chunks[si].byte_len;
                ops.push(CopyOp::Secondary(si));
                si += 1;
            }
        }
    } else {
        for (pi, ch) in primary.chunks.iter().enumerate() {
            p_rel_offsets[pi] = rel_pos;
            rel_pos += ch.byte_len;
            ops.push(CopyOp::Primary(pi));
        }
    }

    let mut sub_rel_offsets = Vec::with_capacity(compiled_subs.len());
    for s in &compiled_subs {
        sub_rel_offsets.push(rel_pos);
        rel_pos += s.mdat_blob.len() as u64;
    }
    let mdat_payload_len = rel_pos;

    let ftyp = build_ftyp();
    let media_count = 1u32 + u32::from(secondary.is_some());
    let next_track_id = 1 + media_count + compiled_subs.len() as u32;

    let build_moov = |mdat_base: u64| -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&build_mvhd(movie_dur_ms, next_track_id));
        let p_abs: Vec<u64> = p_rel_offsets.iter().map(|o| mdat_base + o).collect();
        body.extend_from_slice(&build_media_trak(&primary, 1, &p_abs));
        if let Some(sec) = &secondary {
            let s_abs: Vec<u64> = s_rel_offsets.iter().map(|o| mdat_base + o).collect();
            body.extend_from_slice(&build_media_trak(sec, 2, &s_abs));
        }
        for (idx, sub) in compiled_subs.iter().enumerate() {
            let tid = 1 + media_count + idx as u32;
            body.extend_from_slice(&build_sub_trak(sub, tid, video_w_fp, video_h_fp, mdat_base + sub_rel_offsets[idx]));
        }
        wrap_box(b"moov", &body)
    };

    // Pass A: compute exact moov size (co64 has fixed width so moov size is invariant).
    let moov_size = build_moov(0).len() as u64;
    let mdat_header_len = 16u64; // 64-bit largesize mdat header
    let mdat_base = ftyp.len() as u64 + moov_size + mdat_header_len;
    let moov = build_moov(mdat_base);
    debug_assert_eq!(moov.len() as u64, moov_size);

    let tmp_name = format!(
        "{}.mux.tmp",
        output_path.file_name().and_then(|n| n.to_str()).unwrap_or("out.mp4")
    );
    let tmp_path = output_path.with_file_name(tmp_name);
    let _ = std::fs::remove_file(&tmp_path);

    let write_res = (|| -> io::Result<()> {
        let out_file = File::create(&tmp_path)?;
        let mut w = BufWriter::with_capacity(4 * 1024 * 1024, out_file);
        w.write_all(&ftyp)?;
        w.write_all(&moov)?;
        // 64-bit largesize mdat box header
        w.write_all(&1u32.to_be_bytes())?;
        w.write_all(b"mdat")?;
        w.write_all(&(mdat_header_len + mdat_payload_len).to_be_bytes())?;

        let mut f1 = File::open(primary_path)?;
        let mut f2 = match secondary_path {
            Some(p) => Some(File::open(p)?),
            None => None,
        };
        let mut copy_buf = vec![0u8; 1024 * 1024];

        for op in ops {
            let (src_file, src_off, mut left) = match op {
                CopyOp::Primary(i) => (&mut f1, primary.chunks[i].src_offset, primary.chunks[i].byte_len),
                CopyOp::Secondary(i) => (
                    f2.as_mut().unwrap(),
                    secondary.as_ref().unwrap().chunks[i].src_offset,
                    secondary.as_ref().unwrap().chunks[i].byte_len,
                ),
            };
            src_file.seek(SeekFrom::Start(src_off))?;
            while left > 0 {
                let want = (left as usize).min(copy_buf.len());
                src_file.read_exact(&mut copy_buf[..want])?;
                w.write_all(&copy_buf[..want])?;
                left -= want as u64;
            }
        }
        for sub in &compiled_subs {
            w.write_all(&sub.mdat_blob)?;
        }
        w.flush()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    if output_path.exists() {
        let _ = std::fs::remove_file(output_path);
    }
    std::fs::rename(&tmp_path, output_path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_manual_and_asr_srv3_xml() {
        let xml = r#"<?xml version="1.0" encoding="utf-8" ?><timedtext format="3"><body>
            <p t="1000" d="3000">Hello &amp; world</p>
            <p t="3500" d="2000"><s ac="0">Overlapping </s><s>ASR cue</s></p>
            <p t="6000" d="1000">   </p>
        </body></timedtext>"#;
        let cues = parse_srv3_xml(xml);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0], SubCue { start_ms: 1000, end_ms: 3500, text: "Hello & world".into() });
        assert_eq!(cues[1], SubCue { start_ms: 3500, end_ms: 5500, text: "Overlapping ASR cue".into() });
    }

    #[test]
    fn maps_bcp47_to_iso639_2() {
        assert_eq!(&bcp47_to_iso639_2("en-US"), b"eng");
        assert_eq!(&bcp47_to_iso639_2("ms"), b"msa");
        assert_eq!(&bcp47_to_iso639_2("id"), b"ind");
        assert_eq!(&bcp47_to_iso639_2("ja"), b"jpn");
        assert_eq!(&bcp47_to_iso639_2("zh-Hans"), b"zho");
        assert_eq!(&bcp47_to_iso639_2("xx-unknown"), b"und");
    }
}
