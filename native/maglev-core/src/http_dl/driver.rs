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
//! previous, follow, error}`, `RequestBuilder::{header, basic_auth, send}`, `Response::{status, headers, url,
//! chunk}`. `chunk()` needs no cargo feature, so only the `rustls` feature that librqbit already turns on is used.

use std::collections::{BTreeMap, HashMap};
use std::fs::{File, OpenOptions};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use librqbit::Session;
use parking_lot::Mutex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT_ENCODING, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE,
    CONTENT_TYPE, COOKIE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE, REFERER, RETRY_AFTER, USER_AGENT,
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
    StallClock,
};
use super::sidecar::{final_path, part_path, safe_url, sidecar_path, Sidecar};
use super::stream::{StreamError, StreamRec, StreamSpec};
use crate::error::{EngineError, ErrorCode};
use crate::meta::write_atomic;

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
const EXPIRED_COPY: &str = "This link has expired. Paste a new one.";
const STALLED_COPY: &str = "The server stopped sending data. Try again later.";
const LOCAL_REDIRECT_COPY: &str = "A redirect tried to send Maglev to a device on your network, so it stopped.";
const LAN_ADDRESS_COPY: &str = "This address points to a device on your network.";

/// HLS and DASH downloads (contract section 24.8): probe, transfer, join and refresh live in this child module.
mod stream_run;

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
    pub start_paused: bool,
    pub status: Option<u16>,
    pub error: Option<DlErrInfo>,
    pub notice: Option<String>,
    /// The link needs something that is never saved: a user name and password, a cookie, or a signed query.
    /// The flag is saved, the secret is not. After a restart the download waits for a new link (`AUTH_REQUIRED`).
    pub needs_login: bool,
    /// The user allowed the typed host to be on the local network (contract 17.w). Not a secret.
    pub allow_lan: bool,
    /// The addresses of that host when it was allowed; its lookups may only return these.
    pub lan_pinned: Vec<String>,
    /// Set for an HLS or DASH download (contract 24.8): ids and counts, nothing secret.
    pub stream: Option<StreamRec>,
    /// All bytes of a stream with separate video and audio parts are in, and the join has not finished yet.
    pub mux_needed: bool,
    /// "Resume anyway" (contract section 25): the exemptable rule tags do not pause this download.
    /// Cleared when it finishes or the user pauses it. Saved, so it survives a restart.
    pub allowed_anyway: bool,
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
            start_paused: false,
            status: None,
            error: None,
            notice: None,
            needs_login: false,
            allow_lan: false,
            lan_pinned: Vec::new(),
            stream: None,
            mux_needed: false,
            allowed_anyway: false,
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
    task: Option<JoinHandle<()>>,
    attempts: u32,
    denied: u32,
    bps: u64,
    /// Stall retries since the last healthy minute. Progress does not reset it (a trickle must not buy more tries).
    stalls: u32,
    /// Active, but no byte for 30 s.
    stalled: bool,
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

/// The error of a download in `NeedsLink`. A 401 or 403, or a restart that lost the secrets (no status), is a
/// sign in; anything else (410, an expired signed link) is an expired link.
fn needs_link_info(status: Option<u16>, needs_login: bool) -> DlErrInfo {
    let auth = matches!(status, Some(401) | Some(403)) || (status.is_none() && needs_login);
    DlErrInfo {
        code: if auth { "AUTH_REQUIRED" } else { "LINK_EXPIRED" }.to_string(),
        message: if auth { AUTH_AGAIN_COPY } else { EXPIRED_COPY }.to_string(),
        http_status: status,
    }
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
    r
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

fn build_client(proxy: Option<&str>, scope: LanScope) -> Result<Client, String> {
    // Contract section 17: at most 10 redirects, and https to http is an error. Credentials headers that reqwest
    // marks sensitive (Cookie, Authorization) are dropped by reqwest itself on a cross-origin redirect.
    let policy_scope = scope.clone();
    let policy = redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        let was_https = attempt.previous().last().map(|u| u.scheme() == "https").unwrap_or(false);
        if was_https && attempt.url().scheme() == "http" {
            return attempt.error("redirect from https to http");
        }
        // A redirect may not lead onto the local network, unless the link the user typed was already there (the
        // scope was chosen from the typed host; it also knows an allowed host).
        if !policy_scope.redirect_allowed(attempt.url().host_str().unwrap_or("")) {
            return attempt.error(LOCAL_REDIRECT_MSG);
        }
        attempt.follow()
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
    Auth(u16),
    Status(u16),
    Html,
    LocalRedirect,
    /// The playlist can't be saved (contract 24.8).
    Stream(StreamError),
}

struct ProbeReply {
    info: ProbeInfo,
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
                    rec.error = Some(needs_link_info(None, true));
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
                rec.error = Some(needs_link_info(rec.status, rec.needs_login));
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
                Effect::FlushSidecar => {
                    if rec.resumable && rec.validator.is_some() && !rec.name.is_empty() {
                        let mut sc = Sidecar::new(
                            rec.final_url.as_deref().unwrap_or(&rec.url),
                            &rec.name,
                            rec.size,
                            rec.validator.clone(),
                        );
                        sc.set_single_pos(rec.held);
                        let _ = sc.save(&sidecar_path(Path::new(&rec.folder), &rec.name));
                    }
                }
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
            // Sign-in details stay in memory. Only the fact that they are needed is saved.
            rec.needs_login = auth.is_some() || h.cookie.is_some() || has_secret_query(&rec.url);
            inner.live.insert(
                id.clone(),
                Live {
                    auth,
                    cookie: h.cookie,
                    referer: h.referer,
                    user_agent: h.user_agent,
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
            self.update(id, |rec, _| {
                delete_partial(rec);
                rec.held = 0;
                rec.validator = None;
                rec.size = None;
                rec.resumable = false;
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
        match probe_request(&client, clean.as_str(), auth.as_ref(), &h.cookie, &h.referer, &h.user_agent).await {
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
        let reply = probe_request(&client, clean.as_str(), auth.as_ref(), &h.cookie, &h.referer, &h.user_agent)
            .await
            .map_err(probe_error)?;
        let matches = link_matches(size, validator.as_deref(), &reply.info);
        if matches {
            self.update(id, |rec, live| {
                rec.url = clean.to_string();
                rec.final_url = Some(reply.final_url.clone());
                rec.status = None;
                rec.needs_login = auth.is_some() || h.cookie.is_some() || has_secret_query(&rec.url);
                rec.allow_lan = opts.allow_lan;
                rec.lan_pinned = pinned;
                live.auth = auth;
                live.cookie = h.cookie;
                live.referer = h.referer;
                live.user_agent = h.user_agent;
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
                    "size": r.size,
                    "downloaded": r.held,
                    "down_bps": bps,
                    "stalled": stalled,
                    "eta": eta,
                    "segments_active": if r.state == State::Downloading { 1 } else { 0 },
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
                    if rec.resumable && rec.validator.is_some() && !rec.name.is_empty() {
                        let mut sc = Sidecar::new(
                            rec.final_url.as_deref().unwrap_or(&rec.url),
                            &rec.name,
                            rec.size,
                            rec.validator.clone(),
                        );
                        sc.set_single_pos(rec.held);
                        let _ = sc.save(&sidecar_path(Path::new(&rec.folder), &rec.name));
                    }
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
            Err(ProbeFail::Auth(s)) => {
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
        let (url, auth, cookie, referer, ua) = self
            .update(id, |r, l| (r.url.clone(), l.auth.clone(), l.cookie.clone(), l.referer.clone(), l.user_agent.clone()))
            .ok_or(ProbeFail::Net)?;
        // An allowed host is pinned once, before its first request.
        if self.pin_lan_host(id).await.is_err() {
            return Err(ProbeFail::Net);
        }
        let client = self.client_for_id(id).map_err(|_| ProbeFail::Net)?;
        let reply = probe_request(&client, &url, auth.as_ref(), &cookie, &referer, &ua).await?;
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
                Err(ProbeFail::Auth(s)) => {
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
            let Some((builder, ranged, total, validator)) = self.build_get(&id, &client, held) else {
                return;
            };
            let resp = match builder.send().await {
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
    ) -> Option<(reqwest::RequestBuilder, bool, Option<u64>, Option<String>)> {
        self.update(id, |rec, live| {
            let mut b = client.get(rec.url.as_str()).header(ACCEPT_ENCODING, "identity");
            if let Some(ua) = live.user_agent.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                b = b.header(USER_AGENT, ua);
            }
            if let Some(c) = live.cookie.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                b = b.header(COOKIE, c);
            }
            if let Some(r) = live.referer.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
                b = b.header(REFERER, r);
            }
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
            (b, ranged, rec.size, rec.validator.clone())
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
        let mut pos = offset;
        let started = Instant::now();
        let mut last_report = Instant::now();
        let mut last_flush = Instant::now();
        let mut report_pos = pos;
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
            let chunk = match tokio::time::timeout(STALL_TICK, resp.chunk()).await {
                Ok(Ok(Some(c))) => {
                    clock.on_bytes(Instant::now(), c.len() as u64);
                    c
                }
                Ok(Ok(None)) => return Streamed::Done(pos),
                Ok(Err(_)) => {
                    self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                    return Streamed::Broken(pos);
                }
                Err(_) => {
                    // Nothing arrived for a few seconds.
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
            if overruns(pos, chunk.len() as u64, total) {
                self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                self.dispatch(id, Event::ValidatorChanged);
                return Streamed::Stopped;
            }
            let write = tokio::task::block_in_place(|| write_all_at(file, &chunk, pos));
            if let Err(e) = write {
                let n = self.update(id, |_, l| l.attempts).unwrap_or(0);
                self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                let ev = io_event(&e, n);
                let (state, _) = self.dispatch(id, ev);
                return if matches!(ev, Event::Transient { .. }) && state == State::Downloading {
                    Streamed::Broken(pos)
                } else {
                    Streamed::Stopped
                };
            }
            pos += chunk.len() as u64;
            if self.stall_step(id, limit, clock) {
                self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                self.update(id, |rec, _| rec.held = pos);
                return Streamed::Stalled(pos);
            }

            // Unknown size: stop with Storage full when the free space drops below the reserve.
            if total.is_none() && last_space.elapsed() >= SIDECAR_FLUSH {
                last_space = Instant::now();
                let free = tokio::task::block_in_place(|| free_space(&folder));
                if !fits(None, 0, free) {
                    self.flush_side(id, &mut side, &side_path, file, pos, resumable);
                    self.update(id, |rec, _| rec.held = pos);
                    self.dispatch(id, Event::Enospc);
                    return Streamed::Stopped;
                }
            }

            if last_report.elapsed() >= REPORT_EVERY {
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
                self.flush_side(id, &mut side, &side_path, file, pos, resumable);
            }
            if limit > 0 {
                let wait = pace_delay(pos - offset, started.elapsed(), limit);
                if !wait.is_zero() {
                    let slept = wait.min(Duration::from_secs(2));
                    tokio::time::sleep(slept).await;
                    clock.excuse(slept, Instant::now());
                }
            }
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
    cookie: &Option<String>,
    referer: &Option<String>,
    user_agent: &Option<String>,
) -> Result<ProbeReply, ProbeFail> {
    let mut b = client.get(url).header(ACCEPT_ENCODING, "identity").header(RANGE, "bytes=0-0");
    if let Some(ua) = user_agent.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
        b = b.header(USER_AGENT, ua);
    }
    if let Some(c) = cookie.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
        b = b.header(COOKIE, c);
    }
    if let Some(r) = referer.as_deref().and_then(|v| HeaderValue::from_str(v).ok()) {
        b = b.header(REFERER, r);
    }
    if let Some((u, p)) = auth {
        b = b.basic_auth(u, Some(p));
    }
    let resp = b.send().await.map_err(|e| match refusal(&e, &host_of(url)) {
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
            Ok(ProbeReply { info, name, final_url: display_url(&final_url) })
        }
        ProbeVerdict::Auth => Err(ProbeFail::Auth(status)),
        ProbeVerdict::Status(s) => Err(ProbeFail::Status(s)),
        ProbeVerdict::Html => Err(ProbeFail::Html),
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
    fn a_lost_login_asks_to_sign_in_again() {
        let e = needs_link_info(None, true);
        assert_eq!(e.code, "AUTH_REQUIRED");
        assert_eq!(e.message, "Sign in again: paste the link again.");
        assert_eq!(needs_link_info(Some(401), false).code, "AUTH_REQUIRED");
        assert_eq!(needs_link_info(Some(403), false).code, "AUTH_REQUIRED");
        let gone = needs_link_info(Some(410), true);
        assert_eq!(gone.code, "LINK_EXPIRED");
        assert_eq!(gone.http_status, Some(410));
        assert_eq!(needs_link_info(None, false).code, "LINK_EXPIRED");
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
