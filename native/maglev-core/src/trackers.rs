//! Tracker editing and `.torrent` export (contract section 15).
//!
//! Pure helpers plus the JSON sidecar `<sessionDir>/maglev-trackers.json`, keyed by info-hash.
//! The sidecar holds only what the user changed: URLs added and URLs removed. librqbit re-adds a
//! torrent from its original `.torrent` bytes after a recheck, a move or a restart, so the edits are
//! applied again on top of whatever list the torrent comes back with (`apply_edits`).
//! The engine glue (the vendored `ManagedTorrent::trackers` / `set_trackers`) is in `engine.rs`.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{EngineError, ErrorCode};
use crate::meta::write_atomic;

pub const TRACKERS_FILE: &str = "maglev-trackers.json";
/// Most addresses accepted in one call.
pub const MAX_URLS_PER_CALL: usize = 100;
const MAX_URL_LEN: usize = 2048;

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::new(ErrorCode::InvalidArgument, message)
}

/// Splits `scheme://authority/tail` into lower case scheme, lower case authority and the rest.
/// Does no validation beyond the `://` and the authority boundary.
fn split_url(s: &str) -> Option<(String, String, String)> {
    let (scheme, rest) = s.split_once("://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let tail = &rest[end..];
    Some((
        scheme.to_ascii_lowercase(),
        authority.to_ascii_lowercase(),
        tail.to_string(),
    ))
}

/// Drops the default port of the scheme, the way `url::Url` prints it.
fn strip_default_port(scheme: &str, authority: &str) -> String {
    let default = match scheme {
        "http" => ":80",
        "https" => ":443",
        _ => return authority.to_string(),
    };
    match authority.strip_suffix(default) {
        // `[::1]:80` and `host:80` lose the port; a bare IPv6 ending in ":80" never gets here
        // because validation rejects unbracketed IPv6.
        Some(host) if !host.is_empty() => host.to_string(),
        _ => authority.to_string(),
    }
}

/// The form two addresses are compared in: lower case scheme and host, no default port, `/` for an
/// empty path, no fragment. Works on any string; anything that is not `scheme://...` compares as typed.
pub fn tracker_key(url: &str) -> String {
    let url = url.trim();
    match split_url(url) {
        Some((scheme, authority, tail)) => {
            let tail = tail.split('#').next().unwrap_or("");
            let tail = if tail.is_empty() { "/" } else { tail };
            format!("{scheme}://{}{tail}", strip_default_port(&scheme, &authority))
        }
        None => url.to_string(),
    }
}

/// Checks one announce URL (`http://`, `https://` or `udp://`) and returns its canonical form.
/// The error is a short reason without the address in it.
pub fn validate_tracker_url(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("it is empty".to_string());
    }
    if t.len() > MAX_URL_LEN {
        return Err("it is too long".to_string());
    }
    if t.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("it has spaces in it".to_string());
    }
    let (scheme, authority, _tail) = split_url(t)
        .ok_or_else(|| "it must start with http://, https:// or udp://".to_string())?;
    if !matches!(scheme.as_str(), "http" | "https" | "udp") {
        return Err("only http://, https:// and udp:// trackers work".to_string());
    }
    if authority.is_empty() {
        return Err("it has no host name".to_string());
    }
    if authority.contains('@') {
        return Err("it must not contain a user name or password".to_string());
    }
    let (host, port): (&str, Option<&str>) = if let Some(inner) = authority.strip_prefix('[') {
        let (host, after) = inner
            .split_once(']')
            .ok_or_else(|| "its IPv6 address is not closed with ]".to_string())?;
        if !host.chars().all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.') {
            return Err("its IPv6 address is not valid".to_string());
        }
        match after {
            "" => (host, None),
            a => (host, Some(a.strip_prefix(':').ok_or_else(|| "its port is not valid".to_string())?)),
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (authority.as_str(), None),
        }
    };
    if host.is_empty() {
        return Err("it has no host name".to_string());
    }
    if !authority.starts_with('[')
        && !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_')
    {
        return Err("its host name is not valid".to_string());
    }
    match port {
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => {}
            _ => return Err("its port is not valid".to_string()),
        },
        None if scheme == "udp" => return Err("a udp:// tracker needs a port".to_string()),
        None => {}
    }
    Ok(tracker_key(t))
}

/// Reads the `urls` argument of `nativeAddTrackers`: a JSON array of strings, one address each.
///
/// Blank entries are ignored and repeats (after normalising) are dropped. Nothing is accepted unless
/// every non-blank entry is valid, so a failed call changes nothing. Error code `INVALID_ARGUMENT`.
pub fn parse_url_list(json: &str) -> Result<Vec<String>, EngineError> {
    let raw: Vec<String> = serde_json::from_str(json)
        .map_err(|_| invalid("The tracker list couldn't be read"))?;
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut count = 0usize;
    for line in raw.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        count += 1;
        if count > MAX_URLS_PER_CALL {
            return Err(invalid(format!(
                "Add up to {MAX_URLS_PER_CALL} trackers at a time"
            )));
        }
        match validate_tracker_url(line) {
            Ok(u) => {
                if seen.insert(tracker_key(&u)) {
                    out.push(u);
                }
            }
            Err(reason) => {
                let shown: String = line.chars().take(60).collect();
                return Err(invalid(format!("\"{shown}\" isn't a tracker address: {reason}")));
            }
        }
    }
    if out.is_empty() {
        return Err(invalid("Enter at least one tracker address"));
    }
    Ok(out)
}

/// Splits `new_urls` into the ones `current` lacks and a count of the ones it already has.
pub fn plan_add(current: &[String], new_urls: &[String]) -> (Vec<String>, usize) {
    let have: HashSet<String> = current.iter().map(|u| tracker_key(u)).collect();
    let mut fresh = Vec::new();
    for u in new_urls {
        if !have.contains(&tracker_key(u)) {
            fresh.push(u.clone());
        }
    }
    let skipped = new_urls.len() - fresh.len();
    (fresh, skipped)
}

/// The entry of `current` that matches `url`, if any.
pub fn find_tracker(current: &[String], url: &str) -> Option<String> {
    let key = tracker_key(url);
    current.iter().find(|u| tracker_key(u) == key).cloned()
}

/// What the user changed for one torrent.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TrackerEdits {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

impl TrackerEdits {
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty()
    }
}

/// `(current + added) - removed`, de-duplicated by `tracker_key` and sorted.
pub fn apply_edits(current: &[String], edits: &TrackerEdits) -> Vec<String> {
    let removed: HashSet<String> = edits.removed.iter().map(|u| tracker_key(u)).collect();
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for u in current.iter().chain(edits.added.iter()) {
        let k = tracker_key(u);
        if removed.contains(&k) || !seen.insert(k) {
            continue;
        }
        out.push(u.clone());
    }
    out.sort();
    out
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct TrackersFile {
    version: u32,
    torrents: BTreeMap<String, TrackerEdits>,
}

/// `maglev-trackers.json`, keyed by lower case info-hash. Only torrents with edits are stored.
pub struct TrackerStore {
    path: PathBuf,
    data: TrackersFile,
}

impl TrackerStore {
    /// A missing or unreadable file gives an empty store, never an error.
    pub fn load(session_dir: &Path) -> Self {
        let path = session_dir.join(TRACKERS_FILE);
        let mut data = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<TrackersFile>(&b).ok())
            .unwrap_or_default();
        data.torrents.retain(|_, e| !e.is_empty());
        data.version = 1;
        Self { path, data }
    }

    pub fn get(&self, id: &str) -> Option<TrackerEdits> {
        self.data.torrents.get(id).cloned()
    }

    /// Records that `urls` were added. A URL that was removed before is no longer removed.
    pub fn record_added(&mut self, id: &str, urls: &[String]) {
        let e = self.data.torrents.entry(id.to_string()).or_default();
        for u in urls {
            let k = tracker_key(u);
            e.removed.retain(|r| tracker_key(r) != k);
            if !e.added.iter().any(|a| tracker_key(a) == k) {
                e.added.push(u.clone());
            }
        }
        if e.is_empty() {
            self.data.torrents.remove(id);
        }
    }

    /// Records that `url` was removed. A URL that was added by the user is no longer added.
    pub fn record_removed(&mut self, id: &str, url: &str) {
        let e = self.data.torrents.entry(id.to_string()).or_default();
        let k = tracker_key(url);
        e.added.retain(|a| tracker_key(a) != k);
        if !e.removed.iter().any(|r| tracker_key(r) == k) {
            e.removed.push(url.to_string());
        }
    }

    /// Returns true when an entry existed.
    pub fn forget(&mut self, id: &str) -> bool {
        self.data.torrents.remove(id).is_some()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let bytes = serde_json::to_vec(&self.data).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &bytes)
    }
}

fn bencode_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(s.len().to_string().as_bytes());
    out.push(b':');
    out.extend_from_slice(s.as_bytes());
}

/// A `.torrent` file: the original info dictionary (`info_bytes`, copied byte for byte so the
/// info-hash does not change) plus `trackers` as `announce` and a single-tier `announce-list`.
/// With no trackers the file has the info dictionary only. Keys are in sorted order, as bencode requires.
pub fn build_torrent_file(info_bytes: &[u8], trackers: &[String]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(info_bytes.len() + 64 + trackers.len() * 64);
    out.push(b'd');
    if let Some(first) = trackers.first() {
        bencode_str(&mut out, "announce");
        bencode_str(&mut out, first);
        bencode_str(&mut out, "announce-list");
        out.extend_from_slice(b"ll");
        for t in trackers {
            bencode_str(&mut out, t);
        }
        out.extend_from_slice(b"ee");
    }
    bencode_str(&mut out, "info");
    out.extend_from_slice(info_bytes);
    out.push(b'e');
    out
}

/// The destination of an export must be an absolute path to a `.torrent` file.
pub fn check_export_path(dest: &str) -> Result<PathBuf, EngineError> {
    let p = PathBuf::from(dest.trim());
    let is_torrent = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if !p.is_absolute() || !is_torrent || p.file_name().is_none() {
        return Err(invalid("The export path must be an absolute .torrent file path"));
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-trackers-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn accepts_http_https_and_udp_trackers() {
        assert_eq!(
            validate_tracker_url("udp://tracker.opentrackr.org:1337/announce").unwrap(),
            "udp://tracker.opentrackr.org:1337/announce"
        );
        assert_eq!(
            validate_tracker_url("  HTTPS://Tracker.Example.com/announce?x=1  ").unwrap(),
            "https://tracker.example.com/announce?x=1"
        );
        assert_eq!(
            validate_tracker_url("http://t.example.com:6969/announce").unwrap(),
            "http://t.example.com:6969/announce"
        );
        assert_eq!(
            validate_tracker_url("udp://[2001:db8::1]:80/announce").unwrap(),
            "udp://[2001:db8::1]:80/announce"
        );
    }

    #[test]
    fn normalises_like_url_url() {
        // An empty path becomes "/" and a default port is dropped, as `url::Url::to_string` prints it.
        assert_eq!(validate_tracker_url("http://t.example.com").unwrap(), "http://t.example.com/");
        assert_eq!(
            validate_tracker_url("http://t.example.com:80/a").unwrap(),
            "http://t.example.com/a"
        );
        assert_eq!(
            validate_tracker_url("https://t.example.com:443/a").unwrap(),
            "https://t.example.com/a"
        );
        // udp has no default port to drop
        assert_eq!(
            validate_tracker_url("udp://t.example.com:80/a").unwrap(),
            "udp://t.example.com:80/a"
        );
        // the fragment never reaches a tracker
        assert_eq!(
            validate_tracker_url("http://t.example.com/a#frag").unwrap(),
            "http://t.example.com/a"
        );
    }

    #[test]
    fn rejects_bad_addresses() {
        for bad in [
            "",
            "   ",
            "tracker.example.com/announce",
            "magnet:?xt=urn:btih:abc",
            "ftp://t.example.com/a",
            "ws://t.example.com/a",
            "http://",
            "http:///announce",
            "udp://t.example.com/announce",
            "udp://t.example.com:0/announce",
            "http://t.example.com:99999/a",
            "http://t.example.com:abc/a",
            "http://us er@t.example.com/a",
            "http://user:pw@t.example.com/a",
            "http://t exa.com/a",
            "http://t.exa$mple.com/a",
            "http://::1/a",
            "udp://[2001:db8::1/announce",
        ] {
            assert!(validate_tracker_url(bad).is_err(), "should reject {bad:?}");
        }
        let long = format!("http://t.example.com/{}", "a".repeat(2100));
        assert!(validate_tracker_url(&long).is_err());
    }

    #[test]
    fn parse_list_skips_blanks_and_dedups() {
        let json = r#"["udp://a.example.com:1337/announce","", "  ","UDP://A.example.com:1337/announce","http://b.example.com"]"#;
        let v = parse_url_list(json).unwrap();
        assert_eq!(
            v,
            vec![
                "udp://a.example.com:1337/announce".to_string(),
                "http://b.example.com/".to_string()
            ]
        );
    }

    #[test]
    fn parse_list_fails_whole_call_on_one_bad_line() {
        let e = parse_url_list(r#"["udp://a.example.com:1337/announce","nonsense"]"#).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        assert!(e.message.contains("nonsense"), "{}", e.message);
        let e = parse_url_list(r#"["", "  "]"#).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        let e = parse_url_list("not json").unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument);
        let many: Vec<String> = (0..=MAX_URLS_PER_CALL)
            .map(|i| format!("http://t{i}.example.com/announce"))
            .collect();
        let e = parse_url_list(&serde_json::to_string(&many).unwrap()).unwrap_err();
        assert_eq!(e.code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn plan_add_skips_what_is_already_there() {
        let current = vec!["http://t.example.com/announce".to_string()];
        let new = vec![
            "http://T.example.com:80/announce".to_string(),
            "udp://u.example.com:1/announce".to_string(),
        ];
        let (fresh, skipped) = plan_add(&current, &new);
        assert_eq!(fresh, vec!["udp://u.example.com:1/announce".to_string()]);
        assert_eq!(skipped, 1);
    }

    #[test]
    fn edits_apply_on_top_of_the_original_list() {
        let original = vec![
            "http://orig1.example.com/announce".to_string(),
            "http://orig2.example.com/announce".to_string(),
        ];
        let edits = TrackerEdits {
            added: vec!["udp://new.example.com:1/announce".to_string()],
            removed: vec!["http://ORIG1.example.com/announce".to_string()],
        };
        assert_eq!(
            apply_edits(&original, &edits),
            vec![
                "http://orig2.example.com/announce".to_string(),
                "udp://new.example.com:1/announce".to_string()
            ]
        );
        // applying twice gives the same list
        let once = apply_edits(&original, &edits);
        assert_eq!(apply_edits(&once, &edits), once);
        assert_eq!(apply_edits(&original, &TrackerEdits::default()).len(), 2);
    }

    #[test]
    fn removing_the_last_tracker_is_allowed() {
        let original = vec!["http://only.example.com/announce".to_string()];
        let edits = TrackerEdits {
            added: vec![],
            removed: vec!["http://only.example.com/announce".to_string()],
        };
        assert!(apply_edits(&original, &edits).is_empty());
    }

    #[test]
    fn store_tracks_add_remove_and_re_add() {
        let dir = temp_dir("store");
        let mut s = TrackerStore::load(&dir);
        assert!(s.get("abc").is_none());
        s.record_added("abc", &["udp://n.example.com:1/a".to_string()]);
        s.record_removed("abc", "http://o.example.com/a");
        s.save().unwrap();
        assert!(!dir.join("maglev-trackers.json.tmp").exists());

        let mut s2 = TrackerStore::load(&dir);
        let e = s2.get("abc").unwrap();
        assert_eq!(e.added, vec!["udp://n.example.com:1/a".to_string()]);
        assert_eq!(e.removed, vec!["http://o.example.com/a".to_string()]);

        // removing something the user added just undoes the add
        s2.record_removed("abc", "udp://n.example.com:1/a");
        // adding back something that was removed undoes the removal
        s2.record_added("abc", &["http://O.example.com/a".to_string()]);
        let e = s2.get("abc").unwrap();
        assert_eq!(e.added, vec!["http://O.example.com/a".to_string()]);
        assert_eq!(e.removed, vec!["udp://n.example.com:1/a".to_string()]);

        assert!(s2.forget("abc"));
        assert!(!s2.forget("abc"));
        s2.save().unwrap();
        assert!(TrackerStore::load(&dir).get("abc").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_survives_junk_files() {
        let dir = temp_dir("junk");
        std::fs::write(dir.join(TRACKERS_FILE), b"{not json").unwrap();
        assert!(TrackerStore::load(&dir).get("abc").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn torrent_file_keeps_the_info_dictionary_byte_for_byte() {
        let info = b"d6:lengthi5e4:name1:x12:piece lengthi16384e6:pieces20:AAAAAAAAAAAAAAAAAAAAe";
        let out = build_torrent_file(
            info,
            &[
                "http://a.example.com/announce".to_string(),
                "udp://b.example.com:1/announce".to_string(),
            ],
        );
        let mut want: Vec<u8> = Vec::new();
        want.extend_from_slice(
            b"d8:announce29:http://a.example.com/announce13:announce-listll29:http://a.example.com/announce30:udp://b.example.com:1/announceee4:info",
        );
        want.extend_from_slice(info);
        want.push(b'e');
        assert_eq!(out, want);
    }

    #[test]
    fn torrent_file_without_trackers_has_only_the_info_dictionary() {
        let info = b"d4:name1:xe";
        assert_eq!(build_torrent_file(info, &[]), b"d4:infod4:name1:xee".to_vec());
    }

    #[test]
    fn export_path_must_be_an_absolute_torrent_file() {
        assert!(check_export_path("/sdcard/Download/Maglev/a.torrent").is_ok());
        assert!(check_export_path("/sdcard/Download/Maglev/a.TORRENT").is_ok());
        assert!(check_export_path("a.torrent").is_err());
        assert!(check_export_path("/sdcard/a.txt").is_err());
        assert!(check_export_path("/sdcard/Download/").is_err());
        assert!(check_export_path("").is_err());
    }
}
