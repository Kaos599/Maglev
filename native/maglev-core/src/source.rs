//! Validation and normalisation of torrent sources (magnet URI, `.torrent` URL, `.torrent` file path).
//!
//! This is deliberately independent of librqbit so duplicate detection and `INVALID_SOURCE`
//! decisions are testable without a session.

use crate::error::{EngineError, ErrorCode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    Magnet(MagnetInfo),
    Url(String),
    File(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MagnetInfo {
    /// 40 character lower case hex, whatever form the link used.
    pub info_hash: String,
    /// The `dn` display name, percent-decoded.
    pub name: Option<String>,
}

fn invalid(msg: &str) -> EngineError {
    EngineError::new(ErrorCode::InvalidSource, msg)
}

pub fn parse_source(raw: &str) -> Result<Source, EngineError> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(invalid("Paste a magnet link, a web address or pick a .torrent file"));
    }
    let lower = s.to_ascii_lowercase();
    if lower.starts_with("magnet:") {
        return parse_magnet(s).map(Source::Magnet);
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let after = &s[s.find("://").map(|i| i + 3).unwrap_or(0)..];
        if after.is_empty() || after.starts_with('/') {
            return Err(invalid("That web address isn't complete"));
        }
        return Ok(Source::Url(s.to_string()));
    }
    // A bare info hash is accepted as a magnet.
    if is_hex40(s) {
        return Ok(Source::Magnet(MagnetInfo {
            info_hash: s.to_ascii_lowercase(),
            name: None,
        }));
    }
    if s.starts_with('/') {
        return Ok(Source::File(s.to_string()));
    }
    Err(invalid(
        "That isn't a magnet link, a web address or a .torrent file",
    ))
}

/// librqbit's HTTP client verifies certificates with the bundled Mozilla roots (see
/// `vendor/rustls-platform-verifier`), so https works without any JNI setup. Flip this to
/// `false` to reject https sources again.
const HTTPS_SUPPORTED: bool = true;

pub fn check_supported(src: &Source) -> Result<(), EngineError> {
    if let Source::Url(u) = src {
        if !HTTPS_SUPPORTED && u.to_ascii_lowercase().starts_with("https://") {
            return Err(EngineError::new(
                ErrorCode::Unsupported,
                "Secure (https) torrent links aren't supported yet. Download the .torrent file and open it instead.",
            ));
        }
    }
    Ok(())
}

fn is_hex40(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_magnet(s: &str) -> Result<MagnetInfo, EngineError> {
    let query = match s.split_once('?') {
        Some((_, q)) => q,
        None => return Err(invalid("This magnet link has no info hash")),
    };
    let mut info_hash: Option<String> = None;
    let mut saw_v2_only = false;
    let mut name: Option<String> = None;
    for pair in query.split('&') {
        let (k, v) = match pair.split_once('=') {
            Some(kv) => kv,
            None => continue,
        };
        let key = k.to_ascii_lowercase();
        if key == "xt" || key.starts_with("xt.") {
            let value = percent_decode(v);
            let lv = value.to_ascii_lowercase();
            if let Some(h) = lv.strip_prefix("urn:btih:") {
                let hash = normalize_btih(h).ok_or_else(|| {
                    invalid("This magnet link has an info hash that isn't valid")
                })?;
                if info_hash.is_none() {
                    info_hash = Some(hash);
                }
            } else if lv.starts_with("urn:btmh:") {
                saw_v2_only = true;
            }
        } else if key == "dn" && !v.is_empty() && name.is_none() {
            name = Some(percent_decode(v));
        }
    }
    match info_hash {
        Some(info_hash) => Ok(MagnetInfo { info_hash, name }),
        None if saw_v2_only => Err(invalid(
            "This magnet link only has a BitTorrent v2 hash, which isn't supported yet",
        )),
        None => Err(invalid("This magnet link has no info hash")),
    }
}

/// Accepts a 40 character hex or a 32 character base32 info hash and returns lower case hex.
pub fn normalize_btih(h: &str) -> Option<String> {
    let h = h.trim();
    if is_hex40(h) {
        return Some(h.to_ascii_lowercase());
    }
    if h.len() == 32 {
        let bytes = base32_decode(h)?;
        if bytes.len() == 20 {
            let mut out = String::with_capacity(40);
            for b in bytes {
                out.push_str(&format!("{b:02x}"));
            }
            return Some(out);
        }
    }
    None
}

/// RFC 4648 base32, no padding, case insensitive.
fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a',
            b'2'..=b'7' => c - b'2' + 26,
            _ => return None,
        } as u32;
        buffer = (buffer << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                match hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    Some(b) => {
                        out.push(b);
                        i += 3;
                    }
                    None => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEX: &str = "0123456789abcdef0123456789abcdef01234567";

    #[test]
    fn magnet_without_btih_is_invalid_source() {
        let e = parse_source("magnet:?dn=x").unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidSource);
        let e = parse_source("magnet:").unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidSource);
        let e = parse_source("magnet:?xt=urn:btih:nothex&dn=x").unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidSource);
    }

    #[test]
    fn hex_magnet_is_lowercased() {
        let s = parse_source(&format!(
            "magnet:?xt=urn:btih:{}&dn=My+Movie%20%282024%29&tr=udp%3A%2F%2Ft.example%3A1",
            HEX.to_ascii_uppercase()
        ))
        .unwrap();
        match s {
            Source::Magnet(m) => {
                assert_eq!(m.info_hash, HEX);
                assert_eq!(m.name.as_deref(), Some("My Movie (2024)"));
            }
            _ => panic!("expected magnet"),
        }
    }

    #[test]
    fn base32_btih_normalizes_to_hex_for_duplicate_detection() {
        let zeros = "A".repeat(32);
        let ones = "7".repeat(32);
        let one = format!("{}B", "A".repeat(31));
        assert_eq!(normalize_btih(&zeros).unwrap(), "0".repeat(40));
        assert_eq!(normalize_btih(&ones).unwrap(), "f".repeat(40));
        assert_eq!(normalize_btih(&one).unwrap(), format!("{}1", "0".repeat(39)));
        assert_eq!(normalize_btih(&one.to_ascii_lowercase()), normalize_btih(&one));
        // The same torrent in both spellings produces the same key.
        let a = parse_source(&format!("magnet:?xt=urn:btih:{zeros}")).unwrap();
        let b = parse_source(&format!("magnet:?xt=urn:btih:{}", "0".repeat(40))).unwrap();
        assert_eq!(a, b);
        assert!(normalize_btih("short").is_none());
        assert!(normalize_btih(&"1".repeat(32)).is_none());
    }

    #[test]
    fn v2_only_magnet_is_rejected_with_a_clear_message() {
        let e = parse_source(&format!("magnet:?xt=urn:btmh:1220{}", "a".repeat(64))).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidSource);
        assert!(e.message.contains("v2"));
    }

    #[test]
    fn urls_files_and_bare_hashes() {
        assert!(matches!(
            parse_source("https://example.org/a.torrent").unwrap(),
            Source::Url(_)
        ));
        assert!(matches!(
            parse_source("/storage/emulated/0/Download/a.torrent").unwrap(),
            Source::File(_)
        ));
        match parse_source(&HEX.to_ascii_uppercase()).unwrap() {
            Source::Magnet(m) => assert_eq!(m.info_hash, HEX),
            _ => panic!(),
        }
        for bad in ["", "   ", "ftp://x/y.torrent", "relative/path.torrent", "https://", "hello"] {
            assert_eq!(parse_source(bad).unwrap_err().code, ErrorCode::InvalidSource, "{bad}");
        }
    }

    #[test]
    fn https_sources_are_supported() {
        assert!(check_supported(&parse_source("https://example.org/a.torrent").unwrap()).is_ok());
        assert!(check_supported(&parse_source("http://example.org/a.torrent").unwrap()).is_ok());
        assert!(check_supported(&parse_source(&format!("magnet:?xt=urn:btih:{}", "a".repeat(40))).unwrap()).is_ok());
    }

    #[test]
    fn percent_decoding_handles_edges() {
        assert_eq!(percent_decode("a%20b+c"), "a b c");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%41"), "A");
    }
}
