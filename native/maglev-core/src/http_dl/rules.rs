//! The pure decisions of the URL download driver: how to read a probe answer, what a resume answer means,
//! retry timing and pacing (contract section 17). No IO, no clock, no randomness (the caller passes the jitter).

use std::time::Duration;

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
            if is_html(h.content_type.as_deref()) && url_looks_like_file(url) {
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
    fn probe_html_for_a_file_url() {
        let hd = Headers { content_type: Some("text/html; charset=utf-8".into()), ..h() };
        assert_eq!(classify_probe(200, &hd, "https://x.test/movie.mkv"), ProbeVerdict::Html);
        // An extension-less URL that answers with a page is treated as the file (download endpoints).
        assert!(matches!(classify_probe(200, &hd, "https://x.test/get"), ProbeVerdict::Ok(_)));
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
}
