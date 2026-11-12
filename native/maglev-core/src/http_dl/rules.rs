//! The pure decisions of the URL download driver: how to read a probe answer, what a resume answer means,
//! retry timing and pacing (contract section 17). No IO, no clock, no randomness (the caller passes the jitter).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::{Duration, Instant};

use super::machine::Event;

/// The response headers the driver cares about, already read as text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers {
    pub content_type: Option<String>,
    pub content_length: Option<u64>,
    pub content_range: Option<String>,
    pub accept_ranges: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_disposition: Option<String>,
    pub retry_after: Option<String>,
}

/// What the `Range: bytes=0-0` probe taught us.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeInfo {
    pub size: Option<u64>,
    /// A strong ETag, else Last-Modified. `None` means resume is not offered.
    pub validator: Option<String>,
    /// The server honours ranges and we have a validator to prove the file did not change.
    pub resumable: bool,
    /// The 0-0 probe itself returned 206 (needed for segments).
    pub probe_was_206: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeVerdict {
    Ok(ProbeInfo),
    Auth,
    /// Any other failing status.
    Status(u16),
    Html,
}

/// A strong ETag wins; a weak one (`W/"..."`) is not a byte-exact validator, so Last-Modified is used instead.
pub fn pick_validator(etag: Option<&str>, last_modified: Option<&str>) -> Option<String> {
    if let Some(e) = etag.map(str::trim) {
        if !e.is_empty() && !e.starts_with("W/") && !e.starts_with("w/") {
            return Some(e.to_string());
        }
    }
    last_modified.map(str::trim).filter(|l| !l.is_empty()).map(str::to_string)
}

/// `bytes 0-0/12345` gives `(Some(0), Some(0), Some(12345))`; `bytes */12345` gives `(None, None, Some(12345))`;
/// `bytes 5-9/*` gives total `None`.
pub fn parse_content_range(v: &str) -> Option<(Option<u64>, Option<u64>, Option<u64>)> {
    let v = v.trim();
    let rest = v.strip_prefix("bytes").or_else(|| v.strip_prefix("Bytes"))?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let total = total.trim();
    let total = if total == "*" { None } else { Some(total.parse::<u64>().ok()?) };
    let range = range.trim();
    if range == "*" {
        return Some((None, None, total));
    }
    let (a, b) = range.split_once('-')?;
    Some((Some(a.trim().parse().ok()?), Some(b.trim().parse().ok()?), total))
}

/// Last path segment has a short extension that is not a web page one.
pub fn url_looks_like_file(url: &str) -> bool {
    let Some(name) = super::content_disposition::filename_from_url(url) else {
        return false;
    };
    let Some((stem, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if stem.is_empty() || ext.is_empty() || ext.len() > 5 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    !matches!(
        ext.to_ascii_lowercase().as_str(),
        "html" | "htm" | "xhtml" | "php" | "asp" | "aspx" | "jsp" | "cgi"
    )
}

fn is_html(content_type: Option<&str>) -> bool {
    content_type
        .map(|c| {
            let c = c.trim().to_ascii_lowercase();
            c.starts_with("text/html") || c.starts_with("application/xhtml")
        })
        .unwrap_or(false)
}

/// Reads the answer to the `Range: bytes=0-0` probe.
pub fn classify_probe(status: u16, h: &Headers, url: &str) -> ProbeVerdict {
    match status {
        200 | 206 => {
            // A web page is never the file, whatever the URL looks like (an HTML file download is rare).
            let _ = url;
            if is_html(h.content_type.as_deref()) {
                return ProbeVerdict::Html;
            }
            let validator = pick_validator(h.etag.as_deref(), h.last_modified.as_deref());
            if status == 206 {
                let size = h
                    .content_range
                    .as_deref()
                    .and_then(parse_content_range)
                    .and_then(|(_, _, total)| total);
                ProbeVerdict::Ok(ProbeInfo {
                    size,
                    resumable: validator.is_some() && size.is_some(),
                    validator,
                    probe_was_206: true,
                })
            } else {
                let accepts = h
                    .accept_ranges
                    .as_deref()
                    .map(|a| a.to_ascii_lowercase().contains("bytes"))
                    .unwrap_or(false);
                ProbeVerdict::Ok(ProbeInfo {
                    size: h.content_length,
                    resumable: accepts && validator.is_some() && h.content_length.is_some(),
                    validator,
                    probe_was_206: false,
                })
            }
        }
        // An empty file answers a range request with 416 and `bytes */0`.
        416 => match h.content_range.as_deref().and_then(parse_content_range) {
            Some((_, _, Some(0))) => ProbeVerdict::Ok(ProbeInfo {
                size: Some(0),
                validator: None,
                resumable: false,
                probe_was_206: false,
            }),
            _ => ProbeVerdict::Status(416),
        },
        401 | 403 => ProbeVerdict::Auth,
        other => ProbeVerdict::Status(other),
    }
}

/// What the response to a download request means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    /// Write the body at `offset`. `total` is the full size when the response tells it.
    Body { offset: u64, total: Option<u64> },
    /// The machine event to feed, and whether the driver should keep going afterwards.
    Event(Event),
    /// Retry after this many seconds, if the server said so.
    Retry { retry_after: Option<Duration> },
    /// 401 or 403: the driver counts these (three 403 in a row, or one 401 or 410, need a new link).
    Denied { status: u16 },
}

/// Judges the response to a GET. `held` is the number of bytes already in the part file and `total` the size we
/// stored. `ranged` is true when the request carried `Range` and `If-Range`.
pub fn judge_response(status: u16, h: &Headers, held: u64, total: Option<u64>, ranged: bool) -> Reply {
    match status {
        206 if ranged => match h.content_range.as_deref().and_then(parse_content_range) {
            Some((Some(start), _, got_total)) => {
                let same_total = match (total, got_total) {
                    (Some(a), Some(b)) => a == b,
                    _ => true,
                };
                if start == held && same_total {
                    Reply::Body { offset: start, total: got_total.or(total) }
                } else {
                    Reply::Event(Event::ValidatorChanged)
                }
            }
            _ => Reply::Event(Event::ValidatorChanged),
        },
        // A 206 we did not ask for is a broken server.
        206 => Reply::Event(Event::ValidatorChanged),
        // 200 on a ranged request: the If-Range validator no longer matches, or ranges are ignored.
        200 if ranged => Reply::Event(Event::Got200OnResume),
        200 => Reply::Body { offset: 0, total: h.content_length },
        416 => {
            let len = h.content_range.as_deref().and_then(parse_content_range).and_then(|(_, _, t)| t);
            let held_equals_total = len == Some(held) && total.map(|t| t == held).unwrap_or(true);
            Reply::Event(Event::Got416 { held_equals_total })
        }
        401 | 403 => Reply::Denied { status },
        410 => Reply::Event(Event::Auth),
        408 | 429 | 500 | 502 | 503 | 504 => Reply::Retry { retry_after: parse_retry_after(h.retry_after.as_deref()) },
        _ => Reply::Event(Event::HttpFatal),
    }
}

/// Judges the response to a GET against what the probe taught us (`total` and `validator` as stored).
/// A page instead of the file is `NotAFile`; a fresh 200 whose length or validator differs from the probe is a
/// changed file. A header the GET does not send cannot be compared and is let through.
pub fn judge_get(
    status: u16,
    h: &Headers,
    held: u64,
    total: Option<u64>,
    validator: Option<&str>,
    ranged: bool,
) -> Reply {
    let reply = judge_response(status, h, held, total, ranged);
    let offset = match &reply {
        Reply::Body { offset, .. } => *offset,
        _ => return reply,
    };
    if is_html(h.content_type.as_deref()) {
        return Reply::Event(Event::NotAFile);
    }
    if offset == 0 {
        if let (Some(a), Some(b)) = (total, h.content_length) {
            if a != b {
                return Reply::Event(Event::ValidatorChanged);
            }
        }
        if let (Some(a), Some(b)) = (validator, pick_validator(h.etag.as_deref(), h.last_modified.as_deref())) {
            if a != b {
                return Reply::Event(Event::ValidatorChanged);
            }
        }
    }
    reply
}

/// True when writing `len` more bytes at `pos` would pass the declared `total`.
pub fn overruns(pos: u64, len: u64, total: Option<u64>) -> bool {
    total.map(|t| pos.saturating_add(len) > t).unwrap_or(false)
}

/// Free space kept back for the system and the user (contract section 10.3).
pub const RESERVE_BYTES: u64 = 200 * 1024 * 1024;

/// Does the rest of the file fit with the reserve left over? `free` of `None` (unknown) says yes.
/// With an unknown `size` only the reserve is checked.
pub fn fits(size: Option<u64>, held: u64, free: Option<u64>) -> bool {
    let Some(free) = free else {
        return true;
    };
    let need = size.map(|s| s.saturating_sub(held)).unwrap_or(0);
    need <= free.saturating_sub(RESERVE_BYTES) && (size.is_some() || free >= RESERVE_BYTES)
}

fn v4_is_local(a: Ipv4Addr) -> bool {
    let o = a.octets();
    a.is_loopback()
        || a.is_private()
        || a.is_link_local()
        || a.is_unspecified()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
}

fn v6_is_local(a: Ipv6Addr) -> bool {
    if let Some(v4) = a.to_ipv4_mapped() {
        return v4_is_local(v4);
    }
    let seg = a.segments();
    a.is_loopback()
        || a.is_unspecified()
        || (seg[0] & 0xffc0) == 0xfe80
        || (seg[0] & 0xfe00) == 0xfc00
}

/// Loopback, private (RFC 1918), link-local, CGNAT, unique-local, `localhost` and `*.local`.
/// `host` may be a bracketed IPv6 literal.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']').trim_end_matches('.');
    let lower = h.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") {
        return true;
    }
    match lower.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => v4_is_local(a),
        Ok(IpAddr::V6(a)) => v6_is_local(a),
        Err(_) => false,
    }
}

/// A redirect may not lead onto the local network, unless the link the user typed was already there.
pub fn redirect_host_allowed(original_host: &str, target_host: &str) -> bool {
    !is_lan_host(target_host) || is_lan_host(original_host)
}

/// A host on the local network: an IP literal that `is_local_ip` says is local, or a name that
/// `looks_like_lan_name`. The redirect policy and the resolver both ask this, so they agree.
pub fn is_lan_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']').trim_end_matches('.');
    match h.parse::<IpAddr>() {
        Ok(ip) => is_local_ip(ip),
        Err(_) => looks_like_lan_name(h),
    }
}

/// Which local addresses a download's connections may use (contract 17.w). Chosen from the download's own typed
/// host, never from a list shared between downloads.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum LanScope {
    /// A public link: no redirect target and no resolved address may be on the local network.
    Public,
    /// The typed host is itself local: local to local is fine.
    LanOrigin,
    /// The user allowed this typed host: only it, and only the pinned addresses, may be local.
    Allow { host: String, pinned: Vec<IpAddr> },
}

impl LanScope {
    /// `pinned` are the addresses the host had when the user allowed it (text form; bad entries are ignored).
    pub fn for_host(typed_host: &str, allow_lan: bool, pinned: &[String]) -> LanScope {
        if is_lan_host(typed_host) {
            return LanScope::LanOrigin;
        }
        if allow_lan {
            let mut ips: Vec<IpAddr> = pinned.iter().filter_map(|p| p.parse().ok()).collect();
            ips.sort();
            ips.dedup();
            return LanScope::Allow { host: typed_host.trim_end_matches('.').to_ascii_lowercase(), pinned: ips };
        }
        LanScope::Public
    }

    /// May a redirect lead to this host?
    pub fn redirect_allowed(&self, target_host: &str) -> bool {
        if !is_lan_host(target_host) {
            return true;
        }
        match self {
            LanScope::Public => false,
            LanScope::LanOrigin => true,
            LanScope::Allow { host, .. } => {
                host.eq_ignore_ascii_case(target_host.trim().trim_end_matches('.'))
            }
        }
    }

    /// The resolved addresses of `name` that a connection may use.
    pub fn keep(&self, name: &str, addrs: &[IpAddr]) -> Vec<IpAddr> {
        match self {
            LanScope::Public => keep_resolved(false, addrs),
            LanScope::LanOrigin => addrs.to_vec(),
            LanScope::Allow { host, pinned } => {
                let same = host.eq_ignore_ascii_case(name.trim_end_matches('.'));
                addrs.iter().copied().filter(|a| !is_local_ip(*a) || (same && pinned.contains(a))).collect()
            }
        }
    }
}

/// `Retry-After` in seconds. The HTTP-date form is not parsed; the normal backoff covers it.
pub fn parse_retry_after(v: Option<&str>) -> Option<Duration> {
    let secs: u64 = v?.trim().parse().ok()?;
    Some(Duration::from_secs(secs.min(600)))
}

/// Exponential backoff: 1 s, 2 s, 4 s ... capped at 60 s, plus up to 25 % jitter (`jitter` is 0.0 to 1.0).
/// A longer `Retry-After` replaces the computed wait.
pub fn backoff_delay(attempt: u32, retry_after: Option<Duration>, jitter: f64) -> Duration {
    let base_ms = 1000u64.saturating_mul(1u64 << attempt.min(6)).min(60_000);
    let jitter = jitter.clamp(0.0, 1.0);
    let with_jitter = base_ms + (base_ms as f64 * 0.25 * jitter) as u64;
    let computed = Duration::from_millis(with_jitter);
    match retry_after {
        Some(r) if r > computed => r,
        _ => computed,
    }
}

/// How long to wait so that `bytes` transferred since `elapsed` stay at or under `limit_bps`. Zero limit = no wait.
pub fn pace_delay(bytes: u64, elapsed: Duration, limit_bps: u64) -> Duration {
    if limit_bps == 0 {
        return Duration::ZERO;
    }
    let needed = Duration::from_secs_f64(bytes as f64 / limit_bps as f64);
    needed.saturating_sub(elapsed)
}

// ---- slots ----

/// Is there room for one more working download? `max` is `NativeConfig.max_active_downloads`; 0 = no limit.
pub fn slot_free(active: usize, max: u32) -> bool {
    max == 0 || active < max as usize
}

// ---- stalls ----

/// No byte for this long: the card shows "Waiting for the server".
pub const STALL_FLAG_AFTER: Duration = Duration::from_secs(30);
/// No byte for this long: the connection is cut and retried. Under the client's 45 s read timeout, so a silent
/// server is a stall (budget 5) and not a network error.
pub const STALL_SILENCE_ABORT: Duration = Duration::from_secs(40);
/// The length of the window the average speed is judged over.
pub const STALL_WINDOW: Duration = Duration::from_secs(60);
/// Average speed under this over a window counts as a stall.
pub const STALL_MIN_BPS: u64 = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallCheck {
    /// Keep going; the window is not over.
    Fine,
    /// The window is over and fast enough: start a new one and forgive earlier stalls.
    Healthy,
    /// Too slow or silent: cut the connection.
    Stalled,
}

/// Has the server been quiet long enough to say so on the card?
pub fn waiting_for_server(since_last_byte: Duration) -> bool {
    since_last_byte >= STALL_FLAG_AFTER
}

/// The slowest average (bytes per second) that still counts as moving. A speed limit below 2 KiB/s lowers it, so
/// the user's own limit never looks like a stall. `limit_bps` 0 = no limit.
pub fn stall_floor(limit_bps: u64) -> u64 {
    if limit_bps == 0 {
        STALL_MIN_BPS
    } else {
        STALL_MIN_BPS.min(limit_bps / 2)
    }
}

/// Judges the transfer so far. `window_elapsed` and `window_bytes` cover the current window only.
pub fn check_stall(since_last_byte: Duration, window_elapsed: Duration, window_bytes: u64, floor_bps: u64) -> StallCheck {
    if since_last_byte >= STALL_SILENCE_ABORT {
        return StallCheck::Stalled;
    }
    if window_elapsed >= STALL_WINDOW {
        let needed = floor_bps.saturating_mul(window_elapsed.as_secs());
        return if window_bytes < needed { StallCheck::Stalled } else { StallCheck::Healthy };
    }
    StallCheck::Fine
}

/// The stall window of one transfer. It lives across reconnects, so a server that sends a little and then drops
/// the connection can't start a fresh window each time. `now` is always passed in.
#[derive(Debug, Clone, Copy)]
pub struct StallClock {
    win_start: Instant,
    win_bytes: u64,
    last_byte: Instant,
}

impl StallClock {
    pub fn new(now: Instant) -> Self {
        StallClock { win_start: now, win_bytes: 0, last_byte: now }
    }

    pub fn on_bytes(&mut self, now: Instant, n: u64) {
        self.last_byte = now;
        self.win_bytes = self.win_bytes.saturating_add(n);
    }

    /// Time spent waiting on our own limiter is nobody's stall: move both clocks forward by `waited`.
    pub fn excuse(&mut self, waited: Duration, now: Instant) {
        self.win_start = (self.win_start + waited).min(now);
        self.last_byte = (self.last_byte + waited).min(now);
    }

    pub fn quiet(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last_byte)
    }

    /// A new window after a stall retry.
    pub fn restart(&mut self, now: Instant) {
        *self = StallClock::new(now);
    }

    /// Judges the transfer. A healthy answer also starts the next window.
    pub fn check(&mut self, now: Instant, floor_bps: u64) -> StallCheck {
        let r = check_stall(
            self.quiet(now),
            now.saturating_duration_since(self.win_start),
            self.win_bytes,
            floor_bps,
        );
        if r == StallCheck::Healthy {
            self.win_start = now;
            self.win_bytes = 0;
        }
        r
    }

    /// Did a connection that just broke have a poor window so far? Then the break counts toward the stall budget.
    pub fn broken_is_stall(&self, now: Instant, floor_bps: u64) -> bool {
        let elapsed = now.saturating_duration_since(self.win_start);
        elapsed < STALL_WINDOW && (self.win_bytes as f64) < floor_bps as f64 * elapsed.as_secs_f64()
    }
}

/// The names of the backups to delete so that only the newest `keep` stay. `corrupt-<secs>` names sort by time.
pub fn backups_to_delete(names: &[String], keep: usize) -> Vec<String> {
    let mut stamped: Vec<(i64, &String)> = names
        .iter()
        .filter_map(|n| {
            let t = n.strip_prefix("maglev-downloads.corrupt-")?.strip_suffix(".json")?;
            Some((t.parse::<i64>().ok()?, n))
        })
        .collect();
    stamped.sort_by(|a, b| b.0.cmp(&a.0));
    stamped.into_iter().skip(keep).map(|(_, n)| n.clone()).collect()
}

// ---- resolved addresses (DNS rebinding) ----

/// Loopback, unspecified, private, link-local, CGNAT, unique-local, multicast, broadcast, or a mapped or NAT64 form
/// of one of those.
pub fn is_local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => v4_is_local(a) || a.is_multicast() || a.is_broadcast(),
        IpAddr::V6(a) => {
            if a.is_multicast() {
                return true;
            }
            // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 address in the last 32 bits.
            let s = a.segments();
            if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
                let v4 = Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
                return v4_is_local(v4);
            }
            v6_is_local(a)
        }
    }
}

/// A name the user could type for a device at home: `localhost`, `*.local`, `*.localhost`, `*.lan`,
/// `*.home.arpa`, `*.localdomain` or a single word such as `nas`. These may resolve to a local address.
pub fn looks_like_lan_name(host: &str) -> bool {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() {
        return false;
    }
    if is_local_host(&h) {
        return true;
    }
    if h.parse::<IpAddr>().is_ok() {
        return false;
    }
    !h.contains('.') || h.ends_with(".lan") || h.ends_with(".home.arpa") || h.ends_with(".localdomain")
}

/// The resolved addresses a connection may use. A name the user typed as a local one (`lan_ok`) keeps them all;
/// any other name loses its local addresses. An empty answer means the name only led to the local network.
pub fn keep_resolved(lan_ok: bool, addrs: &[IpAddr]) -> Vec<IpAddr> {
    if lan_ok {
        addrs.to_vec()
    } else {
        addrs.iter().copied().filter(|a| !is_local_ip(*a)).collect()
    }
}

// ---- secrets in a link ----

/// Does the query of this link look like it carries a token or a signature? Such a link is never saved with its
/// query (contract section 17.y).
pub fn has_secret_query(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else {
        return false;
    };
    const WORDS: [&str; 22] = [
        "token", "secret", "password", "passwd", "pwd", "signature", "sig", "credential", "credentials", "session",
        "sessionid", "apikey", "key", "auth", "authorization", "jwt", "sas", "expires", "expire", "sign",
        // Discord CDN signs with `hm` (and `ex`, `is`); Dropbox shared links carry `rlkey`.
        "hm", "rlkey",
    ];
    const PARTS: [&str; 5] = ["token", "apikey", "signature", "secret", "password"];
    u.query_pairs().any(|(k, _)| {
        let k = k.to_ascii_lowercase();
        k.starts_with("x-amz-")
            || k.starts_with("x-goog-")
            || PARTS.iter().any(|p| k.contains(p))
            || k.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| WORDS.contains(&w))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h() -> Headers {
        Headers::default()
    }

    // ---- validators and parsing ----

    #[test]
    fn strong_etag_is_preferred_and_weak_is_not_used() {
        assert_eq!(pick_validator(Some("\"abc\""), Some("Mon, 01 Jan 2024 00:00:00 GMT")).as_deref(), Some("\"abc\""));
        assert_eq!(
            pick_validator(Some("W/\"abc\""), Some("Mon, 01 Jan 2024 00:00:00 GMT")).as_deref(),
            Some("Mon, 01 Jan 2024 00:00:00 GMT")
        );
        assert_eq!(pick_validator(Some("W/\"abc\""), None), None);
        assert_eq!(pick_validator(None, None), None);
    }

    #[test]
    fn content_range_forms() {
        assert_eq!(parse_content_range("bytes 0-0/12345"), Some((Some(0), Some(0), Some(12345))));
        assert_eq!(parse_content_range("bytes 100-199/*"), Some((Some(100), Some(199), None)));
        assert_eq!(parse_content_range("bytes */777"), Some((None, None, Some(777))));
        assert_eq!(parse_content_range("items 0-1/2"), None);
        assert_eq!(parse_content_range("bytes a-b/c"), None);
    }

    #[test]
    fn file_like_urls() {
        assert!(url_looks_like_file("https://x.test/a/b.zip?x=1"));
        assert!(url_looks_like_file("https://x.test/a.tar.gz"));
        assert!(!url_looks_like_file("https://x.test/a/page.html"));
        assert!(!url_looks_like_file("https://x.test/download"));
        assert!(!url_looks_like_file("https://x.test/get.php?id=3"));
        assert!(!url_looks_like_file("https://x.test/"));
    }

    // ---- probe ----

    #[test]
    fn probe_206_with_etag_is_resumable() {
        let hd = Headers {
            content_range: Some("bytes 0-0/5000".into()),
            etag: Some("\"v1\"".into()),
            ..h()
        };
        assert_eq!(
            classify_probe(206, &hd, "https://x.test/f.bin"),
            ProbeVerdict::Ok(ProbeInfo {
                size: Some(5000),
                validator: Some("\"v1\"".into()),
                resumable: true,
                probe_was_206: true
            })
        );
    }

    #[test]
    fn probe_206_without_validator_is_not_resumable() {
        let hd = Headers { content_range: Some("bytes 0-0/5000".into()), ..h() };
        match classify_probe(206, &hd, "https://x.test/f.bin") {
            ProbeVerdict::Ok(i) => {
                assert!(!i.resumable);
                assert_eq!(i.size, Some(5000));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn probe_200_with_accept_ranges_and_last_modified_is_resumable() {
        let hd = Headers {
            content_length: Some(900),
            accept_ranges: Some("bytes".into()),
            last_modified: Some("Mon, 01 Jan 2024 00:00:00 GMT".into()),
            ..h()
        };
        match classify_probe(200, &hd, "https://x.test/f.bin") {
            ProbeVerdict::Ok(i) => {
                assert!(i.resumable);
                assert!(!i.probe_was_206);
                assert_eq!(i.size, Some(900));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn probe_200_without_ranges_is_not_resumable() {
        let hd = Headers { content_length: Some(900), etag: Some("\"x\"".into()), ..h() };
        match classify_probe(200, &hd, "https://x.test/f.bin") {
            ProbeVerdict::Ok(i) => assert!(!i.resumable),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn probe_html_is_always_not_a_file() {
        let hd = Headers { content_type: Some("text/html; charset=utf-8".into()), ..h() };
        assert_eq!(classify_probe(200, &hd, "https://x.test/movie.mkv"), ProbeVerdict::Html);
        assert_eq!(classify_probe(200, &hd, "https://x.test/get"), ProbeVerdict::Html);
        assert_eq!(classify_probe(206, &hd, "https://x.test/page.html"), ProbeVerdict::Html);
        let xh = Headers { content_type: Some("application/xhtml+xml".into()), ..h() };
        assert_eq!(classify_probe(200, &xh, "https://x.test/a"), ProbeVerdict::Html);
    }

    // ---- GET against the probe ----

    #[test]
    fn get_with_a_page_is_not_a_file() {
        let hd = Headers { content_type: Some("text/html".into()), content_length: Some(10), ..h() };
        assert_eq!(judge_get(200, &hd, 0, Some(10), None, false), Reply::Event(Event::NotAFile));
        assert_eq!(judge_get(200, &hd, 0, None, None, false), Reply::Event(Event::NotAFile));
    }

    #[test]
    fn get_length_must_match_the_probe() {
        let hd = Headers { content_length: Some(11), ..h() };
        assert_eq!(judge_get(200, &hd, 0, Some(10), None, false), Reply::Event(Event::ValidatorChanged));
        let ok = Headers { content_length: Some(10), ..h() };
        assert_eq!(
            judge_get(200, &ok, 0, Some(10), None, false),
            Reply::Body { offset: 0, total: Some(10) }
        );
        // No length on the GET cannot be compared.
        assert_eq!(judge_get(200, &h(), 0, Some(10), None, false), Reply::Body { offset: 0, total: None });
    }

    #[test]
    fn get_validator_must_match_the_probe() {
        let other = Headers { etag: Some("\"v2\"".into()), ..h() };
        assert_eq!(
            judge_get(200, &other, 0, None, Some("\"v1\""), false),
            Reply::Event(Event::ValidatorChanged)
        );
        let same = Headers { etag: Some("\"v1\"".into()), ..h() };
        assert!(matches!(judge_get(200, &same, 0, None, Some("\"v1\""), false), Reply::Body { .. }));
        let lm = Headers { last_modified: Some("Tue, 02 Jan 2024 00:00:00 GMT".into()), ..h() };
        assert_eq!(
            judge_get(200, &lm, 0, None, Some("Mon, 01 Jan 2024 00:00:00 GMT"), false),
            Reply::Event(Event::ValidatorChanged)
        );
    }

    #[test]
    fn get_resume_replies_pass_through() {
        assert_eq!(
            judge_get(206, &ranged_206(1000, 5000), 1000, Some(5000), Some("\"v\""), true),
            Reply::Body { offset: 1000, total: Some(5000) }
        );
        assert_eq!(judge_get(200, &h(), 1000, Some(5000), Some("\"v\""), true), Reply::Event(Event::Got200OnResume));
        assert_eq!(judge_get(404, &h(), 0, None, None, false), Reply::Event(Event::HttpFatal));
    }

    // ---- overrun and free space ----

    #[test]
    fn bytes_past_the_total_are_an_overrun() {
        assert!(!overruns(0, 10, Some(10)));
        assert!(overruns(5, 6, Some(10)));
        assert!(overruns(10, 1, Some(10)));
        assert!(!overruns(u64::MAX, 1, None));
    }

    #[test]
    fn free_space_rule_keeps_the_reserve() {
        let gb = 1024 * 1024 * 1024u64;
        assert!(fits(Some(gb), 0, Some(2 * gb)));
        assert!(!fits(Some(gb), 0, Some(gb)));
        assert!(!fits(Some(gb), 0, Some(gb + RESERVE_BYTES - 1)));
        assert!(fits(Some(gb), 0, Some(gb + RESERVE_BYTES)));
        // Bytes already held do not need space again.
        assert!(fits(Some(gb), gb - 1000, Some(RESERVE_BYTES + 1000)));
        // Unknown size: only the reserve counts.
        assert!(fits(None, 0, Some(RESERVE_BYTES)));
        assert!(!fits(None, 0, Some(RESERVE_BYTES - 1)));
        // Unknown free space does not block.
        assert!(fits(Some(gb), 0, None));
    }

    // ---- redirects to the local network ----

    #[test]
    fn local_hosts_are_recognised() {
        for h in [
            "localhost", "LOCALHOST", "printer.local", "nas.local.", "127.0.0.1", "127.9.9.9", "10.0.0.5",
            "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.10.10", "100.64.0.1", "100.127.255.255",
            "0.0.0.0", "[::1]", "::1", "[fe80::1]", "[febf::1]", "[fc00::1]", "[fd12:3456::1]",
            "[::ffff:192.168.1.1]", "[::ffff:127.0.0.1]",
        ] {
            assert!(is_local_host(h), "{h}");
        }
    }

    #[test]
    fn public_hosts_are_not_local() {
        for h in [
            "example.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1",
            "[2001:4860:4860::8888]", "[fec0::1]", "[::ffff:8.8.8.8]", "notlocal.example", "mylocal.com",
        ] {
            assert!(!is_local_host(h), "{h}");
        }
    }

    #[test]
    fn redirect_to_the_local_network_is_refused_from_a_public_link() {
        assert!(!redirect_host_allowed("cdn.example.com", "192.168.1.1"));
        assert!(!redirect_host_allowed("cdn.example.com", "localhost"));
        assert!(!redirect_host_allowed("cdn.example.com", "[::1]"));
        assert!(!redirect_host_allowed("cdn.example.com", "router.local"));
        assert!(redirect_host_allowed("cdn.example.com", "files.example.org"));
    }

    #[test]
    fn a_local_link_may_redirect_locally() {
        assert!(redirect_host_allowed("192.168.1.10", "192.168.1.20"));
        assert!(redirect_host_allowed("nas.local", "10.0.0.2"));
        assert!(redirect_host_allowed("192.168.1.10", "cdn.example.com"));
    }

    #[test]
    fn probe_auth_and_status() {
        assert_eq!(classify_probe(401, &h(), "https://x.test/a.bin"), ProbeVerdict::Auth);
        assert_eq!(classify_probe(403, &h(), "https://x.test/a.bin"), ProbeVerdict::Auth);
        assert_eq!(classify_probe(404, &h(), "https://x.test/a.bin"), ProbeVerdict::Status(404));
        assert_eq!(classify_probe(500, &h(), "https://x.test/a.bin"), ProbeVerdict::Status(500));
    }

    #[test]
    fn probe_416_for_an_empty_file() {
        let hd = Headers { content_range: Some("bytes */0".into()), ..h() };
        match classify_probe(416, &hd, "https://x.test/empty.txt") {
            ProbeVerdict::Ok(i) => assert_eq!(i.size, Some(0)),
            other => panic!("{other:?}"),
        }
        assert_eq!(classify_probe(416, &h(), "https://x.test/a.bin"), ProbeVerdict::Status(416));
    }

    // ---- resume rules ----

    fn ranged_206(start: u64, total: u64) -> Headers {
        Headers { content_range: Some(format!("bytes {start}-{}/{total}", total - 1)), ..h() }
    }

    #[test]
    fn resume_206_at_the_right_offset_appends() {
        assert_eq!(
            judge_response(206, &ranged_206(1000, 5000), 1000, Some(5000), true),
            Reply::Body { offset: 1000, total: Some(5000) }
        );
    }

    #[test]
    fn resume_206_at_the_wrong_offset_is_a_changed_file() {
        assert_eq!(
            judge_response(206, &ranged_206(0, 5000), 1000, Some(5000), true),
            Reply::Event(Event::ValidatorChanged)
        );
    }

    #[test]
    fn resume_206_with_another_total_is_a_changed_file() {
        assert_eq!(
            judge_response(206, &ranged_206(1000, 6000), 1000, Some(5000), true),
            Reply::Event(Event::ValidatorChanged)
        );
    }

    #[test]
    fn resume_206_without_content_range_is_a_changed_file() {
        assert_eq!(judge_response(206, &h(), 1000, Some(5000), true), Reply::Event(Event::ValidatorChanged));
    }

    #[test]
    fn resume_200_restarts_and_never_appends() {
        assert_eq!(judge_response(200, &h(), 1000, Some(5000), true), Reply::Event(Event::Got200OnResume));
    }

    #[test]
    fn fresh_200_writes_from_zero_with_the_length() {
        let hd = Headers { content_length: Some(42), ..h() };
        assert_eq!(judge_response(200, &hd, 0, None, false), Reply::Body { offset: 0, total: Some(42) });
    }

    #[test]
    fn resume_416_with_everything_held_verifies() {
        let hd = Headers { content_range: Some("bytes */5000".into()), ..h() };
        assert_eq!(
            judge_response(416, &hd, 5000, Some(5000), true),
            Reply::Event(Event::Got416 { held_equals_total: true })
        );
    }

    #[test]
    fn resume_416_otherwise_is_a_changed_file() {
        let hd = Headers { content_range: Some("bytes */4000".into()), ..h() };
        assert_eq!(
            judge_response(416, &hd, 5000, Some(5000), true),
            Reply::Event(Event::Got416 { held_equals_total: false })
        );
        assert_eq!(
            judge_response(416, &h(), 5000, Some(5000), true),
            Reply::Event(Event::Got416 { held_equals_total: false })
        );
    }

    #[test]
    fn status_classes() {
        assert_eq!(judge_response(401, &h(), 0, None, false), Reply::Denied { status: 401 });
        assert_eq!(judge_response(403, &h(), 0, None, false), Reply::Denied { status: 403 });
        assert_eq!(judge_response(410, &h(), 0, None, false), Reply::Event(Event::Auth));
        assert_eq!(judge_response(404, &h(), 0, None, false), Reply::Event(Event::HttpFatal));
        assert_eq!(judge_response(400, &h(), 0, None, false), Reply::Event(Event::HttpFatal));
        for s in [408u16, 429, 500, 502, 503, 504] {
            assert!(matches!(judge_response(s, &h(), 0, None, false), Reply::Retry { .. }), "{s}");
        }
    }

    #[test]
    fn retry_after_is_honoured_and_capped() {
        let hd = Headers { retry_after: Some("30".into()), ..h() };
        assert_eq!(
            judge_response(429, &hd, 0, None, false),
            Reply::Retry { retry_after: Some(Duration::from_secs(30)) }
        );
        assert_eq!(parse_retry_after(Some("99999")), Some(Duration::from_secs(600)));
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")), None);
        assert_eq!(parse_retry_after(None), None);
    }

    // ---- backoff and pacing ----

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_delay(0, None, 0.0), Duration::from_millis(1000));
        assert_eq!(backoff_delay(1, None, 0.0), Duration::from_millis(2000));
        assert_eq!(backoff_delay(3, None, 0.0), Duration::from_millis(8000));
        assert_eq!(backoff_delay(9, None, 0.0), Duration::from_millis(60_000));
        assert_eq!(backoff_delay(30, None, 0.0), Duration::from_millis(60_000));
    }

    #[test]
    fn backoff_jitter_adds_at_most_a_quarter() {
        assert_eq!(backoff_delay(2, None, 1.0), Duration::from_millis(5000));
        assert_eq!(backoff_delay(2, None, 5.0), Duration::from_millis(5000));
        assert_eq!(backoff_delay(2, None, -1.0), Duration::from_millis(4000));
    }

    #[test]
    fn retry_after_wins_only_when_longer() {
        assert_eq!(backoff_delay(0, Some(Duration::from_secs(30)), 0.0), Duration::from_secs(30));
        assert_eq!(backoff_delay(5, Some(Duration::from_secs(2)), 0.0), Duration::from_millis(32_000));
    }

    #[test]
    fn pacing_waits_only_when_ahead_of_the_limit() {
        assert_eq!(pace_delay(1000, Duration::from_secs(5), 0), Duration::ZERO);
        assert_eq!(pace_delay(1000, Duration::from_millis(500), 1000), Duration::from_millis(500));
        assert_eq!(pace_delay(1000, Duration::from_secs(2), 1000), Duration::ZERO);
    }

    // ---- slots ----

    #[test]
    fn slots_follow_the_cap_and_zero_means_no_limit() {
        assert!(slot_free(0, 1));
        assert!(!slot_free(1, 1));
        assert!(slot_free(2, 3));
        assert!(!slot_free(3, 3));
        assert!(!slot_free(5, 3));
        assert!(slot_free(100, 0));
    }

    // ---- stalls ----

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn one_byte_every_forty_seconds_is_a_stall() {
        // 2 bytes in a 60 s window.
        assert_eq!(check_stall(secs(20), secs(60), 2, STALL_MIN_BPS), StallCheck::Stalled);
    }

    #[test]
    fn a_healthy_window_is_forgiven() {
        assert_eq!(check_stall(secs(0), secs(60), 5_000_000, STALL_MIN_BPS), StallCheck::Healthy);
        // Exactly the floor is fine.
        assert_eq!(check_stall(secs(1), secs(60), 60 * 1024, STALL_MIN_BPS), StallCheck::Healthy);
        assert_eq!(check_stall(secs(1), secs(60), 60 * 1024 - 1, STALL_MIN_BPS), StallCheck::Stalled);
    }

    #[test]
    fn the_window_is_not_judged_before_it_is_over() {
        assert_eq!(check_stall(secs(10), secs(59), 0, STALL_MIN_BPS), StallCheck::Fine);
        assert_eq!(check_stall(secs(39), secs(59), 0, STALL_MIN_BPS), StallCheck::Fine);
    }

    #[test]
    fn a_minute_of_silence_is_a_stall_inside_the_window() {
        assert_eq!(check_stall(secs(40), secs(60), 10_000_000, STALL_MIN_BPS), StallCheck::Stalled);
        assert_eq!(check_stall(secs(40), secs(5), 10_000_000, STALL_MIN_BPS), StallCheck::Stalled);
        assert!(STALL_SILENCE_ABORT < Duration::from_secs(45), "must fire before the client's read timeout");
    }

    #[test]
    fn the_card_says_waiting_after_thirty_seconds_of_silence() {
        assert!(!waiting_for_server(secs(29)));
        assert!(waiting_for_server(secs(30)));
        assert!(waiting_for_server(secs(45)));
    }

    #[test]
    fn a_tiny_speed_limit_lowers_the_stall_floor() {
        assert_eq!(stall_floor(0), 1024);
        assert_eq!(stall_floor(10_000_000), 1024);
        assert_eq!(stall_floor(2048), 1024);
        assert_eq!(stall_floor(1000), 500);
        assert_eq!(stall_floor(1), 0);
        // A user limit of 1000 B/s running at 900 B/s is not a stall.
        assert_eq!(check_stall(secs(1), secs(60), 900 * 60, stall_floor(1000)), StallCheck::Healthy);
    }

    // ---- resolved addresses ----

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn local_addresses_are_found_in_every_family() {
        for a in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
            "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
            "::ffff:10.0.0.1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "64:ff9b::7f00:1",
        ] {
            assert!(is_local_ip(ip(a)), "{a}");
        }
    }

    #[test]
    fn public_addresses_are_not_local() {
        for a in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(!is_local_ip(ip(a)), "{a}");
        }
    }

    #[test]
    fn a_name_that_resolves_to_the_home_network_is_refused() {
        // DNS rebinding: evil.example answers 192.168.1.1.
        assert!(keep_resolved(false, &[ip("192.168.1.1")]).is_empty());
        assert!(keep_resolved(false, &[ip("127.0.0.1"), ip("::1")]).is_empty());
    }

    #[test]
    fn a_mixed_answer_keeps_only_the_public_addresses() {
        assert_eq!(
            keep_resolved(false, &[ip("10.0.0.5"), ip("93.184.216.34"), ip("fd00::1")]),
            vec![ip("93.184.216.34")]
        );
    }

    #[test]
    fn a_name_the_user_typed_as_local_may_resolve_locally() {
        assert_eq!(keep_resolved(true, &[ip("192.168.1.9")]), vec![ip("192.168.1.9")]);
    }

    #[test]
    fn lan_names_are_recognised() {
        for h in ["localhost", "nas.local", "pi.localhost", "nas", "plex.lan", "box.home.arpa", "NAS.", "pc.localdomain"] {
            assert!(looks_like_lan_name(h), "{h}");
        }
        for h in ["example.com", "files.example.org", "8.8.8.8", "evil.example", ""] {
            assert!(!looks_like_lan_name(h), "{h}");
        }
    }

    // ---- secrets in a link ----

    #[test]
    fn signed_and_token_links_are_found() {
        for u in [
            "https://x.test/f.zip?token=abc",
            "https://x.test/f.zip?access_token=abc",
            "https://x.test/f.zip?X-Amz-Signature=abc&X-Amz-Date=1",
            "https://x.test/f.zip?sig=abc&se=2026",
            "https://x.test/f.zip?Expires=1&Key-Pair-Id=2",
            "https://x.test/f.zip?apikey=1",
            "https://x.test/f.zip?AccessToken=1",
            "https://x.test/f.zip?X-Goog-Credential=1",
            "https://x.test/f.zip?a=1&password=hunter2",
        ] {
            assert!(has_secret_query(u), "{u}");
        }
    }

    #[test]
    fn plain_queries_are_not_secrets() {
        for u in [
            "https://x.test/f.zip",
            "https://x.test/f.zip?id=42&lang=en",
            "https://x.test/download?file=report.pdf&version=3",
            "https://x.test/f.zip?author=bob",
            "not a url",
        ] {
            assert!(!has_secret_query(u), "{u}");
        }
    }

    // ---- LAN scope ----

    #[test]
    fn a_public_link_may_not_redirect_to_a_lan_name_or_a_local_literal() {
        let s = LanScope::for_host("files.example.com", false, &[]);
        assert_eq!(s, LanScope::Public);
        for t in ["router.lan", "nas", "box.home.arpa", "printer.local", "192.168.1.1", "100.64.0.9", "[fd00::1]", "224.0.0.1", "[64:ff9b::a00:1]", "localhost"] {
            assert!(!s.redirect_allowed(t), "{t}");
        }
        assert!(s.redirect_allowed("cdn.example.org"));
        assert!(s.redirect_allowed("8.8.8.8"));
    }

    #[test]
    fn the_predicates_of_the_policy_and_the_resolver_agree() {
        for h in ["router.lan", "nas", "100.64.1.1", "224.0.0.1", "255.255.255.255", "[64:ff9b::7f00:1]", "pc.localdomain"] {
            assert!(is_lan_host(h), "{h}");
        }
        for h in ["example.com", "8.8.8.8", "[2001:4860:4860::8888]"] {
            assert!(!is_lan_host(h), "{h}");
        }
        assert!(!redirect_host_allowed("cdn.example.com", "router.lan"));
        assert!(!redirect_host_allowed("cdn.example.com", "224.0.0.1"));
    }

    #[test]
    fn a_local_origin_may_redirect_locally() {
        let s = LanScope::for_host("nas", false, &[]);
        assert_eq!(s, LanScope::LanOrigin);
        assert!(s.redirect_allowed("192.168.1.5"));
        assert!(s.redirect_allowed("other.lan"));
        assert_eq!(s.keep("192.168.1.5", &[ip("192.168.1.5")]), vec![ip("192.168.1.5")]);
        assert_eq!(LanScope::for_host("192.168.1.9", false, &[]), LanScope::LanOrigin);
        assert_eq!(LanScope::for_host("100.101.102.103", false, &[]), LanScope::LanOrigin);
    }

    #[test]
    fn an_allowed_host_is_pinned_and_redirects_stay_checked() {
        let s = LanScope::for_host("Files.Example.com", true, &["100.64.0.7".into(), "junk".into()]);
        assert_eq!(s, LanScope::Allow { host: "files.example.com".into(), pinned: vec![ip("100.64.0.7")] });
        // The pinned address of that host is kept; any other local address, or another name, is not.
        assert_eq!(s.keep("files.example.com", &[ip("100.64.0.7"), ip("93.184.216.34")]), vec![ip("100.64.0.7"), ip("93.184.216.34")]);
        assert!(s.keep("files.example.com", &[ip("192.168.1.1")]).is_empty());
        assert!(s.keep("other.example.com", &[ip("100.64.0.7")]).is_empty());
        // A redirect to the same host is fine; to another local target it is not.
        assert!(s.redirect_allowed("files.example.com"));
        assert!(!s.redirect_allowed("router.lan"));
        assert!(!s.redirect_allowed("192.168.1.1"));
        assert!(s.redirect_allowed("cdn.example.org"));
    }

    #[test]
    fn allow_without_pinned_addresses_keeps_no_local_address() {
        let s = LanScope::for_host("x.example.com", true, &[]);
        assert!(s.keep("x.example.com", &[ip("10.0.0.2")]).is_empty());
    }

    #[test]
    fn a_public_scope_drops_local_answers() {
        assert!(LanScope::Public.keep("evil.example", &[ip("127.0.0.1")]).is_empty());
        assert_eq!(LanScope::Public.keep("a.example", &[ip("10.0.0.1"), ip("1.1.1.1")]), vec![ip("1.1.1.1")]);
    }

    // ---- stall clock ----

    #[test]
    fn a_trickle_across_reconnects_is_judged_on_one_window() {
        let t0 = Instant::now();
        let mut c = StallClock::new(t0);
        // 100 bytes now and then over a minute, however often the connection was remade.
        c.on_bytes(t0 + secs(10), 100);
        c.on_bytes(t0 + secs(40), 100);
        assert_eq!(c.check(t0 + secs(59), 1024), StallCheck::Fine);
        assert_eq!(c.check(t0 + secs(61), 1024), StallCheck::Stalled);
    }

    #[test]
    fn a_healthy_window_starts_the_next_one() {
        let t0 = Instant::now();
        let mut c = StallClock::new(t0);
        c.on_bytes(t0 + secs(55), 10_000_000);
        assert_eq!(c.check(t0 + secs(60), 1024), StallCheck::Healthy);
        assert_eq!(c.check(t0 + secs(90), 1024), StallCheck::Fine);
    }

    #[test]
    fn silence_is_cut_before_the_read_timeout() {
        let t0 = Instant::now();
        let mut c = StallClock::new(t0);
        c.on_bytes(t0 + secs(1), 5_000_000);
        assert_eq!(c.check(t0 + secs(30), 1024), StallCheck::Fine);
        assert_eq!(c.check(t0 + secs(41), 1024), StallCheck::Stalled);
        assert!(waiting_for_server(c.quiet(t0 + secs(31))));
    }

    #[test]
    fn waiting_on_our_own_limiter_is_not_a_stall() {
        let t0 = Instant::now();
        let mut c = StallClock::new(t0);
        c.on_bytes(t0 + secs(1), 500);
        // 70 s spent in the shared limiter's queue.
        c.excuse(secs(70), t0 + secs(71));
        assert!(c.quiet(t0 + secs(71)) < STALL_SILENCE_ABORT);
        assert_eq!(c.check(t0 + secs(71), 1024), StallCheck::Fine);
    }

    #[test]
    fn excuse_never_moves_a_clock_into_the_future() {
        let t0 = Instant::now();
        let mut c = StallClock::new(t0);
        c.excuse(secs(500), t0 + secs(10));
        assert_eq!(c.quiet(t0 + secs(10)), Duration::ZERO);
    }

    #[test]
    fn a_break_with_a_poor_window_counts_as_a_stall() {
        let t0 = Instant::now();
        let mut c = StallClock::new(t0);
        c.on_bytes(t0 + secs(1), 100);
        // Sends 100 bytes, then the connection closes, again and again.
        assert!(c.broken_is_stall(t0 + secs(5), 1024));
        // A fast connection that drops is an ordinary retry.
        c.on_bytes(t0 + secs(6), 5_000_000);
        assert!(!c.broken_is_stall(t0 + secs(7), 1024));
        // Past a full window the break is ordinary too.
        let d = StallClock::new(t0);
        assert!(!d.broken_is_stall(t0 + secs(61), 1024));
    }

    // ---- backups ----

    #[test]
    fn only_the_newest_three_backups_stay() {
        let names: Vec<String> = [
            "maglev-downloads.corrupt-100.json",
            "maglev-downloads.corrupt-500.json",
            "maglev-downloads.corrupt-300.json",
            "maglev-downloads.corrupt-400.json",
            "maglev-downloads.corrupt-200.json",
            "maglev-downloads.json",
            "other.json",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let mut del = backups_to_delete(&names, 3);
        del.sort();
        assert_eq!(del, vec!["maglev-downloads.corrupt-100.json", "maglev-downloads.corrupt-200.json"]);
        assert!(backups_to_delete(&names[..2], 3).is_empty());
    }

    #[test]
    fn discord_and_dropbox_links_are_secrets() {
        for u in [
            "https://cdn.discordapp.com/attachments/1/2/f.zip?ex=65&is=64&hm=abcdef",
            "https://www.dropbox.com/scl/fi/abc/f.zip?rlkey=xyz&dl=1",
        ] {
            assert!(has_secret_query(u), "{u}");
        }
        assert!(!has_secret_query("https://x.test/f.zip?dl=1&hmm=2"));
    }
}
