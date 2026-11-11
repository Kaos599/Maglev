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

use crate::config::NativeConfig;
use crate::error::{classify_add_error, classify_runtime_error, EngineError, ErrorCode};
use crate::meta::{MetaStore, PendingAdd, TorrentMeta};
use crate::scheduler::{
    derive_state, plan, uploaded_total, Action, RqState, StateInputs, TorrentFacts, TorrentState,
    PAUSED_BY_SEED_LIMIT, PAUSED_BY_USER,
};
use crate::simd::{downsample_bitfield, MATRIX_SIZE};
use crate::source::{parse_source, Source};
use crate::streaming::StreamServer;
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
        let trimmed = config_json.trim();
        let cfg = if trimmed.is_empty() || trimmed == "null" {
            meta.data.config.clone().unwrap_or_default()
        } else {
            NativeConfig::from_json(trimmed)?
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
        });

        engine.resume_pending_adds();
        engine.start_tick_loop();
        // Apply queue and governance rules once before the first list call.
        let _ = engine.run(OP_TIMEOUT, engine.tick());
        Ok(engine)
    }

    pub fn init_result(&self) -> InitResult {
        InitResult {
            stream_port: self.stream.port,
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
        Snapshot {
            id: id.to_string(),
            name: h.name().unwrap_or_else(|| "Unnamed torrent".to_string()),
            state,
            paused_by: m.paused_by.clone(),
            progress_bytes: stats.progress_bytes,
            total_bytes: stats.total_bytes,
            uploaded_bytes: uploaded,
            down_bps,
            up_bps,
            peers_live,
            peers_seen,
            eta_secs,
            ratio,
            seeding_secs: m.seeding_secs,
            added_at: m.added_at,
            output_folder: h.output_folder().to_string_lossy().into_owned(),
            error,
        }
    }

    fn pending_snapshot(&self, id: &str, m: &TorrentMeta, p: &PendingAdd) -> Snapshot {
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
            progress_bytes: 0,
            total_bytes: 0,
            uploaded_bytes: 0,
            down_bps: 0,
            up_bps: 0,
            peers_live: 0,
            peers_seen: 0,
            eta_secs: -1,
            ratio: 0.0,
            seeding_secs: 0,
            added_at: m.added_at,
            output_folder: p
                .output_folder
                .clone()
                .unwrap_or_else(|| self.default_dir.to_string_lossy().into_owned()),
            error: p.error.clone(),
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
        let files: Vec<FileDetail> = h
            .with_metadata(|md| {
                md.file_infos
                    .iter()
                    .enumerate()
                    .filter(|(_, fi)| !fi.attrs.padding)
                    .map(|(i, fi)| FileDetail {
                        index: i as u32,
                        path: fi.relative_filename.to_string_lossy().into_owned(),
                        length: fi.len,
                        progress_bytes: stats.file_progress.get(i).copied().unwrap_or(0),
                        included: only.as_ref().map(|o| o.contains(&i)).unwrap_or(true),
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
                let (down_bps, up_bps) = match previous.get(&key) {
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
                };
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
        let ok = h
            .with_metadata(|m| idx < m.file_infos.len())
            .unwrap_or(false);
        if !ok {
            return Err(EngineError::not_found());
        }
        Ok(serde_json::json!({ "url": self.stream.url(&id, idx as u32) }))
    }

    // ---- adding ---------------------------------------------------------------------------------

    async fn resolve_source(
        &self,
        src: &Source,
        raw: &str,
        limit: Option<Duration>,
    ) -> Result<Resolved, EngineError> {
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

    pub fn resolve_metadata(&self, source: &str, timeout_ms: i64) -> Result<Metadata, EngineError> {
        let src = parse_source(source)?;
        let limit = Duration::from_millis(timeout_ms.clamp(1_000, 600_000) as u64);
        // The inner timeout produces METADATA_TIMEOUT; the outer one is only a safety net.
        let r = self.run(
            limit + Duration::from_secs(5),
            self.resolve_source(&src, source, Some(limit)),
        )??;
        Ok(Metadata {
            info_hash: r.info_hash,
            name: r.name,
            total_bytes: r.total_bytes,
            files: r.files,
        })
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
        let add_opts = AddTorrentOptions {
            // Always added paused; the planner starts it when a slot is free.
            paused: true,
            // Reuse files that are already on disk instead of failing.
            overwrite: true,
            only_files: opts
                .only_files
                .as_ref()
                .map(|v| v.iter().map(|i| *i as usize).collect()),
            output_folder,
            ..Default::default()
        };
        match self
            .session
            .add_torrent(AddTorrent::from_bytes(r.torrent_bytes.clone()), Some(add_opts))
            .await
        {
            Ok(AddTorrentResponse::Added(_, _)) => Ok(()),
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
                    error: None,
                };
                self.meta.lock().insert(&id, initial_meta(Some(pending.clone())));
                self.save_meta();
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
                let _ = self.run(OP_TIMEOUT, self.tick());
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
            self.run(OP_TIMEOUT, self.tick())?;
        }
        Ok(())
    }

    pub fn recheck(&self, id: &str) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
        let h = self.find(hash).ok_or_else(EngineError::not_found)?;
        let bytes = h
            .with_metadata(|m| m.torrent_bytes.clone())
            .map_err(|_| EngineError::internal("This torrent has no info to check yet"))?;
        let only_files = h.only_files();
        let folder = h.output_folder().to_string_lossy().into_owned();
        self.run(DELETE_TIMEOUT, async {
            self.session
                .delete(TorrentIdOrHash::Hash(hash), false)
                .await
                .map_err(|e| {
                    let (code, message) = classify_runtime_error(&format!("{e:#}"));
                    EngineError::new(code, message)
                })?;
            let opts = AddTorrentOptions {
                paused: true,
                overwrite: true,
                only_files,
                output_folder: Some(folder),
                ..Default::default()
            };
            self.session
                .add_torrent(AddTorrent::from_bytes(bytes), Some(opts))
                .await
                .map(|_| ())
                .map_err(|e| classify_add_error(&format!("{e:#}")))
        })??;
        self.meta.lock().update(&id, |m| {
            m.last_error = None;
            m.max_progress_bytes = 0;
            m.queued = m.paused_by.is_none();
        });
        self.save_meta();
        let _ = self.run(OP_TIMEOUT, self.tick());
        Ok(())
    }

    pub fn delete(&self, id: &str, delete_files: bool) -> Result<(), EngineError> {
        let (id, hash) = Self::parse_id(id)?;
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
        self.peer_cache.lock().retain(|k, _| !k.starts_with(&format!("{id}|")));
        self.save_meta();
        if !had_handle && !in_meta {
            return Err(EngineError::not_found());
        }
        Ok(())
    }

    pub fn set_included_files(&self, id: &str, indices_json: &str) -> Result<(), EngineError> {
        let (_, hash) = Self::parse_id(id)?;
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
        let _ = self.run(OP_TIMEOUT, self.tick());
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
        let _ = self.run(OP_TIMEOUT, self.tick());
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
        self.run(OP_TIMEOUT, self.tick())?;
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
        let handles = self.handles();
        let now = now_secs();
        let cfg = self.config.lock().clone();
        let blocked = self.blocked.lock().clone();
        let mut facts: Vec<TorrentFacts> = Vec::with_capacity(handles.len());
        let mut by_id: HashMap<String, Handle20> = HashMap::with_capacity(handles.len());

        {
            let mut meta = self.meta.lock();
            for h in &handles {
                let id = h.info_hash().as_string();
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
                if state == TorrentState::Seeding {
                    m.seeding_secs += 1;
                }
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
                    seeding_secs: m.seeding_secs,
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
    fn bps_zero_means_unlimited_and_large_values_clamp() {
        assert!(nonzero_bps(0).is_none());
        assert_eq!(nonzero_bps(1000).unwrap().get(), 1000);
        assert_eq!(nonzero_bps(u64::MAX).unwrap().get(), u32::MAX);
    }
}
