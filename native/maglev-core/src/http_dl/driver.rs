//! The IO half of URL downloads (`NATIVE_CONTRACT.md` section 17): reqwest requests, the part file, the sidecar,
//! the persisted download list and the governance pass. Every decision comes from `machine::step` and `rules`.
//!
//! One download is one tokio task (`transfer`) on the engine's runtime. A task only reads and writes through
//! `Downloads::dispatch`, which runs the machine and executes the effects that need the whole list (cancel,
//! rename, delete, flush). Pause, governance and remove abort the task; positions are only advanced after
//! the bytes are written, so an abort at any `await` leaves the part file and the sidecar consistent.
//!
//! API verified against reqwest 0.13 (docs.rs/reqwest/0.13): `Client::builder`, `ClientBuilder::{redirect,
//! connect_timeout, read_timeout, user_agent, proxy}`, `redirect::Policy::custom`, `redirect::Attempt::{url,
//! stop, error}`, `RequestBuilder::{header, basic_auth, send}`, `Response::{status, headers, url,
//! chunk}`. `chunk()` needs no cargo feature, so only the `rustls` feature that librqbit already turns on is used.

use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use librqbit::Session;
use parking_lot::Mutex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
    CONTENT_TYPE, COOKIE, ETAG, IF_RANGE, LAST_MODIFIED, ORIGIN, RANGE, REFERER, RETRY_AFTER, USER_AGENT,
};
use reqwest::{redirect, Client};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::runtime::Handle;
use tokio::task::JoinHandle;
use tracing::warn;

use super::content_disposition::{choose_name, sanitize_filename, unique_name};
use super::machine::{step, DlError, Effect, Event, Notice, PauseReason, State, MAX_ATTEMPTS, MAX_STALL_ATTEMPTS};
use super::rules::{
    backoff_delay, backups_to_delete, classify_probe, fits, has_secret_query, judge_get, overruns, pace_delay,
    is_lan_host, slot_free, stall_floor, waiting_for_server, Headers, LanScope, ProbeInfo, ProbeVerdict, Reply, StallCheck,
    StallClock, SPEED_QUIET,
};
use super::sidecar::{final_path, part_path, safe_url, sidecar_path, Sidecar};
use super::redirect::{send_following, CookiePicker};
use super::stream::fetch::{host_lower, pick_cookie};
use super::stream::{StreamError, StreamRec, StreamSpec};
use crate::error::{EngineError, ErrorCode};
use crate::meta::write_atomic;
use crate::timing::{gained, Timing};

/// How many link downloads transfer at once until the engine passes `max_active_downloads` (0 = no limit).
/// Torrents have their own plan (`scheduler.rs`).
pub const DEFAULT_MAX_ACTIVE_DOWNLOADS: u32 = 3;
/// How long one wait for the next chunk lasts before the stall rule looks at the clock again.
const STALL_TICK: Duration = Duration::from_secs(5);
const STORE_FILE: &str = "maglev-downloads.json";
const SIDECAR_FLUSH: Duration = Duration::from_secs(2);
const REPORT_EVERY: Duration = Duration::from_millis(250);
const USER_AGENT_DEFAULT: &str = "Maglev";
const WHOLE_FILE_NOTICE: &str = "Server sent the whole file again; starting over.";
const NO_RESUME_NOTICE: &str = "This server can't resume. Starting over.";
/// Governance tag Kotlin sends while the phone has no validated network. It pauses URL downloads only.
const OFFLINE_TAG: &str = "offline";
/// The text `attempt.error` carries out of the redirect policy; `is_local_redirect` looks for it.
const LOCAL_REDIRECT_MSG: &str = "redirect to a device on the local network";
const BLOCKED_MSG: &str = "Blocked by your Wi-Fi-only or VPN setting.";
const AUTH_AGAIN_COPY: &str = "Sign in again: paste the link again.";
const REFUSED_COPY: &str = "The site refused this link. Open its page again, then retry.";
const REFUSED_PROBE_COPY: &str =
    "The site refused this link. Open the page in Maglev's browser and start the download from there, or paste a fresh link.";
const EXPIRED_COPY: &str = "This link has expired. Paste a new one.";
const STALLED_COPY: &str = "The server stopped sending data. Try again later.";
const LOCAL_REDIRECT_COPY: &str = "A redirect tried to send Maglev to a device on your network, so it stopped.";
const LAN_ADDRESS_COPY: &str = "This address points to a device on your network.";

/// HLS and DASH downloads (contract section 24.8): probe, transfer, join and refresh live in this child module.
mod stream_run;
/// Several connections for one link download (contract section 17, Segments).
mod segments;

use segments::{Parts, PartsEnd, PartsShared};

// ---- options ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HeaderOptions {
    #[serde(rename = "Cookie", alias = "cookie")]
    pub cookie: Option<String>,
    #[serde(rename = "Referer", alias = "referer")]
    pub referer: Option<String>,
    #[serde(rename = "User-Agent", alias = "user-agent", alias = "user_agent", alias = "userAgent")]
    pub user_agent: Option<String>,
    /// The page's `Origin` (scheme and host). Streams send it on every request.
    #[serde(rename = "Origin", alias = "origin")]
    pub origin: Option<String>,
    /// Cookies the app read from the WebView jar, per host. Streams send each host its own.
    #[serde(rename = "Cookies", alias = "cookies")]
    pub cookies: Vec<HostCookie>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct HostCookie {
    pub host: String,
    pub cookie: String,
}

impl HeaderOptions {
    /// The per-host cookies as `(host, cookie)` pairs for a stream request context.
    pub fn host_cookies(&self) -> Vec<(String, String)> {
        self.cookies
            .iter()
            .filter(|c| !c.host.is_empty() && !c.cookie.is_empty())
            .map(|c| (c.host.clone(), c.cookie.clone()))
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExpectedHash {
    pub alg: String,
    pub hex: String,
}

/// `options` of `nativeAddDownload` / `nativeProbeUrl` / `nativeRefreshDownloadUrl` (contract section 17).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct DownloadOptions {
    pub name: Option<String>,
    pub folder: Option<String>,
    pub paused: bool,
    pub segments: Option<u32>,
    pub headers: Option<HeaderOptions>,
    pub expected_hash: Option<ExpectedHash>,
    pub down_limit_bps: Option<u64>,
    /// Allow the typed host to resolve onto the local network (after `LAN_ADDRESS`).
    pub allow_lan: bool,
    /// The page the link was found on (in-app browser). Kept as `page_url` on the record (contract "Auto-refresh").
    pub page_url: Option<String>,
    /// Save an HLS or DASH stream (contract 24.8): which variant and audio track.
    pub stream: Option<StreamSpec>,
}

fn parse_options(json: &str) -> Result<DownloadOptions, EngineError> {
    let t = json.trim();
    if t.is_empty() || t == "null" {
        return Ok(DownloadOptions::default());
    }
    let o: DownloadOptions = serde_json::from_str(t)
        .map_err(|_| EngineError::new(ErrorCode::InvalidArgument, "Those download options aren't valid"))?;
    if let Some(s) = o.segments {
        if !(1..=8).contains(&s) {
            return Err(EngineError::new(ErrorCode::InvalidArgument, "Use 1 to 8 connections"));
        }
    }
    if o.expected_hash.is_some() {
        return Err(EngineError::new(
            ErrorCode::Unsupported,
            "Checking a checksum isn't available yet",
        ));
    }
    Ok(o)
}

// ---- records ------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DlErrInfo {
    pub code: String,
    pub message: String,
    pub http_status: Option<u16>,
}

/// What survives a restart. Credentials and request headers are runtime only (see `Live`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DlRecord {
    pub id: String,
    /// The link without user name, password, or fragment.
    pub url: String,
    pub final_url: Option<String>,
    /// Empty until the probe has run.
    pub name: String,
    pub requested_name: Option<String>,
    pub folder: String,
    pub state: State,
    pub paused_tag: Option<String>,
    pub size: Option<u64>,
    pub held: u64,
    pub validator: Option<String>,
    pub resumable: bool,
    pub added_at: i64,
    pub down_limit_bps: u64,
    pub segments: u32,
    /// The probe answered `Range: bytes=0-0` with 206 and the server says `Accept-Ranges: bytes`.
    pub parts_ok: bool,
    /// A segment was refused or the file drifted: this download stays on one connection for good.
    pub split_off: bool,
    pub start_paused: bool,
    pub status: Option<u16>,
    pub error: Option<DlErrInfo>,
    pub notice: Option<String>,
    /// The link needs something that is never saved: a user name and password, a cookie, or a signed query.
    /// The flag is saved, the secret is not. After a restart the download waits for a new link (`AUTH_REQUIRED`).
    pub needs_login: bool,
    /// The link itself carried a user name and password. Only then is a 403 a sign-in problem (`AUTH_REQUIRED`);
    /// cookies from the in-app browser never set this. Not a secret.
    pub link_login: bool,
    /// The user allowed the typed host to be on the local network (contract 17.w). Not a secret.
    pub allow_lan: bool,
    /// The addresses of that host when it was allowed; its lookups may only return these.
    pub lan_pinned: Vec<String>,
    /// The page a browser download was found on, so the app can load it again when the link expires. In memory it is
    /// whole; on disk a secret-looking query is cut off (`persisted`). Records from before this field load as None.
    #[serde(default)]
    pub page_url: Option<String>,
    /// Set for an HLS or DASH download (contract 24.8): ids and counts, nothing secret.
    pub stream: Option<StreamRec>,
    /// All bytes of a stream with separate video and audio parts are in, and the join has not finished yet.
    pub mux_needed: bool,
    /// "Resume anyway" (contract section 25): the exemptable rule tags do not pause this download.
    /// Cleared when it finishes or the user pauses it. Saved, so it survives a restart.
    pub allowed_anyway: bool,
    /// Active time, finish time, bytes by network (contract section 34.1). Records from before 0.26 load with zeros.
    pub timing: Timing,
}

impl Default for DlRecord {
    fn default() -> Self {
        DlRecord {
            id: String::new(),
            url: String::new(),
            final_url: None,
            name: String::new(),
            requested_name: None,
            folder: String::new(),
            state: State::Resolving,
            paused_tag: None,
            size: None,
            held: 0,
            validator: None,
            resumable: false,
            added_at: 0,
            down_limit_bps: 0,
            segments: 1,
            parts_ok: false,
            split_off: false,
            start_paused: false,
            status: None,
            error: None,
            notice: None,
            needs_login: false,
            link_login: false,
            allow_lan: false,
            lan_pinned: Vec::new(),
            page_url: None,
            stream: None,
            mux_needed: false,
            allowed_anyway: false,
            // Not `Timing::new()`: a record read from an old file must stay untracked (no made-up finish time).
            timing: Timing::default(),
        }
    }
}

/// Runtime only: credentials, request headers, the task and the speed meter.
#[derive(Default)]
struct Live {
    auth: Option<(String, String)>,
    cookie: Option<String>,
    referer: Option<String>,
    user_agent: Option<String>,
    /// Stream downloads only: the page's `Origin` and the per-host cookies (memory only, like `cookie`).
    origin: Option<String>,
    host_cookies: Vec<(String, String)>,
    task: Option<JoinHandle<()>>,
    attempts: u32,
    denied: u32,
    bps: u64,
    /// Stall retries since the last healthy minute. Progress does not reset it (a trickle must not buy more tries).
    stalls: u32,
    /// Active, but no byte for 30 s.
    stalled: bool,
    /// The positions of a download that runs over several connections right now.
    parts: Option<Arc<PartsShared>>,
    /// The last `held` the timing pass saw (section 34.1); bytes between two readings are what was downloaded.
    acct: Option<u64>,
}

#[derive(Default)]
struct Inner {
    records: BTreeMap<String, DlRecord>,
    live: HashMap<String, Live>,
}

#[derive(Serialize, Deserialize, Default)]
struct StoreFile {
    version: u32,
    downloads: Vec<DlRecord>,
}

// ---- pure helpers ---------------------------------------------------------------------------------------------

/// How often a running download's timing is written to disk. A crash or kill loses at most this much (section 34.1).
const TIMING_SAVE_EVERY: Duration = Duration::from_secs(30);

/// One second of timing for one download (section 34.1): time and bytes count only while it is `Downloading`.
/// Returns whether it was downloading, so the caller knows the record changed.
fn account_one(rec: &mut DlRecord, live: &mut Live, elapsed: Duration, metered: bool) -> bool {
    let downloading = rec.state == State::Downloading;
    rec.timing.tick(elapsed, downloading);
    let got = gained(&mut live.acct, downloading, rec.held);
    rec.timing.add_down(got, metered);
    downloading
}

/// A download leaves `Downloading` (or the machine ran an event while it downloads): counts the bytes of the stretch
/// that ended. Call it before the effects touch `held`.
fn account_leave(rec: &mut DlRecord, live: &mut Live, before: State, metered: bool) {
    if before == State::Downloading {
        let got = gained(&mut live.acct, true, rec.held);
        rec.timing.add_down(got, metered);
    }
}

/// After a state change: the baseline follows `held` so bytes already on disk at a resume are never counted, and
/// the finish is stamped once (section 34.1).
fn account_settle(rec: &mut DlRecord, live: &mut Live, now: i64) {
    live.acct = Some(rec.held);
    rec.timing.observe_finished(rec.state == State::Finished, now);
}

/// `scheme://host[:port]/path` with no user name, password, query or fragment. Safe to show and to log.
pub fn display_url(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("");
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            format!("{}://{}{}{}", u.scheme(), host, port, u.path())
        }
        Err(_) => String::new(),
    }
}

/// The URL as we store it: no credentials and no fragment. Returns the credentials separately.
fn split_credentials(mut u: reqwest::Url) -> (reqwest::Url, Option<(String, String)>) {
    let user = super::content_disposition::percent_decode(u.username());
    let pass = u.password().map(super::content_disposition::percent_decode);
    let auth = if user.is_empty() && pass.is_none() {
        None
    } else {
        Some((
            String::from_utf8_lossy(&user).into_owned(),
            pass.map(|p| String::from_utf8_lossy(&p).into_owned()).unwrap_or_default(),
        ))
    };
    let _ = u.set_username("");
    let _ = u.set_password(None);
    u.set_fragment(None);
    (u, auth)
}

fn parse_http_url(raw: &str) -> Result<(reqwest::Url, Option<(String, String)>), EngineError> {
    let parsed = reqwest::Url::parse(raw.trim());
    let url_ok = matches!(&parsed, Ok(u) if (u.scheme() == "http" || u.scheme() == "https") && u.host_str().is_some());
    // The machine owns the rule: only http and https start a download (SM-30 row 2).
    let (_, effects) = step(State::None, Event::Add { url_ok });
    if effects.contains(&Effect::RejectInvalidSource) {
        return Err(EngineError::new(
            ErrorCode::InvalidSource,
            "That isn't a web link. Use a link that starts with http or https.",
        ));
    }
    let u = parsed.map_err(|_| EngineError::new(ErrorCode::InvalidSource, "That isn't a web link."))?;
    Ok(split_credentials(u))
}

/// Maps a governance tag from `setTransfersAllowed` to a pause reason.
pub fn reason_for_tag(tag: &str) -> PauseReason {
    match tag {
        "battery" | "charging_only" => PauseReason::Battery,
        "schedule" => PauseReason::Schedule,
        "storage_full" | "storage_unavailable" => PauseReason::Storage,
        "offline" => PauseReason::Offline,
        _ => PauseReason::Network,
    }
}

/// Does any blocking tag come from the Wi-Fi-only or VPN-only setting? `offline` does not count: a probe while
/// offline just fails as a network error, and an add while offline is paused instead.
fn blocks_network(tags: &[String]) -> bool {
    tags.iter().any(|t| t != OFFLINE_TAG && reason_for_tag(t) == PauseReason::Network)
}

/// The tags that pause one download: an exempt one ignores the exemptable rule tags (section 25).
fn effective_blocked(allowed_anyway: bool, blocked: &[String]) -> Vec<String> {
    blocked
        .iter()
        .filter(|t| !(allowed_anyway && crate::scheduler::is_exemptable(t)))
        .cloned()
        .collect()
}

/// Tags that only concern torrents (`seed_metered`, section 25) never pause a link download.
fn download_tags(blocked: &[String]) -> Vec<String> {
    blocked
        .iter()
        .filter(|t| t.as_str() != crate::scheduler::TAG_SEED_METERED)
        .cloned()
        .collect()
}

/// How user-actionable a blocking tag is; the lowest rank wins when several apply (contract 17.z).
fn tag_rank(tag: &str) -> u8 {
    match tag {
        "storage_unavailable" => 0,
        "storage_full" => 1,
        "battery" | "charging_only" => 3,
        "schedule" => 4,
        "offline" => 5,
        _ => 2, // Wi-Fi only, VPN only and any tag we don't know
    }
}

/// The tag a download pauses for: the most user-actionable blocking one (first among equals).
fn top_block(blocked: &[String]) -> Option<&String> {
    blocked.iter().min_by_key(|t| tag_rank(t))
}

/// The tag `paused_by` shows for a storage pause: the real governance tag, else the one it already had, else
/// `storage_full` (no space found by the probe or the write).
fn storage_pause_tag(tag: Option<&str>, existing: Option<&str>) -> String {
    let is_storage = |t: &&str| matches!(*t, "storage_full" | "storage_unavailable");
    tag.filter(is_storage).or(existing.filter(is_storage)).unwrap_or("storage_full").to_string()
}

/// The governance event that applies to a download in `state` for the blocked tags, with the tag to remember.
/// A working, waiting or probing download pauses for the top tag. Nothing else is touched here.
fn gov_event(state: State, blocked: &[String]) -> Option<(Event, String)> {
    match state {
        State::Downloading | State::Queued | State::Resolving => {
            top_block(blocked).map(|t| (Event::GovBlock(reason_for_tag(t)), t.clone()))
        }
        _ => None,
    }
}

/// True when the error, or anything it wraps, says the redirect policy refused a local address.
fn chain_contains(e: &(dyn std::error::Error + 'static), needle: &str) -> bool {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(x) = cur {
        if x.to_string().contains(needle) {
            return true;
        }
        cur = x.source();
    }
    false
}

fn is_local_redirect(e: &reqwest::Error) -> bool {
    chain_contains(e, LOCAL_REDIRECT_MSG)
}

/// The event for a request that failed because of the local-network rules.
fn refusal_event(r: Refusal) -> Event {
    match r {
        Refusal::LanAddress => Event::LanAddress,
        Refusal::Redirect => Event::LocalRedirect,
    }
}

/// Free bytes for a normal app on the file system holding `path` (the nearest existing parent when the folder is
/// not created yet). `None` when it can't be read; callers then let the download go on.
#[cfg(unix)]
pub fn free_space(path: &Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let mut p = path.to_path_buf();
    while !p.exists() {
        if !p.pop() {
            return None;
        }
    }
    let c = CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a valid NUL-terminated path and `st` is a valid, zeroed out-parameter.
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return None;
    }
    let bs = if st.f_frsize > 0 { st.f_frsize as u64 } else { st.f_bsize as u64 };
    Some((st.f_bavail as u64).saturating_mul(bs))
}

#[cfg(not(unix))]
pub fn free_space(_path: &Path) -> Option<u64> {
    None
}

pub fn state_name(s: State) -> &'static str {
    match s {
        State::None => "resolving",
        State::Resolving => "resolving",
        State::Queued => "queued",
        State::Downloading => "downloading",
        State::Paused(_) => "paused",
        State::Verifying => "verifying",
        State::Finished => "finished",
        State::NeedsLink => "needs_link",
        State::Error(_) => "error",
        State::Gone => "gone",
    }
}

fn error_message(e: DlError, status: Option<u16>) -> String {
    match e {
        DlError::HttpStatus => match status {
            Some(404) | Some(410) => "The file isn't there anymore (404).".to_string(),
            Some(s) => format!("The server returned an error ({s})."),
            None => "The server returned an error.".to_string(),
        },
        DlError::Network => "Couldn't reach the server. Check your connection, then retry.".to_string(),
        DlError::FileChanged => "The file changed on the server.".to_string(),
        DlError::NotAFile => "This link opens a web page, not a file.".to_string(),
        DlError::ChecksumMismatch => "File doesn't match the checksum.".to_string(),
        DlError::Permission => "Maglev can't write to that folder.".to_string(),
        DlError::LocalRedirect => LOCAL_REDIRECT_COPY.to_string(),
        DlError::LanAddress => LAN_ADDRESS_COPY.to_string(),
        DlError::StorageUnavailable => "The folder isn't available. Is the SD card in?".to_string(),
        DlError::FileTooLarge => {
            "This file is bigger than the card's format allows (4 GB). Use phone storage.".to_string()
        }
        DlError::Stalled => STALLED_COPY.to_string(),
        DlError::StreamProtected => crate::error::STREAM_PROTECTED_MSG.to_string(),
        DlError::StreamLive => crate::error::STREAM_LIVE_MSG.to_string(),
        DlError::StreamUnsupported => crate::error::STREAM_UNSUPPORTED_MSG.to_string(),
        DlError::MuxFailed => crate::error::MUX_FAILED_MSG.to_string(),
    }
}

/// The error of a download in `NeedsLink`. A 401, a 403 on a link that carried a user name and password
/// (`link_login`), or a restart that lost the secrets (no status), is a sign in. Any other 403 is a refused link
/// (`LINK_REFUSED`): sites refuse requests that lack the page's headers or carry a token that expired. Browser
/// cookies never make a 403 a sign in. Anything else (410, 404, an expired signed link) is an expired link.
fn needs_link_info(status: Option<u16>, needs_login: bool, link_login: bool) -> DlErrInfo {
    let refused = status == Some(403) && !link_login;
    let auth = status == Some(401) || (status == Some(403) && link_login) || (status.is_none() && needs_login);
    let (code, message) = if refused {
        ("LINK_REFUSED", REFUSED_COPY)
    } else if auth {
        ("AUTH_REQUIRED", AUTH_AGAIN_COPY)
    } else {
        ("LINK_EXPIRED", EXPIRED_COPY)
    };
    DlErrInfo { code: code.to_string(), message: message.to_string(), http_status: status }
}

/// Is `url` the link of this download? After a restart a link with a secret query is saved without it, so a
/// download waiting for a new link (`needs_link`) also matches the same link by scheme, host and path: pasting it
/// again refreshes that download instead of adding a second one.
fn same_link(r: &DlRecord, url: &str, folder: &str) -> bool {
    if r.folder != folder || matches!(r.state, State::Finished | State::Gone) {
        return false;
    }
    r.url == url || (r.state == State::NeedsLink && r.needs_login && safe_url(&r.url) == safe_url(url))
}

/// The record as it is written to disk: no query that looks like a secret, and `final_url` cut down to host and path.
fn persisted(rec: &DlRecord) -> DlRecord {
    let mut r = rec.clone();
    r.final_url = r.final_url.as_deref().map(safe_url);
    if has_secret_query(&r.url) {
        r.url = safe_url(&r.url);
        r.needs_login = true;
    }
    r.page_url = r.page_url.as_deref().and_then(persisted_page_url);
    r
}

/// The page URL a download is added with: http(s) only, no blanks. `None` when there is nothing usable.
fn clean_page_url(raw: Option<&str>) -> Option<String> {
    let t = raw?.trim();
    let u = reqwest::Url::parse(t).ok()?;
    (matches!(u.scheme(), "http" | "https") && u.host_str().is_some()).then(|| t.to_string())
}

/// What is written to disk of a page URL (contract item 6, the same rule as the link): a query with a secret-looking
/// key is cut off, so are a user name and password, and a URL that is then empty is not saved.
fn persisted_page_url(url: &str) -> Option<String> {
    let login = reqwest::Url::parse(url)
        .map(|u| !u.username().is_empty() || u.password().is_some())
        .unwrap_or(false);
    let kept = if has_secret_query(url) || login { safe_url(url) } else { url.to_string() };
    (!kept.trim().is_empty()).then_some(kept)
}

/// Writes the resume record of a download that stops now: one offset, or the offsets of every segment when it runs
/// over several connections.
fn write_record_sidecar(rec: &DlRecord, live: &Live) {
    if !(rec.resumable && rec.validator.is_some() && !rec.name.is_empty()) {
        return;
    }
    let path = sidecar_path(Path::new(&rec.folder), &rec.name);
    let mut sc = Sidecar::new(rec.final_url.as_deref().unwrap_or(&rec.url), &rec.name, rec.size, rec.validator.clone());
    match &live.parts {
        Some(p) => sc.segments = p.snapshot(),
        None => match single_pos_to_write(Sidecar::load(&path).as_ref(), rec.held) {
            Some(pos) => sc.set_single_pos(pos),
            None => return,
        },
    }
    let _ = sc.save(&path);
}

/// With no split run live, the single offset to record, or None to keep the sidecar on disk.
/// After a restart a split download's `held` is the sum of its parts, not a contiguous prefix. Writing it as one
/// offset (a pause, an offline pause or storage full before the parts start again) would make the next resume
/// skip the unfinished middle of every part and finish with holes. A split sidecar stays as it is; the parts run
/// (or its fall-back to one connection, which collapses to the prefix) owns it.
fn single_pos_to_write(existing: Option<&Sidecar>, held: u64) -> Option<u64> {
    match existing {
        Some(sc) if sc.is_split() => None,
        _ => Some(held),
    }
}

/// What `maglev-downloads.json` held, entry by entry.
struct ParsedStore {
    records: Vec<DlRecord>,
    /// Entries that could not be read (or had no id).
    skipped: usize,
    /// The file is not JSON or has no `downloads` list.
    unreadable: bool,
}

/// One bad entry never costs the good ones. Only the id and the kind of error are logged, never the link.
fn parse_store(bytes: &[u8]) -> ParsedStore {
    let unreadable = ParsedStore { records: vec![], skipped: 0, unreadable: true };
    let Ok(root) = serde_json::from_slice::<Value>(bytes) else {
        return unreadable;
    };
    let Some(items) = root.get("downloads").and_then(Value::as_array) else {
        return unreadable;
    };
    let mut records = Vec::new();
    let mut skipped = 0;
    for item in items {
        let id = item.get("id").and_then(Value::as_str).unwrap_or("?").to_string();
        match serde_json::from_value::<DlRecord>(item.clone()) {
            Ok(r) if !r.id.is_empty() => records.push(r),
            Ok(_) => {
                warn!("skipped a saved download with no id");
                skipped += 1;
            }
            Err(e) => {
                warn!("skipped a saved download ({id}): {:?}", e.classify());
                skipped += 1;
            }
        }
    }
    ParsedStore { records, skipped, unreadable: false }
}

fn corrupt_backup_name(now: i64) -> String {
    format!("maglev-downloads.corrupt-{now}.json")
}

// ---- resolving names ----------------------------------------------------------------------------------------------

/// reqwest's resolver, with every answer checked against the download's own `LanScope` (contract 17.w). Runs for the
/// first request and for every redirect hop, so a public name that answers a private address is refused (DNS
/// rebinding).
struct GuardedResolver {
    scope: LanScope,
}

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().trim_end_matches('.').to_ascii_lowercase();
        let scope = self.scope.clone();
        Box::pin(async move {
            guarded_lookup(host, &scope).await.map(|v| Box::new(v.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

async fn guarded_lookup(
    host: String,
    scope: &LanScope,
) -> Result<Vec<SocketAddr>, Box<dyn std::error::Error + Send + Sync>> {
    let found: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0u16)).await?.collect();
    let ips: Vec<IpAddr> = found.iter().map(|a| a.ip()).collect();
    let keep = scope.keep(&host, &ips);
    if keep.is_empty() && !found.is_empty() {
        // The error chain carries the host, so `refusal` can tell the typed host (LAN_ADDRESS) from a redirect.
        return Err(format!("{LOCAL_REDIRECT_MSG} (host: {host})").into());
    }
    Ok(found.into_iter().filter(|a| keep.contains(&a.ip())).collect())
}

/// Why a request was refused by the local-network rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    /// The typed host itself resolved onto the local network.
    LanAddress,
    /// A redirect led there.
    Redirect,
}

/// Looks for the refusal in an error chain. `typed_host` is the host of the link the user typed.
fn refusal(e: &(dyn std::error::Error + 'static), typed_host: &str) -> Option<Refusal> {
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(x) = cur {
        let msg = x.to_string();
        if let Some(at) = msg.find(LOCAL_REDIRECT_MSG) {
            let host = msg[at..].split("(host: ").nth(1).and_then(|r| r.split(')').next());
            return Some(match host {
                Some(h) if h.eq_ignore_ascii_case(typed_host.trim_end_matches('.')) => Refusal::LanAddress,
                _ => Refusal::Redirect,
            });
        }
        cur = x.source();
    }
    None
}

/// The addresses of a host, as text, for pinning.
async fn resolve_ips(host: &str) -> Result<Vec<String>, EngineError> {
    let found = tokio::net::lookup_host((host, 0u16))
        .await
        .map_err(|_| EngineError::new(ErrorCode::Network, "Couldn't find that address. Check your connection."))?;
    let mut ips: Vec<String> = found.map(|a| a.ip().to_string()).collect();
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        return Err(EngineError::new(ErrorCode::Network, "Couldn't find that address. Check your connection."));
    }
    Ok(ips)
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default()
}

/// Does a link to the same file match what was stored? Size must agree; validators must agree when both exist,
/// and a stored validator that the new link cannot prove is a mismatch.
pub fn link_matches(stored_size: Option<u64>, stored_validator: Option<&str>, probe: &ProbeInfo) -> bool {
    if let (Some(a), Some(b)) = (stored_size, probe.size) {
        if a != b {
            return false;
        }
    }
    if stored_size.is_some() && probe.size.is_none() {
        return false;
    }
    match (stored_validator, probe.validator.as_deref()) {
        (Some(a), Some(b)) => a == b,
        (Some(_), None) => false,
        _ => true,
    }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn jitter() -> f64 {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    (n % 1000) as f64 / 1000.0
}

fn is_enospc(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(28) | Some(122))
}

fn is_eacces(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(1) | Some(13) | Some(30))
}

/// EFBIG: the file system can't hold a file this big (FAT32 stops at 4 GB).
fn is_too_large(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(27))
}

/// The folder is gone or the storage fails: ENOENT, EIO, ENXIO, ENODEV, ENOTDIR, ESTALE (a removed SD card).
fn is_unavailable(e: &io::Error) -> bool {
    e.kind() == io::ErrorKind::NotFound || matches!(e.raw_os_error(), Some(2) | Some(5) | Some(6) | Some(19) | Some(20) | Some(116))
}

fn io_event(e: &io::Error, attempts: u32) -> Event {
    if is_enospc(e) {
        Event::Enospc
    } else if is_too_large(e) {
        Event::FileTooLarge
    } else if is_eacces(e) {
        Event::Eacces
    } else if is_unavailable(e) {
        Event::StorageGone
    } else {
        Event::Transient { attempts }
    }
}

#[cfg(unix)]
fn write_all_at(f: &File, buf: &[u8], off: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_all_at(buf, off)
}

#[cfg(windows)]
fn write_all_at(f: &File, mut buf: &[u8], mut off: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = f.seek_write(buf, off)?;
        buf = &buf[n..];
        off += n as u64;
    }
    Ok(())
}

/// How much one connection collects before it writes. One `pwrite` per network chunk (a few KiB) is thousands of
/// calls a second, and on Android shared storage every one goes through FUSE. Memory is bounded by this times the
/// connection count: at most `MAX_PARTS` (8) buffers, 8 MiB in the worst case, 1 MiB for a single connection.
pub(super) const WRITE_BUF_BYTES: usize = 1024 * 1024;
/// A part-filled buffer is written once it has waited this long, so a slow link still shows true progress and
/// loses at most this much on an abort.
pub(super) const WRITE_BUF_MAX_AGE: Duration = Duration::from_millis(250);

/// Collects the body of one connection and writes it in large blocks at the right offsets.
///
/// Two positions: `written()` is what is on disk and is the only one that may be persisted for resume (sidecar,
/// `held`, segment `pos`). `received()` counts the bytes taken off the wire and may drive speed and overrun checks.
/// `written()` moves only after a write returned `Ok`, so it can never be ahead of the file.
pub(super) struct WriteBuf {
    buf: Vec<u8>,
    /// File offset of `buf[0]`; equals the number of bytes safely written (counted from offset 0).
    start: u64,
    /// When the oldest unwritten byte arrived.
    since: Option<Instant>,
}

impl WriteBuf {
    pub(super) fn new(offset: u64) -> Self {
        WriteBuf { buf: Vec::with_capacity(WRITE_BUF_BYTES), start: offset, since: None }
    }

    /// Bytes on disk up to here (a file offset). Safe to persist.
    pub(super) fn written(&self) -> u64 {
        self.start
    }

    /// Bytes taken off the wire up to here, written or not.
    pub(super) fn received(&self) -> u64 {
        self.start + self.buf.len() as u64
    }

    #[cfg(test)]
    pub(super) fn pending(&self) -> usize {
        self.buf.len()
    }

    /// Adds `data`; writes a full buffer. A write error leaves `written()` where it was.
    pub(super) fn push<W>(&mut self, mut data: &[u8], now: Instant, write: &mut W) -> io::Result<()>
    where
        W: FnMut(&[u8], u64) -> io::Result<()>,
    {
        while !data.is_empty() {
            if self.buf.is_empty() {
                self.since = Some(now);
            }
            let take = (WRITE_BUF_BYTES - self.buf.len()).min(data.len());
            self.buf.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.buf.len() >= WRITE_BUF_BYTES {
                self.flush(write)?;
            }
        }
        Ok(())
    }

    /// Writes whatever is held with one call at its start offset. On error nothing moves and the bytes stay held.
    pub(super) fn flush<W>(&mut self, write: &mut W) -> io::Result<()>
    where
        W: FnMut(&[u8], u64) -> io::Result<()>,
    {
        if self.buf.is_empty() {
            return Ok(());
        }
        write(&self.buf, self.start)?;
        self.start += self.buf.len() as u64;
        self.buf.clear();
        self.since = None;
        Ok(())
    }

    /// True when something is held and has waited `WRITE_BUF_MAX_AGE`.
    pub(super) fn due(&self, now: Instant) -> bool {
        self.since.map(|t| now.saturating_duration_since(t) >= WRITE_BUF_MAX_AGE).unwrap_or(false)
    }
}

#[cfg(test)]
mod write_buf_tests {
    use super::*;

    type Calls = Vec<(u64, usize)>;

    fn sink<'a>(calls: &'a mut Calls, disk: &'a mut Vec<u8>) -> impl FnMut(&[u8], u64) -> io::Result<()> + 'a {
        move |b, off| {
            calls.push((off, b.len()));
            let end = off as usize + b.len();
            if disk.len() < end {
                disk.resize(end, 0);
            }
            disk[off as usize..end].copy_from_slice(b);
            Ok(())
        }
    }

    #[test]
    fn a_full_buffer_is_written_in_one_call_at_its_start() {
        let (mut calls, mut disk) = (Vec::new(), Vec::new());
        let mut w = sink(&mut calls, &mut disk);
        let mut b = WriteBuf::new(0);
        let now = Instant::now();
        let chunk = vec![7u8; 16 * 1024];
        for _ in 0..(WRITE_BUF_BYTES / chunk.len() - 1) {
            b.push(&chunk, now, &mut w).unwrap();
        }
        assert_eq!(b.written(), 0, "nothing written before the buffer is full");
        b.push(&chunk, now, &mut w).unwrap();
        assert_eq!(b.written(), WRITE_BUF_BYTES as u64);
        assert_eq!(b.pending(), 0);
        drop(w);
        assert_eq!(calls, vec![(0, WRITE_BUF_BYTES)]);
    }

    #[test]
    fn an_explicit_flush_writes_the_partial_buffer_and_an_empty_flush_writes_nothing() {
        let (mut calls, mut disk) = (Vec::new(), Vec::new());
        let mut w = sink(&mut calls, &mut disk);
        let mut b = WriteBuf::new(0);
        b.flush(&mut w).unwrap();
        b.push(&[1, 2, 3], Instant::now(), &mut w).unwrap();
        assert_eq!((b.written(), b.received()), (0, 3));
        b.flush(&mut w).unwrap();
        assert_eq!((b.written(), b.received()), (3, 3));
        b.flush(&mut w).unwrap();
        drop(w);
        assert_eq!(calls, vec![(0, 3)]);
        assert_eq!(disk, vec![1, 2, 3]);
    }

    #[test]
    fn offsets_stay_right_across_partial_fills_and_a_resume_offset() {
        let (mut calls, mut disk) = (Vec::new(), Vec::new());
        let mut w = sink(&mut calls, &mut disk);
        let mut b = WriteBuf::new(1000);
        let now = Instant::now();
        let data: Vec<u8> = (0..(WRITE_BUF_BYTES * 2 + 123)).map(|i| (i % 251) as u8).collect();
        // Odd-sized pieces that straddle the buffer edge.
        for piece in data.chunks(70_001) {
            b.push(piece, now, &mut w).unwrap();
        }
        b.flush(&mut w).unwrap();
        assert_eq!(b.written(), 1000 + data.len() as u64);
        drop(w);
        assert_eq!(calls, vec![(1000, WRITE_BUF_BYTES), (1000 + WRITE_BUF_BYTES as u64, WRITE_BUF_BYTES), (1000 + 2 * WRITE_BUF_BYTES as u64, 123)]);
        assert_eq!(&disk[1000..], &data[..]);
    }

    #[test]
    fn written_never_exceeds_what_reached_the_disk() {
        use std::cell::Cell;
        let disk_len = Cell::new(0u64);
        let fail = Cell::new(false);
        let mut w = |b: &[u8], off: u64| -> io::Result<()> {
            if fail.get() {
                return Err(io::Error::new(io::ErrorKind::Other, "disk"));
            }
            disk_len.set(disk_len.get().max(off + b.len() as u64));
            Ok(())
        };
        let mut b = WriteBuf::new(0);
        let now = Instant::now();
        b.push(&vec![0u8; 500_000], now, &mut w).unwrap();
        assert!(b.written() <= disk_len.get() && b.written() == 0);
        b.push(&vec![0u8; 500_000], now, &mut w).unwrap();
        assert_eq!(b.written(), 0, "1_000_000 bytes is still below 1 MiB, so still buffered");
        // Fill past the edge while the disk fails: the persisted position must not move.
        fail.set(true);
        let before = b.written();
        assert!(b.push(&vec![0u8; WRITE_BUF_BYTES], now, &mut w).is_err());
        assert_eq!(b.written(), before);
        assert!(b.flush(&mut w).is_err());
        assert_eq!(b.written(), before);
        fail.set(false);
        b.flush(&mut w).unwrap();
        assert_eq!(b.written(), b.received());
        assert!(b.written() <= disk_len.get());
    }

    #[test]
    fn a_waiting_buffer_becomes_due_after_the_max_age() {
        let (mut calls, mut disk) = (Vec::new(), Vec::new());
        let mut w = sink(&mut calls, &mut disk);
        let mut b = WriteBuf::new(0);
        let t0 = Instant::now();
        assert!(!b.due(t0 + Duration::from_secs(10)), "empty is never due");
        b.push(&[9], t0, &mut w).unwrap();
        assert!(!b.due(t0 + WRITE_BUF_MAX_AGE - Duration::from_millis(1)));
        assert!(b.due(t0 + WRITE_BUF_MAX_AGE));
        b.flush(&mut w).unwrap();
        assert!(!b.due(t0 + Duration::from_secs(10)));
    }
}

fn read_headers(h: &HeaderMap) -> Headers {
    let text = |name: reqwest::header::HeaderName| {
        h.get(name)
            .map(|v: &HeaderValue| String::from_utf8_lossy(v.as_bytes()).into_owned())
    };
    Headers {
        content_type: text(CONTENT_TYPE),
        content_length: text(CONTENT_LENGTH).and_then(|s| s.trim().parse().ok()),
        content_range: text(CONTENT_RANGE),
        accept_ranges: text(ACCEPT_RANGES),
        etag: text(ETAG),
        last_modified: text(LAST_MODIFIED),
        content_disposition: text(CONTENT_DISPOSITION),
        retry_after: text(RETRY_AFTER),
    }
}

pub(super) fn build_client(proxy: Option<&str>, scope: LanScope) -> Result<Client, String> {
    // Contract section 17: redirects are followed by `redirect::send_following` (a cookie per hop's own host, at most
    // 10 hops, https to http refused). This policy never follows: it refuses a hop onto the local network (unless the
    // link the user typed was already there; the scope was chosen from the typed host and also knows an allowed
    // host) and otherwise returns the 3xx answer as it is.
    let policy_scope = scope.clone();
    let policy = redirect::Policy::custom(move |attempt| {
        if !policy_scope.redirect_allowed(attempt.url().host_str().unwrap_or("")) {
            return attempt.error(LOCAL_REDIRECT_MSG);
        }
        attempt.stop()
    });
    let mut b = Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
        // Every connection, redirects included, goes through the address check. A proxy resolves names itself.
        .dns_resolver(Arc::new(GuardedResolver { scope }))
        .user_agent(USER_AGENT_DEFAULT);
    if let Some(p) = proxy {
        b = b.proxy(reqwest::Proxy::all(p).map_err(|e| e.to_string())?);
    }
    b.build().map_err(|e| e.to_string())
}

// ---- results for the JNI layer ---------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub name: String,
    pub size: Option<u64>,
    pub resumable: bool,
    pub url_display: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AddedDownload {
    pub id: String,
}

#[derive(Debug)]
enum ProbeFail {
    Net,
    /// The typed host resolved onto the local network and wasn't allowed.
    LanAddress,
    /// 401 (or 403 on a link with a user name and password): a sign in.
    Auth(u16),
    /// 403 with no sign-in details: the site refused the link.
    Refused(u16),
    Status(u16),
    Html,
    LocalRedirect,
    /// The playlist can't be saved (contract 24.8).
    Stream(StreamError),
}

struct ProbeReply {
    info: ProbeInfo,
    /// Segments are allowed by what the probe saw (206 and `Accept-Ranges: bytes`).
    ranges_ok: bool,
    name: String,
    final_url: String,
}

enum Streamed {
    Done(u64),
    Broken(u64),
    /// Too slow or silent for too long (the stall rule).
    Stalled(u64),
    Stopped,
}

// ---- the manager ------------------------------------------------------------------------------------------------

pub struct Downloads {
    handle: Handle,
    /// `None` only in unit tests. The session holds the global speed limiter shared with torrents.
    session: Option<Arc<Session>>,
    session_dir: PathBuf,
    default_dir: PathBuf,
    inner: Mutex<Inner>,
    blocked: Mutex<Vec<String>>,
    proxy: Mutex<Option<String>>,
    /// One client per proxy and local-network scope (a handful at most).
    clients: Mutex<HashMap<(Option<String>, LanScope), Client>>,
    counter: AtomicU64,
    /// `NativeConfig.max_active_downloads`; 0 = no limit.
    max_active: AtomicU32,
    /// Held while a download takes a slot, so the cap can't be passed by two starts at once.
    start_lock: Mutex<()>,
    /// The active network is metered, as the engine last said (section 34.1). Splits bytes only.
    metered: AtomicBool,
    /// When the list was last written; the timing pass writes again once this is older than `TIMING_SAVE_EVERY`.
    last_save: Mutex<Instant>,
}

impl Downloads {
    pub fn new(
        handle: Handle,
        session: Arc<Session>,
        session_dir: &Path,
        default_dir: &Path,
        proxy: Option<String>,
        blocked: Vec<String>,
    ) -> Arc<Self> {
        Self::build(handle, Some(session), session_dir, default_dir, proxy, blocked)
    }

    fn build(
        handle: Handle,
        session: Option<Arc<Session>>,
        session_dir: &Path,
        default_dir: &Path,
        proxy: Option<String>,
        blocked: Vec<String>,
    ) -> Arc<Self> {
        let me = Arc::new(Downloads {
            handle,
            session,
            session_dir: session_dir.to_path_buf(),
            default_dir: default_dir.to_path_buf(),
            inner: Mutex::new(Inner::default()),
            blocked: Mutex::new(download_tags(&blocked)),
            proxy: Mutex::new(proxy),
            clients: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(1),
            max_active: AtomicU32::new(DEFAULT_MAX_ACTIVE_DOWNLOADS),
            start_lock: Mutex::new(()),
            metered: AtomicBool::new(false),
            last_save: Mutex::new(Instant::now()),
        });
        me.restore();
        me
    }

    fn store_path(&self) -> PathBuf {
        self.session_dir.join(STORE_FILE)
    }

    /// Loads the list entry by entry. Every download that was working goes back in the queue (SM-30 `Restore`).
    /// A download that needs a login that was never saved waits for a new link. When anything is unreadable the
    /// original file is kept as `maglev-downloads.corrupt-<time>.json` before the list is rewritten.
    fn restore(&self) {
        let bytes = match std::fs::read(self.store_path()) {
            Ok(b) => b,
            Err(_) => return,
        };
        let parsed = parse_store(&bytes);
        if parsed.unreadable || parsed.skipped > 0 {
            warn!(
                "the downloads list has {} unreadable entries{}; keeping a copy",
                parsed.skipped,
                if parsed.unreadable { " (the whole file)" } else { "" }
            );
            let backup = self.session_dir.join(corrupt_backup_name(now_secs()));
            if parsed.unreadable {
                // Moved, not copied: the next start finds no file, so the backup happens once.
                if std::fs::rename(self.store_path(), &backup).is_err() {
                    if let Err(e) = std::fs::write(&backup, &bytes) {
                        warn!("could not keep a copy of the downloads list: {e}");
                    }
                    let _ = std::fs::remove_file(self.store_path());
                }
            } else if let Err(e) = std::fs::write(&backup, &bytes) {
                warn!("could not keep a copy of the downloads list: {e}");
            }
            self.prune_backups();
        }
        if parsed.unreadable {
            return;
        }
        let mut inner = self.inner.lock();
        for mut rec in parsed.records {
            let (next, _) = step(rec.state, Event::Restore);
            rec.state = next;
            // Seen unfinished now: a later finish is a real edge. A finished record from before 0.26 stays at 0.
            rec.timing.observe_finished(rec.state == State::Finished, 0);
            // A download that was verifying has all its bytes; the first request answers 416 and finishes it.
            // A stream whose parts are all in waits for the join (`mux_needed`); it keeps `verifying`.
            if rec.state == State::Verifying && !rec.mux_needed {
                rec.state = State::Queued;
            }
            // Added with `paused: true` and never ran: it comes back paused, not queued.
            if rec.start_paused {
                let (st, _) = step(rec.state, Event::RestoreStartPaused);
                if st != rec.state {
                    rec.state = st;
                    rec.paused_tag = Some("user".to_string());
                }
                rec.start_paused = false;
            }
            // Older builds saved the query of the final link.
            rec.final_url = rec.final_url.as_deref().map(safe_url);
            // What is on disk is the truth for how much we hold.
            if let Some(sc) = Sidecar::load(&sidecar_path(Path::new(&rec.folder), &rec.name)) {
                if rec.state != State::Finished {
                    rec.held = if sc.stream.is_some() { sc.stream_held() } else { sc.held() };
                }
            }
            // The password, cookie or signed query lived in memory only: ask for the link again.
            if rec.needs_login && !rec.mux_needed {
                let (st, _) = step(rec.state, Event::SecretsLost);
                if st == State::NeedsLink {
                    rec.state = st;
                    rec.paused_tag = None;
                    rec.status = None;
                    rec.error = Some(needs_link_info(None, true, false));
                }
            }
            inner.live.insert(rec.id.clone(), Live::default());
            inner.records.insert(rec.id.clone(), rec);
        }
        drop(inner);
        self.save();
    }

    /// Keeps the newest 3 `maglev-downloads.corrupt-*` copies.
    fn prune_backups(&self) {
        let Ok(dir) = std::fs::read_dir(&self.session_dir) else { return };
        let names: Vec<String> = dir.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        for old in backups_to_delete(&names, 3) {
            let _ = std::fs::remove_file(self.session_dir.join(old));
        }
    }

    fn save(&self) {
        *self.last_save.lock() = Instant::now();
        let file = StoreFile {
            version: 1,
            downloads: self.inner.lock().records.values().map(persisted).collect(),
        };
        match serde_json::to_vec(&file) {
            Ok(bytes) => {
                if let Err(e) = write_atomic(&self.store_path(), &bytes) {
                    warn!("could not save the downloads list: {e}");
                }
            }
            Err(e) => warn!("could not encode the downloads list: {e}"),
        }
    }

    /// The cap on working link downloads (`max_active_downloads`, 0 = no limit). Raising it starts waiting downloads;
    /// lowering it never stops a working one.
    pub fn set_max_active(self: &Arc<Self>, max: u32) {
        self.max_active.store(max, Ordering::Relaxed);
        self.pump();
    }

    /// The session-wide download limit shared with torrents, if one is set.
    fn global_down_bps(&self) -> Option<NonZeroU32> {
        self.session.as_ref().and_then(|s| s.ratelimits.get_download_bps())
    }

    fn has_free_slot(&self, inner: &Inner) -> bool {
        slot_free(Self::active_count(inner), self.max_active.load(Ordering::Relaxed))
    }

    pub fn set_proxy(&self, proxy: Option<String>) {
        *self.proxy.lock() = proxy;
    }

    /// The client for a link: its scope comes from the typed host, `allow_lan` and the pinned addresses.
    fn client_for(&self, url: &str, allow_lan: bool, pinned: &[String]) -> Result<Client, EngineError> {
        let scope = LanScope::for_host(&host_of(url), allow_lan, pinned);
        let proxy = self.proxy.lock().clone();
        let mut clients = self.clients.lock();
        if let Some(c) = clients.get(&(proxy.clone(), scope.clone())) {
            return Ok(c.clone());
        }
        let c = build_client(proxy.as_deref(), scope.clone()).map_err(|e| {
            warn!("download client failed: {e}");
            EngineError::new(ErrorCode::Network, "The download client couldn't start. Check the proxy address.")
        })?;
        if clients.len() >= 16 {
            clients.clear();
        }
        clients.insert((proxy, scope), c.clone());
        Ok(c)
    }

    /// A client for a link typed in the add sheet (or pasted again), with the host pinned when `allow_lan` is set.
    async fn scoped_client(&self, url: &str, allow_lan: bool) -> Result<(Client, Vec<String>), EngineError> {
        let host = host_of(url);
        let pinned = if allow_lan && !is_lan_host(&host) { resolve_ips(&host).await? } else { Vec::new() };
        Ok((self.client_for(url, allow_lan, &pinned)?, pinned))
    }

    /// Is this download waiting for a new link? The engine uses it to turn a pasted duplicate into a refresh.
    pub fn is_needs_link(&self, id: &str) -> bool {
        self.state_of(id) == Some(State::NeedsLink)
    }

    /// The client of a stored download.
    fn client_for_id(&self, id: &str) -> Result<Client, EngineError> {
        let (url, allow, pinned) = self
            .update(id, |r, _| (r.url.clone(), r.allow_lan, r.lan_pinned.clone()))
            .ok_or_else(EngineError::not_found)?;
        self.client_for(&url, allow, &pinned)
    }

    /// Resolves the typed host once and keeps its addresses with the download (contract 17.w). Later lookups of that
    /// host may only return these. Nothing to do when it is already pinned.
    async fn pin_lan_host(&self, id: &str) -> Result<(), EngineError> {
        let (url, allow, pinned) = self
            .update(id, |r, _| (r.url.clone(), r.allow_lan, r.lan_pinned.clone()))
            .ok_or_else(EngineError::not_found)?;
        if !allow || !pinned.is_empty() {
            return Ok(());
        }
        let ips = resolve_ips(&host_of(&url)).await?;
        self.update(id, |r, _| r.lan_pinned = ips);
        self.save();
        Ok(())
    }

    /// The user allows the typed host of a download that failed with `LAN_ADDRESS`. The caller retries afterwards.
    pub async fn allow_lan_host(self: &Arc<Self>, id: &str) -> Result<(), EngineError> {
        let s = self.state_of(id).ok_or_else(EngineError::not_found)?;
        if s != State::Error(DlError::LanAddress) {
            return Err(EngineError::new(ErrorCode::InvalidState, "This download doesn't need that"));
        }
        self.update(id, |r, _| {
            r.allow_lan = true;
            r.lan_pinned.clear();
        });
        self.pin_lan_host(id).await
    }

    fn new_id(&self, inner: &Inner) -> String {
        loop {
            let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(1);
            let n = nanos
                .wrapping_mul(6364136223846793005)
                .wrapping_add(self.counter.fetch_add(1, Ordering::Relaxed));
            let id = format!("dl_{:012x}", n & 0xffff_ffff_ffff);
            if !inner.records.contains_key(&id) {
                return id;
            }
        }
    }

    // ---- state changes ------------------------------------------------------------------------------------------

    /// The blocking tags that apply to one download, after its "Resume anyway" exemption.
    fn blocked_for(&self, id: &str) -> Vec<String> {
        let allowed = self.inner.lock().records.get(id).map(|r| r.allowed_anyway).unwrap_or(false);
        effective_blocked(allowed, &self.blocked.lock())
    }

    fn gov_allows_for(&self, id: &str) -> bool {
        self.blocked_for(id).is_empty()
    }

    /// The tag a new or retried download pauses for: the most user-actionable one (`top_block`).
    fn first_block(&self) -> Option<String> {
        top_block(&self.blocked.lock()).cloned()
    }

    fn is_offline(&self) -> bool {
        self.blocked.lock().iter().any(|t| t == OFFLINE_TAG)
    }

    fn network_blocked(&self) -> bool {
        blocks_network(&self.blocked.lock())
    }

    fn active_count(inner: &Inner) -> usize {
        inner.records.values().filter(|r| r.state == State::Downloading).count()
    }

    /// Runs the machine for one download and executes the effects that need the whole list.
    fn dispatch(self: &Arc<Self>, id: &str, ev: Event) -> (State, Vec<Effect>) {
        self.dispatch_tagged(id, ev, None)
    }

    fn dispatch_tagged(self: &Arc<Self>, id: &str, ev: Event, tag: Option<&str>) -> (State, Vec<Effect>) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let Some(rec) = inner.records.get_mut(id) else {
            return (State::Gone, vec![]);
        };
        let before = rec.state;
        let (next, effects) = step(before, ev);
        rec.state = next;
        let live = inner.live.entry(id.to_string()).or_default();
        // Count what the stretch that is ending downloaded, before the effects touch `held`.
        account_leave(rec, live, before, self.metered.load(Ordering::Relaxed));

        match next {
            State::Paused(PauseReason::User) => rec.paused_tag = Some("user".to_string()),
            State::Paused(PauseReason::Storage) => {
                rec.paused_tag = Some(storage_pause_tag(tag, rec.paused_tag.as_deref()));
            }
            State::Paused(_) => {
                if before != next || tag.is_some() {
                    rec.paused_tag = tag.map(str::to_string).or_else(|| rec.paused_tag.clone());
                }
            }
            _ => rec.paused_tag = None,
        }
        if next == State::Finished {
            rec.allowed_anyway = false;
        }
        match next {
            State::Error(e) => {
                rec.error = Some(DlErrInfo {
                    code: e.as_str().to_string(),
                    message: error_message(e, rec.status),
                    http_status: if e == DlError::HttpStatus { rec.status } else { None },
                });
            }
            State::NeedsLink => {
                rec.error = Some(needs_link_info(rec.status, rec.needs_login, rec.link_login));
            }
            State::Downloading | State::Queued | State::Resolving | State::Verifying | State::Finished => {
                rec.error = None;
            }
            _ => {}
        }
        if next == State::Downloading && before != State::Downloading {
            live.bps = 0;
        }
        if next != State::Downloading {
            live.bps = 0;
            live.stalled = false;
        }

        for e in &effects {
            match e {
                Effect::Probe => {
                    rec.status = None;
                    rec.error = None;
                    let me = self.clone();
                    let id2 = id.to_string();
                    let jh = self.handle.spawn(async move { me.run_probe(id2).await });
                    if let Some(old) = live.task.replace(jh) {
                        old.abort();
                    }
                }
                Effect::StartSegments => {
                    live.attempts = 0;
                    live.denied = 0;
                    live.stalls = 0;
                    live.stalled = false;
                    rec.notice = None;
                    let me = self.clone();
                    let id2 = id.to_string();
                    let jh = self.handle.spawn(async move { me.transfer(id2).await });
                    if let Some(old) = live.task.replace(jh) {
                        old.abort();
                    }
                }
                Effect::CancelTasks => {
                    if let Some(t) = live.task.take() {
                        t.abort();
                    }
                }
                Effect::FlushSidecar => write_record_sidecar(rec, live),
                Effect::Notice(Notice::ServerSentWholeFile) => rec.notice = Some(WHOLE_FILE_NOTICE.to_string()),
                Effect::Notice(Notice::DiskFull) => rec.notice = None,
                Effect::RenamePart => {
                    if let Err(msg) = finish_files(rec) {
                        warn!("could not finish the download: {msg}");
                        rec.state = State::Error(DlError::Permission);
                        rec.error = Some(DlErrInfo {
                            code: DlError::Permission.as_str().to_string(),
                            message: error_message(DlError::Permission, None),
                            http_status: None,
                        });
                    }
                }
                Effect::DeletePartIf(delete) => {
                    delete_files(rec, *delete, before == State::Finished);
                }
                _ => {}
            }
        }

        account_settle(rec, live, now_secs());
        let final_state = rec.state;
        if final_state == State::Gone {
            inner.records.remove(id);
            inner.live.remove(id);
        }
        drop(guard);
        if before != next || !effects.is_empty() {
            self.save();
        }
        (final_state, effects)
    }

    fn update<R>(&self, id: &str, f: impl FnOnce(&mut DlRecord, &mut Live) -> R) -> Option<R> {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let rec = inner.records.get_mut(id)?;
        let live = inner.live.entry(id.to_string()).or_default();
        Some(f(rec, live))
    }

    fn state_of(&self, id: &str) -> Option<State> {
        self.inner.lock().records.get(id).map(|r| r.state)
    }

    // ---- public API (called from the engine) ------------------------------------------------------------------------

    /// Starts a download. Returns at once; the probe runs on the runtime.
    pub fn add(self: &Arc<Self>, url: &str, options_json: &str) -> Result<AddedDownload, EngineError> {
        let opts = parse_options(options_json)?;
        let (clean, auth) = parse_http_url(url)?;
        let folder = opts
            .folder
            .clone()
            .filter(|f| !f.trim().is_empty())
            .unwrap_or_else(|| self.default_dir.to_string_lossy().into_owned());
        let url_str = clean.to_string();
        let block = self.first_block();
        let id = {
            let mut inner = self.inner.lock();
            let want_stream = opts.stream.as_ref().map(|s| (s.variant_id.clone(), s.audio_id.clone()));
            let same_stream = |r: &DlRecord| {
                r.stream.as_ref().map(|s| (s.variant_id.clone(), s.audio_id.clone())) == want_stream
            };
            if let Some(existing) = inner.records.values().find(|r| same_link(r, &url_str, &folder) && same_stream(r)) {
                let mut e = EngineError::duplicate(existing.id.clone());
                e.message = "This link is already in your downloads".to_string();
                return Err(e);
            }
            let id = self.new_id(&inner);
            // Governance blocks: the record is created paused and nothing touches the network until it clears.
            let (reason, tag) = match &block {
                Some(tag) => {
                    let r = if opts.paused { PauseReason::User } else { reason_for_tag(tag) };
                    (Some(r), Some(tag.clone()))
                }
                None => (None, None),
            };
            let (state, _) = match reason {
                Some(r) => step(State::None, Event::AddBlocked(r)),
                None => step(State::None, Event::Add { url_ok: true }),
            };
            let paused_tag = match reason {
                Some(PauseReason::User) => Some("user".to_string()),
                Some(PauseReason::Storage) => Some(storage_pause_tag(tag.as_deref(), None)),
                Some(_) => tag,
                None => None,
            };
            let rec = DlRecord {
                paused_tag,
                id: id.clone(),
                url: url_str,
                state,
                folder,
                requested_name: opts.name.as_deref().map(sanitize_filename),
                added_at: now_secs(),
                down_limit_bps: opts.down_limit_bps.unwrap_or(0),
                segments: opts.segments.unwrap_or(1),
                start_paused: opts.paused && block.is_none(),
                allow_lan: opts.allow_lan,
                page_url: clean_page_url(opts.page_url.as_deref()),
                timing: Timing::new(),
                stream: opts.stream.as_ref().map(|s| StreamRec {
                    kind: s.kind,
                    variant_id: s.variant_id.clone(),
                    audio_id: s.audio_id.clone(),
                    segments_done: 0,
                    segments_total: 0,
                }),
                ..DlRecord::default()
            };
            let h = opts.headers.clone().unwrap_or_default();
            let mut rec = rec;
            let host_cookies = h.host_cookies();
            // Sign-in details stay in memory. Only the fact that they are needed is saved.
            rec.needs_login = auth.is_some() || h.cookie.is_some() || !host_cookies.is_empty() || has_secret_query(&rec.url);
            rec.link_login = auth.is_some();
            inner.live.insert(
                id.clone(),
                Live {
                    auth,
                    cookie: h.cookie,
                    referer: h.referer,
                    user_agent: h.user_agent,
                    origin: h.origin,
                    host_cookies,
                    ..Live::default()
                },
            );
            inner.records.insert(id.clone(), rec);
            id
        };
        self.save();
        if block.is_some() {
            // Paused by governance: the probe runs when the transfer starts (`transfer` probes an unnamed record).
            return Ok(AddedDownload { id });
        }
        // Persist and Probe are the effects of the `Add` row.
        // The handle is stored while the list is locked, so a fast probe that starts the transfer can't have its
        // transfer handle overwritten by this one afterwards.
        {
            let me = self.clone();
            let id2 = id.clone();
            let mut inner = self.inner.lock();
            let jh = self.handle.spawn(async move { me.run_probe(id2).await });
            inner.live.entry(id.clone()).or_default().task = Some(jh);
        }
        Ok(AddedDownload { id })
    }

    pub fn pause(self: &Arc<Self>, id: &str) -> Result<(), EngineError> {
        let s = self.state_of(id).ok_or_else(EngineError::not_found)?;
        // A probing download, and one that governance paused, can be held by the user too (Pause all).
        let can = match s {
            State::Downloading | State::Queued | State::Resolving => true,
            State::Paused(r) => r != PauseReason::User,
            _ => false,
        };
        if can {
            self.update(id, |r, _| {
                r.start_paused = false;
                r.allowed_anyway = false;
            });
            self.dispatch(id, Event::UserPause);
        }
        Ok(())
    }

    /// "Resume anyway" (section 25): exempt the download from the rule tags, then resume it.
    pub fn resume_anyway(self: &Arc<Self>, id: &str) -> Result<(), EngineError> {
        self.state_of(id).ok_or_else(EngineError::not_found)?;
        self.update(id, |r, _| r.allowed_anyway = true);
        self.resume(id)?;
        // A download that is already queued or running only needs a governance pass.
        self.pump();
        Ok(())
    }

    pub fn resume(self: &Arc<Self>, id: &str) -> Result<(), EngineError> {
        let s = self.state_of(id).ok_or_else(EngineError::not_found)?;
        if matches!(s, State::Paused(_)) {
            self.dispatch(id, Event::UserResume);
            self.pump();
        }
        Ok(())
    }

    /// Retry from an error. After `FILE_CHANGED` it is a restart: the old bytes belong to a different file.
    pub fn retry(self: &Arc<Self>, id: &str) -> Result<(), EngineError> {
        let s = self.state_of(id).ok_or_else(EngineError::not_found)?;
        let State::Error(e) = s else {
            return Err(EngineError::new(ErrorCode::InvalidState, "Only a failed download can be retried"));
        };
        // A failed join runs the join again; nothing is fetched (contract 24.8).
        if e == DlError::MuxFailed {
            self.dispatch(id, Event::RetryMux);
            return Ok(());
        }
        if e == DlError::FileChanged || e == DlError::ChecksumMismatch {
            let changed = e == DlError::FileChanged;
            self.update(id, |rec, live| {
                delete_partial(rec);
                rec.held = 0;
                // A different file: the time, finish and bytes counted so far belong to the old one (section 34.1).
                if changed {
                    rec.timing.reset();
                    live.acct = Some(0);
                }
                rec.validator = None;
                rec.size = None;
                rec.resumable = false;
                // A different file: splitting may be tried again after the new probe.
                rec.split_off = false;
            });
        }
        // Wi-Fi-only, VPN-only, offline and the other reasons gate the request here too.
        if let Some(tag) = top_block(&self.blocked_for(id)).cloned() {
            self.dispatch_tagged(id, Event::UserRetryBlocked(reason_for_tag(&tag)), Some(tag.as_str()));
            return Ok(());
        }
        self.dispatch(id, Event::UserRetry);
        Ok(())
    }

    pub fn remove(self: &Arc<Self>, id: &str, delete_files: bool) -> Result<(), EngineError> {
        if self.state_of(id).is_none() {
            return Err(EngineError::not_found());
        }
        self.dispatch(id, Event::Remove { delete_files });
        Ok(())
    }

    pub fn set_limits(&self, id: &str, json: &str) -> Result<(), EngineError> {
        #[derive(Deserialize, Default)]
        #[serde(default)]
        struct L {
            down_limit_bps: Option<u64>,
        }
        let l: L = serde_json::from_str(json)
            .map_err(|_| EngineError::new(ErrorCode::InvalidArgument, "Those limits aren't valid"))?;
        let v = l.down_limit_bps.unwrap_or(0);
        self.update(id, |rec, _| rec.down_limit_bps = v).ok_or_else(EngineError::not_found)?;
        self.save();
        Ok(())
    }

    /// Probes a link for the add sheet. Nothing is stored.
    pub async fn probe_url(&self, url: &str, options_json: &str) -> Result<ProbeResult, EngineError> {
        let opts = parse_options(options_json)?;
        let (clean, auth) = parse_http_url(url)?;
        if self.network_blocked() {
            return Err(EngineError::new(ErrorCode::Blocked, BLOCKED_MSG));
        }
        let (client, _) = self.scoped_client(clean.as_str(), opts.allow_lan).await?;
        let h = opts.headers.unwrap_or_default();
        let hdrs = LinkHeaders::from_options(&h);
        match probe_request(&client, clean.as_str(), auth.as_ref(), &hdrs).await {
            Ok(r) => Ok(ProbeResult {
                name: opts.name.as_deref().map(sanitize_filename).unwrap_or(r.name),
                size: r.info.size,
                resumable: r.info.resumable,
                url_display: display_url(&r.final_url),
            }),
            Err(f) => Err(probe_error(f)),
        }
    }

    /// Replaces the link of a `NeedsLink` download when the new one points at the same file.
    pub async fn refresh_url(self: &Arc<Self>, id: &str, url: &str, options_json: &str) -> Result<(), EngineError> {
        let opts = parse_options(options_json)?;
        let (clean, auth) = parse_http_url(url)?;
        let (state, size, validator) = self
            .update(id, |r, _| (r.state, r.size, r.validator.clone()))
            .ok_or_else(EngineError::not_found)?;
        if state != State::NeedsLink {
            return Err(EngineError::new(ErrorCode::InvalidState, "This download doesn't need a new link"));
        }
        if self.network_blocked() {
            return Err(EngineError::new(ErrorCode::Blocked, BLOCKED_MSG));
        }
        if self.update(id, |r, _| r.stream.is_some()).unwrap_or(false) {
            return self.refresh_stream_url(id, clean, auth, opts).await;
        }
        let (client, pinned) = self.scoped_client(clean.as_str(), opts.allow_lan).await?;
        let h = opts.headers.unwrap_or_default();
        let host_cookies = h.host_cookies();
        let hdrs = LinkHeaders::from_options(&h);
        let reply = probe_request(&client, clean.as_str(), auth.as_ref(), &hdrs).await.map_err(probe_error)?;
        let matches = link_matches(size, validator.as_deref(), &reply.info);
        if matches {
            self.update(id, |rec, live| {
                rec.url = clean.to_string();
                rec.final_url = Some(reply.final_url.clone());
                rec.status = None;
                rec.needs_login = auth.is_some() || h.cookie.is_some() || !host_cookies.is_empty() || has_secret_query(&rec.url);
                rec.link_login = auth.is_some();
                rec.allow_lan = opts.allow_lan;
                rec.lan_pinned = pinned;
                if let Some(p) = clean_page_url(opts.page_url.as_deref()) {
                    rec.page_url = Some(p);
                }
                live.auth = auth;
                live.cookie = h.cookie;
                live.referer = h.referer;
                live.user_agent = h.user_agent;
                live.origin = h.origin;
                live.host_cookies = host_cookies;
                live.attempts = 0;
                live.denied = 0;
            });
        }
        self.dispatch(id, Event::NewLink { matches });
        if matches {
            self.pump();
            Ok(())
        } else {
            Err(EngineError::new(ErrorCode::FileChanged, "That link points to a different file"))
        }
    }

    /// The engine's network word (section 34.1): metered or not. Only splits bytes; never pauses anything.
    pub fn set_metered(&self, metered: bool) {
        self.metered.store(metered, Ordering::Relaxed);
    }

    /// The default network changed from one live network to another (contract section 17.x). A socket opened on the
    /// old network is dead, but nothing tells the transfer until a read timeout. Every working or probing download
    /// (streams included) gets its task aborted and started again at once: the transfer resumes from the written
    /// position (sidecar, Range) on the new network. No state change, no `paused_by`, no attempt counted.
    pub fn network_changed(self: &Arc<Self>) {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        for (id, rec) in inner.records.iter() {
            let resolving = match rec.state {
                State::Downloading => false,
                State::Resolving => true,
                _ => continue,
            };
            // Cancel the old task first, so two tasks never write the same part file at once.
            let live = inner.live.entry(id.clone()).or_default();
            if let Some(old) = live.task.take() {
                old.abort();
            }
            let me = self.clone();
            let id2 = id.clone();
            let jh = if resolving {
                self.handle.spawn(async move { me.run_probe(id2).await })
            } else {
                self.handle.spawn(async move { me.transfer(id2).await })
            };
            live.task = Some(jh);
        }
    }

    /// The one-second timing pass, called from the engine's governance tick (section 34.1). `elapsed` is the wall time
    /// since the previous pass. Time and bytes count only for a download in `Downloading`; the list is written at
    /// most every `TIMING_SAVE_EVERY` while something downloads, so a kill loses no more than that.
    pub fn account(&self, elapsed: Duration, metered: bool) {
        self.metered.store(metered, Ordering::Relaxed);
        let mut any = false;
        {
            let mut guard = self.inner.lock();
            let inner = &mut *guard;
            for (id, rec) in inner.records.iter_mut() {
                let live = inner.live.entry(id.clone()).or_default();
                any |= account_one(rec, live, elapsed, metered);
            }
        }
        if any && self.last_save.lock().elapsed() >= TIMING_SAVE_EVERY {
            self.save();
        }
    }

    pub fn snapshots(&self) -> Vec<Value> {
        let inner = self.inner.lock();
        let mut recs: Vec<&DlRecord> = inner.records.values().collect();
        recs.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.id.cmp(&b.id)));
        recs.into_iter()
            .map(|r| {
                let bps = inner.live.get(&r.id).map(|l| l.bps).unwrap_or(0);
                let stalled = r.state == State::Downloading && inner.live.get(&r.id).map(|l| l.stalled).unwrap_or(false);
                let eta: i64 = match (r.size, r.state) {
                    (Some(total), State::Downloading) if bps > 0 => (total.saturating_sub(r.held) / bps) as i64,
                    _ => -1,
                };
                let name = if !r.name.is_empty() {
                    r.name.clone()
                } else {
                    r.requested_name
                        .clone()
                        .or_else(|| super::content_disposition::filename_from_url(&r.url).map(|n| sanitize_filename(&n)))
                        .unwrap_or_else(|| "Download".to_string())
                };
                json!({
                    "id": r.id,
                    "url_display": display_url(&r.url),
                    "name": name,
                    "state": state_name(r.state),
                    "paused_by": if matches!(r.state, State::Paused(_)) { r.paused_tag.clone() } else { None },
                    "allowed_anyway": r.allowed_anyway,
                    "page_url": r.page_url,
                    "size": r.size,
                    "downloaded": r.held,
                    "down_bps": bps,
                    "stalled": stalled,
                    "eta": eta,
                    "segments_active": if r.state == State::Downloading {
                        inner.live.get(&r.id).and_then(|l| l.parts.as_ref()).map(|p| p.active()).unwrap_or(1)
                    } else {
                        0
                    },
                    "down_limit_bps": r.down_limit_bps,
                    "resumable": r.resumable || r.stream.is_some(),
                    "stream": r.stream.as_ref().map(|s| json!({
                        "kind": s.kind,
                        "segments_done": s.segments_done,
                        "segments_total": s.segments_total,
                    })),
                    "mux_needed": r.mux_needed && r.state == State::Verifying,
                    "folder": r.folder,
                    "added_at": r.added_at,
                    "error": r.error,
                    "notice": r.notice,
                    "active_secs": r.timing.active_secs(),
                    "finished_at": r.timing.finished_at,
                    "session_bytes": r.timing.session_bytes,
                    "bytes_wifi": r.timing.bytes_wifi,
                    "bytes_mobile": r.timing.bytes_mobile,
                })
            })
            .collect()
    }

    /// Flushes every sidecar and stops every task. Called from the engine's shutdown.
    pub fn shutdown(self: &Arc<Self>) {
        let ids: Vec<String> = self.inner.lock().records.keys().cloned().collect();
        for id in ids {
            let working = matches!(self.state_of(&id), Some(State::Downloading));
            if working {
                // The state stays `Downloading` on disk, and `Restore` turns it into `Queued` at the next start.
                self.update(&id, |rec, live| {
                    if let Some(t) = live.task.take() {
                        t.abort();
                    }
                    write_record_sidecar(rec, live);
                });
            } else {
                self.update(&id, |_, live| {
                    if let Some(t) = live.task.take() {
                        t.abort();
                    }
                });
            }
        }
        self.save();
    }

    // ---- governance ---------------------------------------------------------------------------------------------------

    pub fn set_blocked(self: &Arc<Self>, blocked: &[String]) {
        *self.blocked.lock() = download_tags(blocked);
        self.govern();
    }

    /// Starts queued downloads when a slot is free.
    pub fn pump(self: &Arc<Self>) {
        self.govern();
    }

    /// One governance pass: block or clear by the engine's reasons, restart dead tasks, fill free slots.
    pub fn govern(self: &Arc<Self>) {
        let blocked = self.blocked.lock().clone();

        // Snapshot the facts, then act without holding the lock.
        struct Fact {
            id: String,
            state: State,
            tag: Option<String>,
            dead: bool,
            added_at: i64,
            folder: String,
            size: Option<u64>,
            held: u64,
            allowed: bool,
        }
        let facts: Vec<Fact> = {
            let inner = self.inner.lock();
            inner
                .records
                .values()
                .map(|r| Fact {
                    id: r.id.clone(),
                    state: r.state,
                    tag: r.paused_tag.clone(),
                    dead: r.state == State::Downloading
                        && inner
                            .live
                            .get(&r.id)
                            .map(|l| l.task.as_ref().map(|t| t.is_finished()).unwrap_or(true))
                            .unwrap_or(true),
                    added_at: r.added_at,
                    folder: r.folder.clone(),
                    size: r.size,
                    held: r.held,
                    allowed: r.allowed_anyway,
                })
                .collect()
        };

        for f in &facts {
            match f.state {
                State::Downloading => {
                    if f.dead {
                        // The task ended without a state change (a panic). Do not leave the download spinning.
                        self.dispatch(&f.id, Event::Transient { attempts: MAX_ATTEMPTS });
                    }
                }
                // Storage pauses clear on their own once the governance tag is gone and the space is back.
                State::Paused(PauseReason::Storage) => {
                    let tagged = blocked.iter().any(|t| reason_for_tag(t) == PauseReason::Storage);
                    if !tagged && fits(f.size, f.held, free_space(Path::new(&f.folder))) {
                        self.dispatch(&f.id, Event::GovClear(PauseReason::Storage));
                    }
                }
                State::Paused(r) if r != PauseReason::User && r != PauseReason::Storage => {
                    let mine = effective_blocked(f.allowed, &blocked);
                    let still = f.tag.as_ref().map(|t| mine.contains(t)).unwrap_or(false);
                    if !still {
                        self.dispatch(&f.id, Event::GovClear(r));
                    }
                }
                _ => {}
            }
        }

        // Second pass, on the states the first pass left: a download that is working, waiting or probing while a tag
        // still blocks is paused for the top tag. This catches a download that a cleared reason just put back in
        // the queue while another reason still applies, and one that `resume` just woke up.
        if !blocked.is_empty() {
            let ids: Vec<String> = facts.iter().map(|f| f.id.clone()).collect();
            for id in ids {
                let Some(state) = self.state_of(&id) else { continue };
                if let Some((ev, tag)) = gov_event(state, &self.blocked_for(&id)) {
                    self.dispatch_tagged(&id, ev, Some(tag.as_str()));
                }
            }
        }

        // Queued downloads start in `added_at` order while slots are free and nothing blocks.
        {
            let mut queued: Vec<(i64, String)> = facts
                .iter()
                .filter(|f| matches!(f.state, State::Queued) || self.state_of(&f.id) == Some(State::Queued))
                .filter(|f| self.gov_allows_for(&f.id))
                .map(|f| (f.added_at, f.id.clone()))
                .collect();
            queued.sort();
            queued.dedup();
            for (_, id) in queued {
                // Check the slot and take it under one lock, so a probe finishing now can't pass the cap too.
                let _start = self.start_lock.lock();
                if !self.has_free_slot(&self.inner.lock()) {
                    break;
                }
                if self.state_of(&id) == Some(State::Queued) {
                    self.dispatch(&id, Event::SlotFree { gov_allows: true });
                }
            }
        }
    }

    // ---- tasks --------------------------------------------------------------------------------------------------------

    /// Probe task for `Add` and `UserRetry`. Feeds the machine the probe events.
    async fn run_probe(self: Arc<Self>, id: String) {
        let outcome = self.do_probe(&id).await;
        match outcome {
            Ok(()) => {
                let (start_paused, space_ok) = self
                    .update(&id, |r, _| (r.start_paused, fits(r.size, r.held, free_space(Path::new(&r.folder)))))
                    .unwrap_or((false, true));
                // The slot is checked and taken under one lock, so two starts can't both pass the cap.
                let (state, _) = {
                    let _start = self.start_lock.lock();
                    let slot_free = self.has_free_slot(&self.inner.lock());
                    let gov_allows = self.gov_allows_for(&id);
                    let ev = if start_paused {
                        Event::ProbeOk { slot_free: false, gov_allows: true, space_ok }
                    } else {
                        Event::ProbeOk { slot_free, gov_allows, space_ok }
                    };
                    self.dispatch(&id, ev)
                };
                if start_paused && state == State::Queued {
                    self.update(&id, |r, _| r.start_paused = false);
                    self.dispatch(&id, Event::UserPause);
                }
            }
            Err(ProbeFail::Auth(s)) | Err(ProbeFail::Refused(s)) => {
                self.update(&id, |r, _| r.status = Some(s));
                self.dispatch(&id, Event::ProbeAuth);
            }
            Err(ProbeFail::Status(s)) => {
                self.update(&id, |r, _| r.status = Some(s));
                self.dispatch(&id, Event::ProbeStatus);
            }
            Err(ProbeFail::Html) => {
                self.dispatch(&id, Event::ProbeHtml { url_looks_like_file: true });
            }
            Err(ProbeFail::LocalRedirect) => {
                self.dispatch(&id, Event::LocalRedirect);
            }
            Err(ProbeFail::LanAddress) => {
                self.dispatch(&id, Event::LanAddress);
            }
            Err(ProbeFail::Stream(e)) => {
                self.dispatch(&id, Event::StreamRefused(stream_run::stream_dl_error(e)));
            }
            Err(ProbeFail::Net) => {
                if self.is_offline() {
                    // No network: wait for it instead of failing.
                    self.dispatch_tagged(&id, Event::GovBlock(PauseReason::Offline), Some(OFFLINE_TAG));
                } else {
                    self.dispatch(&id, Event::NetErr);
                }
            }
        }
    }

    /// Probes the record's link and fills in name, size, validator and resume support.
    async fn do_probe(&self, id: &str) -> Result<(), ProbeFail> {
        if self.update(id, |r, _| r.stream.is_some()).unwrap_or(false) {
            return self.do_probe_stream(id).await;
        }
        let (url, auth, hdrs) = self
            .update(id, |r, l| (r.url.clone(), l.auth.clone(), LinkHeaders::from_live(l)))
            .ok_or(ProbeFail::Net)?;
        // An allowed host is pinned once, before its first request.
        if self.pin_lan_host(id).await.is_err() {
            return Err(ProbeFail::Net);
        }
        let client = self.client_for_id(id).map_err(|_| ProbeFail::Net)?;
        let reply = probe_request(&client, &url, auth.as_ref(), &hdrs).await?;
        // Pick a free name once, on the first probe. A resumed download keeps the name its part file has. The names
        // of the other downloads are read under the same lock that stores this one, so two downloads of the same
        // name can't both take it.
        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let taken_by_others: Vec<String> = inner
            .records
            .values()
            .filter(|r| r.id != id && !r.name.is_empty())
            .map(|r| format!("{}\u{0}{}", r.folder, r.name))
            .collect();
        if let Some(rec) = inner.records.get_mut(id) {
            rec.size = reply.info.size;
            rec.validator = reply.info.validator.clone();
            rec.resumable = reply.info.resumable;
            rec.parts_ok = reply.ranges_ok;
            rec.final_url = Some(reply.final_url.clone());
            if rec.name.is_empty() {
                let wanted = rec.requested_name.clone().unwrap_or_else(|| reply.name.clone());
                let folder = PathBuf::from(&rec.folder);
                let key = rec.folder.clone();
                rec.name = unique_name(&wanted, |n| {
                    final_path(&folder, n).exists()
                        || part_path(&folder, n).exists()
                        || taken_by_others.contains(&format!("{key}\u{0}{n}"))
                });
            }
        }
        Ok(())
    }

    /// The transfer task of one download: prepare the part file, then request, judge, write, retry.
    async fn transfer(self: Arc<Self>, id: String) {
        if self.update(&id, |r, _| r.stream.is_some()).unwrap_or(false) {
            return self.transfer_stream(id).await;
        }
        // A download restored before its probe ran has no name yet.
        let probed = self.update(&id, |r, _| !r.name.is_empty()).unwrap_or(false);
        if !probed {
            match self.do_probe(&id).await {
                Ok(()) => {}
                Err(ProbeFail::Auth(s)) | Err(ProbeFail::Refused(s)) => {
                    self.update(&id, |r, _| r.status = Some(s));
                    self.dispatch(&id, Event::Auth);
                    return;
                }
                Err(ProbeFail::Status(s)) => {
                    self.update(&id, |r, _| r.status = Some(s));
                    self.dispatch(&id, Event::HttpFatal);
                    return;
                }
                Err(ProbeFail::Html) => {
                    self.dispatch(&id, Event::NotAFile);
                    return;
                }
                Err(ProbeFail::LocalRedirect) => {
                    self.dispatch(&id, Event::LocalRedirect);
                    return;
                }
                Err(ProbeFail::LanAddress) => {
                    self.dispatch(&id, Event::LanAddress);
                    return;
                }
                Err(ProbeFail::Stream(_)) => return,
                Err(ProbeFail::Net) => {
                    if !self.transient(&id, None).await {
                        return;
                    }
                }
            }
        }
        // An allowed host is pinned before the first request (a restored download may not be yet).
        if self.pin_lan_host(&id).await.is_err() && !self.transient(&id, None).await {
            return;
        }
        let client = match self.client_for_id(&id) {
            Ok(c) => c,
            Err(_) => {
                self.dispatch(&id, Event::Transient { attempts: MAX_ATTEMPTS });
                return;
            }
        };
        // Several connections when the file allows it (and the download has not fallen back). A fallback comes back
        // here with the sidecar already cut down to the contiguous prefix, so the single connection resumes from it.
        if let Parts::Split { segs, fresh } = tokio::task::block_in_place(|| self.choose_parts(&id)) {
            let host = self.update(&id, |r, _| host_of(&r.url)).unwrap_or_default();
            match self.run_parts(&id, &client, segs, fresh, &host).await {
                PartsEnd::Done | PartsEnd::Stop => return,
                PartsEnd::Fallback => {}
            }
        }
        let (file, mut held) = match tokio::task::block_in_place(|| self.prepare_part(&id)) {
            Ok(x) => x,
            Err(ev) => {
                self.dispatch(&id, ev);
                return;
            }
        };

        let (folder, typed_host) = self
            .update(&id, |r, _| (PathBuf::from(&r.folder), host_of(&r.url)))
            .unwrap_or_default();
        // One stall window for the whole transfer, across reconnects (contract 17.w).
        let mut clock = StallClock::new(Instant::now());
        loop {
            if self.state_of(&id) != Some(State::Downloading) {
                return;
            }
            let Some((builder, picker, ranged, total, validator)) = self.build_get(&id, &client, held) else {
                return;
            };
            let resp = match send_following(&client, builder, &picker).await {
                Ok(r) => r,
                Err(e) => {
                    if let Some(r) = refusal(&e, &typed_host) {
                        self.dispatch(&id, refusal_event(r));
                        return;
                    }
                    if !self.transient(&id, None).await {
                        return;
                    }
                    continue;
                }
            };
            let status = resp.status().as_u16();
            let headers = read_headers(resp.headers());
            match judge_get(status, &headers, held, total, validator.as_deref(), ranged) {
                Reply::Body { offset, total: learned } => {
                    if offset == 0 {
                        held = 0;
                    }
                    self.update(&id, |rec, _| {
                        if learned.is_some() && rec.size != learned {
                            rec.size = learned;
                        }
                    });
                    let size = learned.or(total);
                    if let Some(sz) = size {
                        // The size is known now: stop before allocating more than the storage can hold.
                        let free = tokio::task::block_in_place(|| free_space(&folder));
                        if !fits(Some(sz), offset, free) {
                            self.dispatch(&id, Event::Enospc);
                            return;
                        }
                        // Pre-allocate once for a fresh file.
                        let alloc = tokio::task::block_in_place(|| {
                            if file.metadata().map(|m| m.len()).unwrap_or(0) != sz && offset == 0 {
                                file.set_len(sz)
                            } else {
                                Ok(())
                            }
                        });
                        if let Err(e) = alloc {
                            let ev = io_event(&e, 0);
                            if !matches!(ev, Event::Transient { .. }) {
                                self.dispatch(&id, ev);
                                return;
                            }
                        }
                    }
                    match self.stream_body(&id, resp, &file, offset, size, &mut clock).await {
                        Streamed::Stopped => return,
                        Streamed::Done(pos) => {
                            let complete = size.map(|s| pos >= s).unwrap_or(true);
                            if complete {
                                self.update(&id, |rec, _| {
                                    rec.size = Some(size.unwrap_or(pos));
                                    rec.held = pos;
                                });
                                self.finish(&id, &file);
                                return;
                            }
                            // The server closed early: treat it as a broken connection.
                            held = self.resume_point(&id, pos);
                            if !self.after_break(&id, &mut clock).await {
                                return;
                            }
                        }
                        Streamed::Broken(pos) => {
                            held = self.resume_point(&id, pos);
                            if !self.after_break(&id, &mut clock).await {
                                return;
                            }
                        }
                        Streamed::Stalled(pos) => {
                            held = self.resume_point(&id, pos);
                            if !self.stall_retry(&id, Some(&mut clock)).await {
                                return;
                            }
                        }
                    }
                }
                Reply::Event(ev) => {
                    let (state, effects) = self.dispatch(&id, ev);
                    if ev == Event::NotAFile {
                        // A page is never saved: drop the part file.
                        self.update(&id, |rec, _| delete_partial(rec));
                    }
                    if effects.contains(&Effect::TruncatePart) {
                        // The server sent the whole file again: write it from the start.
                        held = 0;
                        let size = self.update(&id, |rec, _| {
                            rec.held = 0;
                            rec.size
                        });
                        let _ = tokio::task::block_in_place(|| {
                            file.set_len(0)?;
                            if let Some(Some(sz)) = size {
                                file.set_len(sz)?;
                            }
                            Ok::<(), io::Error>(())
                        });
                        continue;
                    }
                    if state == State::Verifying {
                        self.finish(&id, &file);
                    }
                    return;
                }
                Reply::Retry { retry_after } => {
                    if !self.transient(&id, retry_after).await {
                        return;
                    }
                }
                Reply::Denied { status } => {
                    let n = self.update(&id, |r, l| {
                        r.status = Some(status);
                        l.denied += 1;
                        l.denied
                    });
                    if status == 401 || n.unwrap_or(3) >= 3 {
                        self.dispatch(&id, Event::Auth);
                        return;
                    }
                    if !self.transient(&id, None).await {
                        return;
                    }
                }
            }
        }
    }

    /// One failed attempt: ask the machine, wait the backoff, and say whether to go on.
    async fn transient(self: &Arc<Self>, id: &str, retry_after: Option<Duration>) -> bool {
        // Nothing moves until the next request answers: no speed on the card (contract 17.v).
        self.update(id, |_, l| l.bps = 0);
        // While the phone is offline a failed request is expected: wait, and do not use up the retries.
        // The governance pass pauses the download with the reason `offline` and stops this task.
        if self.is_offline() {
            tokio::time::sleep(Duration::from_secs(2)).await;
            return self.state_of(id) == Some(State::Downloading);
        }
        let n = self
            .update(id, |_, l| {
                let n = l.attempts;
                l.attempts += 1;
                n
            })
            .unwrap_or(MAX_ATTEMPTS);
        let (state, effects) = self.dispatch(id, Event::Transient { attempts: n });
        if state != State::Downloading {
            return false;
        }
        if effects.contains(&Effect::Backoff) {
            // "Waiting for the server" until the next byte clears it.
            self.update(id, |_, l| l.stalled = true);
            tokio::time::sleep(backoff_delay(n, retry_after, jitter())).await;
        }
        self.state_of(id) == Some(State::Downloading)
    }

    /// Where to ask the server to continue after a broken connection.
    fn resume_point(&self, id: &str, pos: u64) -> u64 {
        self.update(id, |rec, _| {
            let at = if rec.resumable && rec.validator.is_some() { pos } else { 0 };
            rec.held = at;
            at
        })
        .unwrap_or(0)
    }

    /// Creates the folder, decides whether the part file can be continued and opens it.
    /// `Err` carries the event to feed the machine.
    fn prepare_part(self: &Arc<Self>, id: &str) -> Result<(File, u64), Event> {
        let (folder, name, total, validator, resumable, url) = self
            .update(id, |r, _| {
                (PathBuf::from(&r.folder), r.name.clone(), r.size, r.validator.clone(), r.resumable, r.url.clone())
            })
            .ok_or(Event::Transient { attempts: MAX_ATTEMPTS })?;
        std::fs::create_dir_all(&folder).map_err(|e| io_event(&e, 0))?;
        let part = part_path(&folder, &name);
        let side_path = sidecar_path(&folder, &name);
        let side = Sidecar::load(&side_path);
        let part_len = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        let side_held = side.as_ref().map(|s| s.resume_offset()).unwrap_or(0);
        let usable = resumable
            && validator.is_some()
            && side_held > 0
            && part_len >= side_held
            && side.as_ref().map(|s| s.validator == validator && s.total == total).unwrap_or(false);
        let had_data = part_len > 0 || side_held > 0;
        let held = if usable { side_held } else { 0 };
        if !usable && had_data && !resumable {
            self.update(id, |r, _| r.notice = Some(NO_RESUME_NOTICE.to_string()));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&part)
            .map_err(|e| io_event(&e, 0))?;
        if held == 0 {
            file.set_len(0).map_err(|e| io_event(&e, 0))?;
            if let Some(t) = total {
                // Never allocate more than the storage can hold, with the reserve left over.
                if !fits(Some(t), 0, free_space(&folder)) {
                    return Err(Event::Enospc);
                }
                file.set_len(t).map_err(|e| io_event(&e, 0))?;
            }
        }
        if resumable && validator.is_some() {
            let mut sc = Sidecar::new(&url, &name, total, validator);
            sc.set_single_pos(held);
            // Skipped when the download was removed meanwhile (see `flush_side`).
            let guard = self.inner.lock();
            if guard.records.contains_key(id) {
                let _ = sc.save(&side_path);
            }
            drop(guard);
        }
        self.update(id, |r, _| r.held = held);
        Ok((file, held))
    }

    /// The GET for the next attempt, with Range and If-Range when bytes are held.
    fn build_get(
        &self,
        id: &str,
        client: &Client,
        held: u64,
    ) -> Option<(reqwest::RequestBuilder, CookiePicker, bool, Option<u64>, Option<String>)> {
        self.update(id, |rec, live| {
            let hdrs = LinkHeaders::from_live(live);
            let mut b = hdrs.apply(client.get(rec.url.as_str()).header(ACCEPT_ENCODING, "identity"), rec.url.as_str());
            if let Some((u, p)) = &live.auth {
                b = b.basic_auth(u, Some(p));
            }
            let mut ranged = false;
            if held > 0 {
                if let Some(v) = rec.validator.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                    b = b.header(RANGE, format!("bytes={held}-")).header(IF_RANGE, v);
                    ranged = true;
                }
            }
            (b, hdrs.picker(rec.url.as_str()), ranged, rec.size, rec.validator.clone())
        })
    }

    /// Writes the body at `offset`. Reports progress every 250 ms, flushes the sidecar every 2 s, honours the
    /// global and per-download limits. Errors are fed to the machine here.
    async fn stream_body(
        self: &Arc<Self>,
        id: &str,
        mut resp: reqwest::Response,
        file: &File,
        offset: u64,
        total: Option<u64>,
        clock: &mut StallClock,
    ) -> Streamed {
        // `wb.received()` is what came off the wire (speed, limits, overrun). `wb.written()` is what is on disk, and
        // it is the only position that is ever persisted or returned: the sidecar, `rec.held` and every `Streamed`
        // value use it, so a resume point can never be ahead of the part file.
        let mut wb = WriteBuf::new(offset);
        let mut write = |b: &[u8], off: u64| tokio::task::block_in_place(|| write_all_at(file, b, off));
        let started = Instant::now();
        let mut last_report = Instant::now();
        let mut last_flush = Instant::now();
        let mut report_pos = wb.received();
        let mut bps_smooth: f64 = 0.0;
        let mut limit = self.update(id, |r, _| r.down_limit_bps).unwrap_or(0);
        let (name, folder, url, validator, resumable) = match self.update(id, |r, _| {
            (r.name.clone(), PathBuf::from(&r.folder), r.final_url.clone().unwrap_or_else(|| r.url.clone()), r.validator.clone(), r.resumable)
        }) {
            Some(x) => x,
            None => return Streamed::Stopped,
        };
        let mut side = Sidecar::new(&url, &name, total, validator);
        let side_path = sidecar_path(&folder, &name);
        let mut last_space = Instant::now();
        // The stall rule (contract 17.y, 17.w): the client's read timeout alone lets a server that sends one byte
        // every 40 s hold a slot forever, so the clock is read here too. `clock` lives across reconnects.
        loop {
            // SPEED_QUIET, not STALL_TICK: a body that goes quiet must stop showing its last speed (contract 17.v).
            let chunk = match tokio::time::timeout(SPEED_QUIET, resp.chunk()).await {
                Ok(Ok(Some(c))) => {
                    clock.on_bytes(Instant::now(), c.len() as u64);
                    c
                }
                Ok(Ok(None)) => {
                    // The end of the body: everything held is written before the caller verifies or renames.
                    return match wb.flush(&mut write) {
                        Ok(()) => Streamed::Done(wb.written()),
                        Err(e) => self.write_failed(id, &e, &mut side, &side_path, file, wb.written(), resumable),
                    };
                }
                Ok(Err(_)) => {
                    // Broken: keep what already arrived if the disk takes it; a failure here only costs a re-download.
                    let _ = wb.flush(&mut write);
                    let pos = wb.written();
                    self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                    return Streamed::Broken(pos);
                }
                Err(_) => {
                    // Nothing arrived for a few seconds: no speed to show, and the average starts over. Held bytes
                    // are written now so a quiet link does not sit on them (and pause/cancel see them on disk).
                    if let Err(e) = wb.flush(&mut write) {
                        return self.write_failed(id, &e, &mut side, &side_path, file, wb.written(), resumable);
                    }
                    let pos = wb.written();
                    bps_smooth = 0.0;
                    self.update(id, |_, l| l.bps = 0);
                    if self.stall_step(id, limit, clock) {
                        self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                        self.update(id, |rec, _| rec.held = pos);
                        return Streamed::Stalled(pos);
                    }
                    if self.state_of(id) != Some(State::Downloading) {
                        return Streamed::Stopped;
                    }
                    continue;
                }
            };
            // The global limit is the session's limiter, shared with torrents. A limit below one chunk
            // is served in pieces no larger than the limit itself (the burst can't be below the request).
            if let (Some(session), Some(bps)) = (self.session.as_ref(), self.global_down_bps()) {
                let step_max = bps.get().min(16 * 1024) as usize;
                let waiting_since = Instant::now();
                let mut left = chunk.len();
                while left > 0 {
                    let n = left.min(step_max.max(1));
                    if let Some(nz) = NonZeroU32::new(n as u32) {
                        let _ = session.ratelimits.prepare_for_download(nz).await;
                    }
                    left -= n;
                }
                // Our own limiter's queue is not the server's stall.
                clock.excuse(waiting_since.elapsed(), Instant::now());
            }
            // More bytes than the probe promised: the file changed. Nothing is finished from this.
            if overruns(wb.received(), chunk.len() as u64, total) {
                // The held bytes are from the file that changed: they are dropped, not written.
                self.flush_side(id, &mut side, &side_path, file, wb.written(), resumable);
                self.dispatch(id, Event::ValidatorChanged);
                return Streamed::Stopped;
            }
            if let Err(e) = wb.push(&chunk, Instant::now(), &mut write) {
                return self.write_failed(id, &e, &mut side, &side_path, file, wb.written(), resumable);
            }
            if self.stall_step(id, limit, clock) {
                if let Err(e) = wb.flush(&mut write) {
                    return self.write_failed(id, &e, &mut side, &side_path, file, wb.written(), resumable);
                }
                let pos = wb.written();
                self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                self.update(id, |rec, _| rec.held = pos);
                return Streamed::Stalled(pos);
            }

            // Unknown size: stop with Storage full when the free space drops below the reserve.
            if total.is_none() && last_space.elapsed() >= SIDECAR_FLUSH {
                last_space = Instant::now();
                let free = tokio::task::block_in_place(|| free_space(&folder));
                if !fits(None, 0, free) {
                    // Storage is full: try to keep the held bytes, but a failed write only loses them.
                    let _ = wb.flush(&mut write);
                    let pos = wb.written();
                    self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                    self.update(id, |rec, _| rec.held = pos);
                    self.dispatch(id, Event::Enospc);
                    return Streamed::Stopped;
                }
            }

            if last_report.elapsed() >= REPORT_EVERY {
                // Written before the count is published, so `rec.held` (which the store may save) is never ahead
                // of the file. A report tick is 250 ms, so this is also the age bound for a slow link's buffer.
                if let Err(e) = wb.flush(&mut write) {
                    return self.write_failed(id, &e, &mut side, &side_path, file, wb.written(), resumable);
                }
                let pos = wb.written();
                let dt = last_report.elapsed().as_secs_f64().max(0.001);
                let inst = (pos - report_pos) as f64 / dt;
                bps_smooth = if bps_smooth == 0.0 { inst } else { bps_smooth * 0.6 + inst * 0.4 };
                report_pos = pos;
                last_report = Instant::now();
                let alive = self.update(id, |rec, live| {
                    rec.held = pos;
                    live.bps = bps_smooth as u64;
                    live.stalled = false;
                    live.attempts = 0;
                    live.denied = 0;
                    limit = rec.down_limit_bps;
                    rec.state == State::Downloading
                });
                if alive != Some(true) {
                    return Streamed::Stopped;
                }
            }
            if last_flush.elapsed() >= SIDECAR_FLUSH {
                last_flush = Instant::now();
                if let Err(e) = wb.flush(&mut write) {
                    return self.write_failed(id, &e, &mut side, &side_path, file, wb.written(), resumable);
                }
                self.flush_side(id, &mut side, &side_path, file, wb.written(), resumable);
            }
            if limit > 0 {
                let wait = pace_delay(wb.received() - offset, started.elapsed(), limit);
                if !wait.is_zero() {
                    let slept = wait.min(Duration::from_secs(2));
                    tokio::time::sleep(slept).await;
                    clock.excuse(slept, Instant::now());
                }
            }
        }
    }

    /// A write to the part file failed. The sidecar is saved at `written` (never past what is on disk), then the
    /// error goes to the machine: a transient one retries from there, anything else stops the download.
    #[allow(clippy::too_many_arguments)]
    fn write_failed(
        self: &Arc<Self>,
        id: &str,
        e: &io::Error,
        side: &mut Sidecar,
        side_path: &Path,
        file: &File,
        written: u64,
        resumable: bool,
    ) -> Streamed {
        let n = self.update(id, |_, l| l.attempts).unwrap_or(0);
        self.flush_side(id, side, side_path, file, written, resumable);
        let ev = io_event(e, n);
        let (state, _) = self.dispatch(id, ev);
        if matches!(ev, Event::Transient { .. }) && state == State::Downloading {
            Streamed::Broken(written)
        } else {
            Streamed::Stopped
        }
    }

    /// The slowest speed that still counts as moving for this download (a tiny speed limit lowers it).
    fn stall_floor_for(&self, id: &str) -> u64 {
        let per = self.update(id, |r, _| r.down_limit_bps).unwrap_or(0);
        self.floor_for_limit(per)
    }

    fn floor_for_limit(&self, per_download_limit: u64) -> u64 {
        let global = self.global_down_bps().map(|n| n.get() as u64).unwrap_or(0);
        let limit = match (per_download_limit, global) {
            (0, g) => g,
            (l, 0) => l,
            (l, g) => l.min(g),
        };
        stall_floor(limit)
    }

    /// Applies the stall rule once. Keeps the "waiting for the server" flag up to date, starts a new window after a
    /// healthy one (and forgives earlier stalls), and says whether the transfer must be cut.
    fn stall_step(&self, id: &str, per_download_limit: u64, clock: &mut StallClock) -> bool {
        let now = Instant::now();
        match clock.check(now, self.floor_for_limit(per_download_limit)) {
            StallCheck::Stalled => true,
            StallCheck::Healthy => {
                self.update(id, |_, l| l.stalls = 0);
                false
            }
            StallCheck::Fine => {
                if waiting_for_server(clock.quiet(now)) {
                    self.update(id, |_, l| l.stalled = true);
                }
                false
            }
        }
    }

    /// A connection broke or ended early. When the window average is still poor it counts as a stall (budget 5);
    /// otherwise it is an ordinary retry.
    async fn after_break(self: &Arc<Self>, id: &str, clock: &mut StallClock) -> bool {
        if clock.broken_is_stall(Instant::now(), self.stall_floor_for(id)) {
            self.stall_retry(id, None).await
        } else {
            self.transient(id, None).await
        }
    }

    /// One stall: wait the backoff and say whether to go on. Has its own, smaller budget than `transient`.
    /// `restart` is the clock to start afresh after a real stall verdict (a break keeps the window going).
    async fn stall_retry(self: &Arc<Self>, id: &str, restart: Option<&mut StallClock>) -> bool {
        if let Some(c) = restart {
            c.restart(Instant::now());
        }
        self.update(id, |_, l| l.bps = 0);
        // Offline is not the server's fault: wait without using the budget.
        if self.is_offline() {
            return self.transient(id, None).await;
        }
        let n = self
            .update(id, |_, l| {
                let n = l.stalls;
                l.stalls += 1;
                n
            })
            .unwrap_or(MAX_STALL_ATTEMPTS);
        let (state, effects) = self.dispatch(id, Event::Stalled { attempts: n });
        if state != State::Downloading {
            return false;
        }
        if effects.contains(&Effect::Backoff) {
            self.update(id, |_, l| l.stalled = true);
            tokio::time::sleep(backoff_delay(n, None, jitter())).await;
        }
        self.state_of(id) == Some(State::Downloading)
    }

    fn flush_side(&self, id: &str, side: &mut Sidecar, path: &Path, file: &File, pos: u64, resumable: bool) {
        if !resumable {
            return;
        }
        tokio::task::block_in_place(|| {
            let _ = file.sync_data();
            side.set_single_pos(pos);
            let guard = self.inner.lock();
            if guard.records.contains_key(id) {
                let _ = side.save(path);
            }
        });
    }

    /// All bytes are in the part file. There is no checksum to compare (`expected_hash` is refused at add), so
    /// the machine goes `Verifying` to `Finished`, which renames the part file.
    fn finish(self: &Arc<Self>, id: &str, file: &File) {
        let _ = tokio::task::block_in_place(|| file.sync_all());
        if self.state_of(id) == Some(State::Downloading) {
            self.dispatch(id, Event::AllBytes);
        }
        if self.state_of(id) == Some(State::Verifying) {
            self.dispatch(id, Event::HashOk);
        }
    }
}

// ---- probe request ------------------------------------------------------------------------------------------------

/// `GET` with `Range: bytes=0-0`. The body is never read: dropping the response closes the connection.
async fn probe_request(
    client: &Client,
    url: &str,
    auth: Option<&(String, String)>,
    hdrs: &LinkHeaders,
) -> Result<ProbeReply, ProbeFail> {
    let mut b = hdrs.apply(client.get(url).header(ACCEPT_ENCODING, "identity").header(RANGE, "bytes=0-0"), url);
    if let Some((u, p)) = auth {
        b = b.basic_auth(u, Some(p));
    }
    let resp = send_following(client, b, &hdrs.picker(url)).await.map_err(|e| match refusal(&e, &host_of(url)) {
        Some(Refusal::LanAddress) => ProbeFail::LanAddress,
        Some(Refusal::Redirect) => ProbeFail::LocalRedirect,
        None => ProbeFail::Net,
    })?;
    let status = resp.status().as_u16();
    let headers = read_headers(resp.headers());
    let final_url = resp.url().to_string();
    drop(resp);
    match classify_probe(status, &headers, &final_url) {
        ProbeVerdict::Ok(info) => {
            let name = choose_name(headers.content_disposition.as_deref(), &final_url);
            let ranges_ok = segments::parts_probe_ok(&info, &headers);
            Ok(ProbeReply { info, ranges_ok, name, final_url: display_url(&final_url) })
        }
        ProbeVerdict::Auth => Err(ProbeFail::Auth(status)),
        ProbeVerdict::Refused => Err(with_link_login(ProbeFail::Refused(status), auth.is_some())),
        ProbeVerdict::Status(s) => Err(ProbeFail::Status(s)),
        ProbeVerdict::Html => Err(ProbeFail::Html),
    }
}

/// A refused link (403) is a sign-in problem only when the link itself carried a user name and password.
fn with_link_login(f: ProbeFail, link_login: bool) -> ProbeFail {
    match f {
        ProbeFail::Refused(s) if link_login => ProbeFail::Auth(s),
        other => other,
    }
}

/// The headers every request for a direct file carries (the probe and every GET, resumes included), like streams:
/// user agent, referer and origin when given, and the cookie chosen by the request's own host.
#[derive(Debug, Clone, Default)]
struct LinkHeaders {
    user_agent: Option<String>,
    referer: Option<String>,
    origin: Option<String>,
    /// The `Cookie` option: goes to the link's host only.
    cookie: Option<String>,
    /// The in-app browser jar: one cookie per host, the longest domain match wins.
    host_cookies: Vec<(String, String)>,
}

impl LinkHeaders {
    fn from_options(h: &HeaderOptions) -> Self {
        Self {
            user_agent: h.user_agent.clone(),
            referer: h.referer.clone(),
            origin: h.origin.clone(),
            cookie: h.cookie.clone(),
            host_cookies: h.host_cookies(),
        }
    }

    fn from_live(l: &Live) -> Self {
        Self {
            user_agent: l.user_agent.clone(),
            referer: l.referer.clone(),
            origin: l.origin.clone(),
            cookie: l.cookie.clone(),
            host_cookies: l.host_cookies.clone(),
        }
    }

    /// The cookie for each host a request for `link_url` may be redirected to: the old host's cookie never goes
    /// along, each hop gets the one picked for its own host (`redirect::send_following`).
    fn picker(&self, link_url: &str) -> CookiePicker {
        CookiePicker::for_link(link_url, self.cookie.as_deref(), &self.host_cookies)
    }

    /// The cookie for a request to `url` (the link itself).
    fn cookie_for_url(&self, url: &str) -> Option<&str> {
        let host = host_lower(url);
        pick_cookie(&self.host_cookies, self.cookie.as_deref(), &host, &host)
    }

    fn apply(&self, mut b: reqwest::RequestBuilder, url: &str) -> reqwest::RequestBuilder {
        if let Some(ua) = self.user_agent.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
            b = b.header(USER_AGENT, ua);
        }
        if let Some(r) = self.referer.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
            b = b.header(REFERER, r);
        }
        if let Some(o) = self.origin.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
            b = b.header(ORIGIN, o);
        }
        if let Some(c) = self.cookie_for_url(url).and_then(|v| HeaderValue::from_str(v).ok()) {
            b = b.header(COOKIE, c);
        }
        b
    }
}

fn probe_error(f: ProbeFail) -> EngineError {
    match f {
        ProbeFail::Net => EngineError::new(
            ErrorCode::Network,
            "Couldn't reach that link. Check your connection and the address.",
        ),
        ProbeFail::Auth(s) => {
            let mut e = EngineError::new(ErrorCode::AuthRequired, "This link needs a sign in, or it has expired.");
            e.http_status = Some(s);
            e
        }
        ProbeFail::Refused(s) => {
            let mut e = EngineError::new(ErrorCode::LinkRefused, REFUSED_PROBE_COPY);
            e.http_status = Some(s);
            e
        }
        ProbeFail::Status(s) => EngineError::http_status(
            s,
            if s == 404 || s == 410 {
                "The file isn't there (404).".to_string()
            } else {
                format!("The server returned an error ({s}).")
            },
        ),
        ProbeFail::Html => EngineError::new(ErrorCode::NotAFile, "This link opens a web page, not a file."),
        ProbeFail::LocalRedirect => EngineError::new(ErrorCode::LocalRedirect, LOCAL_REDIRECT_COPY),
        ProbeFail::LanAddress => EngineError::new(ErrorCode::LanAddress, LAN_ADDRESS_COPY),
        ProbeFail::Stream(e) => EngineError::new(e.code(), e.message()),
    }
}

// ---- files --------------------------------------------------------------------------------------------------------

/// Renames the part file to its final name (a free one if that is taken) and removes the sidecar.
fn finish_files(rec: &mut DlRecord) -> Result<(), String> {
    let folder = PathBuf::from(&rec.folder);
    if rec.mux_needed {
        // Kotlin joined the parts into `<name>` already. The parts and the record go; the file stays.
        let len = std::fs::metadata(final_path(&folder, &rec.name)).map_err(|e| e.to_string())?.len();
        remove_stream_parts(&folder, &rec.name);
        let _ = std::fs::remove_file(sidecar_path(&folder, &rec.name));
        rec.mux_needed = false;
        rec.size = Some(len);
        rec.held = len;
        return Ok(());
    }
    let part = part_path(&folder, &rec.name);
    let wanted = rec.name.clone();
    let name = unique_name(&wanted, |n| final_path(&folder, n).exists());
    std::fs::rename(&part, final_path(&folder, &name)).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(sidecar_path(&folder, &wanted));
    // A stream's size was an estimate until now.
    if rec.stream.is_some() {
        if let Ok(m) = std::fs::metadata(final_path(&folder, &name)) {
            rec.size = Some(m.len());
        }
    }
    rec.name = name;
    rec.held = rec.size.unwrap_or(rec.held);
    Ok(())
}

/// The video and audio parts and the temporary join output of a stream download (contract 24.8).
fn remove_stream_parts(folder: &Path, name: &str) {
    for suffix in [".video.part", ".audio.part", ".mux.tmp"] {
        let _ = std::fs::remove_file(folder.join(format!("{name}{suffix}")));
    }
}

/// Removes the part file and the sidecar (a restart after `FILE_CHANGED`).
fn delete_partial(rec: &DlRecord) {
    if rec.name.is_empty() {
        return;
    }
    let folder = PathBuf::from(&rec.folder);
    let _ = std::fs::remove_file(part_path(&folder, &rec.name));
    let _ = std::fs::remove_file(sidecar_path(&folder, &rec.name));
    remove_stream_parts(&folder, &rec.name);
}

/// `Remove`: the sidecar always goes. The part file (or, for a finished download, the file) goes when asked.
fn delete_files(rec: &DlRecord, delete: bool, was_finished: bool) {
    if rec.name.is_empty() {
        return;
    }
    let folder = PathBuf::from(&rec.folder);
    let _ = std::fs::remove_file(sidecar_path(&folder, &rec.name));
    if delete && !was_finished {
        remove_stream_parts(&folder, &rec.name);
    }
    if delete {
        if was_finished {
            let _ = std::fs::remove_file(final_path(&folder, &rec.name));
        } else {
            let _ = std::fs::remove_file(part_path(&folder, &rec.name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(size: Option<u64>, validator: Option<&str>) -> ProbeInfo {
        ProbeInfo { size, validator: validator.map(str::to_string), resumable: true, probe_was_206: true }
    }

    #[test]
    fn display_url_drops_credentials_query_and_fragment() {
        assert_eq!(
            display_url("https://user:secret@files.example.com:8443/a/b%20c.zip?token=abc#frag"),
            "https://files.example.com:8443/a/b%20c.zip"
        );
        assert_eq!(display_url("not a url"), "");
    }

    #[test]
    fn credentials_are_split_from_the_stored_link() {
        let (u, auth) = parse_http_url("https://me:p%40ss@x.test/f.bin#top").unwrap();
        assert_eq!(u.as_str(), "https://x.test/f.bin");
        assert_eq!(auth, Some(("me".to_string(), "p@ss".to_string())));
        let (u, auth) = parse_http_url("http://x.test/f.bin?a=1").unwrap();
        assert_eq!(u.as_str(), "http://x.test/f.bin?a=1");
        assert_eq!(auth, None);
    }

    #[test]
    fn other_schemes_are_rejected_as_invalid_source() {
        for bad in ["ftp://x.test/a", "magnet:?xt=urn:btih:abc", "file:///etc/passwd", "javascript:alert(1)", "nope", ""] {
            let e = parse_http_url(bad).unwrap_err();
            assert_eq!(e.code, ErrorCode::InvalidSource, "{bad}");
        }
    }

    #[test]
    fn governance_tags_map_to_pause_reasons() {
        assert_eq!(reason_for_tag("wifi_only"), PauseReason::Network);
        assert_eq!(reason_for_tag("vpn_required"), PauseReason::Network);
        assert_eq!(reason_for_tag("battery"), PauseReason::Battery);
        assert_eq!(reason_for_tag("charging_only"), PauseReason::Battery);
        assert_eq!(reason_for_tag("schedule"), PauseReason::Schedule);
        assert_eq!(reason_for_tag("storage_full"), PauseReason::Storage);
        assert_eq!(reason_for_tag("offline"), PauseReason::Offline);
    }

    fn tags(t: &[&str]) -> Vec<String> {
        t.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn offline_pauses_working_and_waiting_downloads_with_its_own_reason() {
        let b = tags(&["offline"]);
        for st in [State::Downloading, State::Queued, State::Resolving] {
            assert_eq!(
                gov_event(st, &b),
                Some((Event::GovBlock(PauseReason::Offline), "offline".to_string())),
                "{st:?}"
            );
        }
        assert_eq!(gov_event(State::Finished, &b), None);
        assert_eq!(gov_event(State::Paused(PauseReason::User), &b), None);
        assert_eq!(gov_event(State::Downloading, &tags(&[])), None);
    }

    #[test]
    fn every_tag_now_pauses_a_queued_or_probing_download() {
        let b = tags(&["wifi_only"]);
        for st in [State::Downloading, State::Queued, State::Resolving] {
            assert_eq!(
                gov_event(st, &b),
                Some((Event::GovBlock(PauseReason::Network), "wifi_only".to_string())),
                "{st:?}"
            );
        }
    }

    #[test]
    fn the_most_actionable_tag_wins() {
        let top = |t: &[&str]| gov_event(State::Queued, &tags(t)).map(|(_, tag)| tag);
        assert_eq!(top(&["offline", "wifi_only"]).as_deref(), Some("wifi_only"));
        assert_eq!(top(&["wifi_only", "offline"]).as_deref(), Some("wifi_only"));
        assert_eq!(top(&["schedule", "battery"]).as_deref(), Some("battery"));
        assert_eq!(top(&["offline", "schedule"]).as_deref(), Some("schedule"));
        assert_eq!(top(&["battery", "wifi_only"]).as_deref(), Some("wifi_only"));
        assert_eq!(top(&["wifi_only", "storage_full"]).as_deref(), Some("storage_full"));
        assert_eq!(top(&["storage_full", "storage_unavailable", "offline"]).as_deref(), Some("storage_unavailable"));
        assert_eq!(top(&[]), None);
    }

    #[test]
    fn a_storage_pause_keeps_its_real_tag() {
        assert_eq!(storage_pause_tag(Some("storage_unavailable"), None), "storage_unavailable");
        assert_eq!(storage_pause_tag(Some("storage_full"), Some("storage_unavailable")), "storage_full");
        assert_eq!(storage_pause_tag(None, Some("storage_unavailable")), "storage_unavailable");
        assert_eq!(storage_pause_tag(None, None), "storage_full");
        assert_eq!(storage_pause_tag(Some("wifi_only"), Some("offline")), "storage_full");
    }

    #[test]
    fn wifi_and_vpn_tags_block_the_network_but_offline_does_not() {
        assert!(blocks_network(&tags(&["wifi_only"])));
        assert!(blocks_network(&tags(&["offline", "vpn_required"])));
        assert!(!blocks_network(&tags(&["offline"])));
        assert!(!blocks_network(&tags(&["battery", "schedule", "storage_full"])));
        assert!(!blocks_network(&tags(&[])));
    }

    #[test]
    fn the_redirect_refusal_is_found_in_an_error_chain() {
        let inner = io::Error::new(io::ErrorKind::Other, LOCAL_REDIRECT_MSG);
        assert!(chain_contains(&inner, LOCAL_REDIRECT_MSG));
        let other = io::Error::new(io::ErrorKind::Other, "timed out");
        assert!(!chain_contains(&other, LOCAL_REDIRECT_MSG));
    }

    #[cfg(unix)]
    #[test]
    fn free_space_reads_the_nearest_existing_folder() {
        let d = std::env::temp_dir();
        assert!(free_space(&d).is_some());
        assert!(free_space(&d.join("maglev-not-created-yet").join("sub")).is_some());
    }

    #[test]
    fn state_names_match_the_snapshot_contract() {
        assert_eq!(state_name(State::Resolving), "resolving");
        assert_eq!(state_name(State::Paused(PauseReason::User)), "paused");
        assert_eq!(state_name(State::NeedsLink), "needs_link");
        assert_eq!(state_name(State::Error(DlError::Network)), "error");
        assert_eq!(state_name(State::Finished), "finished");
    }

    #[test]
    fn a_new_link_must_match_size_and_validator() {
        assert!(link_matches(Some(100), Some("\"a\""), &info(Some(100), Some("\"a\""))));
        assert!(!link_matches(Some(100), Some("\"a\""), &info(Some(101), Some("\"a\""))));
        assert!(!link_matches(Some(100), Some("\"a\""), &info(Some(100), Some("\"b\""))));
        // The stored validator cannot be proven by the new link.
        assert!(!link_matches(Some(100), Some("\"a\""), &info(Some(100), None)));
        // Nothing stored to compare.
        assert!(link_matches(None, None, &info(Some(100), Some("\"a\""))));
        assert!(!link_matches(Some(100), None, &info(None, None)));
    }

    #[test]
    fn options_accept_the_contract_shape() {
        let o = parse_options(
            r#"{"name":"a.zip","folder":"/x","paused":true,"segments":4,
                "headers":{"Cookie":"a=b","Referer":"https://r.test","User-Agent":"UA"},"down_limit_bps":1000}"#,
        )
        .unwrap();
        assert_eq!(o.name.as_deref(), Some("a.zip"));
        assert!(o.paused);
        assert_eq!(o.segments, Some(4));
        let h = o.headers.unwrap();
        assert_eq!(h.cookie.as_deref(), Some("a=b"));
        assert_eq!(h.user_agent.as_deref(), Some("UA"));
        assert_eq!(o.down_limit_bps, Some(1000));
        assert!(parse_options("").unwrap().name.is_none());
        assert!(parse_options("null").is_ok());
    }

    #[test]
    fn options_reject_bad_segments_and_unsupported_hash() {
        assert_eq!(parse_options(r#"{"segments":0}"#).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(parse_options(r#"{"segments":9}"#).unwrap_err().code, ErrorCode::InvalidArgument);
        assert_eq!(
            parse_options(r#"{"expected_hash":{"alg":"sha256","hex":"ab"}}"#).unwrap_err().code,
            ErrorCode::Unsupported
        );
        assert_eq!(parse_options("{bad").unwrap_err().code, ErrorCode::InvalidArgument);
    }

    #[test]
    fn io_errors_map_to_events() {
        assert_eq!(io_event(&io::Error::from_raw_os_error(28), 3), Event::Enospc);
        assert_eq!(io_event(&io::Error::from_raw_os_error(13), 3), Event::Eacces);
        assert_eq!(io_event(&io::Error::new(io::ErrorKind::PermissionDenied, "x"), 3), Event::Eacces);
        assert_eq!(io_event(&io::Error::new(io::ErrorKind::Other, "x"), 3), Event::Transient { attempts: 3 });
        // Read-only storage and a full quota.
        assert_eq!(io_event(&io::Error::from_raw_os_error(30), 0), Event::Eacces);
        assert_eq!(io_event(&io::Error::from_raw_os_error(122), 0), Event::Enospc);
    }

    #[test]
    fn storage_faults_do_not_become_network_errors() {
        // ENOENT, EIO, ENXIO, ENODEV, ENOTDIR, ESTALE: the folder or the card is gone.
        for code in [2, 5, 6, 19, 20, 116] {
            assert_eq!(io_event(&io::Error::from_raw_os_error(code), 4), Event::StorageGone, "{code}");
        }
        assert_eq!(io_event(&io::Error::new(io::ErrorKind::NotFound, "x"), 4), Event::StorageGone);
        // EFBIG: FAT32 4 GB limit.
        assert_eq!(io_event(&io::Error::from_raw_os_error(27), 4), Event::FileTooLarge);
    }

    #[test]
    fn new_error_copy_is_plain_english() {
        assert_eq!(
            error_message(DlError::StorageUnavailable, None),
            "The folder isn't available. Is the SD card in?"
        );
        assert_eq!(
            error_message(DlError::FileTooLarge, None),
            "This file is bigger than the card's format allows (4 GB). Use phone storage."
        );
        assert_eq!(
            error_message(DlError::LocalRedirect, None),
            "A redirect tried to send Maglev to a device on your network, so it stopped."
        );
        assert_eq!(error_message(DlError::LanAddress, None), "This address points to a device on your network.");
    }

    #[test]
    fn finishing_renames_to_a_free_name_and_drops_the_sidecar() {
        let d = std::env::temp_dir().join(format!("maglev-dl-finish-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.bin.part"), b"12345").unwrap();
        std::fs::write(d.join("a.bin.maglev-dl.json"), b"{}").unwrap();
        std::fs::write(d.join("a.bin"), b"other").unwrap();
        let mut rec = DlRecord {
            name: "a.bin".into(),
            folder: d.to_string_lossy().into_owned(),
            size: Some(5),
            ..DlRecord::default()
        };
        finish_files(&mut rec).unwrap();
        assert_eq!(rec.name, "a (1).bin");
        assert_eq!(std::fs::read(d.join("a (1).bin")).unwrap(), b"12345");
        assert_eq!(std::fs::read(d.join("a.bin")).unwrap(), b"other");
        assert!(!d.join("a.bin.part").exists());
        assert!(!d.join("a.bin.maglev-dl.json").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn remove_keeps_or_deletes_the_files() {
        let d = std::env::temp_dir().join(format!("maglev-dl-remove-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let rec = DlRecord { name: "a.bin".into(), folder: d.to_string_lossy().into_owned(), ..DlRecord::default() };
        std::fs::write(d.join("a.bin.part"), b"1").unwrap();
        std::fs::write(d.join("a.bin.maglev-dl.json"), b"{}").unwrap();
        delete_files(&rec, false, false);
        assert!(d.join("a.bin.part").exists());
        assert!(!d.join("a.bin.maglev-dl.json").exists());
        delete_files(&rec, true, false);
        assert!(!d.join("a.bin.part").exists());
        std::fs::write(d.join("a.bin"), b"done").unwrap();
        delete_files(&rec, false, true);
        assert!(d.join("a.bin").exists());
        delete_files(&rec, true, true);
        assert!(!d.join("a.bin").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn error_copy_is_plain_english() {
        assert_eq!(error_message(DlError::NotAFile, None), "This link opens a web page, not a file.");
        assert_eq!(error_message(DlError::FileChanged, None), "The file changed on the server.");
        assert_eq!(error_message(DlError::HttpStatus, Some(404)), "The file isn't there anymore (404).");
        assert_eq!(error_message(DlError::HttpStatus, Some(500)), "The server returned an error (500).");
    }

    // ---- second hardening round ----

    fn rec_json(id: &str, url: &str) -> serde_json::Value {
        serde_json::to_value(DlRecord { id: id.into(), url: url.into(), ..DlRecord::default() }).unwrap()
    }

    #[test]
    fn one_bad_saved_entry_keeps_the_good_ones() {
        let file = json!({
            "version": 1,
            "downloads": [
                rec_json("dl_a", "https://x.test/a.bin"),
                { "id": "dl_bad", "state": "NotAState", "url": "https://secret.example/?token=1" },
                { "id": "dl_worse", "size": "huge" },
                rec_json("dl_b", "https://x.test/b.bin"),
                { "url": "https://x.test/noid.bin" },
            ],
        });
        let p = parse_store(file.to_string().as_bytes());
        assert!(!p.unreadable);
        assert_eq!(p.records.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["dl_a", "dl_b"]);
        assert_eq!(p.skipped, 3);
    }

    #[test]
    fn a_clean_saved_list_skips_nothing_and_old_files_still_load() {
        // An entry written before `needs_login` and `stalled` existed.
        let old = r#"{"version":1,"downloads":[{"id":"dl_old","url":"https://x.test/a.bin","state":"Queued","held":5}]}"#;
        let p = parse_store(old.as_bytes());
        assert!(!p.unreadable);
        assert_eq!(p.skipped, 0);
        assert_eq!(p.records.len(), 1);
        assert_eq!(p.records[0].held, 5);
        assert!(!p.records[0].needs_login);
    }

    #[test]
    fn a_broken_file_is_unreadable_not_empty() {
        for bad in ["", "{", "not json", "[]", r#"{"version":1}"#, r#"{"downloads":3}"#] {
            let p = parse_store(bad.as_bytes());
            assert!(p.unreadable, "{bad}");
            assert!(p.records.is_empty());
        }
    }

    #[test]
    fn the_backup_name_carries_the_time() {
        assert_eq!(corrupt_backup_name(1700000000), "maglev-downloads.corrupt-1700000000.json");
    }

    #[test]
    fn saved_copies_never_hold_a_signed_query_or_the_final_query() {
        let rec = DlRecord {
            id: "dl_a".into(),
            url: "https://cdn.test/f.zip?X-Amz-Signature=abc&id=1".into(),
            final_url: Some("https://edge.test/f.zip?token=zzz".into()),
            ..DlRecord::default()
        };
        let p = persisted(&rec);
        assert_eq!(p.url, "https://cdn.test/f.zip");
        assert_eq!(p.final_url.as_deref(), Some("https://edge.test/f.zip"));
        assert!(p.needs_login);
        let text = serde_json::to_string(&p).unwrap();
        assert!(!text.contains("abc") && !text.contains("zzz"));
        // The copy in memory keeps what it needs to go on.
        assert!(rec.url.contains("X-Amz-Signature"));
    }

    #[test]
    fn a_plain_query_is_saved_as_it_is() {
        let rec = DlRecord {
            id: "dl_a".into(),
            url: "https://x.test/get?file=a.zip".into(),
            final_url: Some("https://x.test/get?file=a.zip".into()),
            ..DlRecord::default()
        };
        let p = persisted(&rec);
        assert_eq!(p.url, "https://x.test/get?file=a.zip");
        assert!(!p.needs_login);
        assert_eq!(p.final_url.as_deref(), Some("https://x.test/get"));
    }

    #[test]
    fn a_clean_page_url_is_saved_as_it_is() {
        let rec = DlRecord {
            id: "dl_a".into(),
            page_url: Some("https://site.test/watch?v=42&t=10#c".into()),
            ..DlRecord::default()
        };
        assert_eq!(persisted(&rec).page_url.as_deref(), Some("https://site.test/watch?v=42&t=10#c"));
        assert_eq!(persisted(&DlRecord::default()).page_url, None);
    }

    #[test]
    fn a_secret_looking_page_query_is_cut_off_before_saving() {
        for u in [
            "https://site.test/watch?v=42&token=abc",
            "https://site.test/watch?X-Amz-Signature=abc",
            "https://site.test/watch?session=abc#x",
            "https://user:pw@site.test/watch?v=42",
        ] {
            let rec = DlRecord { id: "dl_a".into(), page_url: Some(u.into()), ..DlRecord::default() };
            let p = persisted(&rec);
            let text = serde_json::to_string(&p).unwrap();
            assert_eq!(p.page_url.as_deref().map(|s| s.starts_with("https://site.test/watch")), Some(true), "{u}");
            assert!(!text.contains("abc") && !text.contains("pw@") && !text.contains("v=42"), "{u}: {text}");
            // The copy in memory keeps the whole page address.
            assert_eq!(rec.page_url.as_deref(), Some(u));
        }
        assert_eq!(persisted_page_url(""), None);
        assert_eq!(persisted_page_url("   "), None);
    }

    #[test]
    fn the_page_url_option_is_taken_when_it_is_a_web_page_and_ignored_otherwise() {
        let o = parse_options(r#"{"page_url":"https://site.test/p?x=1"}"#).unwrap();
        assert_eq!(clean_page_url(o.page_url.as_deref()).as_deref(), Some("https://site.test/p?x=1"));
        assert_eq!(clean_page_url(Some("  https://site.test/p  ")).as_deref(), Some("https://site.test/p"));
        assert_eq!(clean_page_url(Some("")), None);
        assert_eq!(clean_page_url(Some("file:///etc/passwd")), None);
        assert_eq!(clean_page_url(Some("javascript:alert(1)")), None);
        assert_eq!(clean_page_url(None), None);
        assert_eq!(parse_options("{}").unwrap().page_url, None);
    }

    #[test]
    fn the_page_url_survives_the_store_and_shows_in_the_download_json() {
        let rec = DlRecord { id: "dl_a".into(), page_url: Some("https://site.test/p".into()), ..DlRecord::default() };
        let file = json!({ "version": 1, "downloads": [serde_json::to_value(persisted(&rec)).unwrap()] });
        let back = parse_store(file.to_string().as_bytes());
        assert_eq!(back.records[0].page_url.as_deref(), Some("https://site.test/p"));
        // A record saved before the field existed loads with none.
        let old = parse_store(json!({ "downloads": [ { "id": "dl_old" } ] }).to_string().as_bytes());
        assert_eq!(old.records[0].page_url, None);
    }

    #[tokio::test]
    async fn the_download_json_carries_the_page_url() {
        let dir = std::env::temp_dir().join(format!("maglev-dl-pageurl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = Downloads::build(tokio::runtime::Handle::current(), None, &dir, &dir, None, Vec::new());
        // Paused, so nothing reaches the network.
        d.add("http://127.0.0.1:9/a.bin", r#"{"paused":true,"page_url":"https://site.test/p?token=zz"}"#).unwrap();
        let snap = d.snapshots();
        assert_eq!(snap[0]["page_url"], "https://site.test/p?token=zz");
        // The saved list never holds the secret query.
        let saved = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap_or_default();
        assert!(!saved.contains("token=zz"), "{saved}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lost_login_asks_to_sign_in_again() {
        let e = needs_link_info(None, true, false);
        assert_eq!(e.code, "AUTH_REQUIRED");
        assert_eq!(e.message, "Sign in again: paste the link again.");
        assert_eq!(needs_link_info(Some(401), false, false).code, "AUTH_REQUIRED");
        let gone = needs_link_info(Some(410), true, false);
        assert_eq!(gone.code, "LINK_EXPIRED");
        assert_eq!(gone.http_status, Some(410));
        assert_eq!(needs_link_info(None, false, false).code, "LINK_EXPIRED");
    }

    #[test]
    fn a_403_is_a_refused_link_unless_the_link_carried_a_login() {
        // No sign-in details: the site refused the link.
        let e = needs_link_info(Some(403), false, false);
        assert_eq!(e.code, "LINK_REFUSED");
        assert_eq!(e.message, "The site refused this link. Open its page again, then retry.");
        assert_eq!(e.http_status, Some(403));
        // Browser cookies set `needs_login` but never `link_login`: still a refused link.
        assert_eq!(needs_link_info(Some(403), true, false).code, "LINK_REFUSED");
        // A user name and password in the link: a sign in.
        assert_eq!(needs_link_info(Some(403), true, true).code, "AUTH_REQUIRED");
        assert_eq!(needs_link_info(Some(401), false, false).code, "AUTH_REQUIRED");
    }

    #[test]
    fn the_stalled_error_has_plain_copy() {
        assert_eq!(error_message(DlError::Stalled, None), "The server stopped sending data. Try again later.");
    }

    #[tokio::test]
    async fn a_lookup_that_leads_to_the_home_network_is_refused() {
        // An IP literal resolves to itself: stands in for a public name that answers a private address.
        let public = LanScope::Public;
        let e = guarded_lookup("127.0.0.1".to_string(), &public).await.unwrap_err();
        assert!(e.to_string().contains(LOCAL_REDIRECT_MSG));
        assert!(e.to_string().contains("(host: 127.0.0.1)"));
        let e = guarded_lookup("192.168.1.1".to_string(), &public).await.unwrap_err();
        assert!(e.to_string().contains(LOCAL_REDIRECT_MSG));
        assert!(!guarded_lookup("8.8.8.8".to_string(), &public).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_local_origin_may_resolve_locally_and_an_allowed_host_only_to_its_pinned_addresses() {
        let a = guarded_lookup("127.0.0.1".to_string(), &LanScope::LanOrigin).await.unwrap();
        assert_eq!(a.len(), 1);
        assert!(a[0].ip().is_loopback());
        let allow = LanScope::Allow { host: "127.0.0.1".into(), pinned: vec!["127.0.0.1".parse().unwrap()] };
        assert_eq!(guarded_lookup("127.0.0.1".to_string(), &allow).await.unwrap().len(), 1);
        let other = LanScope::Allow { host: "127.0.0.1".into(), pinned: vec!["10.0.0.1".parse().unwrap()] };
        assert!(guarded_lookup("127.0.0.1".to_string(), &other).await.is_err());
    }

    #[test]
    fn the_typed_host_is_a_lan_address_and_a_redirect_is_a_redirect() {
        let typed = std::io::Error::new(io::ErrorKind::Other, format!("{LOCAL_REDIRECT_MSG} (host: Files.Example.com)"));
        assert_eq!(refusal(&typed, "files.example.com"), Some(Refusal::LanAddress));
        let other = std::io::Error::new(io::ErrorKind::Other, format!("{LOCAL_REDIRECT_MSG} (host: router.lan)"));
        assert_eq!(refusal(&other, "files.example.com"), Some(Refusal::Redirect));
        let policy = std::io::Error::new(io::ErrorKind::Other, LOCAL_REDIRECT_MSG);
        assert_eq!(refusal(&policy, "files.example.com"), Some(Refusal::Redirect));
        let unrelated = std::io::Error::new(io::ErrorKind::Other, "timed out");
        assert_eq!(refusal(&unrelated, "files.example.com"), None);
        assert_eq!(refusal_event(Refusal::LanAddress), Event::LanAddress);
        assert_eq!(refusal_event(Refusal::Redirect), Event::LocalRedirect);
    }

    #[test]
    fn a_pasted_signed_link_matches_the_download_that_lost_its_query() {
        let rec = DlRecord {
            id: "dl_a".into(),
            url: "https://cdn.discordapp.com/attachments/1/2/f.zip".into(),
            folder: "/d".into(),
            state: State::NeedsLink,
            needs_login: true,
            ..DlRecord::default()
        };
        let typed = "https://cdn.discordapp.com/attachments/1/2/f.zip?ex=1&is=2&hm=3";
        assert!(same_link(&rec, typed, "/d"));
        assert!(!same_link(&rec, typed, "/other"));
        assert!(!same_link(&rec, "https://cdn.discordapp.com/attachments/9/9/g.zip?hm=3", "/d"));
        // Only while it waits for a link, and only when it was saved stripped.
        let queued = DlRecord { state: State::Queued, ..rec.clone() };
        assert!(!same_link(&queued, typed, "/d"));
        let plain = DlRecord { needs_login: false, ..rec.clone() };
        assert!(!same_link(&plain, typed, "/d"));
        // The exact same link is the same link in any live state.
        assert!(same_link(&queued, "https://cdn.discordapp.com/attachments/1/2/f.zip", "/d"));
        let done = DlRecord { state: State::Finished, ..rec };
        assert!(!same_link(&done, typed, "/d"));
    }

    #[test]
    fn the_refusal_text_survives_an_error_chain() {
        let inner: Box<dyn std::error::Error + Send + Sync> = LOCAL_REDIRECT_MSG.into();
        #[derive(Debug)]
        struct Wrap(Box<dyn std::error::Error + Send + Sync>);
        impl std::fmt::Display for Wrap {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "dns error")
            }
        }
        impl std::error::Error for Wrap {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&*self.0)
            }
        }
        assert!(chain_contains(&Wrap(inner), LOCAL_REDIRECT_MSG));
    }

    // ---- the manager itself (no session: `Downloads::build(.., None, ..)`) ----

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-dl-drv-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap()
    }

    fn manager(rt: &tokio::runtime::Runtime, dir: &Path, blocked: &[&str]) -> Arc<Downloads> {
        Downloads::build(rt.handle().clone(), None, dir, dir, None, tags(blocked))
    }

    fn put(d: &Arc<Downloads>, id: &str, state: State, f: impl FnOnce(&mut DlRecord)) {
        let mut rec = DlRecord {
            id: id.into(),
            url: "https://x.test/a.bin".into(),
            state,
            folder: d.default_dir.to_string_lossy().into_owned(),
            ..DlRecord::default()
        };
        f(&mut rec);
        let mut inner = d.inner.lock();
        inner.live.insert(id.into(), Live::default());
        inner.records.insert(id.into(), rec);
    }

    fn tag_of(d: &Arc<Downloads>, id: &str) -> Option<String> {
        d.inner.lock().records.get(id).and_then(|r| r.paused_tag.clone())
    }

    #[test]
    fn a_cleared_reason_with_another_still_blocking_ends_paused_not_queued() {
        let (rt, dir) = (rt(), tmp("stack"));
        let d = manager(&rt, &dir, &["offline", "wifi_only"]);
        put(&d, "dl_a", State::Paused(PauseReason::Offline), |r| r.paused_tag = Some("offline".into()));
        put(&d, "dl_q", State::Queued, |_| {});
        // Offline clears, Wi-Fi-only stays: the download must say so, not wait in the queue.
        d.set_blocked(&tags(&["wifi_only"]));
        assert_eq!(d.state_of("dl_a"), Some(State::Paused(PauseReason::Network)));
        assert_eq!(tag_of(&d, "dl_a").as_deref(), Some("wifi_only"));
        assert_eq!(d.state_of("dl_q"), Some(State::Paused(PauseReason::Network)));
        // Both at once: the Wi-Fi reason is the one the user can act on.
        d.set_blocked(&tags(&["offline", "wifi_only"]));
        assert_eq!(tag_of(&d, "dl_a").as_deref(), Some("wifi_only"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn network_changed_restarts_working_downloads_without_a_pause_or_an_attempt() {
        let (rt, dir) = (rt(), tmp("netchange"));
        let d = manager(&rt, &dir, &[]);
        put(&d, "dl_a", State::Downloading, |_| {});
        put(&d, "dl_p", State::Resolving, |_| {});
        put(&d, "dl_u", State::Paused(PauseReason::User), |r| r.paused_tag = Some("user".into()));
        d.inner.lock().live.get_mut("dl_a").unwrap().attempts = 2;
        // Keep the one worker busy so the restarted tasks cannot run (and fail) before the checks.
        rt.spawn(async { std::thread::sleep(Duration::from_millis(400)) });
        std::thread::sleep(Duration::from_millis(100));
        d.network_changed();
        assert_eq!(d.state_of("dl_a"), Some(State::Downloading));
        assert_eq!(d.state_of("dl_p"), Some(State::Resolving));
        assert_eq!(d.state_of("dl_u"), Some(State::Paused(PauseReason::User)));
        assert_eq!(tag_of(&d, "dl_a"), None);
        let inner = d.inner.lock();
        assert_eq!(inner.live["dl_a"].attempts, 2);
        assert!(inner.live["dl_a"].task.is_some());
        assert!(inner.live["dl_p"].task.is_some());
        assert!(inner.live["dl_u"].task.is_none());
        drop(inner);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resume_while_blocked_pauses_again_for_the_block() {
        let (rt, dir) = (rt(), tmp("resume"));
        let d = manager(&rt, &dir, &["wifi_only"]);
        put(&d, "dl_a", State::Paused(PauseReason::User), |r| r.paused_tag = Some("user".into()));
        d.resume("dl_a").unwrap();
        assert_eq!(d.state_of("dl_a"), Some(State::Paused(PauseReason::Network)));
        assert_eq!(tag_of(&d, "dl_a").as_deref(), Some("wifi_only"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pause_all_holds_a_probing_download_and_a_governance_paused_one() {
        let (rt, dir) = (rt(), tmp("pauseall"));
        let d = manager(&rt, &dir, &["wifi_only"]);
        put(&d, "dl_probe", State::Resolving, |r| r.start_paused = true);
        put(&d, "dl_gov", State::Paused(PauseReason::Network), |r| r.paused_tag = Some("wifi_only".into()));
        d.pause("dl_probe").unwrap();
        d.pause("dl_gov").unwrap();
        for id in ["dl_probe", "dl_gov"] {
            assert_eq!(d.state_of(id), Some(State::Paused(PauseReason::User)), "{id}");
            assert_eq!(tag_of(&d, id).as_deref(), Some("user"));
        }
        // The block clears: the user pause stays.
        d.set_blocked(&[]);
        assert_eq!(d.state_of("dl_gov"), Some(State::Paused(PauseReason::User)));
        assert_eq!(d.state_of("dl_probe"), Some(State::Paused(PauseReason::User)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_carries_the_download_limit_and_it_survives_a_restart() {
        let (rt, dir) = (rt(), tmp("limit_snap"));
        let d = manager(&rt, &dir, &[]);
        put(&d, "dl_a", State::Paused(PauseReason::User), |r| r.paused_tag = Some("user".into()));
        put(&d, "dl_b", State::Paused(PauseReason::User), |r| {
            r.paused_tag = Some("user".into());
            r.added_at = 1;
        });
        // No limit is 0, never a made-up value.
        assert_eq!(d.snapshots()[0]["down_limit_bps"], 0);
        d.set_limits("dl_b", r#"{"down_limit_bps":250000}"#).unwrap();
        let snap = d.snapshots();
        let b = snap.iter().find(|s| s["id"] == "dl_b").unwrap();
        assert_eq!(b["down_limit_bps"], 250_000);
        let a = snap.iter().find(|s| s["id"] == "dl_a").unwrap();
        assert_eq!(a["down_limit_bps"], 0);
        // A new manager on the same folder reads the saved list.
        drop(d);
        let d2 = manager(&rt, &dir, &[]);
        let snap = d2.snapshots();
        let b = snap.iter().find(|s| s["id"] == "dl_b").unwrap();
        assert_eq!(b["down_limit_bps"], 250_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_pauses_with_the_storage_unavailable_tag() {
        let (rt, dir) = (rt(), tmp("storage"));
        let d = manager(&rt, &dir, &["storage_unavailable"]);
        put(&d, "dl_a", State::Queued, |_| {});
        d.govern();
        assert_eq!(d.state_of("dl_a"), Some(State::Paused(PauseReason::Storage)));
        assert_eq!(tag_of(&d, "dl_a").as_deref(), Some("storage_unavailable"));
        let snap = d.snapshots();
        assert_eq!(snap[0]["paused_by"], "storage_unavailable");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_brings_back_a_start_paused_download_paused() {
        let (rt, dir) = (rt(), tmp("restore"));
        let mk = |id: &str, state: State, start_paused: bool| DlRecord {
            id: id.into(),
            url: format!("https://x.test/{id}.bin"),
            state,
            start_paused,
            folder: dir.to_string_lossy().into_owned(),
            ..DlRecord::default()
        };
        let file = StoreFile {
            version: 1,
            downloads: vec![
                mk("dl_sp", State::Resolving, true),
                mk("dl_q", State::Queued, false),
                mk("dl_dl", State::Downloading, false),
            ],
        };
        std::fs::write(dir.join(STORE_FILE), serde_json::to_vec(&file).unwrap()).unwrap();
        let d = manager(&rt, &dir, &["wifi_only"]);
        assert_eq!(d.state_of("dl_sp"), Some(State::Paused(PauseReason::User)));
        assert_eq!(tag_of(&d, "dl_sp").as_deref(), Some("user"));
        assert_eq!(d.state_of("dl_q"), Some(State::Queued));
        assert_eq!(d.state_of("dl_dl"), Some(State::Queued));
        // The flag is spent: the next save no longer carries it.
        let saved = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap();
        assert!(saved.contains("\"start_paused\":false"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_keeps_good_entries_and_a_copy_of_a_damaged_file() {
        let (rt, dir) = (rt(), tmp("damaged"));
        let good = serde_json::to_value(DlRecord { id: "dl_ok".into(), state: State::Queued, ..DlRecord::default() }).unwrap();
        let file = json!({ "version": 1, "downloads": [ good, { "id": "dl_bad", "state": "Nope" } ] });
        std::fs::write(dir.join(STORE_FILE), file.to_string()).unwrap();
        let d = manager(&rt, &dir, &["wifi_only"]);
        assert_eq!(d.state_of("dl_ok"), Some(State::Queued));
        assert_eq!(d.state_of("dl_bad"), None);
        let copies: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("maglev-downloads.corrupt-"))
            .collect();
        assert_eq!(copies.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_sends_a_download_that_needs_a_login_to_needs_link() {
        let (rt, dir) = (rt(), tmp("login"));
        let rec = DlRecord { id: "dl_a".into(), state: State::Downloading, needs_login: true, ..DlRecord::default() };
        std::fs::write(
            dir.join(STORE_FILE),
            serde_json::to_vec(&StoreFile { version: 1, downloads: vec![rec] }).unwrap(),
        )
        .unwrap();
        let d = manager(&rt, &dir, &[]);
        assert_eq!(d.state_of("dl_a"), Some(State::NeedsLink));
        let snap = d.snapshots();
        assert_eq!(snap[0]["error"]["code"], "AUTH_REQUIRED");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_late_flush_cannot_bring_back_a_removed_sidecar() {
        let dir = tmp("flush");
        let d = Downloads::build(tokio::runtime::Handle::current(), None, &dir, &dir, None, tags(&["wifi_only"]));
        put(&d, "dl_a", State::Paused(PauseReason::User), |r| r.name = "a.bin".into());
        let file = File::create(dir.join("a.bin.part")).unwrap();
        let side_path = sidecar_path(&dir, "a.bin");
        let mut sc = Sidecar::new("https://x.test/a.bin", "a.bin", Some(10), Some("\"e\"".into()));
        // Present: written.
        d.flush_side("dl_a", &mut sc, &side_path, &file, 5, true);
        assert!(side_path.exists());
        // Removed (the sidecar goes with it), then a late flush: nothing comes back.
        d.remove("dl_a", false).unwrap();
        assert!(!side_path.exists());
        d.flush_side("dl_a", &mut sc, &side_path, &file, 7, true);
        assert!(!side_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_download_pauses_for_the_top_tag_not_the_first() {
        let (rt, dir) = (rt(), tmp("addtop"));
        let d = manager(&rt, &dir, &["offline", "wifi_only"]);
        let added = d.add("https://x.test/a.bin", "").unwrap();
        assert_eq!(d.state_of(&added.id), Some(State::Paused(PauseReason::Network)));
        assert_eq!(tag_of(&d, &added.id).as_deref(), Some("wifi_only"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn retry_pauses_for_the_top_tag() {
        let (rt, dir) = (rt(), tmp("retrytop"));
        let d = manager(&rt, &dir, &["schedule", "battery"]);
        put(&d, "dl_a", State::Error(DlError::Network), |_| {});
        d.retry("dl_a").unwrap();
        assert_eq!(d.state_of("dl_a"), Some(State::Paused(PauseReason::Battery)));
        assert_eq!(tag_of(&d, "dl_a").as_deref(), Some("battery"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_list_is_backed_up_once() {
        let (rt, dir) = (rt(), tmp("once"));
        std::fs::write(dir.join(STORE_FILE), b"{ not json").unwrap();
        let count = |dir: &Path| {
            std::fs::read_dir(dir)
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("maglev-downloads.corrupt-"))
                .count()
        };
        let _d = manager(&rt, &dir, &["wifi_only"]);
        assert_eq!(count(&dir), 1);
        // Moved, not copied: the damaged file is gone and the next start finds nothing to back up.
        assert!(!dir.join(STORE_FILE).exists());
        let _d2 = manager(&rt, &dir, &["wifi_only"]);
        assert_eq!(count(&dir), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_three_backups_are_kept() {
        let (rt, dir) = (rt(), tmp("prune"));
        for t in [100, 200, 300, 400, 500] {
            std::fs::write(dir.join(corrupt_backup_name(t)), b"x").unwrap();
        }
        std::fs::write(dir.join(STORE_FILE), b"nope").unwrap();
        let _d = manager(&rt, &dir, &["wifi_only"]);
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("maglev-downloads.corrupt-"))
            .collect();
        assert_eq!(left.len(), 3, "{left:?}");
        assert!(!left.contains(&corrupt_backup_name(100)));
        assert!(!left.contains(&corrupt_backup_name(200)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn allowing_a_lan_host_pins_its_addresses_and_needs_the_lan_error() {
        let dir = tmp("allow");
        let d = Downloads::build(tokio::runtime::Handle::current(), None, &dir, &dir, None, tags(&["wifi_only"]));
        put(&d, "dl_a", State::Error(DlError::LanAddress), |r| r.url = "https://localhost/a.bin".into());
        put(&d, "dl_b", State::Queued, |_| {});
        assert_eq!(d.allow_lan_host("dl_b").await.unwrap_err().code, ErrorCode::InvalidState);
        assert_eq!(d.allow_lan_host("dl_zz").await.unwrap_err().code, ErrorCode::NotFound);
        d.allow_lan_host("dl_a").await.unwrap();
        let (allow, pinned) = d.update("dl_a", |r, _| (r.allow_lan, r.lan_pinned.clone())).unwrap();
        assert!(allow);
        assert!(!pinned.is_empty());
        // Saved, and not a secret.
        let saved = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap();
        assert!(saved.contains("\"allow_lan\":true"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod split_sidecar_tests {
    use super::*;
    use super::super::sidecar::Segment;

    fn split() -> Sidecar {
        let mut sc = Sidecar::new("https://example.com/f.bin", "f.bin", Some(400), Some("\"v1\"".into()));
        sc.segments = vec![
            Segment { start: 0, end: 99, pos: 10 },
            Segment { start: 100, end: 199, pos: 200 },
            Segment { start: 200, end: 299, pos: 250 },
            Segment { start: 300, end: 399, pos: 400 },
        ];
        sc
    }

    #[test]
    fn split_sidecar_is_never_overwritten_with_the_sum_of_its_parts() {
        let sc = split();
        assert!(sc.is_split());
        // held after a restart is the sum (10 + 100 + 50 + 100), far past the contiguous prefix (10).
        assert_eq!(sc.held(), 260);
        assert_eq!(single_pos_to_write(Some(&sc), sc.held()), None);
    }

    #[test]
    fn single_or_missing_sidecar_records_held() {
        let mut one = Sidecar::new("https://example.com/f.bin", "f.bin", Some(400), Some("\"v1\"".into()));
        one.set_single_pos(120);
        assert!(!one.is_split());
        assert_eq!(single_pos_to_write(Some(&one), 150), Some(150));
        assert_eq!(single_pos_to_write(None, 150), Some(150));
    }
}

#[cfg(test)]
mod resume_anyway_tests {
    use super::*;

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exempt_download_ignores_rule_tags_only() {
        let b = tags(&["wifi_only", "schedule", "storage_full", "vpn_required"]);
        assert_eq!(effective_blocked(false, &b), b);
        assert_eq!(effective_blocked(true, &b), tags(&["storage_full", "vpn_required"]));
    }

    #[test]
    fn seed_metered_never_reaches_downloads() {
        assert_eq!(download_tags(&tags(&["seed_metered", "battery"])), tags(&["battery"]));
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-dl-timing-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap()
    }

    fn manager(rt: &tokio::runtime::Runtime, dir: &Path, blocked: &[&str]) -> Arc<Downloads> {
        Downloads::build(rt.handle().clone(), None, dir, dir, None, tags(blocked))
    }

    fn put(d: &Arc<Downloads>, id: &str, state: State, f: impl FnOnce(&mut DlRecord)) {
        let mut rec = DlRecord {
            id: id.into(),
            url: "https://x.test/a.bin".into(),
            state,
            folder: d.default_dir.to_string_lossy().into_owned(),
            timing: Timing::new(),
            ..DlRecord::default()
        };
        f(&mut rec);
        let mut inner = d.inner.lock();
        inner.live.insert(id.into(), Live::default());
        inner.records.insert(id.into(), rec);
    }

    fn snap(d: &Arc<Downloads>, id: &str) -> Value {
        d.snapshots().into_iter().find(|s| s["id"] == id).unwrap()
    }

    fn set_held(d: &Arc<Downloads>, id: &str, held: u64) {
        d.update(id, |r, _| r.held = held).unwrap();
    }

    const SEC: Duration = Duration::from_secs(1);

    #[test]
    fn only_a_downloading_download_counts() {
        let (rt, dir) = (rt(), tmp("only"));
        let d = manager(&rt, &dir, &[]);
        put(&d, "dl_d", State::Downloading, |r| r.held = 1000);
        for (id, st) in [
            ("dl_paused", State::Paused(PauseReason::User)),
            ("dl_wifi", State::Paused(PauseReason::Network)),
            ("dl_queued", State::Queued),
            ("dl_resolving", State::Resolving),
            ("dl_verifying", State::Verifying),
            ("dl_error", State::Error(DlError::Network)),
            ("dl_done", State::Finished),
        ] {
            put(&d, id, st, |r| r.held = 1000);
        }
        d.account(SEC, false); // first reading is the baseline
        for id in ["dl_d", "dl_paused", "dl_wifi", "dl_queued", "dl_resolving", "dl_verifying", "dl_error", "dl_done"] {
            set_held(&d, id, 1500);
        }
        d.account(SEC, true);
        let s = snap(&d, "dl_d");
        assert_eq!(s["active_secs"], 2);
        assert_eq!(s["session_bytes"], 500);
        assert_eq!((s["bytes_wifi"].as_u64(), s["bytes_mobile"].as_u64()), (Some(0), Some(500)));
        for id in ["dl_paused", "dl_wifi", "dl_queued", "dl_resolving", "dl_verifying", "dl_error", "dl_done"] {
            let s = snap(&d, id);
            assert_eq!((s["active_secs"].as_i64(), s["session_bytes"].as_u64()), (Some(0), Some(0)), "{id}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wifi_and_mobile_split_follows_the_network_at_the_time() {
        let (rt, dir) = (rt(), tmp("split"));
        let d = manager(&rt, &dir, &[]);
        put(&d, "dl_a", State::Downloading, |r| r.held = 0);
        d.account(SEC, false);
        set_held(&d, "dl_a", 700);
        d.account(SEC, false);
        set_held(&d, "dl_a", 1000);
        d.account(SEC, true);
        let s = snap(&d, "dl_a");
        assert_eq!((s["bytes_wifi"].as_u64(), s["bytes_mobile"].as_u64(), s["session_bytes"].as_u64()), (Some(700), Some(300), Some(1000)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bytes_on_disk_at_a_resume_are_not_counted_and_the_tail_before_a_pause_is() {
        let (rt, dir) = (rt(), tmp("resume"));
        let d = manager(&rt, &dir, &[]);
        put(&d, "dl_a", State::Downloading, |r| r.held = 5000);
        d.update("dl_a", |_, l| l.acct = Some(5000)).unwrap();
        set_held(&d, "dl_a", 5400);
        // The user pauses before the next one-second pass: the 400 bytes still count.
        d.dispatch("dl_a", Event::UserPause);
        assert_eq!(d.state_of("dl_a"), Some(State::Paused(PauseReason::User)));
        assert_eq!(snap(&d, "dl_a")["session_bytes"], 400);
        // Paused: nothing counts, the baseline follows the file.
        set_held(&d, "dl_a", 9000);
        d.account(SEC, false);
        assert_eq!(snap(&d, "dl_a")["session_bytes"], 400);
        assert_eq!(snap(&d, "dl_a")["active_secs"], 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finished_at_is_set_once_by_the_state_change() {
        let mut rec = DlRecord { state: State::Downloading, timing: Timing::new(), ..DlRecord::default() };
        let mut live = Live::default();
        account_settle(&mut rec, &mut live, 100);
        assert_eq!(rec.timing.finished_at, 0);
        rec.state = State::Finished;
        account_settle(&mut rec, &mut live, 200);
        account_settle(&mut rec, &mut live, 300);
        assert_eq!(rec.timing.finished_at, 200);
    }

    #[test]
    fn a_failed_item_that_the_old_file_never_finished_can_still_finish_after_restore() {
        let (rt, dir) = (rt(), tmp("old"));
        // Records as 0.25 wrote them: no `timing` key at all.
        let mut done = serde_json::to_value(DlRecord { id: "dl_done".into(), state: State::Finished, ..DlRecord::default() }).unwrap();
        let mut open = serde_json::to_value(DlRecord { id: "dl_open".into(), state: State::Queued, ..DlRecord::default() }).unwrap();
        done.as_object_mut().unwrap().remove("timing");
        open.as_object_mut().unwrap().remove("timing");
        std::fs::write(dir.join(STORE_FILE), json!({ "version": 1, "downloads": [done, open] }).to_string()).unwrap();
        let d = manager(&rt, &dir, &[]);
        for id in ["dl_done", "dl_open"] {
            let s = snap(&d, id);
            assert_eq!((s["active_secs"].as_i64(), s["finished_at"].as_i64(), s["session_bytes"].as_u64()), (Some(0), Some(0), Some(0)));
        }
        // The old finished one never gets a made-up time; the old unfinished one stamps when it really finishes.
        d.update("dl_done", |r, l| account_settle(r, l, 500)).unwrap();
        assert_eq!(snap(&d, "dl_done")["finished_at"], 0);
        d.update("dl_open", |r, l| {
            r.state = State::Finished;
            account_settle(r, l, 600)
        })
        .unwrap();
        assert_eq!(snap(&d, "dl_open")["finished_at"], 600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timing_survives_a_restart_and_the_timing_pass_saves_by_itself() {
        let (rt, dir) = (rt(), tmp("persist"));
        let d = manager(&rt, &dir, &[]);
        put(&d, "dl_a", State::Downloading, |r| r.held = 10);
        d.account(SEC, true);
        // A recent save: the pass does not write again.
        assert!(!std::fs::read_to_string(dir.join(STORE_FILE)).unwrap_or_default().contains("dl_a"));
        // Older than the save interval: the pass writes the list, so a kill loses at most that long.
        *d.last_save.lock() = Instant::now().checked_sub(TIMING_SAVE_EVERY + SEC).unwrap_or_else(Instant::now);
        d.account(SEC, true);
        drop(d);
        let d2 = manager(&rt, &dir, &[]);
        assert_eq!(snap(&d2, "dl_a")["active_secs"], 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_changed_retry_resets_the_counters_but_other_retries_keep_them() {
        let (rt, dir) = (rt(), tmp("reset"));
        let d = manager(&rt, &dir, &["battery"]);
        let counted = |r: &mut DlRecord| {
            r.timing.active_ms = 9000;
            r.timing.finished_at = 5;
            r.timing.session_bytes = 100;
            r.timing.bytes_wifi = 100;
        };
        put(&d, "dl_changed", State::Error(DlError::FileChanged), counted);
        put(&d, "dl_net", State::Error(DlError::Network), counted);
        d.retry("dl_changed").unwrap();
        d.retry("dl_net").unwrap();
        let s = snap(&d, "dl_changed");
        assert_eq!((s["active_secs"].as_i64(), s["finished_at"].as_i64(), s["session_bytes"].as_u64(), s["bytes_wifi"].as_u64()), (Some(0), Some(0), Some(0), Some(0)));
        let s = snap(&d, "dl_net");
        assert_eq!((s["active_secs"].as_i64(), s["finished_at"].as_i64(), s["session_bytes"].as_u64()), (Some(9), Some(5), Some(100)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod link_refused_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    fn pairs(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(h, c)| (h.to_string(), c.to_string())).collect()
    }

    fn hdrs() -> LinkHeaders {
        LinkHeaders {
            user_agent: Some("PageUA/1".into()),
            referer: Some("https://page.test/v".into()),
            origin: Some("https://page.test".into()),
            cookie: None,
            host_cookies: pairs(&[("page.test", "p=1"), ("cdn.test", "c=1")]),
        }
    }

    fn sent(h: &LinkHeaders, url: &str) -> reqwest::header::HeaderMap {
        h.apply(reqwest::Client::new().get(url), url).build().unwrap().headers().clone()
    }

    fn val<'a>(m: &'a reqwest::header::HeaderMap, name: &str) -> Option<&'a str> {
        m.get(name).and_then(|v| v.to_str().ok())
    }

    #[test]
    fn a_direct_file_request_carries_user_agent_referer_and_origin() {
        let m = sent(&hdrs(), "https://page.test/a.bin");
        assert_eq!(val(&m, "user-agent"), Some("PageUA/1"));
        assert_eq!(val(&m, "referer"), Some("https://page.test/v"));
        assert_eq!(val(&m, "origin"), Some("https://page.test"));
    }

    #[test]
    fn the_cookie_is_chosen_by_the_requests_own_host() {
        let h = hdrs();
        assert_eq!(val(&sent(&h, "https://page.test/a.bin"), "cookie"), Some("p=1"));
        assert_eq!(val(&sent(&h, "https://cdn.test/a.bin"), "cookie"), Some("c=1"));
        assert_eq!(val(&sent(&h, "https://a.cdn.test/a.bin"), "cookie"), Some("c=1"));
        assert_eq!(val(&sent(&h, "https://other.test/a.bin"), "cookie"), None);
        // A host that only ends in the same letters is not a subdomain.
        assert_eq!(val(&sent(&h, "https://evilcdn.test/a.bin"), "cookie"), None);
    }

    #[test]
    fn the_longest_domain_wins() {
        let mut h = hdrs();
        h.host_cookies = pairs(&[("cdn.test", "wide=1"), ("files.cdn.test", "narrow=1")]);
        assert_eq!(val(&sent(&h, "https://files.cdn.test/a.bin"), "cookie"), Some("narrow=1"));
        assert_eq!(val(&sent(&h, "https://x.cdn.test/a.bin"), "cookie"), Some("wide=1"));
    }

    #[test]
    fn the_cookie_option_goes_to_the_link_host_only() {
        let hc = pairs(&[("cdn.test", "c=1")]);
        // The link's own host gets the `Cookie` option.
        assert_eq!(pick_cookie(&hc, Some("sid=1"), "page.test", "page.test"), Some("sid=1"));
        // After a redirect to another host the old host's cookie is not sent; the new host's own entry is.
        assert_eq!(pick_cookie(&hc, Some("sid=1"), "page.test", "cdn.test"), Some("c=1"));
        assert_eq!(pick_cookie(&hc, Some("sid=1"), "page.test", "other.test"), None);
        assert_eq!(pick_cookie(&hc, Some("sid=1"), "page.test", "evilcdn.test"), None);
        assert_eq!(pick_cookie(&[], Some("sid=1"), "page.test", "cdn.test"), None);
    }

    #[test]
    fn a_probe_403_is_a_refused_link_unless_the_link_has_a_login() {
        let refused = with_link_login(ProbeFail::Refused(403), false);
        assert!(matches!(refused, ProbeFail::Refused(403)));
        let e = probe_error(refused);
        assert_eq!(e.code, ErrorCode::LinkRefused);
        assert_eq!(e.code.as_str(), "LINK_REFUSED");
        assert_eq!(e.http_status, Some(403));
        assert_eq!(
            e.message,
            "The site refused this link. Open the page in Maglev's browser and start the download from there, or paste a fresh link."
        );
        let with_login = with_link_login(ProbeFail::Refused(403), true);
        assert!(matches!(with_login, ProbeFail::Auth(403)));
        assert_eq!(probe_error(with_login).code, ErrorCode::AuthRequired);
        assert_eq!(probe_error(ProbeFail::Auth(401)).code, ErrorCode::AuthRequired);
    }

    // ---- a local server that wants the page's headers ----

    const FILE_LEN: usize = 3000;

    async fn answer(mut sock: TcpStream) -> std::io::Result<()> {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 2048];
        loop {
            let n = sock.read(&mut tmp).await?;
            if n == 0 {
                return Ok(());
            }
            buf.extend_from_slice(&tmp[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let header = |name: &str| {
            text.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
            })
        };
        let ok = header("referer").as_deref() == Some("https://page.test/v")
            && header("origin").as_deref() == Some("https://page.test")
            && header("cookie").as_deref() == Some("sid=abc")
            && header("user-agent").as_deref() == Some("PageUA/1");
        if !ok {
            sock.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
            return sock.shutdown().await;
        }
        let body: Vec<u8> = (0..FILE_LEN).map(|i| (i % 251) as u8).collect();
        let head = if header("range").as_deref() == Some("bytes=0-0") {
            format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Length: 1\r\nContent-Range: bytes 0-0/{FILE_LEN}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n"
            )
        } else {
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {FILE_LEN}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n"
            )
        };
        sock.write_all(head.as_bytes()).await?;
        if head.contains("206") {
            sock.write_all(&body[..1]).await?;
        } else {
            sock.write_all(&body).await?;
        }
        sock.shutdown().await
    }

    async fn serve() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                tokio::spawn(async move {
                    let _ = answer(sock).await;
                });
            }
        });
        port
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-dl-refused-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    async fn wait_state(d: &Arc<Downloads>, state: &str) -> Value {
        let t0 = Instant::now();
        loop {
            let cur = d.snapshots().first().cloned().unwrap_or(Value::Null);
            if cur["state"] == state {
                return cur;
            }
            assert!(t0.elapsed() < Duration::from_secs(30), "timed out in {}: {cur}", cur["state"]);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    const WITH_HEADERS: &str = r#"{"segments":1,"headers":{"User-Agent":"PageUA/1","Referer":"https://page.test/v","Origin":"https://page.test","Cookies":[{"host":"127.0.0.1","cookie":"sid=abc"}]}}"#;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_download_with_the_page_headers_finishes() {
        let dir = tmpdir("ok");
        let port = serve().await;
        let d = Downloads::build(tokio::runtime::Handle::current(), None, &dir, &dir, None, Vec::new());
        d.add(&format!("http://127.0.0.1:{port}/a.bin"), WITH_HEADERS).unwrap();
        wait_state(&d, "finished").await;
        assert_eq!(std::fs::metadata(dir.join("a.bin")).unwrap().len(), FILE_LEN as u64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_same_link_without_the_headers_ends_refused() {
        let dir = tmpdir("refused");
        let port = serve().await;
        let d = Downloads::build(tokio::runtime::Handle::current(), None, &dir, &dir, None, Vec::new());
        d.add(&format!("http://127.0.0.1:{port}/a.bin"), r#"{"segments":1}"#).unwrap();
        let snap = wait_state(&d, "needs_link").await;
        assert_eq!(snap["error"]["code"], "LINK_REFUSED");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn browser_cookies_alone_do_not_make_a_403_a_sign_in() {
        let dir = tmpdir("cookies");
        let port = serve().await;
        let d = Downloads::build(tokio::runtime::Handle::current(), None, &dir, &dir, None, Vec::new());
        // The cookie is wrong and the page headers are missing: refused, and not AUTH_REQUIRED.
        let opts = r#"{"segments":1,"headers":{"Cookies":[{"host":"127.0.0.1","cookie":"sid=wrong"}]}}"#;
        d.add(&format!("http://127.0.0.1:{port}/a.bin"), opts).unwrap();
        let snap = wait_state(&d, "needs_link").await;
        assert_eq!(snap["error"]["code"], "LINK_REFUSED");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
