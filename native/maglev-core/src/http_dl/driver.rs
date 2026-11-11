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
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
use super::machine::{step, DlError, Effect, Event, Notice, PauseReason, State, MAX_ATTEMPTS};
use super::rules::{
    backoff_delay, classify_probe, judge_response, pace_delay, Headers, ProbeInfo, ProbeVerdict, Reply,
};
use super::sidecar::{final_path, part_path, sidecar_path, Sidecar};
use crate::error::{EngineError, ErrorCode};
use crate::meta::write_atomic;

/// How many URL downloads transfer at once. Torrents have their own cap.
pub const MAX_ACTIVE_DOWNLOADS: usize = 3;
const STORE_FILE: &str = "maglev-downloads.json";
const SIDECAR_FLUSH: Duration = Duration::from_secs(2);
const REPORT_EVERY: Duration = Duration::from_millis(250);
const USER_AGENT_DEFAULT: &str = "Maglev";
const WHOLE_FILE_NOTICE: &str = "Server sent the whole file again; starting over.";
const NO_RESUME_NOTICE: &str = "This server can't resume. Starting over.";

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
        _ => PauseReason::Network,
    }
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
    }
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

fn io_event(e: &io::Error, attempts: u32) -> Event {
    if is_enospc(e) {
        Event::Enospc
    } else if is_eacces(e) {
        Event::Eacces
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

fn build_client(proxy: Option<&str>) -> Result<Client, String> {
    // Contract section 17: at most 10 redirects, and https to http is an error. Credentials headers that reqwest
    // marks sensitive (Cookie, Authorization) are dropped by reqwest itself on a cross-origin redirect.
    let policy = redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 10 {
            return attempt.error("too many redirects");
        }
        let was_https = attempt.previous().last().map(|u| u.scheme() == "https").unwrap_or(false);
        if was_https && attempt.url().scheme() == "http" {
            return attempt.error("redirect from https to http");
        }
        attempt.follow()
    });
    let mut b = Client::builder()
        .redirect(policy)
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(45))
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
    Auth(u16),
    Status(u16),
    Html,
}

struct ProbeReply {
    info: ProbeInfo,
    name: String,
    final_url: String,
}

enum Streamed {
    Done(u64),
    Broken(u64),
    Stopped,
}

// ---- the manager ------------------------------------------------------------------------------------------------

pub struct Downloads {
    handle: Handle,
    session: Arc<Session>,
    session_dir: PathBuf,
    default_dir: PathBuf,
    inner: Mutex<Inner>,
    blocked: Mutex<Vec<String>>,
    proxy: Mutex<Option<String>>,
    client: Mutex<Option<(Option<String>, Client)>>,
    counter: AtomicU64,
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
        let me = Arc::new(Downloads {
            handle,
            session,
            session_dir: session_dir.to_path_buf(),
            default_dir: default_dir.to_path_buf(),
            inner: Mutex::new(Inner::default()),
            blocked: Mutex::new(blocked),
            proxy: Mutex::new(proxy),
            client: Mutex::new(None),
            counter: AtomicU64::new(1),
        });
        me.restore();
        me
    }

    fn store_path(&self) -> PathBuf {
        self.session_dir.join(STORE_FILE)
    }

    /// Loads the list. Every download that was working goes back in the queue (SM-30 `Restore`).
    fn restore(&self) {
        let bytes = match std::fs::read(self.store_path()) {
            Ok(b) => b,
            Err(_) => return,
        };
        let file: StoreFile = match serde_json::from_slice(&bytes) {
            Ok(f) => f,
            Err(e) => {
                warn!("could not read the downloads list: {e}");
                return;
            }
        };
        let mut inner = self.inner.lock();
        for mut rec in file.downloads {
            if rec.id.is_empty() {
                continue;
            }
            let (next, _) = step(rec.state, Event::Restore);
            rec.state = next;
            // A download that was verifying has all its bytes; the first request answers 416 and finishes it.
            if rec.state == State::Verifying {
                rec.state = State::Queued;
            }
            // What is on disk is the truth for how much we hold.
            if let Some(sc) = Sidecar::load(&sidecar_path(Path::new(&rec.folder), &rec.name)) {
                if rec.state != State::Finished {
                    rec.held = sc.held();
                }
            }
            inner.live.insert(rec.id.clone(), Live::default());
            inner.records.insert(rec.id.clone(), rec);
        }
        drop(inner);
        self.save();
    }

    fn save(&self) {
        let file = StoreFile {
            version: 1,
            downloads: self.inner.lock().records.values().cloned().collect(),
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

    pub fn set_proxy(&self, proxy: Option<String>) {
        *self.proxy.lock() = proxy;
    }

    fn client(&self) -> Result<Client, EngineError> {
        let proxy = self.proxy.lock().clone();
        let mut slot = self.client.lock();
        if let Some((p, c)) = slot.as_ref() {
            if *p == proxy {
                return Ok(c.clone());
            }
        }
        let c = build_client(proxy.as_deref()).map_err(|e| {
            warn!("download client failed: {e}");
            EngineError::new(ErrorCode::Network, "The download client couldn't start. Check the proxy address.")
        })?;
        *slot = Some((proxy, c.clone()));
        Ok(c)
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

    fn gov_allows(&self) -> bool {
        self.blocked.lock().is_empty()
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
            State::Paused(PauseReason::Storage) => rec.paused_tag = Some("storage_full".to_string()),
            State::Paused(_) => {
                if before != next || tag.is_some() {
                    rec.paused_tag = tag.map(str::to_string).or_else(|| rec.paused_tag.clone());
                }
            }
            _ => rec.paused_tag = None,
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
                let auth = matches!(rec.status, Some(401) | Some(403));
                rec.error = Some(DlErrInfo {
                    code: if auth { "AUTH_REQUIRED" } else { "LINK_EXPIRED" }.to_string(),
                    message: "Link expired".to_string(),
                    http_status: rec.status,
                });
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
        let id = {
            let mut inner = self.inner.lock();
            if let Some(existing) = inner
                .records
                .values()
                .find(|r| r.url == url_str && r.folder == folder && !matches!(r.state, State::Finished | State::Gone))
            {
                let mut e = EngineError::duplicate(existing.id.clone());
                e.message = "This link is already in your downloads".to_string();
                return Err(e);
            }
            let id = self.new_id(&inner);
            let (state, _) = step(State::None, Event::Add { url_ok: true });
            let rec = DlRecord {
                id: id.clone(),
                url: url_str,
                state,
                folder,
                requested_name: opts.name.as_deref().map(sanitize_filename),
                added_at: now_secs(),
                down_limit_bps: opts.down_limit_bps.unwrap_or(0),
                segments: opts.segments.unwrap_or(1),
                start_paused: opts.paused,
                ..DlRecord::default()
            };
            let h = opts.headers.clone().unwrap_or_default();
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
        // Persist and Probe are the effects of the `Add` row.
        let me = self.clone();
        let id2 = id.clone();
        let jh = self.handle.spawn(async move { me.run_probe(id2).await });
        self.update(&id, |_, live| live.task = Some(jh));
        Ok(AddedDownload { id })
    }

    pub fn pause(self: &Arc<Self>, id: &str) -> Result<(), EngineError> {
        let s = self.state_of(id).ok_or_else(EngineError::not_found)?;
        if matches!(s, State::Downloading | State::Queued) {
            self.dispatch(id, Event::UserPause);
        }
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
        if e == DlError::FileChanged || e == DlError::ChecksumMismatch {
            self.update(id, |rec, _| {
                delete_partial(rec);
                rec.held = 0;
                rec.validator = None;
                rec.size = None;
                rec.resumable = false;
            });
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
        let h = opts.headers.unwrap_or_default();
        let client = self.client()?;
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
        let h = opts.headers.unwrap_or_default();
        let client = self.client()?;
        let reply = probe_request(&client, clean.as_str(), auth.as_ref(), &h.cookie, &h.referer, &h.user_agent)
            .await
            .map_err(probe_error)?;
        let matches = link_matches(size, validator.as_deref(), &reply.info);
        if matches {
            self.update(id, |rec, live| {
                rec.url = clean.to_string();
                rec.final_url = Some(reply.final_url.clone());
                rec.status = None;
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
                    "size": r.size,
                    "downloaded": r.held,
                    "down_bps": bps,
                    "eta": eta,
                    "segments_active": if r.state == State::Downloading { 1 } else { 0 },
                    "resumable": r.resumable,
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
        *self.blocked.lock() = blocked.to_vec();
        self.govern();
    }

    /// Starts queued downloads when a slot is free.
    pub fn pump(self: &Arc<Self>) {
        self.govern();
    }

    /// One governance pass: block or clear by the engine's reasons, restart dead tasks, fill free slots.
    pub fn govern(self: &Arc<Self>) {
        let blocked = self.blocked.lock().clone();
        let first = blocked.first().cloned();

        // Snapshot the facts, then act without holding the lock.
        struct Fact {
            id: String,
            state: State,
            tag: Option<String>,
            dead: bool,
            added_at: i64,
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
                })
                .collect()
        };

        for f in &facts {
            match f.state {
                State::Downloading => {
                    if f.dead {
                        // The task ended without a state change (a panic). Do not leave the download spinning.
                        self.dispatch(&f.id, Event::Transient { attempts: MAX_ATTEMPTS });
                    } else if let Some(tag) = &first {
                        self.dispatch_tagged(&f.id, Event::GovBlock(reason_for_tag(tag)), Some(tag));
                    }
                }
                State::Paused(r) if r != PauseReason::User && r != PauseReason::Storage => {
                    let still = f.tag.as_ref().map(|t| blocked.contains(t)).unwrap_or(false);
                    if !still {
                        self.dispatch(&f.id, Event::GovClear(r));
                    }
                }
                _ => {}
            }
        }

        // Queued downloads start in `added_at` order while slots are free and nothing blocks.
        if first.is_none() {
            let mut queued: Vec<(i64, String)> = facts
                .iter()
                .filter(|f| matches!(f.state, State::Queued) || self.state_of(&f.id) == Some(State::Queued))
                .map(|f| (f.added_at, f.id.clone()))
                .collect();
            queued.sort();
            queued.dedup();
            for (_, id) in queued {
                let free = Self::active_count(&self.inner.lock()) < MAX_ACTIVE_DOWNLOADS;
                if !free {
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
                let start_paused = self.update(&id, |r, _| r.start_paused).unwrap_or(false);
                let slot_free = Self::active_count(&self.inner.lock()) < MAX_ACTIVE_DOWNLOADS;
                let gov_allows = self.gov_allows();
                let ev = if start_paused {
                    Event::ProbeOk { slot_free: false, gov_allows: true, space_ok: true }
                } else {
                    Event::ProbeOk { slot_free, gov_allows, space_ok: true }
                };
                let (state, _) = self.dispatch(&id, ev);
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
            Err(ProbeFail::Net) => {
                self.dispatch(&id, Event::NetErr);
            }
        }
    }

    /// Probes the record's link and fills in name, size, validator and resume support.
    async fn do_probe(&self, id: &str) -> Result<(), ProbeFail> {
        let (url, auth, cookie, referer, ua) = self
            .update(id, |r, l| (r.url.clone(), l.auth.clone(), l.cookie.clone(), l.referer.clone(), l.user_agent.clone()))
            .ok_or(ProbeFail::Net)?;
        let client = self.client().map_err(|_| ProbeFail::Net)?;
        let reply = probe_request(&client, &url, auth.as_ref(), &cookie, &referer, &ua).await?;
        // Pick a free name once, on the first probe. A resumed download keeps the name its part file has.
        let taken_by_others: Vec<String> = {
            let inner = self.inner.lock();
            inner
                .records
                .values()
                .filter(|r| r.id != id && !r.name.is_empty())
                .map(|r| format!("{}\u{0}{}", r.folder, r.name))
                .collect()
        };
        self.update(id, |rec, _| {
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
        });
        Ok(())
    }

    /// The transfer task of one download: prepare the part file, then request, judge, write, retry.
    async fn transfer(self: Arc<Self>, id: String) {
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
                    self.dispatch(&id, Event::HttpFatal);
                    return;
                }
                Err(ProbeFail::Net) => {
                    if !self.transient(&id, None).await {
                        return;
                    }
                }
            }
        }
        let client = match self.client() {
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

        loop {
            if self.state_of(&id) != Some(State::Downloading) {
                return;
            }
            let Some((builder, ranged, total)) = self.build_get(&id, &client, held) else {
                return;
            };
            let resp = match builder.send().await {
                Ok(r) => r,
                Err(_) => {
                    if !self.transient(&id, None).await {
                        return;
                    }
                    continue;
                }
            };
            let status = resp.status().as_u16();
            let headers = read_headers(resp.headers());
            match judge_response(status, &headers, held, total, ranged) {
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
                        // Pre-allocate once for a fresh file.
                        let _ = tokio::task::block_in_place(|| {
                            if file.metadata().map(|m| m.len()).unwrap_or(0) != sz && offset == 0 {
                                file.set_len(sz)
                            } else {
                                Ok(())
                            }
                        });
                    }
                    match self.stream_body(&id, resp, &file, offset, size).await {
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
                            if !self.transient(&id, None).await {
                                return;
                            }
                        }
                        Streamed::Broken(pos) => {
                            held = self.resume_point(&id, pos);
                            if !self.transient(&id, None).await {
                                return;
                            }
                        }
                    }
                }
                Reply::Event(ev) => {
                    let (state, effects) = self.dispatch(&id, ev);
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
                file.set_len(t).map_err(|e| io_event(&e, 0))?;
            }
        }
        if resumable && validator.is_some() {
            let mut sc = Sidecar::new(&url, &name, total, validator);
            sc.set_single_pos(held);
            let _ = sc.save(&side_path);
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
    ) -> Option<(reqwest::RequestBuilder, bool, Option<u64>)> {
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
            (b, ranged, rec.size)
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
        loop {
            let chunk = match resp.chunk().await {
                Ok(Some(c)) => c,
                Ok(None) => return Streamed::Done(pos),
                Err(_) => {
                    self.flush_side(&mut side, &side_path, file, pos, resumable);
                    return Streamed::Broken(pos);
                }
            };
            // The global limit is the session's limiter, shared with torrents. A limit below one chunk
            // is served in pieces no larger than the limit itself (the burst can't be below the request).
            if let Some(bps) = self.session.ratelimits.get_download_bps() {
                let step_max = bps.get().min(16 * 1024) as usize;
                let mut left = chunk.len();
                while left > 0 {
                    let n = left.min(step_max.max(1));
                    if let Some(nz) = NonZeroU32::new(n as u32) {
                        let _ = self.session.ratelimits.prepare_for_download(nz).await;
                    }
                    left -= n;
                }
            }
            let write = tokio::task::block_in_place(|| write_all_at(file, &chunk, pos));
            if let Err(e) = write {
                let n = self.update(id, |_, l| l.attempts).unwrap_or(0);
                self.flush_side(&mut side, &side_path, file, pos, resumable);
                let ev = io_event(&e, n);
                let (state, _) = self.dispatch(id, ev);
                return if matches!(ev, Event::Transient { .. }) && state == State::Downloading {
                    Streamed::Broken(pos)
                } else {
                    Streamed::Stopped
                };
            }
            pos += chunk.len() as u64;

            if last_report.elapsed() >= REPORT_EVERY {
                let dt = last_report.elapsed().as_secs_f64().max(0.001);
                let inst = (pos - report_pos) as f64 / dt;
                bps_smooth = if bps_smooth == 0.0 { inst } else { bps_smooth * 0.6 + inst * 0.4 };
                report_pos = pos;
                last_report = Instant::now();
                let alive = self.update(id, |rec, live| {
                    rec.held = pos;
                    live.bps = bps_smooth as u64;
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
                self.flush_side(&mut side, &side_path, file, pos, resumable);
            }
            if limit > 0 {
                let wait = pace_delay(pos - offset, started.elapsed(), limit);
                if !wait.is_zero() {
                    tokio::time::sleep(wait.min(Duration::from_secs(2))).await;
                }
            }
        }
    }

    fn flush_side(&self, side: &mut Sidecar, path: &Path, file: &File, pos: u64, resumable: bool) {
        if !resumable {
            return;
        }
        tokio::task::block_in_place(|| {
            let _ = file.sync_data();
            side.set_single_pos(pos);
            let _ = side.save(path);
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
    let resp = b.send().await.map_err(|_| ProbeFail::Net)?;
    let status = resp.status().as_u16();
    let headers = read_headers(resp.headers());
    let final_url = resp.url().to_string();
    drop(resp);
    match classify_probe(status, &headers, &final_url) {
        ProbeVerdict::Ok(info) => {
            let name = choose_name(headers.content_disposition.as_deref(), &final_url);
            Ok(ProbeReply { info, name, final_url: display_url_keep(&final_url) })
        }
        ProbeVerdict::Auth => Err(ProbeFail::Auth(status)),
        ProbeVerdict::Status(s) => Err(ProbeFail::Status(s)),
        ProbeVerdict::Html => Err(ProbeFail::Html),
    }
}

/// The final URL without credentials or fragment, keeping the query (a signed link needs it to resume).
fn display_url_keep(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => split_credentials(u).0.to_string(),
        Err(_) => url.to_string(),
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
    }
}

// ---- files --------------------------------------------------------------------------------------------------------

/// Renames the part file to its final name (a free one if that is taken) and removes the sidecar.
fn finish_files(rec: &mut DlRecord) -> Result<(), String> {
    let folder = PathBuf::from(&rec.folder);
    let part = part_path(&folder, &rec.name);
    let wanted = rec.name.clone();
    let name = unique_name(&wanted, |n| final_path(&folder, n).exists());
    std::fs::rename(&part, final_path(&folder, &name)).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(sidecar_path(&folder, &wanted));
    rec.name = name;
    rec.held = rec.size.unwrap_or(rec.held);
    Ok(())
}

/// Removes the part file and the sidecar (a restart after `FILE_CHANGED`).
fn delete_partial(rec: &DlRecord) {
    if rec.name.is_empty() {
        return;
    }
    let folder = PathBuf::from(&rec.folder);
    let _ = std::fs::remove_file(part_path(&folder, &rec.name));
    let _ = std::fs::remove_file(sidecar_path(&folder, &rec.name));
}

/// `Remove`: the sidecar always goes. The part file (or, for a finished download, the file) goes when asked.
fn delete_files(rec: &DlRecord, delete: bool, was_finished: bool) {
    if rec.name.is_empty() {
        return;
    }
    let folder = PathBuf::from(&rec.folder);
    let _ = std::fs::remove_file(sidecar_path(&folder, &rec.name));
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
}
