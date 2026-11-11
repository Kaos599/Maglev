//! File names for URL downloads: a small RFC 6266 `Content-Disposition` reader, the URL path fallback and a
//! sanitiser that makes any name safe to create inside the download folder.
//!
//! Precedence (contract section 17): `filename*` > `filename` > last URL path segment > `download`.

/// Longest file name we create, in bytes. Android file systems allow 255; `.part` and the sidecar suffix are added on top.
pub const MAX_NAME_BYTES: usize = 200;
pub const FALLBACK_NAME: &str = "download";

/// Names Windows reserves. Android does not care, but the file is often copied to a PC.
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Percent-decodes bytes. A bad escape is kept as is.
pub fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && hex(b[i + 1]).is_some() && hex(b[i + 2]).is_some() {
            out.push(hex(b[i + 1]).unwrap_or(0) * 16 + hex(b[i + 2]).unwrap_or(0));
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Decodes an RFC 5987 value such as `UTF-8''na%C3%AFve.txt`. Only UTF-8 and ISO-8859-1 are understood.
fn decode_ext_value(v: &str) -> Option<String> {
    let mut parts = v.splitn(3, '\'');
    let charset = parts.next()?.trim().to_ascii_lowercase();
    let _lang = parts.next()?;
    let encoded = parts.next()?;
    let bytes = percent_decode(encoded);
    match charset.as_str() {
        "utf-8" | "utf8" => String::from_utf8(bytes).ok(),
        "iso-8859-1" | "latin1" => Some(bytes.iter().map(|&b| b as char).collect()),
        _ => None,
    }
}

/// Splits a header into `(name, value)` parameters. Handles quoted strings with `\` escapes and `;` inside quotes.
fn params(header: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = header.chars().collect();
    let mut i = 0;
    // Skip the disposition type.
    while i < chars.len() && chars[i] != ';' {
        i += 1;
    }
    while i < chars.len() {
        // At ';'.
        i += 1;
        while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
            i += 1;
        }
        let mut name = String::new();
        while i < chars.len() && chars[i] != '=' && chars[i] != ';' {
            name.push(chars[i]);
            i += 1;
        }
        let name = name.trim().to_ascii_lowercase();
        if i >= chars.len() || chars[i] == ';' {
            continue;
        }
        i += 1; // '='
        while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
            i += 1;
        }
        let mut value = String::new();
        if i < chars.len() && chars[i] == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                }
                value.push(chars[i]);
                i += 1;
            }
            i += 1; // closing quote
            while i < chars.len() && chars[i] != ';' {
                i += 1;
            }
        } else {
            while i < chars.len() && chars[i] != ';' {
                value.push(chars[i]);
                i += 1;
            }
        }
        out.push((name, value.trim().to_string()));
    }
    out
}

/// The raw file name from a `Content-Disposition` value (`filename*` wins over `filename`). Not sanitised.
pub fn parse_filename(header: &str) -> Option<String> {
    let ps = params(header);
    if let Some((_, v)) = ps.iter().find(|(k, _)| k == "filename*") {
        if let Some(n) = decode_ext_value(v) {
            if !n.trim().is_empty() {
                return Some(n);
            }
        }
    }
    if let Some((_, v)) = ps.iter().find(|(k, _)| k == "filename") {
        if !v.trim().is_empty() {
            // Some servers send raw UTF-8 bytes read as Latin-1, others percent-encode inside the quotes.
            return Some(v.clone());
        }
    }
    None
}

/// The last path segment of a URL, percent-decoded. Query and fragment are ignored.
pub fn filename_from_url(url: &str) -> Option<String> {
    let after_scheme = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let path_start = after_scheme.find('/')?;
    let path = &after_scheme[path_start..];
    let path = path.split(['?', '#']).next().unwrap_or("");
    let seg = path.rsplit('/').find(|s| !s.is_empty())?;
    let decoded = String::from_utf8(percent_decode(seg)).ok()?;
    if decoded.trim().is_empty() {
        None
    } else {
        Some(decoded)
    }
}

/// Makes `raw` a safe single file name: no path parts, no control or reserved characters, no leading dots,
/// at most [`MAX_NAME_BYTES`] bytes with the extension kept. Never returns an empty string.
pub fn sanitize_filename(raw: &str) -> String {
    // Only the last path component counts, for both separators.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut s: String = last
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0') {
                '_'
            } else if is_invisible(c) {
                '\u{0}'
            } else {
                c
            }
        })
        .filter(|&c| c != '\u{0}')
        .collect();
    s = s.trim_matches(|c: char| c == ' ' || c == '.').to_string();
    if s.is_empty() {
        return FALLBACK_NAME.to_string();
    }
    let stem_lower = s.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED.contains(&stem_lower.as_str()) {
        s.insert(0, '_');
    }
    truncate_keeping_extension(&s, MAX_NAME_BYTES)
}

/// Zero-width and bidi control characters hide the real extension of a file.
fn is_invisible(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
    )
}

fn truncate_keeping_extension(name: &str, max: usize) -> String {
    if name.len() <= max {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 16 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let room = max.saturating_sub(ext.len());
    let mut cut = room.min(stem.len());
    while cut > 0 && !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{}", &stem[..cut], ext)
}

/// Picks the name for a download. `final_url` is the URL after redirects.
pub fn choose_name(content_disposition: Option<&str>, final_url: &str) -> String {
    if let Some(n) = content_disposition.and_then(parse_filename) {
        let s = sanitize_filename(&n);
        if s != FALLBACK_NAME || n.trim().eq_ignore_ascii_case(FALLBACK_NAME) {
            return s;
        }
    }
    if let Some(n) = filename_from_url(final_url) {
        return sanitize_filename(&n);
    }
    FALLBACK_NAME.to_string()
}

/// `name`, then `name (1).ext`, `name (2).ext` ... until `taken` says the name is free.
pub fn unique_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    for n in 1..10_000u32 {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken(&candidate) {
            return candidate;
        }
    }
    format!("{stem} ({}){ext}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_quoted_filename() {
        assert_eq!(
            parse_filename(r#"attachment; filename="report 2024.pdf""#).as_deref(),
            Some("report 2024.pdf")
        );
    }

    #[test]
    fn token_filename_without_quotes() {
        assert_eq!(parse_filename("attachment; filename=movie.mkv").as_deref(), Some("movie.mkv"));
    }

    #[test]
    fn quoted_filename_with_escape_and_semicolon() {
        assert_eq!(
            parse_filename(r#"attachment; filename="a\"b;c.txt""#).as_deref(),
            Some(r#"a"b;c.txt"#)
        );
    }

    #[test]
    fn extended_filename_wins_over_plain() {
        let h = "attachment; filename=\"fallback.txt\"; filename*=UTF-8''na%C3%AFve%20caf%C3%A9.txt";
        assert_eq!(parse_filename(h).as_deref(), Some("naïve café.txt"));
        let h2 = "attachment; filename*=UTF-8''na%C3%AFve.txt; filename=\"fallback.txt\"";
        assert_eq!(parse_filename(h2).as_deref(), Some("naïve.txt"));
    }

    #[test]
    fn extended_filename_in_latin1() {
        assert_eq!(
            parse_filename("attachment; filename*=iso-8859-1'en'%E9t%E9.txt").as_deref(),
            Some("été.txt")
        );
    }

    #[test]
    fn bad_extended_value_falls_back_to_plain() {
        let h = "attachment; filename*=UTF-8''%FF%FE.txt; filename=\"ok.txt\"";
        assert_eq!(parse_filename(h).as_deref(), Some("ok.txt"));
    }

    #[test]
    fn no_filename_gives_none() {
        assert_eq!(parse_filename("inline"), None);
        assert_eq!(parse_filename("attachment; size=3"), None);
    }

    #[test]
    fn url_segment_is_decoded_and_stops_at_query() {
        assert_eq!(
            filename_from_url("https://example.com/files/My%20Song.mp3?token=abc#x").as_deref(),
            Some("My Song.mp3")
        );
        assert_eq!(filename_from_url("https://example.com/"), None);
        assert_eq!(filename_from_url("https://example.com"), None);
        assert_eq!(filename_from_url("https://example.com/dir/").as_deref(), Some("dir"));
    }

    #[test]
    fn sanitise_strips_paths_in_both_directions() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("/"), FALLBACK_NAME);
    }

    #[test]
    fn sanitise_replaces_bad_characters_and_controls() {
        assert_eq!(sanitize_filename("a:b*c?d\"e<f>g|h.txt"), "a_b_c_d_e_f_g_h.txt");
        assert_eq!(sanitize_filename("a\u{0}b\nc.txt"), "a_b_c.txt");
    }

    #[test]
    fn sanitise_trims_dots_and_spaces() {
        assert_eq!(sanitize_filename("  ..hidden.txt. "), "hidden.txt");
        assert_eq!(sanitize_filename("..."), FALLBACK_NAME);
        assert_eq!(sanitize_filename(""), FALLBACK_NAME);
    }

    #[test]
    fn sanitise_drops_invisible_characters() {
        assert_eq!(sanitize_filename("photo\u{202E}gpj.exe"), "photogpj.exe");
        assert_eq!(sanitize_filename("a\u{200B}b.txt"), "ab.txt");
    }

    #[test]
    fn sanitise_prefixes_reserved_device_names() {
        assert_eq!(sanitize_filename("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_filename("nul"), "_nul");
        assert_eq!(sanitize_filename("console.txt"), "console.txt");
    }

    #[test]
    fn sanitise_limits_length_and_keeps_the_extension() {
        let long = format!("{}.mkv", "é".repeat(300));
        let s = sanitize_filename(&long);
        assert!(s.len() <= MAX_NAME_BYTES, "{}", s.len());
        assert!(s.ends_with(".mkv"));
        assert!(s.starts_with('é'));
    }

    #[test]
    fn choose_prefers_disposition_over_url() {
        let n = choose_name(Some("attachment; filename=\"real.zip\""), "https://x.test/path/other.bin");
        assert_eq!(n, "real.zip");
    }

    #[test]
    fn choose_falls_back_to_url_then_default() {
        assert_eq!(choose_name(None, "https://x.test/path/other.bin?x=1"), "other.bin");
        assert_eq!(choose_name(Some("inline"), "https://x.test/"), FALLBACK_NAME);
    }

    #[test]
    fn choose_sanitises_a_hostile_disposition() {
        let n = choose_name(Some("attachment; filename=\"../../x/evil.sh\""), "https://x.test/a.bin");
        assert_eq!(n, "evil.sh");
    }

    #[test]
    fn unique_name_adds_a_counter_before_the_extension() {
        let taken = |n: &str| n == "a.txt" || n == "a (1).txt";
        assert_eq!(unique_name("a.txt", taken), "a (2).txt");
        assert_eq!(unique_name("b.txt", taken), "b.txt");
        assert_eq!(unique_name("noext", |n| n == "noext"), "noext (1)");
    }

    #[test]
    fn percent_decode_keeps_bad_escapes() {
        assert_eq!(percent_decode("a%2Fb"), b"a/b".to_vec());
        assert_eq!(percent_decode("100%"), b"100%".to_vec());
        assert_eq!(percent_decode("%zz"), b"%zz".to_vec());
        assert_eq!(percent_decode("%4"), b"%4".to_vec());
    }
}
