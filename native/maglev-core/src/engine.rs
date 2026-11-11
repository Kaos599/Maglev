//! The Maglev engine: one tokio runtime (2 workers) and one librqbit `Session`.
//!
//! Every public method here is blocking and is meant to be called from a Kotlin `Dispatchers.IO` thread.
//! Torrent ids are lower case 40 character hex info hashes. Queue, seed-limit and governance decisions
//! come from the pure planner in `scheduler.rs`; this file only gathers facts and applies actions.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::Ipv4Addr;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use futures::StreamExt;
use librqbit::api::{Api, TorrentIdOrHash};
use librqbit::dht::{DhtPersistenceConfig, Id20};
use librqbit::limits::LimitsConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, ConnectionOptions, DhtSessionConfig,
    ListenerMode, ListenerOptions, ManagedTorrent, Session, SessionOptions,
    SessionPersistenceConfig, TorrentStats, TorrentStatsState,
};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::runtime::{Handle, Runtime};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tracing::warn;

use crate::activity::{ActivitySnapshot, ResolveRegistry};
use crate::config::NativeConfig;
use crate::error::{classify_add_error, classify_runtime_error, EngineError, ErrorCode};
use crate::meta::{MetaStore, PendingAdd, TorrentMeta};
use crate::priority::{
    include_set_changed, order_from_first, parse_priorities, plan_priorities, plan_removal,
    priority_of_file, PriorityPlan, PriorityStore, ReannounceLimiter, REANNOUNCE_MIN_INTERVAL,
};
use crate::scheduler::{
    accumulate_seed_ms, derive_state, plan, uploaded_total, Action, RqState, StateInputs, TorrentFacts, TorrentState,
    PAUSED_BY_SEED_LIMIT, PAUSED_BY_USER,
};
use crate::readiness::{file_readiness, have_piece};
use crate::relocate::{
    check_destination, destination_folder, execute_moves, move_error, plan_moves, probe_writable,
    remove_empty_dirs, rollback, MoveProgress,
};
use crate::simd::{downsample_bitfield, MATRIX_SIZE};
use crate::source::{check_supported, parse_source, Source};
use crate::streaming::{mime_for_extension, StreamServer};
use crate::torrent_limits::{parse_limits, LimitsStore, TorrentLimits};
use crate::types::{
    subfolder_for, AddOptions, Detail, ErrorInfo, FileDetail, FileEntry, Metadata, PeerDetail,
    Snapshot, TrackerDetail,
};

type Handle20 = Arc<ManagedTorrent>;

const OP_TIMEOUT: Duration = Duration::from_secs(20);
const DELETE_TIMEOUT: Duration = Duration::from_secs(90);
const SOFT_SAVE_INTERVAL: Duration = Duration::from_secs(30);
/// Meta entries with no torrent behind them are dropped after this long.
const ORPHAN_GRACE_SECS: i64 = 180;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn nonzero_bps(v: u64) -> Option<NonZeroU32> {
    NonZeroU32::new(v.min(u32::MAX as u64) as u32)
}

/// Download and upload speed in bytes per second since the previous sample `(fetched, uploaded, taken_at)`.
/// `(0, 0)` without a sample or when it is under 200 ms old.
fn rates_since(previous: Option<&(u64, u64, Instant)>, now: Instant, fetched: u64, uploaded: u64) -> (u64, u64) {
    match previous {
        Some((pf, pu, at)) => {
            let dt = now.duration_since(*at).as_secs_f64();
            if dt >= 0.2 {
                (
                    (fetched.saturating_sub(*pf) as f64 / dt) as u64,
                    (uploaded.saturating_sub(*pu) as f64 / dt) as u64,
                )
            } else {
                (0, 0)
            }
        }
        None => (0, 0),
    }
}

/// The host (and port, if any) of a web seed URL, for the peers list. Falls back to the whole string.
fn web_seed_host(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host.is_empty() {
        url.to_string()
    } else {
        host.to_string()
    }
}

/// A stored per-torrent limit as librqbit's config. 0 becomes `None` (no limit).
fn limits_config(l: TorrentLimits) -> LimitsConfig {
    LimitsConfig {
        download_bps: nonzero_bps(l.down_bps),
        upload_bps: nonzero_bps(l.up_bps),
    }
}

/// What the snapshot builder needs to show a torrent while its files are moving.
struct MoveEntry {
    progress: Arc<MoveProgress>,
    name: String,
    total_bytes: u64,
    progress_bytes: u64,
    finished: bool,
    folder: String,
}

/// Everything the move task needs, gathered while the call is still synchronous.
struct MoveJob {
    id: String,
    hash: Id20,
    handle: Handle20,
    torrent_bytes: Bytes,
    only_files: Option<Vec<usize>>,
    old_folder: PathBuf,
    new_folder: PathBuf,
    own_folder: bool,
    rels: Vec<PathBuf>,
    moves: Vec<crate::relocate::FileMove>,
    progress: Arc<MoveProgress>,
}

/// Removes a torrent's "moving" marker when the move task ends, even if it panics.
struct MoveGuard {
    engine: Arc<MaglevEngine>,
    id: String,
}

impl Drop for MoveGuard {
    fn drop(&mut self) {
        self.engine.moves.lock().remove(&self.id);
    }
}

/// librqbit reads blocklists through URLs; a `file://` URL makes it read the local file.
pub fn file_url(path: &str) -> String {
    let mut out = String::from("file://");
    for c in path.chars() {
        match c {
            '%' => out.push_str("%25"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            ' ' => out.push_str("%20"),
            c => out.push(c),
        }
    }
    out
}

fn rq_state(stats: &TorrentStats) -> RqState {
    match stats.state {
        TorrentStatsState::Initializing { paused } => RqState::Initializing { paused },
        TorrentStatsState::Live => RqState::Live,
        TorrentStatsState::Paused => RqState::Paused,
        TorrentStatsState::Error => RqState::Error,
    }
}

fn is_running(rq: RqState) -> bool {
    matches!(
        rq,
        RqState::Live | RqState::Initializing { paused: false }
    )
}

fn default_meta(h: &Handle20, now: i64) -> TorrentMeta {
    TorrentMeta {
        added_at: now,
        // A torrent librqbit restored as paused, with no record of why, is treated as user-paused.
        paused_by: if h.is_paused() {
            Some(PAUSED_BY_USER.to_string())
        } else {
            None
        },
        ..Default::default()
    }
}

struct Resolved {
    info_hash: String,
    name: String,
    file_count: usize,
    total_bytes: u64,
    files: Vec<FileEntry>,
    torrent_bytes: Bytes,
}

#[derive(Serialize)]
pub struct AddResult {
    pub id: String,
    pub info_hash: String,
}

#[derive(Serialize)]
pub struct ApplyConfigResult {
    pub restart_required: bool,
}

#[derive(Serialize)]
pub struct InitResult {
    pub stream_port: u16,
    pub torrents: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_warning: Option<String>,
}

pub struct MaglevEngine {
    runtime: Mutex<Option<Runtime>>,
    handle: Handle,
    session: Arc<Session>,
    api: Api,
    meta: Mutex<MetaStore>,
    config: Mutex<NativeConfig>,
    blocked: Mutex<Vec<String>>,
    tick_lock: tokio::sync::Mutex<()>,
    last_save: Mutex<Instant>,
    stream: StreamServer,
    default_dir: PathBuf,
    peer_cache: Mutex<HashMap<String, (u64, u64, Instant)>>,
    pending_tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    tick_task: Mutex<Option<JoinHandle<()>>>,
    shutting_down: AtomicBool,
    config_warning: Mutex<Option<String>>,
    last_seed_tick: Mutex<Instant>,
    /// "Download first" choices, persisted in `maglev-priorities.json`.
    priorities: Mutex<PriorityStore>,
    reannounce_limiter: Mutex<ReannounceLimiter>,
    /// Per-torrent speed limits, persisted in `maglev-limits.json`.
    limits: Mutex<LimitsStore>,
    /// Torrents whose files are being moved right now (state `MOVING`).
    moves: Mutex<HashMap<String, Arc<MoveEntry>>>,
    /// Magnet resolves in progress: peers seen on the DHT and the cancel signal (section 12.1).
    resolves: Arc<ResolveRegistry>,
}

/// Keeps a registry entry and its peer-counting task alive for one magnet resolve. Dropping it (any
/// outcome, including a panic) aborts the task and removes the entry.
struct ResolveGuard {
    registry: Arc<ResolveRegistry>,
    key: String,
    generation: u64,
    cancel: Arc<tokio::sync::Notify>,
    task: Option<JoinHandle<()>>,
}

impl Drop for ResolveGuard {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
        }
        self.registry.end(&self.key, self.generation);
    }
}

fn build_options(cfg: &NativeConfig, session_dir: &Path) -> SessionOptions {
    let dht = if cfg.enable_dht {
        Some(DhtSessionConfig {
            bootstrap_addrs: None,
            port: None,
            // librqbit's default DHT file location needs a home directory, which Android lacks.
            persistence: Some(DhtPersistenceConfig {
                dump_interval: None,
                config_filename: Some(session_dir.join("dht.json")),
            }),
        })
    } else {
        None
    };

    // A blocklist that cannot be read would make the whole session fail to start; skip it instead.
    let blocklist_url = cfg.ip_filter_path.as_ref().and_then(|p| {
        match std::fs::metadata(p) {
            Ok(m) if m.is_file() && m.len() >= 2 => Some(file_url(p)),
            _ => {
                warn!("ip filter file is missing or empty, ignoring it");
                None
            }
        }
    });

    SessionOptions {
        dht,
        fastresume: true,
        persistence: Some(SessionPersistenceConfig::Json {
            folder: Some(session_dir.to_path_buf()),
        }),
        listen: Some(ListenerOptions {
            mode: ListenerMode::TcpOnly,
            listen_addr: (Ipv4Addr::UNSPECIFIED, cfg.listen_port).into(),
            enable_upnp_port_forwarding: cfg.enable_upnp,
            ipv4_only: true,
            ..Default::default()
        }),
        connect: Some(ConnectionOptions {
            proxy_url: cfg.proxy_url.clone(),
            enable_tcp: true,
            peer_opts: None,
        }),
        ratelimits: LimitsConfig {
            upload_bps: nonzero_bps(cfg.upload_limit_bps),
            download_bps: nonzero_bps(cfg.download_limit_bps),
        },
        peer_limit: if cfg.max_connections_per_torrent > 0 {
            Some(cfg.max_connections_per_torrent as usize)
        } else {
            None
        },
        disable_local_service_discovery: !cfg.enable_lsd,
        ipv4_only: true,
        blocklist_url,
        ..Default::default()
    }
}

impl MaglevEngine {
    pub fn new(
        config_json: &str,
        session_dir: &str,
        default_download_dir: &str,
    ) -> Result<Arc<Self>, EngineError> {
        let session_dir = PathBuf::from(session_dir);
        let default_dir = PathBuf::from(default_download_dir);
        std::fs::create_dir_all(&session_dir).map_err(|_| {
            EngineError::new(
                ErrorCode::EngineUnavailable,
                "Maglev can't use its data folder",
            )
        })?;
        // The default folder may be unavailable (permission not granted yet); torrents carry their own folder.
        let _ = std::fs::create_dir_all(&default_dir);

        let mut meta = MetaStore::load(&session_dir);
        let priorities = PriorityStore::load(&session_dir);
        let limits = LimitsStore::load(&session_dir);
        let trimmed = config_json.trim();
        let mut config_warning: Option<String> = None;
        let cfg = if trimmed.is_empty() || trimmed == "null" {
            meta.data.config.clone().unwrap_or_default()
        } else {
            match NativeConfig::from_json(trimmed) {
                Ok(c) => c,
                Err(e) => {
                    // A bad config must never leave the engine unavailable.
                    config_warning = Some(format!(
                        "{}. Using your last saved settings instead.",
                        e.message.trim_end_matches('.')
                    ));
                    meta.data.config.clone().unwrap_or_default()
                }
            }
        };
        meta.data.config = Some(cfg.clone());
        let blocked = meta.data.blocked.clone();

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("maglev-rt")
            .enable_all()
            .build()
            .map_err(|_| {
                EngineError::new(
                    ErrorCode::EngineUnavailable,
                    "The download engine couldn't start",
                )
            })?;
        let handle = runtime.handle().clone();

        let _ = librqbit::try_increase_nofile_limit();

        let session = runtime
            .block_on(Session::new_with_opts(
                default_dir.clone(),
                build_options(&cfg, &session_dir),
            ))
            .map_err(|e| {
                warn!("session start failed: {e:#}");
                let raw = format!("{e:#}").to_ascii_lowercase();
                if raw.contains("address already in use") {
                    EngineError::new(
                        ErrorCode::EngineUnavailable,
                        "The connection port is already in use. Pick another port in Settings.",
                    )
                } else {
                    EngineError::new(
                        ErrorCode::EngineUnavailable,
                        "The download engine couldn't start",
                    )
                }
            })?;

        let stream = runtime
            .block_on(StreamServer::start(session.clone()))
            .map_err(|_| {
                EngineError::new(
                    ErrorCode::EngineUnavailable,
                    "The video streaming helper couldn't start",
                )
            })?;

        let engine = Arc::new(MaglevEngine {
            runtime: Mutex::new(Some(runtime)),
            handle,
            api: Api::new(session.clone(), None),
            session,
            meta: Mutex::new(meta),
            config: Mutex::new(cfg),
            blocked: Mutex::new(blocked),
            tick_lock: tokio::sync::Mutex::new(()),
            last_save: Mutex::new(Instant::now()),
            stream,
            default_dir,
            peer_cache: Mutex::new(HashMap::new()),
            pending_tasks: Mutex::new(HashMap::new()),
            tick_task: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            config_warning: Mutex::new(config_warning),
            last_seed_tick: Mutex::new(Instant::now()),
            priorities: Mutex::new(priorities),
            reannounce_limiter: Mutex::new(ReannounceLimiter::new(REANNOUNCE_MIN_INTERVAL)),
            limits: Mutex::new(limits),
            moves: Mutex::new(HashMap::new()),
            resolves: Arc::new(ResolveRegistry::new()),
        });

        engine.restore_priorities();
        engine.restore_limits();
        engine.resume_pending_adds();
        engine.start_tick_loop();
        // Apply queue and governance rules once before the first list call.
        let _ = engine.run(OP_TIMEOUT, engine.tick());
        Ok(engine)
    }

    pub fn init_result(&self) -> InitResult {
        InitResult {
            stream_port: self.stream.port,
            config_warning: self.config_warning.lock().clone(),
            torrents: self.handles().len(),
        }
    }

    // ---- plumbing -------------------------------------------------------------------------------

    fn run<T>(&self, limit: Duration, fut: impl Future<Output = T>) -> Result<T, EngineError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(EngineError::not_initialized());
        }
        self.handle
            .block_on(async { tokio::time::timeout(limit, fut).await })
            .map_err(|_| EngineError::internal("That took too long. Try again."))
    }

    fn handles(&self) -> Vec<Handle20> {
        self.session
            .with_torrents(|it| it.map(|(_, h)| h.clone()).collect())
    }

    fn parse_id(id: &str) -> Result<(String, Id20), EngineError> {
        let id = id.trim().to_ascii_lowercase();
        if id.len() != 40 {
            return Err(EngineError::not_found());
        }
        let hash = Id20::from_str(&id).map_err(|_| EngineError::not_found())?;
        Ok((id, hash))
    }

    fn find(&self, hash: Id20) -> Option<Handle20> {
        self.session.get(TorrentIdOrHash::Hash(hash))
    }

    fn save_meta(&self) {
        let mut m = self.meta.lock();
        if let Err(e) = m.save() {
            warn!("could not save maglev meta: {e}");
        }
        *self.last_save.lock() = Instant::now();
    }

    // ---- snapshots ------------------------------------------------------------------------------

    fn snapshot(&self, id: &str, h: &Handle20, m: &TorrentMeta, stats: &TorrentStats) -> Snapshot {
        let rq = rq_state(stats);
        let error = if let Some(e) = &m.last_error {
            Some(e.clone())
        } else if rq == RqState::Error {
            let (code, message) = classify_runtime_error(stats.error.as_deref().unwrap_or(""));
            Some(ErrorInfo { code, message })
        } else {
            None
        };
        let state = derive_state(StateInputs {
            rq,
            finished: stats.finished,
            paused_by: m.paused_by.as_deref(),
            queued: m.queued,
            has_error: error.is_some(),
            resolving: false,
        });
        let (down_bps, up_bps, peers_live, peers_seen) = match &stats.live {
            Some(l) => (
                l.download_speed.as_bytes(),
                l.upload_speed.as_bytes(),
                l.snapshot.peer_stats.live,
                l.snapshot.peer_stats.seen,
            ),
            None => (0, 0, 0, 0),
        };
        let remaining = stats.total_bytes.saturating_sub(stats.progress_bytes);
        let eta_secs = if stats.finished || down_bps == 0 || remaining == 0 {
            -1
        } else {
            (remaining / down_bps) as i64
        };
        let (uploaded, _, _) = uploaded_total(m.uploaded_base, m.last_uploaded_seen, stats.uploaded_bytes);
        let ratio = if stats.progress_bytes == 0 {
            0.0
        } else {
            uploaded as f64 / stats.progress_bytes as f64
        };
        let (down_limit_bps, up_limit_bps) = self.limit_pair(id);
        // MOVING is set by the engine and wins over everything librqbit says.
        let moving = self.moves.lock().get(id).cloned();
        let state = if moving.is_some() {
            TorrentState::Moving
        } else {
            state
        };
        let error = if moving.is_some() { None } else { error };
        Snapshot {
            id: id.to_string(),
            name: h.name().unwrap_or_else(|| "Unnamed torrent".to_string()),
            state,
            paused_by: m.paused_by.clone(),
            finished: stats.finished,
            progress_bytes: stats.progress_bytes,
            total_bytes: stats.total_bytes,
            uploaded_bytes: uploaded,
            down_bps,
            up_bps,
            peers_live,
            peers_seen,
            web_seeds: u32::try_from(h.web_seeds().len()).unwrap_or(u32::MAX),
            eta_secs,
            ratio,
            seeding_secs: (m.seeding_ms / 1000) as i64,
            added_at: m.added_at,
            output_folder: h.output_folder().to_string_lossy().into_owned(),
            error,
            down_limit_bps,
            up_limit_bps,
            move_progress: moving.map(|e| e.progress.fraction()),
        }
    }

    /// The stored per-torrent limits as `(down, up)`; `(0, 0)` when there are none.
    fn limit_pair(&self, id: &str) -> (u64, u64) {
        match self.limits.lock().get(id) {
            Some(l) => (l.down_bps, l.up_bps),
            None => (0, 0),
        }
    }

    /// A torrent that is mid-move and has no librqbit handle for a moment (between forget and re-add).
    fn moving_snapshot(&self, id: &str, m: &TorrentMeta, e: &MoveEntry) -> Snapshot {
        let (down_limit_bps, up_limit_bps) = self.limit_pair(id);
        Snapshot {
            id: id.to_string(),
            name: e.name.clone(),
            state: TorrentState::Moving,
            paused_by: m.paused_by.clone(),
            finished: e.finished,
            progress_bytes: e.progress_bytes,
            total_bytes: e.total_bytes,
            uploaded_bytes: m.uploaded_base.saturating_add(m.last_uploaded_seen),
            down_bps: 0,
            up_bps: 0,
            peers_live: 0,
            peers_seen: 0,
            web_seeds: 0,
            eta_secs: -1,
            ratio: if e.progress_bytes == 0 {
                0.0
            } else {
                m.uploaded_base.saturating_add(m.last_uploaded_seen) as f64 / e.progress_bytes as f64
            },
            seeding_secs: (m.seeding_ms / 1000) as i64,
            added_at: m.added_at,
            output_folder: e.folder.clone(),
            error: None,
            down_limit_bps,
            up_limit_bps,
            move_progress: Some(e.progress.fraction()),
        }
    }

    fn pending_snapshot(&self, id: &str, m: &TorrentMeta, p: &PendingAdd) -> Snapshot {
        let (down_limit_bps, up_limit_bps) = self.limit_pair(id);
        let state = derive_state(StateInputs {
            rq: RqState::Paused,
            finished: false,
            paused_by: None,
            queued: false,
            has_error: p.error.is_some(),
            resolving: true,
        });
        Snapshot {
            id: id.to_string(),
            name: p
                .name
                .clone()
                .unwrap_or_else(|| "Getting torrent info".to_string()),
            state,
            paused_by: m.paused_by.clone(),
            finished: false,
            progress_bytes: 0,
            total_bytes: 0,
            uploaded_bytes: 0,
            down_bps: 0,
            up_bps: 0,
            peers_live: 0,
            peers_seen: 0,
            web_seeds: 0,
            eta_secs: -1,
            ratio: 0.0,
            seeding_secs: 0,
            added_at: m.added_at,
            output_folder: p
                .output_folder
                .clone()
                .unwrap_or_else(|| self.default_dir.to_string_lossy().into_owned()),
            error: p.error.clone(),
            down_limit_bps,
            up_limit_bps,
            move_progress: None,
        }
    }

    pub fn list(&self) -> Result<serde_json::Value, EngineError> {
        let handles = self.handles();
        let meta = self.meta.lock();
        let now = now_secs();
        let mut seen: HashSet<String> = HashSet::new();
        let mut out: Vec<Snapshot> = Vec::with_capacity(handles.len());
        for h in &handles {
            let id = h.info_hash().as_string();
            let stats = h.stats();
            let m = meta
                .get(&id)
                .cloned()
                .unwrap_or_else(|| default_meta(h, now));
            out.push(self.snapshot(&id, h, &m, &stats));
            seen.insert(id);
        }
        for (id, m) in meta.data.torrents.iter() {
            if seen.contains(id) {
                continue;
            }
            if let Some(p) = &m.pending {
                out.push(self.pending_snapshot(id, m, p));
            }
        }
        // A torrent between forget and re-add has no handle for a moment; keep showing it.
        let moving: Vec<(String, Arc<MoveEntry>)> = self
            .moves
            .lock()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (id, e) in moving {
            if seen.contains(&id) {
                continue;
            }
            if let Some(m) = meta.get(&id) {
                out.push(self.moving_snapshot(&id, m, &e));
            }
        }
        out.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.id.cmp(&b.id)));
        Ok(serde_json::json!({ "torrents": out }))
    }

    pub fn detail(&self, id: &str) -> Result<Detail, EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        let h = match self.find(hash) {
            Some(h) => h,
            None => {
                let meta = self.meta.lock();
                let m = meta.get(&id).ok_or_else(EngineError::not_found)?;
                let moving = self.moves.lock().get(&id).cloned();
                if let Some(e) = moving {
                    return Ok(Detail {
                        snapshot: self.moving_snapshot(&id, m, &e),
                        files: vec![],
                        peers: vec![],
                        trackers: vec![],
                        piece_count: 0,
                        piece_length: 0,
                    });
                }
                let p = m.pending.as_ref().ok_or_else(EngineError::not_found)?;
                return Ok(Detail {
                    snapshot: self.pending_snapshot(&id, m, p),
                    files: vec![],
                    peers: vec![],
                    trackers: vec![],
                    piece_count: 0,
                    piece_length: 0,
                });
            }
        };
        let stats = h.stats();
        let m = self
            .meta
            .lock()
            .get(&id)
            .cloned()
            .unwrap_or_else(|| default_meta(&h, now_secs()));
        let snapshot = self.snapshot(&id, &h, &m, &stats);

        let only = h.only_files();
        let first: Vec<u32> = self
            .priorities
            .lock()
            .get(&id)
            .map(|f| f.to_vec())
            .unwrap_or_default();
        // The piece bitfield, for stream readiness. Empty while the torrent is still checking.
        let have_raw: Vec<u8> = self
            .api
            .api_dump_haves(TorrentIdOrHash::Hash(hash))
            .map(|(bf, _)| bf.as_raw_slice().to_vec())
            .unwrap_or_default();
        let files: Vec<FileDetail> = h
            .with_metadata(|md| {
                let piece_length = md.lengths().default_piece_length() as u64;
                md.file_infos
                    .iter()
                    .enumerate()
                    .filter(|(_, fi)| !fi.attrs.padding)
                    .map(|(i, fi)| {
                        let included = only.as_ref().map(|o| o.contains(&i)).unwrap_or(true);
                        let ready = file_readiness(fi.offset_in_torrent, fi.len, piece_length, |p| {
                            have_piece(&have_raw, p)
                        });
                        FileDetail {
                            index: i as u32,
                            path: fi.relative_filename.to_string_lossy().into_owned(),
                            length: fi.len,
                            progress_bytes: stats.file_progress.get(i).copied().unwrap_or(0),
                            included,
                            priority: priority_of_file(i as u32, included, &first),
                            stream_ready_bytes: ready.stream_ready_bytes,
                            tail_ready: ready.tail_ready,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let (piece_count, piece_length) = h
            .with_metadata(|md| {
                (
                    md.lengths().total_pieces(),
                    md.lengths().default_piece_length() as u32,
                )
            })
            .unwrap_or((0, 0));

        let trackers: Vec<TrackerDetail> = h
            .shared()
            .trackers
            .iter()
            .map(|u| TrackerDetail {
                url: u.to_string(),
                // librqbit does not expose per-tracker status.
                status: "unknown".to_string(),
                message: None,
            })
            .collect();

        let mut peers: Vec<PeerDetail> = Vec::new();
        if let Ok(ps) = self
            .api
            .api_peer_stats(TorrentIdOrHash::Hash(hash), Default::default())
        {
            let now = Instant::now();
            let mut cache = self.peer_cache.lock();
            let prefix = format!("{id}|");
            let previous: HashMap<String, (u64, u64, Instant)> = cache
                .iter()
                .filter(|(k, _)| k.starts_with(&prefix))
                .map(|(k, v)| (k.clone(), *v))
                .collect();
            cache.retain(|k, _| !k.starts_with(&prefix));
            for (addr, p) in ps.peers.iter() {
                let key = format!("{prefix}{addr}");
                let fetched = p.counters.fetched_bytes;
                let uploaded = p.counters.uploaded_bytes;
                let (down_bps, up_bps) = rates_since(previous.get(&key), now, fetched, uploaded);
                cache.insert(key, (fetched, uploaded, now));
                peers.push(PeerDetail {
                    addr: addr.to_string(),
                    client: p
                        .client_name
                        .clone()
                        .unwrap_or_else(|| "Unknown".to_string()),
                    down_bps,
                    up_bps,
                    // librqbit does not expose a peer's progress.
                    progress: 0.0,
                });
            }
            // Web seeds (section 16) are not librqbit peers: one row per configured web seed.
            for w in h.web_seeds() {
                let key = format!("{prefix}ws|{}", w.url);
                let fetched = w.downloaded_bytes;
                let (down_bps, _) = rates_since(previous.get(&key), now, fetched, 0);
                cache.insert(key, (fetched, 0, now));
                peers.push(PeerDetail {
                    addr: web_seed_host(&w.url),
                    client: "Web seed".to_string(),
                    down_bps,
                    up_bps: 0,
                    progress: 0.0,
                });
            }
            peers.sort_by(|a, b| b.down_bps.cmp(&a.down_bps).then_with(|| a.addr.cmp(&b.addr)));
            peers.truncate(100);
        }

        Ok(Detail {
            snapshot,
            files,
            peers,
            trackers,
            piece_count,
            piece_length,
        })
    }

    /// Fills the 16x16 grid. Returns false when the torrent does not exist.
    pub fn piece_bitfield(&self, id: &str, out: &mut [u8; MATRIX_SIZE]) -> bool {
        let (_, hash) = match Self::parse_id(id) {
            Ok(x) => x,
            Err(_) => return false,
        };
        if self.find(hash).is_none() {
            return false;
        }
        match self.api.api_dump_haves(TorrentIdOrHash::Hash(hash)) {
            Ok((bf, total)) => downsample_bitfield(bf.as_raw_slice(), total as usize, out),
            // Still checking files: nothing is verified yet.
            Err(_) => out.fill(0),
        }
        true
    }

    pub fn stream_url(&self, id: &str, file_index: i32) -> Result<serde_json::Value, EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let idx = usize::try_from(file_index).map_err(|_| EngineError::not_found())?;
        // (is a padding file, MIME type from the extension); None when the index is out of range.
        let file: Option<(bool, &'static str)> = h
            .with_metadata(|m| {
                m.file_infos.get(idx).map(|fi| {
                    (
                        fi.attrs.padding,
                        fi.relative_filename
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(mime_for_extension)
                            .unwrap_or("application/octet-stream"),
                    )
                })
            })
            .map_err(|_| EngineError::not_found())?;
        let (padding, mime) = file.ok_or_else(EngineError::not_found)?;
        let included = h.only_files().map(|o| o.contains(&idx)).unwrap_or(true);
        if padding || !included {
            return Err(EngineError::new(
                ErrorCode::Unsupported,
                "This file is skipped. Include it to play it.",
            ));
        }
        Ok(serde_json::json!({ "url": self.stream.url(&id, idx as u32), "mime": mime }))
    }

    // ---- adding ---------------------------------------------------------------------------------

    async fn resolve_source(
        &self,
        src: &Source,
        raw: &str,
        limit: Option<Duration>,
    ) -> Result<Resolved, EngineError> {
        check_supported(src)?;
        let add = match src {
            Source::Magnet(_) | Source::Url(_) => AddTorrent::from_url(raw.trim().to_string()),
            Source::File(path) => {
                let bytes = std::fs::read(path).map_err(|e| match e.kind() {
                    std::io::ErrorKind::PermissionDenied => EngineError::new(
                        ErrorCode::Permission,
                        "Maglev can't open that file. Check the file permission.",
                    ),
                    _ => EngineError::new(
                        ErrorCode::InvalidSource,
                        "Couldn't open that .torrent file",
                    ),
                })?;
                AddTorrent::from_bytes(bytes)
            }
        };
        let opts = AddTorrentOptions {
            list_only: true,
            ..Default::default()
        };
        let fut = self.session.add_torrent(add, Some(opts));
        let res = match limit {
            Some(d) => tokio::time::timeout(d, fut).await.map_err(|_| {
                EngineError::new(
                    ErrorCode::MetadataTimeout,
                    "Couldn't find this torrent's info in time",
                )
            })?,
            None => fut.await,
        };
        match res {
            Ok(AddTorrentResponse::ListOnly(r)) => {
                let name = r
                    .info
                    .name()
                    .map(|n| n.into_owned())
                    .unwrap_or_else(|| "Unnamed torrent".to_string());
                let mut files = Vec::new();
                let mut count = 0usize;
                for (i, d) in r.info.iter_file_details().enumerate() {
                    count += 1;
                    if d.attrs().padding {
                        continue;
                    }
                    files.push(FileEntry {
                        index: i as u32,
                        path: d.filename.to_string(),
                        length: d.len,
                    });
                }
                Ok(Resolved {
                    info_hash: r.info_hash.as_string(),
                    name,
                    file_count: count,
                    total_bytes: r.info.lengths().total_length(),
                    files,
                    torrent_bytes: r.torrent_bytes,
                })
            }
            Ok(_) => Err(EngineError::internal("Unexpected answer while reading the torrent")),
            Err(e) => Err(classify_add_error(&format!("{e:#}"))),
        }
    }

    /// Registers a magnet resolve and starts the side task that counts unique DHT peer addresses.
    fn begin_resolve(&self, info_hash: &str) -> Result<ResolveGuard, EngineError> {
        let hash = Id20::from_str(info_hash)
            .map_err(|_| EngineError::new(ErrorCode::InvalidSource, "This magnet link has an info hash that isn't valid"))?;
        let dht_on = self.session.get_dht().is_some();
        let started = self.resolves.begin(info_hash, dht_on);
        let task = if dht_on {
            let registry = self.resolves.clone();
            let session = self.session.clone();
            let key = info_hash.to_string();
            let generation = started.generation;
            Some(self.handle.spawn(async move {
                // Same call librqbit makes for a magnet (session.rs make_peer_rx): a stream of SocketAddr.
                let stream = session
                    .get_dht()
                    .map(|dht| dht.get_peers(hash, None));
                if let Some(mut stream) = stream {
                    while let Some(addr) = stream.next().await {
                        registry.record_peer(&key, generation, addr);
                    }
                }
            }))
        } else {
            None
        };
        Ok(ResolveGuard {
            registry: self.resolves.clone(),
            key: info_hash.to_string(),
            generation: started.generation,
            cancel: started.cancel,
            task,
        })
    }

    pub fn resolve_metadata(&self, source: &str, timeout_ms: i64) -> Result<Metadata, EngineError> {
        let src = parse_source(source)?;
        let limit = Duration::from_millis(timeout_ms.clamp(1_000, 600_000) as u64);
        // Only magnets have activity to report and can be cancelled.
        let guard = match &src {
            Source::Magnet(m) => Some(self.begin_resolve(&m.info_hash)?),
            _ => None,
        };
        let cancel = guard.as_ref().map(|g| g.cancel.clone());
        let resolving = self.resolve_source(&src, source, Some(limit));
        // The inner timeout produces METADATA_TIMEOUT; the outer one is only a safety net.
        let r = self.run(limit + Duration::from_secs(5), async move {
            match cancel {
                Some(c) => tokio::select! {
                    r = resolving => r,
                    _ = c.notified() => Err(EngineError::new(
                        ErrorCode::Cancelled,
                        "Cancelled",
                    )),
                },
                None => resolving.await,
            }
        })??;
        drop(guard);
        Ok(Metadata {
            info_hash: r.info_hash,
            name: r.name,
            total_bytes: r.total_bytes,
            files: r.files,
        })
    }

    /// Peers found so far for a magnet that is resolving right now.
    pub fn resolve_activity(&self, info_hash: &str) -> Result<ActivitySnapshot, EngineError> {
        let (id, _) = Self::parse_id(info_hash)?;
        self.resolves.snapshot(&id).ok_or_else(EngineError::not_found)
    }

    /// Stops a running magnet resolve. `nativeResolveMetadata` then answers `CANCELLED`.
    pub fn cancel_resolve(&self, info_hash: &str) -> Result<(), EngineError> {
        let (id, _) = Self::parse_id(info_hash)?;
        if self.resolves.cancel(&id) {
            Ok(())
        } else {
            Err(EngineError::not_found())
        }
    }

    async fn add_resolved(&self, r: &Resolved, opts: &AddOptions) -> Result<(), EngineError> {
        let output_folder = match opts.output_folder.as_deref().map(str::trim) {
            Some(f) if !f.is_empty() => {
                let base = PathBuf::from(f);
                let dir = match subfolder_for(&r.name, r.file_count) {
                    Some(s) => base.join(s),
                    None => base,
                };
                Some(dir.to_string_lossy().into_owned())
            }
            _ => None,
        };
        // Per-file choices replace `only_files` when both are given.
        let planned: Option<PriorityPlan> = match &opts.file_priorities {
            Some(entries) => {
                let valid: Vec<usize> = r.files.iter().map(|f| f.index as usize).collect();
                Some(plan_priorities(entries, &valid, r.file_count)?)
            }
            None => None,
        };
        let only_files: Option<Vec<usize>> = match &planned {
            Some(p) => Some(p.included.iter().copied().collect()),
            None => opts
                .only_files
                .as_ref()
                .map(|v| v.iter().map(|i| *i as usize).collect()),
        };
        let add_opts = AddTorrentOptions {
            // Always added paused; the planner starts it when a slot is free.
            paused: true,
            // Reuse files that are already on disk instead of failing.
            overwrite: true,
            only_files,
            output_folder,
            ..Default::default()
        };
        match self
            .session
            .add_torrent(AddTorrent::from_bytes(r.torrent_bytes.clone()), Some(add_opts))
            .await
        {
            Ok(AddTorrentResponse::Added(_, handle)) => {
                if let Some(p) = planned {
                    handle.set_file_priority_order(p.order);
                    self.remember_first_files(&r.info_hash, p.first);
                }
                if opts.down_limit_bps.is_some() || opts.up_limit_bps.is_some() {
                    self.remember_limits(
                        &r.info_hash,
                        TorrentLimits::new(
                            opts.down_limit_bps.unwrap_or(0),
                            opts.up_limit_bps.unwrap_or(0),
                        ),
                    );
                }
                // Covers limits given with the add and limits stored while a magnet was still resolving.
                self.apply_saved_limits(&r.info_hash, &handle);
                Ok(())
            }
            Ok(AddTorrentResponse::AlreadyManaged(_, _)) => {
                Err(EngineError::duplicate(r.info_hash.clone()))
            }
            Ok(AddTorrentResponse::ListOnly(_)) => {
                Err(EngineError::internal("Unexpected answer while adding the torrent"))
            }
            Err(e) => Err(classify_add_error(&format!("{e:#}"))),
        }
    }

    fn is_known(&self, id: &str, hash: Id20) -> bool {
        self.find(hash).is_some() || self.meta.lock().contains(id)
    }

    pub fn add_torrent(
        self: &Arc<Self>,
        source: &str,
        options_json: &str,
    ) -> Result<AddResult, EngineError> {
        let opts: AddOptions = if options_json.trim().is_empty() || options_json.trim() == "null" {
            AddOptions::default()
        } else {
            serde_json::from_str(options_json)
                .map_err(|_| EngineError::internal("The download options couldn't be read"))?
        };
        let src = parse_source(source)?;
        let now = now_secs();

        let initial_meta = |pending: Option<PendingAdd>| TorrentMeta {
            added_at: now,
            paused_by: if opts.paused {
                Some(PAUSED_BY_USER.to_string())
            } else {
                None
            },
            queued: !opts.paused,
            sequential: opts.sequential,
            pending,
            ..Default::default()
        };

        match &src {
            Source::Magnet(m) => {
                let (id, hash) = Self::parse_id(&m.info_hash)?;
                if self.is_known(&id, hash) {
                    return Err(EngineError::duplicate(id));
                }
                let pending = PendingAdd {
                    source: source.trim().to_string(),
                    name: m.name.clone(),
                    only_files: opts.only_files.clone(),
                    output_folder: opts.output_folder.clone(),
                    sequential: opts.sequential,
                    file_priorities: opts.file_priorities.clone(),
                    error: None,
                };
                self.meta.lock().insert(&id, initial_meta(Some(pending.clone())));
                self.save_meta();
                if opts.down_limit_bps.is_some() || opts.up_limit_bps.is_some() {
                    self.remember_limits(
                        &id,
                        TorrentLimits::new(
                            opts.down_limit_bps.unwrap_or(0),
                            opts.up_limit_bps.unwrap_or(0),
                        ),
                    );
                }
                self.spawn_pending(id.clone(), pending);
                Ok(AddResult {
                    info_hash: id.clone(),
                    id,
                })
            }
            Source::Url(_) | Source::File(_) => {
                let resolved = self.run(
                    Duration::from_secs(50),
                    self.resolve_source(&src, source, Some(Duration::from_secs(45))),
                )??;
                let (id, hash) = Self::parse_id(&resolved.info_hash)?;
                if self.is_known(&id, hash) {
                    return Err(EngineError::duplicate(id));
                }
                self.meta.lock().insert(&id, initial_meta(None));
                self.save_meta();
                let added = self
                    .run(Duration::from_secs(60), self.add_resolved(&resolved, &opts))
                    .and_then(|r| r);
                if let Err(e) = added {
                    self.meta.lock().remove(&id);
                    self.save_meta();
                    return Err(e);
                }
                let _ = self.run(OP_TIMEOUT, self.tick_soon());
                Ok(AddResult {
                    info_hash: id.clone(),
                    id,
                })
            }
        }
    }

    fn spawn_pending(self: &Arc<Self>, id: String, pending: PendingAdd) {
        let me = self.clone();
        let task_id = id.clone();
        let jh = self.handle.spawn(async move {
            me.run_pending(id, pending).await;
        });
        self.pending_tasks.lock().insert(task_id, jh);
    }

    async fn run_pending(self: Arc<Self>, id: String, pending: PendingAdd) {
        let outcome: Result<(), EngineError> = async {
            let src = parse_source(&pending.source)?;
            // No time limit: DHT and trackers keep looking until the user deletes the entry.
            let resolved = self.resolve_source(&src, &pending.source, None).await?;
            let opts = AddOptions {
                only_files: pending.only_files.clone(),
                paused: false,
                output_folder: pending.output_folder.clone(),
                sequential: pending.sequential,
                file_priorities: pending.file_priorities.clone(),
                // Limits for a magnet were saved to the sidecar when it was added.
                down_limit_bps: None,
                up_limit_bps: None,
            };
            self.add_resolved(&resolved, &opts).await
        }
        .await;
        {
            let mut meta = self.meta.lock();
            match outcome {
                Ok(()) => {
                    meta.update(&id, |m| m.pending = None);
                }
                Err(e) if e.code == ErrorCode::Duplicate => {
                    meta.update(&id, |m| m.pending = None);
                }
                Err(e) => {
                    meta.update(&id, |m| {
                        if let Some(p) = m.pending.as_mut() {
                            p.error = Some(ErrorInfo {
                                code: e.code,
                                message: e.message.clone(),
                            });
                        }
                    });
                }
            }
        }
        self.save_meta();
        self.pending_tasks.lock().remove(&id);
    }

    fn resume_pending_adds(self: &Arc<Self>) {
        let todo: Vec<(String, PendingAdd)> = {
            let meta = self.meta.lock();
            meta.data
                .torrents
                .iter()
                .filter_map(|(id, m)| m.pending.clone().map(|p| (id.clone(), p)))
                .collect()
        };
        for (id, mut p) in todo {
            let in_session = Self::parse_id(&id)
                .ok()
                .and_then(|(_, h)| self.find(h))
                .is_some();
            if in_session {
                self.meta.lock().update(&id, |m| m.pending = None);
                continue;
            }
            p.error = None;
            self.meta.lock().update(&id, |m| m.pending = Some(p.clone()));
            self.spawn_pending(id, p);
        }
    }

    // ---- user actions ---------------------------------------------------------------------------

    pub fn pause(&self, id: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash);
        {
            let mut meta = self.meta.lock();
            if let Some(hh) = &h {
                if !meta.contains(&id) {
                    meta.insert(&id, default_meta(hh, now_secs()));
                }
            }
            let found = meta
                .update(&id, |m| {
                    m.paused_by = Some(PAUSED_BY_USER.to_string());
                    m.queued = false;
                })
                .is_some();
            if !found {
                return Err(EngineError::not_found());
            }
        }
        self.save_meta();
        if let Some(h) = h {
            self.run(OP_TIMEOUT, self.ensure_paused(&h))?;
        }
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash);
        if let Some(hh) = &h {
            if let Some(err) = self.files_missing(&id, hh) {
                self.meta.lock().update(&id, |m| {
                    m.last_error = Some(err.clone());
                    m.queued = false;
                });
                self.save_meta();
                return Err(EngineError::new(err.code, err.message));
            }
        }
        {
            let mut meta = self.meta.lock();
            if let Some(hh) = &h {
                if !meta.contains(&id) {
                    meta.insert(&id, default_meta(hh, now_secs()));
                }
            }
            let found = meta
                .update(&id, |m| {
                    if m.paused_by.as_deref() == Some(PAUSED_BY_SEED_LIMIT) {
                        m.limits_waived = true;
                    }
                    m.paused_by = None;
                    m.last_error = None;
                    // Released into the queue; the planner decides whether it starts now.
                    m.queued = true;
                })
                .is_some();
            if !found {
                return Err(EngineError::not_found());
            }
        }
        self.save_meta();
        if let Some(h) = h {
            self.run(OP_TIMEOUT, async {
                // A torrent in librqbit's error state needs a restart before the planner can see it as paused.
                let stats = h.stats();
                if rq_state(&stats) == RqState::Error {
                    if let Err(e) = self.session.unpause(&h).await {
                        let (code, message) = classify_runtime_error(&format!("{e:#}"));
                        return Err(EngineError::new(code, message));
                    }
                }
                Ok(())
            })??;
            self.run(OP_TIMEOUT, self.tick_soon())?;
        }
        Ok(())
    }

    /// Adds a torrent back (paused, reusing the files on disk) after a forget, and gives the new handle
    /// the saved download order and speed limits. Shared by Recheck and Move. The caller holds the tick lock.
    async fn readd_at(
        &self,
        id: &str,
        bytes: Bytes,
        only_files: Option<Vec<usize>>,
        folder: String,
    ) -> Result<(), EngineError> {
        let opts = AddTorrentOptions {
            paused: true,
            overwrite: true,
            only_files,
            output_folder: Some(folder),
            ..Default::default()
        };
        match self
            .session
            .add_torrent(AddTorrent::from_bytes(bytes), Some(opts))
            .await
        {
            Ok(AddTorrentResponse::Added(_, new_handle)) => {
                // The re-added torrent is a new handle; give it its saved settings back.
                self.apply_saved_order(id, &new_handle);
                self.apply_saved_limits(id, &new_handle);
                Ok(())
            }
            Ok(_) => Ok(()),
            Err(e) => Err(classify_add_error(&format!("{e:#}"))),
        }
    }

    /// User actions are refused while a torrent's files are moving.
    fn reject_if_moving(&self, id: &str) -> Result<(), EngineError> {
        if self.moves.lock().contains_key(id) {
            return Err(EngineError::new(
                ErrorCode::Unsupported,
                "This torrent is moving. Wait for the move to finish.",
            ));
        }
        Ok(())
    }

    /// A governance pass for callers that just changed something. Skipped while a move holds the
    /// tick lock, so the caller is not blocked for the whole move; the loop's next pass catches up.
    async fn tick_soon(&self) {
        let idle = self.moves.lock().is_empty();
        if idle {
            self.tick().await;
        }
    }

    pub fn recheck(&self, id: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let bytes = h
            .with_metadata(|m| m.torrent_bytes.clone())
            .map_err(|_| EngineError::internal("This torrent has no info to check yet"))?;
        let only_files = h.only_files();
        let folder = h.output_folder().to_string_lossy().into_owned();
        self.run(DELETE_TIMEOUT, async {
            // Holding the tick lock keeps the governance pass (and its stale-entry sweep) away from
            // this torrent between the delete and the re-add, so its Maglev metadata survives.
            let _tick = self.tick_lock.lock().await;
            self.session
                .delete(TorrentIdOrHash::Hash(hash), false)
                .await
                .map_err(|e| {
                    let (code, message) = classify_runtime_error(&format!("{e:#}"));
                    EngineError::new(code, message)
                })?;
            let added = self.readd_at(&id, bytes, only_files, folder).await;
            // added_at, paused_by, uploaded totals and seeding time are kept; only error state resets.
            self.meta.lock().update(&id, |m| {
                m.last_error = None;
                m.max_progress_bytes = 0;
                m.queued = m.paused_by.is_none();
            });
            added
        })??;
        self.save_meta();
        let _ = self.run(OP_TIMEOUT, self.tick_soon());
        Ok(())
    }

    pub fn delete(&self, id: &str, delete_files: bool) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        if let Some(t) = self.pending_tasks.lock().remove(&id) {
            t.abort();
        }
        let had_handle = self.find(hash).is_some();
        if had_handle {
            self.run(DELETE_TIMEOUT, async {
                self.session
                    .delete(TorrentIdOrHash::Hash(hash), delete_files)
                    .await
                    .map_err(|e| {
                        let raw = format!("{e:#}");
                        if raw.contains("could not delete files") {
                            EngineError::new(
                                ErrorCode::Permission,
                                "The torrent was removed, but some files couldn't be deleted",
                            )
                        } else {
                            let (code, message) = classify_runtime_error(&raw);
                            EngineError::new(code, message)
                        }
                    })
            })??;
        }
        let in_meta = self.meta.lock().remove(&id).is_some();
        self.forget_priorities(&id);
        self.forget_limits(&id);
        self.reannounce_limiter.lock().release(&id);
        self.peer_cache.lock().retain(|k, _| !k.starts_with(&format!("{id}|")));
        self.save_meta();
        if !had_handle && !in_meta {
            return Err(EngineError::not_found());
        }
        Ok(())
    }

    pub fn set_included_files(&self, id: &str, indices_json: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let indices: Vec<u32> = serde_json::from_str(indices_json)
            .map_err(|_| EngineError::internal("The file selection couldn't be read"))?;
        let set: HashSet<usize> = indices.into_iter().map(|i| i as usize).collect();
        self.run(OP_TIMEOUT, async {
            self.session.update_only_files(&h, &set).await.map_err(|e| {
                let raw = format!("{e:#}");
                if raw.contains("invalid value") {
                    EngineError::new(ErrorCode::NotFound, "One of those files isn't in the torrent")
                } else {
                    EngineError::internal("Couldn't change the file selection right now. Try again in a moment.")
                }
            })
        })??;
        let _ = self.run(OP_TIMEOUT, self.tick_soon());
        Ok(())
    }

    // ---- file priority ----------------------------------------------------------------------------

    /// Saves the `first` files of a torrent to the sidecar.
    fn remember_first_files(&self, id: &str, first: Vec<u32>) {
        let mut store = self.priorities.lock();
        store.set(id, first);
        if let Err(e) = store.save() {
            warn!("could not save file priorities: {e}");
        }
    }

    fn forget_priorities(&self, id: &str) {
        let mut store = self.priorities.lock();
        if store.remove(id) {
            if let Err(e) = store.save() {
                warn!("could not save file priorities: {e}");
            }
        }
    }

    /// Gives a handle the download order saved for `id`, if there is one.
    fn apply_saved_order(&self, id: &str, h: &Handle20) {
        let first: Option<Vec<u32>> = self.priorities.lock().get(id).map(|f| f.to_vec());
        let Some(first) = first else { return };
        let file_count = h.with_metadata(|m| m.file_infos.len()).unwrap_or(0);
        if file_count > 0 {
            h.set_file_priority_order(order_from_first(&first, file_count));
        }
    }

    /// Run once at start: torrents that librqbit restored get their saved order.
    fn restore_priorities(&self) {
        for h in self.handles() {
            let id = h.info_hash().as_string();
            self.apply_saved_order(&id, &h);
        }
    }

    /// `nativeSetFilePriorities`: the include set and the download order change together.
    pub fn set_file_priorities(&self, id: &str, json: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let entries = parse_priorities(json)?;
        let (valid, file_count): (Vec<usize>, usize) = h
            .with_metadata(|m| {
                (
                    m.file_infos
                        .iter()
                        .enumerate()
                        .filter(|(_, fi)| !fi.attrs.padding)
                        .map(|(i, _)| i)
                        .collect::<Vec<usize>>(),
                    m.file_infos.len(),
                )
            })
            .map_err(|_| EngineError::not_found())?;
        // Nothing is changed until the whole list has been checked.
        let plan = plan_priorities(&entries, &valid, file_count)?;

        let current = h.only_files();
        if include_set_changed(current.as_deref(), &valid, &plan.included) {
            self.run(OP_TIMEOUT, async {
                self.session
                    .update_only_files(&h, &plan.included)
                    .await
                    .map_err(|e| {
                        let raw = format!("{e:#}");
                        if raw.contains("invalid value") {
                            EngineError::new(
                                ErrorCode::InvalidSource,
                                "One of those files isn't in the torrent",
                            )
                        } else {
                            EngineError::internal(
                                "Couldn't change the file selection right now. Try again in a moment.",
                            )
                        }
                    })
            })??;
        }
        // Only reached when the include set is in place, so the two never disagree.
        h.set_file_priority_order(plan.order);
        self.remember_first_files(&id, plan.first);
        let _ = self.run(OP_TIMEOUT, self.tick_soon());
        Ok(())
    }

    // ---- remove a file's data -----------------------------------------------------------------------

    /// `nativeRemoveFiles` (`NATIVE_CONTRACT.md` section 14): the files stop downloading, their data is deleted
    /// from disk and the pieces that overlap them lose their have bits. Returns the verified bytes freed.
    ///
    /// librqbit can only rewrite the chunk tracker and delete files safely while the torrent is paused, so a
    /// live torrent is paused first and started again afterwards. The tick lock is held for the whole round
    /// trip, as in `reannounce`, so the governance pass never sees the torrent paused. `paused_by`, `queued`
    /// and `added_at` are not touched. A torrent that is checking or in error is refused with `UNSUPPORTED`.
    pub fn remove_files(&self, id: &str, indices_json: &str) -> Result<serde_json::Value, EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let indices: Vec<u32> = serde_json::from_str(indices_json)
            .map_err(|_| EngineError::new(ErrorCode::InvalidSource, "The file choices couldn't be read"))?;
        let (valid, file_count): (Vec<usize>, usize) = h
            .with_metadata(|m| {
                (
                    m.file_infos
                        .iter()
                        .enumerate()
                        .filter(|(_, fi)| !fi.attrs.padding)
                        .map(|(i, _)| i)
                        .collect::<Vec<usize>>(),
                    m.file_infos.len(),
                )
            })
            .map_err(|_| EngineError::not_found())?;
        // Nothing is changed until the whole request has been checked.
        let current = h.only_files();
        let remove = plan_removal(&indices, &valid, current.as_deref())?;

        let busy = || {
            EngineError::new(
                ErrorCode::Unsupported,
                "Wait until the torrent has been checked, then remove files",
            )
        };
        let freed = self.run(DELETE_TIMEOUT, async {
            let _tick = self.tick_lock.lock().await;
            // The state may have changed while this call waited for the lock.
            let was_live = match h.stats().state {
                TorrentStatsState::Live => true,
                TorrentStatsState::Paused => false,
                _ => return Err(busy()),
            };
            if was_live {
                // librqbit restarts its upload counter when a torrent goes live again.
                // Fold what it has counted so far into the saved total first.
                let uploaded_now = h.stats().uploaded_bytes;
                self.meta.lock().update(&id, |m| {
                    let (_, base, last) =
                        uploaded_total(m.uploaded_base, m.last_uploaded_seen, uploaded_now);
                    m.uploaded_base = base;
                    m.last_uploaded_seen = last;
                });
                self.session.pause(&h).await.map_err(|e| {
                    let (code, message) = classify_runtime_error(&format!("{e:#}"));
                    EngineError::new(code, message)
                })?;
            }
            let removed = self.session.remove_files_data(&h, &remove).await;
            if was_live {
                if let Err(e) = self.session.unpause(&h).await {
                    warn!("remove_files could not restart the torrent: {e:#}");
                    // Leave it for the planner to start again instead of stuck paused.
                    self.meta.lock().update(&id, |m| {
                        if m.paused_by.is_none() {
                            m.queued = true;
                        }
                    });
                }
            }
            removed.map_err(|e| {
                let raw = format!("{e:#}");
                if raw.contains("must be paused") {
                    return busy();
                }
                if raw.contains("invalid value") || raw.contains("no file to download") {
                    return EngineError::new(ErrorCode::InvalidSource, "Keep at least one file in the torrent");
                }
                let (code, message) = classify_runtime_error(&raw);
                if code == ErrorCode::Internal {
                    EngineError::new(code, "Couldn't delete those files. Try again in a moment.")
                } else {
                    EngineError::new(code, message)
                }
            })
        })??;

        // The files are skipped now; forget them in the "download first" list too.
        let first: Vec<u32> = self.priorities.lock().get(&id).map(|f| f.to_vec()).unwrap_or_default();
        let pruned: Vec<u32> = first
            .iter()
            .copied()
            .filter(|i| !remove.contains(&(*i as usize)))
            .collect();
        if pruned.len() != first.len() {
            h.set_file_priority_order(order_from_first(&pruned, file_count));
            self.remember_first_files(&id, pruned);
        }
        // Progress went down on purpose: the files_missing check must not read that as lost data.
        self.meta.lock().update(&id, |m| {
            m.max_progress_bytes = 0;
        });
        self.save_meta();
        let _ = self.run(OP_TIMEOUT, self.tick_soon());
        Ok(serde_json::json!({ "freed_bytes": freed }))
    }

    // ---- reannounce -------------------------------------------------------------------------------

    /// True while the torrent shows as DOWNLOADING or SEEDING.
    fn is_active_transfer(&self, id: &str, h: &Handle20) -> bool {
        let stats = h.stats();
        let m = self
            .meta
            .lock()
            .get(id)
            .cloned()
            .unwrap_or_else(|| default_meta(h, now_secs()));
        matches!(
            self.snapshot(id, h, &m, &stats).state,
            TorrentState::Downloading | TorrentState::Seeding
        )
    }

    /// `nativeReannounce`: pause and unpause the same handle so trackers, DHT and LSD are asked again.
    ///
    /// The tick lock is held for the whole round trip, so the governance pass never sees the
    /// torrent paused. `paused_by`, `queued`, `added_at` and the seeding clock are not touched.
    pub fn reannounce(&self, id: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        self.reject_if_moving(&id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let not_running = || {
            EngineError::new(
                ErrorCode::Unsupported,
                "Find more peers only works while a torrent is downloading or seeding",
            )
        };
        if !self.is_active_transfer(&id, &h) {
            return Err(not_running());
        }
        if let Err(secs) = self.reannounce_limiter.lock().try_acquire(&id, Instant::now()) {
            return Err(EngineError::retry_later(
                format!("Try again in {secs} seconds"),
                secs,
            ));
        }
        let outcome = self
            .run(OP_TIMEOUT, async {
                let _tick = self.tick_lock.lock().await;
                // The state may have changed while this call waited for the lock.
                if !self.is_active_transfer(&id, &h) {
                    return Err(not_running());
                }
                // librqbit restarts its upload counter when a torrent goes live again.
                // Fold what it has counted so far into the saved total first.
                let uploaded_now = h.stats().uploaded_bytes;
                self.meta.lock().update(&id, |m| {
                    let (_, base, last) =
                        uploaded_total(m.uploaded_base, m.last_uploaded_seen, uploaded_now);
                    m.uploaded_base = base;
                    m.last_uploaded_seen = last;
                });
                self.session.pause(&h).await.map_err(|e| {
                    let (code, message) = classify_runtime_error(&format!("{e:#}"));
                    EngineError::new(code, message)
                })?;
                if let Err(e) = self.session.unpause(&h).await {
                    warn!("reannounce could not restart the torrent: {e:#}");
                    // Leave it for the planner to start again instead of stuck paused.
                    self.meta.lock().update(&id, |m| {
                        if m.paused_by.is_none() {
                            m.queued = true;
                        }
                    });
                    let (code, message) = classify_runtime_error(&format!("{e:#}"));
                    return Err(EngineError::new(code, message));
                }
                Ok::<(), EngineError>(())
            })
            .and_then(|r| r);
        if outcome.is_err() {
            // A call that did not reach the trackers must not use up the minute.
            self.reannounce_limiter.lock().release(&id);
        }
        outcome
    }

    // ---- per-torrent speed limits -------------------------------------------------------------------

    /// Saves a torrent's limits to the sidecar. "No limit" in both directions removes the entry.
    fn remember_limits(&self, id: &str, l: TorrentLimits) {
        let mut store = self.limits.lock();
        store.set(id, l);
        if let Err(e) = store.save() {
            warn!("could not save torrent limits: {e}");
        }
    }

    fn forget_limits(&self, id: &str) {
        let mut store = self.limits.lock();
        if store.remove(id) {
            if let Err(e) = store.save() {
                warn!("could not save torrent limits: {e}");
            }
        }
    }

    /// Gives a handle the limits saved for `id`, if there are any.
    fn apply_saved_limits(&self, id: &str, h: &Handle20) {
        let saved: Option<TorrentLimits> = self.limits.lock().get(id);
        if let Some(l) = saved {
            h.set_ratelimits(limits_config(l));
        }
    }

    /// Run once at start: torrents that librqbit restored get their saved limits.
    fn restore_limits(&self) {
        for h in self.handles() {
            let id = h.info_hash().as_string();
            self.apply_saved_limits(&id, &h);
        }
    }

    /// `nativeSetTorrentLimits`: `{"down_bps":u64,"up_bps":u64}`, 0 = no limit. The session-wide limits still apply.
    pub fn set_torrent_limits(&self, id: &str, json: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        let limits = parse_limits(json)?;
        let handle = self.find(hash);
        if handle.is_none() {
            // A magnet that is still looking for its info has no handle yet; the limit is applied once it has.
            let pending = self
                .meta
                .lock()
                .get(&id)
                .map(|m| m.pending.is_some())
                .unwrap_or(false);
            if !pending {
                return Err(EngineError::not_found());
            }
        }
        self.remember_limits(&id, limits);
        if let Some(h) = handle {
            h.set_ratelimits(limits_config(limits));
        }
        Ok(())
    }

    // ---- move storage ---------------------------------------------------------------------------------

    /// `nativeMoveStorage`: checks the request, then moves the files on a background thread and returns at once.
    pub fn move_storage(self: &Arc<Self>, id: &str, dest_dir: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        let h = match self.find(hash) {
            Some(h) => h,
            None => {
                let pending = self
                    .meta
                    .lock()
                    .get(&id)
                    .map(|m| m.pending.is_some())
                    .unwrap_or(false);
                return Err(if pending {
                    EngineError::new(
                        ErrorCode::Unsupported,
                        "Wait until this torrent has its info, then move it",
                    )
                } else {
                    EngineError::not_found()
                });
            }
        };
        self.reject_if_moving(&id)?;
        let state = {
            let stats = h.stats();
            let m = self
                .meta
                .lock()
                .get(&id)
                .cloned()
                .unwrap_or_else(|| default_meta(&h, now_secs()));
            self.snapshot(&id, &h, &m, &stats)
        };
        if matches!(state.state, TorrentState::Checking | TorrentState::Initializing) {
            return Err(EngineError::new(
                ErrorCode::Unsupported,
                "Wait until the torrent has been checked, then move it",
            ));
        }
        let dest = dest_dir.trim();
        if dest.is_empty() {
            return Err(EngineError::new(
                ErrorCode::InvalidSource,
                "Pick a folder to move this torrent to",
            ));
        }
        let dest = PathBuf::from(dest);

        let (name, file_count, rels, torrent_bytes) = h
            .with_metadata(|md| {
                (
                    h.name().unwrap_or_default(),
                    md.file_infos.len(),
                    md.file_infos
                        .iter()
                        .filter(|fi| !fi.attrs.padding)
                        .map(|fi| fi.relative_filename.clone())
                        .collect::<Vec<PathBuf>>(),
                    md.torrent_bytes.clone(),
                )
            })
            .map_err(|_| EngineError::internal("This torrent has no info to move yet"))?;
        let old_folder = h.output_folder().to_path_buf();
        let new_folder = destination_folder(&dest, &name, file_count);
        let own_folder = subfolder_for(&name, file_count).is_some();
        check_destination(&dest, &old_folder, &new_folder, own_folder)?;

        // Only files that exist move. A destination file with the same name is never overwritten.
        let moves: Vec<crate::relocate::FileMove> = plan_moves(&old_folder, &new_folder, &rels)
            .into_iter()
            .filter(|m| m.from.is_file())
            .collect();
        if moves.iter().any(|m| m.to.exists()) {
            return Err(EngineError::new(
                ErrorCode::Unsupported,
                "That folder already has files with the same names",
            ));
        }
        probe_writable(&new_folder).map_err(|e| {
            let (code, message) = move_error(&e);
            EngineError::new(code, message)
        })?;
        let total: u64 = moves
            .iter()
            .filter_map(|m| std::fs::metadata(&m.from).ok())
            .map(|md| md.len())
            .sum();

        let progress = Arc::new(MoveProgress::new(total));
        let entry = Arc::new(MoveEntry {
            progress: progress.clone(),
            name: if name.is_empty() {
                "Unnamed torrent".to_string()
            } else {
                name
            },
            total_bytes: state.total_bytes,
            progress_bytes: state.progress_bytes,
            finished: state.finished,
            folder: old_folder.to_string_lossy().into_owned(),
        });
        {
            let mut mv = self.moves.lock();
            if mv.contains_key(&id) {
                return Err(EngineError::new(
                    ErrorCode::Unsupported,
                    "This torrent is moving. Wait for the move to finish.",
                ));
            }
            mv.insert(id.clone(), entry);
        }
        // A failed earlier move leaves an error on the torrent; a new attempt starts clean.
        self.meta.lock().update(&id, |m| m.last_error = None);

        let job = MoveJob {
            id: id.clone(),
            hash,
            only_files: h.only_files(),
            handle: h,
            torrent_bytes,
            old_folder,
            new_folder,
            own_folder,
            rels,
            moves,
            progress,
        };
        let me = self.clone();
        // A blocking thread: the copy is long blocking I/O, and the task never needs to be `Send`.
        self.handle.spawn_blocking(move || {
            let _guard = MoveGuard {
                engine: me.clone(),
                id: job.id.clone(),
            };
            me.handle.block_on(me.run_move(job));
        });
        Ok(())
    }

    /// Runs the move and records the outcome in the torrent's metadata.
    async fn run_move(&self, job: MoveJob) {
        let outcome = self.do_move(&job).await;
        {
            let mut meta = self.meta.lock();
            match &outcome {
                Ok(()) => {
                    meta.update(&job.id, |m| {
                        m.last_error = None;
                        m.max_progress_bytes = 0;
                        m.queued = m.paused_by.is_none();
                    });
                }
                Err(e) => {
                    meta.update(&job.id, |m| {
                        m.last_error = Some(ErrorInfo {
                            code: e.code,
                            message: e.message.clone(),
                        });
                        m.queued = false;
                    });
                }
            }
        }
        self.save_meta();
        if let Err(e) = outcome {
            warn!("move failed: {e}");
        }
        // The MOVING marker is removed when the guard drops, after the outcome is saved.
    }

    /// The algorithm of contract section 11.3. Holds the tick lock for the whole move.
    async fn do_move(&self, job: &MoveJob) -> Result<(), EngineError> {
        let _tick = self.tick_lock.lock().await;
        let old = job.old_folder.to_string_lossy().into_owned();
        let new = job.new_folder.to_string_lossy().into_owned();
        // The user-visible state (paused_by, queued) stays in the metadata; only the handle is stopped.
        self.ensure_paused(&job.handle).await;
        let only_files = job.only_files.clone();

        let done = match execute_moves(&job.moves, &job.progress) {
            Ok(done) => done,
            Err(fail) => {
                warn!("move stopped: {}", fail.error);
                let (code, message) = move_error(&fail.error);
                rollback(&fail.done);
                remove_empty_dirs(&job.new_folder, &job.rels, job.own_folder);
                return Err(EngineError::new(code, message));
            }
        };

        // Same path as Recheck: forget the torrent, then add it back at the new folder.
        let forgotten = self
            .session
            .delete(TorrentIdOrHash::Hash(job.hash), false)
            .await;
        if let Err(e) = forgotten {
            rollback(&done);
            remove_empty_dirs(&job.new_folder, &job.rels, job.own_folder);
            let (code, message) = classify_runtime_error(&format!("{e:#}"));
            return Err(EngineError::new(code, message));
        }
        if let Err(e) = self
            .readd_at(&job.id, job.torrent_bytes.clone(), only_files.clone(), new)
            .await
        {
            // Put the files and the torrent back where they were.
            rollback(&done);
            remove_empty_dirs(&job.new_folder, &job.rels, job.own_folder);
            if let Err(back) = self
                .readd_at(&job.id, job.torrent_bytes.clone(), only_files, old)
                .await
            {
                warn!("could not add the torrent back after a failed move: {back}");
            }
            let (code, message) = match e.code {
                ErrorCode::DiskFull | ErrorCode::Permission => (e.code, e.message),
                _ => (
                    ErrorCode::Internal,
                    "Couldn't move the files. Try again.".to_string(),
                ),
            };
            return Err(EngineError::new(code, message));
        }
        // The files are at the new folder and the torrent points there. Tidy up the old one.
        remove_empty_dirs(&job.old_folder, &job.rels, job.own_folder);
        Ok(())
    }

    // ---- settings and governance ----------------------------------------------------------------

    fn apply_limits(&self, down: u64, up: u64) {
        self.session.ratelimits.set_download_bps(nonzero_bps(down));
        self.session.ratelimits.set_upload_bps(nonzero_bps(up));
    }

    pub fn set_global_limits(&self, down_bps: i64, up_bps: i64) -> Result<(), EngineError> {
        let down = down_bps.max(0) as u64;
        let up = up_bps.max(0) as u64;
        self.apply_limits(down, up);
        let snapshot = {
            let mut c = self.config.lock();
            c.download_limit_bps = down;
            c.upload_limit_bps = up;
            c.clone()
        };
        self.meta.lock().data.config = Some(snapshot);
        self.meta.lock().mark_dirty();
        self.save_meta();
        Ok(())
    }

    pub fn apply_config(&self, config_json: &str) -> Result<ApplyConfigResult, EngineError> {
        let new = NativeConfig::from_json(config_json)?;
        let old = self.config.lock().clone();
        let restart_required = old.restart_required(&new);
        self.apply_limits(new.download_limit_bps, new.upload_limit_bps);
        *self.config.lock() = new.clone();
        {
            let mut m = self.meta.lock();
            m.data.config = Some(new);
            m.mark_dirty();
        }
        self.save_meta();
        let _ = self.run(OP_TIMEOUT, self.tick_soon());
        Ok(ApplyConfigResult { restart_required })
    }

    pub fn effective_config(&self) -> NativeConfig {
        self.config.lock().clone()
    }

    pub fn set_transfers_allowed(&self, allowed: bool, reason: &str) -> Result<(), EngineError> {
        let reason = reason.trim().to_string();
        {
            let mut b = self.blocked.lock();
            if allowed {
                b.retain(|r| *r != reason);
            } else if !b.contains(&reason) {
                b.push(reason);
                b.sort();
            }
            let mut m = self.meta.lock();
            m.data.blocked = b.clone();
            m.mark_dirty();
        }
        self.save_meta();
        self.run(OP_TIMEOUT, self.tick_soon())?;
        Ok(())
    }

    // ---- governance tick ------------------------------------------------------------------------

    fn start_tick_loop(self: &Arc<Self>) {
        let me = self.clone();
        let jh = self.handle.spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(1));
            iv.set_missed_tick_behavior(MissedTickBehavior::Skip);
            loop {
                iv.tick().await;
                let e = me.clone();
                // A panic in one tick must not stop the loop.
                let _ = tokio::spawn(async move { e.tick().await }).await;
            }
        });
        *self.tick_task.lock() = Some(jh);
    }

    /// Output folder join of every included, non-padding file; true when one is gone from disk
    /// although the torrent had verified data before.
    fn files_missing(&self, id: &str, h: &Handle20) -> Option<ErrorInfo> {
        let had_progress = self
            .meta
            .lock()
            .get(id)
            .map(|m| m.max_progress_bytes > 0)
            .unwrap_or(false);
        if !had_progress {
            return None;
        }
        let only = h.only_files();
        let folder = h.output_folder().to_path_buf();
        let missing = h
            .with_metadata(|m| {
                m.file_infos.iter().enumerate().any(|(i, fi)| {
                    !fi.attrs.padding
                        && fi.len > 0
                        && only.as_ref().map(|o| o.contains(&i)).unwrap_or(true)
                        && !folder.join(&fi.relative_filename).exists()
                })
            })
            .unwrap_or(false);
        if missing {
            Some(ErrorInfo {
                code: ErrorCode::FilesMissing,
                message: "Some downloaded files are missing. Recheck to download them again."
                    .to_string(),
            })
        } else {
            None
        }
    }

    async fn ensure_paused(&self, h: &Handle20) {
        let rq = rq_state(&h.stats());
        if is_running(rq) {
            if let Err(e) = self.session.pause(h).await {
                warn!("pause failed: {e:#}");
            }
        }
    }

    async fn ensure_running(&self, id: &str, h: &Handle20) {
        let rq = rq_state(&h.stats());
        if rq == RqState::Paused || rq == (RqState::Initializing { paused: true }) {
            if let Err(e) = self.session.unpause(h).await {
                let (code, message) = classify_runtime_error(&format!("{e:#}"));
                warn!("resume failed: {e:#}");
                self.meta.lock().update(id, |m| {
                    m.last_error = Some(ErrorInfo { code, message });
                    m.queued = false;
                });
            }
        }
    }

    async fn apply_action(&self, a: Action, by_id: &HashMap<String, Handle20>) {
        match a {
            Action::Pause { id, reason } => {
                self.meta.lock().update(&id, |m| {
                    m.paused_by = Some(reason);
                    m.queued = false;
                });
                if let Some(h) = by_id.get(&id) {
                    self.ensure_paused(h).await;
                }
            }
            Action::Queue { id } => {
                self.meta.lock().update(&id, |m| {
                    m.paused_by = None;
                    m.queued = true;
                });
                if let Some(h) = by_id.get(&id) {
                    self.ensure_paused(h).await;
                }
            }
            Action::Park { id } => {
                self.meta.lock().update(&id, |m| {
                    m.paused_by = None;
                    m.queued = false;
                });
                if let Some(h) = by_id.get(&id) {
                    self.ensure_paused(h).await;
                }
            }
            Action::Resume { id } => {
                if let Some(h) = by_id.get(&id) {
                    if let Some(err) = self.files_missing(&id, h) {
                        self.meta.lock().update(&id, |m| {
                            m.last_error = Some(err);
                            m.queued = false;
                        });
                        return;
                    }
                    self.meta.lock().update(&id, |m| {
                        m.paused_by = None;
                        m.queued = false;
                    });
                    self.ensure_running(&id, h).await;
                }
            }
        }
    }

    /// One governance pass: refresh counters, plan, apply, persist.
    pub async fn tick(&self) {
        let _guard = self.tick_lock.lock().await;
        // Wall-clock time since the previous pass, however it was triggered.
        let elapsed = {
            let mut last = self.last_seed_tick.lock();
            let d = last.elapsed();
            *last = Instant::now();
            d
        };
        let handles = self.handles();
        let now = now_secs();
        let cfg = self.config.lock().clone();
        let blocked = self.blocked.lock().clone();
        let mut facts: Vec<TorrentFacts> = Vec::with_capacity(handles.len());
        let mut by_id: HashMap<String, Handle20> = HashMap::with_capacity(handles.len());
        // Torrents being moved are not startable, not counted against the queue and never touched.
        let moving: HashSet<String> = self.moves.lock().keys().cloned().collect();

        {
            let mut meta = self.meta.lock();
            for h in &handles {
                let id = h.info_hash().as_string();
                if moving.contains(&id) {
                    // Kept in `by_id` so its metadata is not swept as stale; kept out of `facts`.
                    by_id.insert(id, h.clone());
                    continue;
                }
                if !meta.contains(&id) {
                    meta.insert(&id, default_meta(h, now));
                }
                let stats = h.stats();
                let rq = rq_state(&stats);
                let running = is_running(rq);
                let mut changed = false;
                let Some(m) = meta.get_mut(&id) else { continue };
                let before = m.clone();

                let (uploaded, base, last) =
                    uploaded_total(m.uploaded_base, m.last_uploaded_seen, stats.uploaded_bytes);
                m.uploaded_base = base;
                m.last_uploaded_seen = last;
                if stats.progress_bytes > m.max_progress_bytes {
                    m.max_progress_bytes = stats.progress_bytes;
                }
                let errored = m.last_error.is_some() || rq == RqState::Error;
                let state = derive_state(StateInputs {
                    rq,
                    finished: stats.finished,
                    paused_by: m.paused_by.as_deref(),
                    queued: m.queued,
                    has_error: errored,
                    resolving: false,
                });
                m.seeding_ms = accumulate_seed_ms(
                    m.seeding_ms,
                    elapsed,
                    state == TorrentState::Seeding,
                );
                let ratio = if stats.progress_bytes == 0 {
                    0.0
                } else {
                    uploaded as f64 / stats.progress_bytes as f64
                };
                facts.push(TorrentFacts {
                    id: id.clone(),
                    added_at: m.added_at,
                    finished: stats.finished,
                    running,
                    paused_by: m.paused_by.clone(),
                    queued: m.queued,
                    errored,
                    ratio,
                    seeding_secs: (m.seeding_ms / 1000) as i64,
                    limits_waived: m.limits_waived,
                });
                if *m != before {
                    changed = true;
                }
                if changed {
                    meta.mark_dirty();
                }
                by_id.insert(id, h.clone());
            }

            // Drop entries whose torrent is gone (for example removed by a failed restore).
            let stale: Vec<String> = meta
                .data
                .torrents
                .iter()
                .filter(|(id, m)| {
                    !by_id.contains_key(*id)
                        && !moving.contains(*id)
                        && m.pending.is_none()
                        && now - m.added_at > ORPHAN_GRACE_SECS
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in stale {
                meta.remove(&id);
            }
        }

        let actions = plan(&facts, &cfg.scheduler(), &blocked);
        let structural = !actions.is_empty();
        for a in actions {
            self.apply_action(a, &by_id).await;
        }

        let should_save = {
            let meta = self.meta.lock();
            meta.is_dirty() && (structural || self.last_save.lock().elapsed() >= SOFT_SAVE_INTERVAL)
        };
        if should_save {
            self.save_meta();
        }
    }

    // ---- shutdown -------------------------------------------------------------------------------

    pub fn shutdown(&self) -> Result<(), EngineError> {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        if let Some(t) = self.tick_task.lock().take() {
            t.abort();
        }
        for (_, t) in self.pending_tasks.lock().drain() {
            t.abort();
        }
        self.stream.stop();
        self.save_meta();
        let rt = self.runtime.lock().take();
        if let Some(rt) = rt {
            // Session::stop pauses every torrent, cancels all tasks and waits a second for them to end.
            let _ = rt.block_on(async {
                tokio::time::timeout(Duration::from_secs(8), self.session.stop()).await
            });
            rt.shutdown_timeout(Duration::from_secs(3));
        }
        Ok(())
    }

    pub fn version() -> String {
        serde_json::json!({ "engine": "librqbit", "version": librqbit::version() }).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_escape_url_syntax_characters() {
        assert_eq!(file_url("/a/b.txt"), "file:///a/b.txt");
        assert_eq!(file_url("/a b/c#d?e%f"), "file:///a%20b/c%23d%3Fe%25f");
    }

    #[test]
    fn web_seed_host_drops_scheme_path_and_credentials() {
        assert_eq!(web_seed_host("https://mirror.example.org/pub/x.iso"), "mirror.example.org");
        assert_eq!(web_seed_host("http://u:p@host.test:8080/a?b=1"), "host.test:8080");
        assert_eq!(web_seed_host("http://[::1]:80/"), "[::1]:80");
        assert_eq!(web_seed_host("http://host.test"), "host.test");
    }

    #[test]
    fn rates_need_a_sample_at_least_200ms_old() {
        let t0 = Instant::now();
        assert_eq!(rates_since(None, t0, 100, 50), (0, 0));
        assert_eq!(rates_since(Some(&(0, 0, t0)), t0, 100, 50), (0, 0));
        let later = t0 + Duration::from_secs(2);
        assert_eq!(rates_since(Some(&(100, 0, t0)), later, 300, 40), (100, 20));
    }

    #[test]
    fn bps_zero_means_unlimited_and_large_values_clamp() {
        assert!(nonzero_bps(0).is_none());
        assert_eq!(nonzero_bps(1000).unwrap().get(), 1000);
        assert_eq!(nonzero_bps(u64::MAX).unwrap().get(), u32::MAX);
    }
}
