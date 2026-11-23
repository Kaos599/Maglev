//! HLS and DASH downloads on top of the link downloader (`NATIVE_CONTRACT.md` section 24.8).
//!
//! A child of `driver`, so it can use the manager's private state. The pure parts (parsers, plan, names, resume
//! math) are in `http_dl::stream`; this file holds what needs the list, the files and the machine:
//!
//! - `do_probe_stream`: reads the playlist, picks the name, sets the size estimate (`estBytes`).
//! - `transfer_stream`: reads the playlist again, then fetches the segments of each track: up to 3 at once, written
//!   strictly in order, each through the download client (headers, proxy, LAN rules). Retries, stall rule, speed
//!   limits, free-space checks and governance behave as for any link download.
//! - `finish_mux`: Kotlin joined the video and audio parts (or failed).
//! - `refresh_stream_url`: a new playlist link for a download that needs one.
//! - `probe_stream`: the add sheet's probe.
//!
//! Keys and links are never logged. AES keys live in the `keys` map of one transfer only.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::task::JoinSet;

use super::*;
use crate::http_dl::redirect::SendError;
use crate::http_dl::sidecar::{StreamSide, TrackSide};
use crate::http_dl::stream::fetch::{self, FetchFail, ReqCtx};
use crate::http_dl::stream::{
    self, mp4_mux, plan, ResolveFail, StreamKind, StreamProbe, TrackPlan, MAX_IN_FLIGHT, MAX_SEGMENT_BYTES, PAIR_IN_FLIGHT,
};

pub(super) fn stream_dl_error(e: StreamError) -> DlError {
    match e {
        StreamError::Protected => DlError::StreamProtected,
        StreamError::Live => DlError::StreamLive,
        StreamError::Unsupported => DlError::StreamUnsupported,
    }
}

/// Turns a failed playlist or segment request into what the probe code understands.
fn probe_fail_of(r: ResolveFail, typed_host: &str) -> ProbeFail {
    match r {
        ResolveFail::Stream(e) => ProbeFail::Stream(e),
        ResolveFail::Fetch(f) => match f {
            FetchFail::Status(401, _) => ProbeFail::Auth(401),
            FetchFail::Status(403, _) => ProbeFail::Refused(403),
            FetchFail::Status(s, _) => ProbeFail::Status(s),
            FetchFail::Send(e) => match refusal(&e, typed_host) {
                Some(Refusal::LanAddress) => ProbeFail::LanAddress,
                Some(Refusal::Redirect) => ProbeFail::LocalRedirect,
                None => ProbeFail::Net,
            },
            FetchFail::Body(_) | FetchFail::Short | FetchFail::Sink(_) => ProbeFail::Net,
            FetchFail::TooBig | FetchFail::RangeIgnored => ProbeFail::Stream(StreamError::Unsupported),
        },
    }
}

/// One track's part file and how far it got.
struct TrackRun {
    file: Arc<File>,
    /// Segments written (the init segment counts as the first).
    done: usize,
    /// Byte length of the part file after those segments.
    bytes: u64,
}

enum TrackEnd {
    Done,
    Stopped,
    /// The connection broke or a segment came up short.
    Broken,
    Stalled,
    Status(u16, Option<Duration>),
    Send(SendError),
    /// The machine event to feed; the transfer ends.
    Fatal(Event),
}

fn end_of_fail(f: FetchFail) -> TrackEnd {
    match f {
        FetchFail::Status(s, ra) => TrackEnd::Status(s, ra),
        FetchFail::Send(e) => TrackEnd::Send(e),
        FetchFail::Body(_) | FetchFail::Short | FetchFail::Sink(_) => TrackEnd::Broken,
        FetchFail::TooBig | FetchFail::RangeIgnored => TrackEnd::Fatal(Event::StreamRefused(DlError::StreamUnsupported)),
    }
}

/// The segments being fetched. Dropping it cancels them.
struct Window(VecDeque<JoinHandle<Result<Vec<u8>, FetchFail>>>);

impl Drop for Window {
    fn drop(&mut self) {
        for h in self.0.iter() {
            h.abort();
        }
    }
}

/// Cancels background subtitle prefetching if the transfer exits early (pause, cancel, error).
struct SubPrefetch(Option<JoinHandle<Vec<mp4_mux::SubtitleTrack>>>);

impl Drop for SubPrefetch {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            h.abort();
        }
    }
}

/// Lock-protected cursor/end range for one active `Pair` worker, allowing lock-free-overlap
/// IDM-style dynamic work-stealing (splitting the tail half of the slowest worker).
struct PairJob {
    track: usize,
    base_url: String,
    range: Mutex<(u64, u64)>,
}

impl PairJob {
    /// Atomically steals the upper half of this job's remaining bytes when at least `min_split` bytes remain.
    /// Returns `Some((stolen_start, stolen_end))` with zero overlap against this job's cursor.
    fn try_steal_half(&self, min_split: u64) -> Option<(u64, u64)> {
        let mut st = self.range.lock();
        let rem = st.1.saturating_sub(st.0);
        if rem < min_split {
            return None;
        }
        let mid = (st.0 + rem / 2) & !4095;
        if mid <= st.0 + 128 * 1024 || st.1 <= mid + 128 * 1024 {
            return None;
        }
        let old_end = st.1;
        st.1 = mid;
        Some((mid, old_end))
    }
}

/// Returns the contiguous covered byte length starting at 0 from a set of completed `[start, end)` intervals.
fn merged_contiguous_prefix(intervals: &[(u64, u64)]) -> u64 {
    let mut sorted: Vec<(u64, u64)> = intervals.iter().copied().filter(|(s, e)| e > s).collect();
    sorted.sort_by_key(|(s, _)| *s);
    let mut pref = 0u64;
    for (s, e) in sorted {
        if s <= pref {
            pref = pref.max(e);
        } else {
            break;
        }
    }
    pref
}

/// What every call of the track loop needs.
struct StreamCtx<'a> {
    id: &'a str,
    ctx: &'a ReqCtx,
    folder: &'a Path,
    name: &'a str,
    url: &'a str,
    est: Option<u64>,
    tracks: &'a [TrackPlan],
    max_in_flight: usize,
}

impl Downloads {
    /// The request context of a stored download: its client and its in-memory headers.
    fn req_ctx(&self, id: &str) -> Result<ReqCtx, ProbeFail> {
        let client = self.client_for_id(id).map_err(|_| ProbeFail::Net)?;
        self.update(id, |r, l| ReqCtx {
            client,
            user_agent: l.user_agent.clone(),
            referer: l.referer.clone(),
            origin: l.origin.clone(),
            cookie: l.cookie.clone(),
            host_cookies: l.host_cookies.clone(),
            auth: l.auth.clone(),
            origin_host: host_of(&r.url),
        })
        .ok_or(ProbeFail::Net)
    }

    /// Reads the playlist, picks the file name once, and stores the estimate as the size.
    pub(super) async fn do_probe_stream(&self, id: &str) -> Result<(), ProbeFail> {
        let (url, st, requested) = self
            .update(id, |r, _| (r.url.clone(), r.stream.clone(), r.requested_name.clone()))
            .ok_or(ProbeFail::Net)?;
        let st = st.ok_or(ProbeFail::Net)?;
        if self.pin_lan_host(id).await.is_err() {
            return Err(ProbeFail::Net);
        }
        let ctx = self.req_ctx(id)?;
        let host = host_of(&url);
        let resolved = stream::resolve(&ctx, &url, &st.spec()).await.map_err(|e| probe_fail_of(e, &host))?;
        let base = plan::base_name(requested.as_deref(), &url);
        let wanted = sanitize_filename(&plan::output_name(&base, resolved.height, resolved.extension()));
        let total_items = resolved.total_items();
        let est = resolved.est_bytes;

        let mut guard = self.inner.lock();
        let inner = &mut *guard;
        let taken_by_others: Vec<String> = inner
            .records
            .values()
            .filter(|r| r.id != id && !r.name.is_empty())
            .map(|r| format!("{}\u{0}{}", r.folder, r.name))
            .collect();
        if let Some(rec) = inner.records.get_mut(id) {
            rec.size = est;
            rec.validator = None;
            rec.resumable = false;
            rec.final_url = Some(display_url(&url));
            if let Some(s) = rec.stream.as_mut() {
                s.segments_total = total_items;
            }
            if rec.name.is_empty() {
                let folder = PathBuf::from(&rec.folder);
                let key = rec.folder.clone();
                rec.name = unique_name(&wanted, |n| {
                    final_path(&folder, n).exists()
                        || part_path(&folder, n).exists()
                        || folder.join(format!("{n}.video.part")).exists()
                        || folder.join(format!("{n}.audio.part")).exists()
                        || taken_by_others.contains(&format!("{key}\u{0}{n}"))
                });
            }
        }
        Ok(())
    }

    /// The probe of the add sheet. Nothing is stored.
    pub async fn probe_stream(&self, url: &str, options_json: &str) -> Result<StreamProbe, EngineError> {
        let opts = parse_options(options_json)?;
        let (clean, auth) = parse_http_url(url)?;
        if self.network_blocked() {
            return Err(EngineError::new(ErrorCode::Blocked, BLOCKED_MSG));
        }
        let (client, _) = self.scoped_client(clean.as_str(), opts.allow_lan).await?;
        let h = opts.headers.unwrap_or_default();
        let host_cookies = h.host_cookies();
        let host = host_of(clean.as_str());
        let ctx = ReqCtx {
            client,
            user_agent: h.user_agent,
            referer: h.referer,
            origin: h.origin,
            cookie: h.cookie,
            host_cookies,
            auth,
            origin_host: host.clone(),
        };
        stream::probe(&ctx, clean.as_str()).await.map_err(|e| probe_error(probe_fail_of(e, &host)))
    }

    /// Kotlin finished (or failed) joining `<name>.video.part` and `<name>.audio.part` into `<name>`.
    pub fn finish_mux(self: &Arc<Self>, id: &str, ok: bool, message: Option<&str>) -> Result<(), EngineError> {
        let (state, needed) = self.update(id, |r, _| (r.state, r.mux_needed)).ok_or_else(EngineError::not_found)?;
        if state != State::Verifying || !needed {
            return Err(EngineError::new(
                ErrorCode::InvalidState,
                "This download isn't waiting for its video and audio to be joined",
            ));
        }
        if ok {
            self.dispatch(id, Event::HashOk);
        } else {
            if let Some(m) = message {
                warn!("joining video and audio failed: {}", m.chars().take(200).collect::<String>());
            }
            self.dispatch(id, Event::MuxFailed);
        }
        Ok(())
    }

    /// A new playlist link for a download in `needs_link`. When the segment list has the same size the download
    /// goes on from the next missing segment; otherwise it starts over (contract 24.8).
    pub(super) async fn refresh_stream_url(
        self: &Arc<Self>,
        id: &str,
        clean: reqwest::Url,
        auth: Option<(String, String)>,
        opts: DownloadOptions,
    ) -> Result<(), EngineError> {
        let (spec, known_total) = self
            .update(id, |r, _| (r.stream.as_ref().map(|s| s.spec()), r.stream.as_ref().map(|s| s.segments_total).unwrap_or(0)))
            .ok_or_else(EngineError::not_found)?;
        let spec = spec.ok_or_else(EngineError::not_found)?;
        let (client, pinned) = self.scoped_client(clean.as_str(), opts.allow_lan).await?;
        let h = opts.headers.clone().unwrap_or_default();
        let host_cookies = h.host_cookies();
        let host = host_of(clean.as_str());
        let ctx = ReqCtx {
            client,
            user_agent: h.user_agent.clone(),
            referer: h.referer.clone(),
            origin: h.origin.clone(),
            cookie: h.cookie.clone(),
            host_cookies: host_cookies.clone(),
            auth: auth.clone(),
            origin_host: host.clone(),
        };
        let resolved = stream::resolve(&ctx, clean.as_str(), &spec)
            .await
            .map_err(|e| probe_error(with_link_login(probe_fail_of(e, &host), auth.is_some())))?;
        let same = known_total == 0 || resolved.total_items() == known_total;
        let needs_login = auth.is_some() || h.cookie.is_some() || !host_cookies.is_empty() || has_secret_query(clean.as_str());
        self.update(id, |rec, live| {
            if !same {
                delete_partial(rec);
                rec.held = 0;
                if let Some(s) = rec.stream.as_mut() {
                    s.segments_done = 0;
                }
            }
            rec.url = clean.to_string();
            rec.final_url = Some(display_url(clean.as_str()));
            rec.status = None;
            rec.needs_login = needs_login;
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
        self.dispatch(id, Event::NewLink { matches: true });
        self.pump();
        Ok(())
    }

    /// A failing status from a playlist, key or segment. True when the transfer should go on (a retry was
    /// scheduled), false when the machine took it (or the budget ran out).
    async fn handle_status(self: &Arc<Self>, id: &str, status: u16, retry_after: Option<Duration>) -> bool {
        match status {
            401 | 403 => {
                let n = self.update(id, |r, l| {
                    r.status = Some(status);
                    l.denied += 1;
                    l.denied
                });
                if status == 401 || n.unwrap_or(3) >= 3 {
                    self.dispatch(id, Event::Auth);
                    return false;
                }
                self.transient(id, None).await
            }
            // The link or the segment is gone: ask for a new link (LINK_EXPIRED).
            404 | 410 => {
                self.update(id, |r, _| r.status = Some(status));
                self.dispatch(id, Event::Auth);
                false
            }
            408 | 429 | 500 | 502 | 503 | 504 => self.transient(id, retry_after).await,
            _ => {
                self.update(id, |r, _| r.status = Some(status));
                self.dispatch(id, Event::HttpFatal);
                false
            }
        }
    }

    fn flush_stream_side(&self, c: &StreamCtx<'_>, runs: &[TrackRun]) {
        tokio::task::block_in_place(|| {
            for r in runs {
                let _ = r.file.sync_data();
            }
            let mut sc = Sidecar::new(c.url, c.name, c.est, None);
            sc.stream = Some(StreamSide {
                tracks: runs
                    .iter()
                    .zip(c.tracks.iter())
                    .map(|(r, t)| TrackSide { done: r.done, bytes: r.bytes, total: t.items.len() })
                    .collect(),
            });
            // Skipped when the download was removed meanwhile.
            let guard = self.inner.lock();
            if guard.records.contains_key(c.id) {
                let _ = sc.save(&sidecar_path(c.folder, c.name));
            }
        });
    }

    /// The transfer task of a stream download.
    pub(super) async fn transfer_stream(self: Arc<Self>, id: String) {
        // A download restored before its probe ran has no name yet.
        let probed = self.update(&id, |r, _| !r.name.is_empty()).unwrap_or(false);
        if !probed {
            loop {
                match self.do_probe_stream(&id).await {
                    Ok(()) => break,
                    Err(ProbeFail::Net) => {
                        if !self.transient(&id, None).await {
                            return;
                        }
                    }
                    Err(ProbeFail::Auth(s)) | Err(ProbeFail::Refused(s)) | Err(ProbeFail::Status(s)) => {
                        if !self.handle_status(&id, s, None).await {
                            return;
                        }
                    }
                    Err(ProbeFail::LocalRedirect) => {
                        self.dispatch(&id, Event::LocalRedirect);
                        return;
                    }
                    Err(ProbeFail::LanAddress) => {
                        self.dispatch(&id, Event::LanAddress);
                        return;
                    }
                    Err(ProbeFail::Stream(e)) => {
                        self.dispatch(&id, Event::StreamRefused(stream_dl_error(e)));
                        return;
                    }
                    Err(ProbeFail::Html) => {
                        self.dispatch(&id, Event::NotAFile);
                        return;
                    }
                }
            }
        }
        if self.pin_lan_host(&id).await.is_err() && !self.transient(&id, None).await {
            return;
        }
        let ctx = match self.req_ctx(&id) {
            Ok(c) => c,
            Err(_) => {
                self.dispatch(&id, Event::Transient { attempts: MAX_ATTEMPTS });
                return;
            }
        };
        let (url, spec, typed_host) = match self.update(&id, |r, _| (r.url.clone(), r.stream.as_ref().map(|s| s.spec()), host_of(&r.url))) {
            Some((u, Some(s), h)) => (u, s, h),
            _ => return,
        };

        // Read the playlists again: segment links are never saved.
        let resolved = loop {
            if self.state_of(&id) != Some(State::Downloading) {
                return;
            }
            match stream::resolve(&ctx, &url, &spec).await {
                Ok(r) => break r,
                Err(e) => match probe_fail_of(e, &typed_host) {
                    ProbeFail::Net => {
                        if !self.transient(&id, None).await {
                            return;
                        }
                    }
                    ProbeFail::Auth(s) | ProbeFail::Refused(s) | ProbeFail::Status(s) => {
                        if !self.handle_status(&id, s, None).await {
                            return;
                        }
                    }
                    ProbeFail::LocalRedirect => {
                        self.dispatch(&id, Event::LocalRedirect);
                        return;
                    }
                    ProbeFail::LanAddress => {
                        self.dispatch(&id, Event::LanAddress);
                        return;
                    }
                    ProbeFail::Stream(e) => {
                        self.dispatch(&id, Event::StreamRefused(stream_dl_error(e)));
                        return;
                    }
                    ProbeFail::Html => {
                        self.dispatch(&id, Event::NotAFile);
                        return;
                    }
                },
            }
        };

        let n_items = resolved.total_items();
        let est = resolved.est_bytes;
        let (folder, name) = self
            .update(&id, |r, _| {
                if let Some(s) = r.stream.as_mut() {
                    s.segments_total = n_items;
                }
                if est.is_some() {
                    r.size = est;
                }
                (PathBuf::from(&r.folder), r.name.clone())
            })
            .unwrap_or_default();
        if let Err(e) = std::fs::create_dir_all(&folder) {
            self.dispatch(&id, io_event(&e, 0));
            return;
        }

        // Open one part file per track and decide where each continues.
        let side = Sidecar::load(&sidecar_path(&folder, &name)).and_then(|s| s.stream);
        let tracks = &resolved.tracks;
        let mut runs: Vec<TrackRun> = Vec::new();
        for (i, t) in tracks.iter().enumerate() {
            let path = folder.join(plan::part_file_name(&name, t.role));
            let file = match OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path) {
                Ok(f) => f,
                Err(e) => {
                    self.dispatch(&id, io_event(&e, 0));
                    return;
                }
            };
            let saved = side.as_ref().filter(|s| s.tracks.len() == tracks.len()).and_then(|s| s.tracks.get(i));
            let flen = file.metadata().map(|m| m.len()).unwrap_or(0);
            let (done, bytes) = plan::resume_point(saved, t.items.len(), flen);
            if let Err(e) = file.set_len(bytes) {
                self.dispatch(&id, io_event(&e, 0));
                return;
            }
            runs.push(TrackRun { file: Arc::new(file), done, bytes });
        }
        let held0: u64 = runs.iter().map(|r| r.bytes).sum();
        let done0: usize = runs.iter().map(|r| r.done).sum();
        let free = tokio::task::block_in_place(|| free_space(&folder));
        if !fits(est, held0, free) {
            self.dispatch(&id, Event::Enospc);
            return;
        }
        self.update(&id, |r, _| {
            r.held = held0;
            if let Some(s) = r.stream.as_mut() {
                s.segments_done = done0;
            }
        });

        let mux = resolved.mux_needed();
        // Fast pure-Rust MP4 muxing for direct `Pair` downloads (YouTube):
        // avoids Android MediaExtractor/MediaMuxer frame-by-frame JNI overhead (finishes in < 0.5s)
        // and embeds all available YouTube subtitle languages as standard `tx3g` (`sbtl`) tracks.
        let want_rust_mux = spec.kind == StreamKind::Pair
            && (mux || (!spec.subtitles.is_empty() && matches!(resolved.extension(), "mp4" | "m4a")));

        // Prefetch tiny YouTube subtitle srv3 XML tracks in parallel while video+audio download,
        // so muxing starts immediately at 100% with zero subtitle fetch wait.
        let mut sub_prefetch = SubPrefetch(if want_rust_mux && !spec.subtitles.is_empty() {
            let subs = spec.subtitles.clone();
            let sub_ctx = ctx.clone();
            Some(self.handle.spawn(async move {
                let mut sub_set: JoinSet<(usize, Option<mp4_mux::SubtitleTrack>)> = JoinSet::new();
                for (si, sub) in subs.into_iter().enumerate() {
                    let cx = sub_ctx.clone();
                    sub_set.spawn(async move {
                        let fetched = tokio::time::timeout(Duration::from_secs(6), fetch::fetch_text(&cx, &sub.url)).await;
                        let track = match fetched {
                            Ok(Ok((xml, _))) => {
                                let cues = mp4_mux::parse_srv3_xml(&xml);
                                if cues.is_empty() {
                                    None
                                } else {
                                    Some(mp4_mux::SubtitleTrack { lang: sub.lang, name: sub.name, cues })
                                }
                            }
                            _ => None,
                        };
                        (si, track)
                    });
                }
                let mut ordered: Vec<(usize, mp4_mux::SubtitleTrack)> = Vec::new();
                while let Some(Ok((si, Some(t)))) = sub_set.join_next().await {
                    ordered.push((si, t));
                }
                ordered.sort_by_key(|(si, _)| *si);
                ordered.into_iter().map(|(_, t)| t).collect()
            }))
        } else {
            None
        });

        let max_in_flight = if spec.kind == StreamKind::Pair { PAIR_IN_FLIGHT } else { MAX_IN_FLIGHT };
        let c = StreamCtx { id: &id, ctx: &ctx, folder: &folder, name: &name, url: &url, est, tracks, max_in_flight };
        let mut keys: HashMap<String, [u8; 16]> = HashMap::new();
        let mut clock = StallClock::new(Instant::now());

        // Unified multi-track download pool with dynamic work-stealing for direct `Pair` downloads (YouTube):
        // downloads video + audio in one continuous 12-connection pool with zero tail drop and zero track-gap dip.
        let unified_pair = spec.kind == StreamKind::Pair
            && !tracks.is_empty()
            && tracks.iter().all(|t| {
                t.base_url.is_some()
                    && t.total_bytes.is_some()
                    && !t.items.is_empty()
                    && t.items.iter().all(|s| s.write_offset.is_some())
            });
        if unified_pair {
            loop {
                if runs.iter().enumerate().all(|(i, r)| r.done >= tracks[i].items.len()) {
                    break;
                }
                match self.run_pair_tracks(&c, &mut runs, &mut clock).await {
                    TrackEnd::Done => break,
                    TrackEnd::Stopped => return,
                    TrackEnd::Broken => {
                        self.flush_stream_side(&c, &runs);
                        if !self.after_break(&id, &mut clock).await {
                            return;
                        }
                    }
                    TrackEnd::Stalled => {
                        if !self.stall_retry(&id, Some(&mut clock)).await {
                            return;
                        }
                    }
                    TrackEnd::Status(s, ra) => {
                        self.flush_stream_side(&c, &runs);
                        if !self.handle_status(&id, s, ra).await {
                            return;
                        }
                    }
                    TrackEnd::Send(e) => {
                        self.flush_stream_side(&c, &runs);
                        if let Some(r) = refusal(&e, &typed_host) {
                            self.dispatch(&id, refusal_event(r));
                            return;
                        }
                        if !self.transient(&id, None).await {
                            return;
                        }
                    }
                    TrackEnd::Fatal(ev) => {
                        self.flush_stream_side(&c, &runs);
                        self.dispatch(&id, ev);
                        return;
                    }
                }
            }
        } else {
            for ti in 0..tracks.len() {
                loop {
                    if runs[ti].done >= tracks[ti].items.len() {
                        break;
                    }
                    match self.run_track(&c, ti, &mut runs, &mut keys, &mut clock).await {
                        TrackEnd::Done => break,
                        TrackEnd::Stopped => return,
                        TrackEnd::Broken => {
                            self.flush_stream_side(&c, &runs);
                            if !self.after_break(&id, &mut clock).await {
                                return;
                            }
                        }
                        TrackEnd::Stalled => {
                            if !self.stall_retry(&id, Some(&mut clock)).await {
                                return;
                            }
                        }
                        TrackEnd::Status(s, ra) => {
                            self.flush_stream_side(&c, &runs);
                            if !self.handle_status(&id, s, ra).await {
                                return;
                            }
                        }
                        TrackEnd::Send(e) => {
                            self.flush_stream_side(&c, &runs);
                            if let Some(r) = refusal(&e, &typed_host) {
                                self.dispatch(&id, refusal_event(r));
                                return;
                            }
                            if !self.transient(&id, None).await {
                                return;
                            }
                        }
                        TrackEnd::Fatal(ev) => {
                            self.flush_stream_side(&c, &runs);
                            self.dispatch(&id, ev);
                            return;
                        }
                    }
                }
            }
        }

        // Every segment of every track is on disk.
        let held: u64 = runs.iter().map(|r| r.bytes).sum();
        if want_rust_mux {
            // Drop open part file handles before reading/removing them.
            drop(runs);

            // Collect prefetched subtitles (usually already done before video+audio finished).
            let parsed_subs: Vec<mp4_mux::SubtitleTrack> = match sub_prefetch.0.take() {
                Some(h) => h.await.unwrap_or_default(),
                None => Vec::new(),
            };

            let primary_part = folder.join(plan::part_file_name(&name, tracks[0].role));
            let secondary_part = if tracks.len() > 1 {
                Some(folder.join(plan::part_file_name(&name, tracks[1].role)))
            } else {
                None
            };
            let out_path = final_path(&folder, &name);
            let p1 = primary_part.clone();
            let p2 = secondary_part.clone();
            let out_clone = out_path.clone();
            let rust_mux_res = tokio::task::spawn_blocking(move || {
                mp4_mux::mux_fmp4(&p1, p2.as_deref(), &parsed_subs, &out_clone)
            })
            .await;

            if matches!(rust_mux_res, Ok(Ok(()))) {
                let _ = std::fs::remove_file(&primary_part);
                if let Some(p2) = &secondary_part {
                    let _ = std::fs::remove_file(p2);
                }
                let final_len = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(held);
                self.update(&id, |r, _| {
                    r.held = final_len;
                    r.size = Some(final_len);
                    // `mux_needed = true` tells `finish_files` that `<name>` is already in place.
                    r.mux_needed = true;
                    if let Some(s) = r.stream.as_mut() {
                        s.segments_done = s.segments_total;
                    }
                });
                if self.state_of(&id) == Some(State::Downloading) {
                    self.dispatch(&id, Event::AllBytes);
                }
                if self.state_of(&id) == Some(State::Verifying) {
                    self.dispatch(&id, Event::HashOk);
                }
                return;
            }
            // Fallback to Kotlin StreamMuxer (or plain rename) if the input wasn't fMP4 (e.g. WebM).
            self.update(&id, |r, _| {
                r.held = held;
                r.size = Some(held);
                r.mux_needed = mux;
                if let Some(s) = r.stream.as_mut() {
                    s.segments_done = s.segments_total;
                }
            });
            if self.state_of(&id) == Some(State::Downloading) {
                self.dispatch(&id, Event::AllBytes);
            }
            if !mux && self.state_of(&id) == Some(State::Verifying) {
                self.dispatch(&id, Event::HashOk);
            }
            return;
        }

        if !mux {
            tokio::task::block_in_place(|| {
                for r in &runs {
                    let _ = r.file.sync_data();
                }
            });
        }
        self.update(&id, |r, _| {
            r.held = held;
            r.size = Some(held);
            r.mux_needed = mux;
            if let Some(s) = r.stream.as_mut() {
                s.segments_done = s.segments_total;
            }
        });
        if self.state_of(&id) == Some(State::Downloading) {
            self.dispatch(&id, Event::AllBytes);
        }
        // Separate parts wait in `verifying` until Kotlin has joined them (`finish_mux`).
        if !mux && self.state_of(&id) == Some(State::Verifying) {
            self.dispatch(&id, Event::HashOk);
        }
    }

    /// Fetches the rest of one track: up to `MAX_IN_FLIGHT` segments at once, written strictly in order.
    async fn run_track(
        self: &Arc<Self>,
        c: &StreamCtx<'_>,
        ti: usize,
        runs: &mut Vec<TrackRun>,
        keys: &mut HashMap<String, [u8; 16]>,
        clock: &mut StallClock,
    ) -> TrackEnd {
        let items = &c.tracks[ti].items;
        let total = items.len();
        let file = runs[ti].file.clone();

        // One whole file (DASH `SegmentBase`): streamed to disk, not held in memory.
        if total == 1 && items[0].whole_file {
            let resp = match c.ctx.send(&items[0].url, None).await {
                Ok(r) => r,
                Err(e) => return TrackEnd::Send(e),
            };
            let status = resp.status().as_u16();
            if status != 200 {
                return TrackEnd::Status(status, None);
            }
            return match self.stream_body(c.id, resp, &file, 0, None, clock).await {
                Streamed::Done(pos) => {
                    let _ = tokio::task::block_in_place(|| file.set_len(pos));
                    runs[ti].bytes = pos;
                    runs[ti].done = 1;
                    TrackEnd::Done
                }
                Streamed::Broken(_) => TrackEnd::Broken,
                Streamed::Stalled(_) => TrackEnd::Stalled,
                Streamed::Stopped => TrackEnd::Stopped,
            };
        }

        let mut next = runs[ti].done;
        let mut window = Window(VecDeque::new());
        let mut limit = self.update(c.id, |r, _| r.down_limit_bps).unwrap_or(0);
        let started = Instant::now();
        let start_bytes = runs[ti].bytes;
        let mut last_flush = Instant::now();
        let mut last_report = Instant::now();
        let mut last_space = Instant::now();
        let mut report_held: u64 = runs.iter().map(|r| r.bytes).sum();
        let mut bps_smooth = 0.0_f64;

        loop {
            if self.state_of(c.id) != Some(State::Downloading) {
                return TrackEnd::Stopped;
            }
            while window.0.len() < c.max_in_flight && next < total {
                let seg = items[next].clone();
                let cx = c.ctx.clone();
                window.0.push_back(
                    self.handle.spawn(async move { fetch::fetch_vec(&cx, &seg.url, seg.range, MAX_SEGMENT_BYTES).await }),
                );
                next += 1;
            }
            let Some(front) = window.0.front_mut() else { break };
            let waited = tokio::time::timeout(STALL_TICK, &mut *front).await;
            let joined = match waited {
                Ok(j) => {
                    window.0.pop_front();
                    j
                }
                Err(_) => {
                    // Nothing finished for a few seconds.
                    if self.stall_step(c.id, limit, clock) {
                        self.flush_stream_side(c, runs);
                        return TrackEnd::Stalled;
                    }
                    continue;
                }
            };
            let bytes = match joined {
                Err(_) => return TrackEnd::Broken,
                Ok(Err(f)) => return end_of_fail(f),
                Ok(Ok(b)) => b,
            };

            // Decrypt (HLS AES-128). The key is fetched once per link and kept in memory only.
            let idx = runs[ti].done;
            let data = match &items[idx].key {
                None => bytes,
                Some(k) => {
                    let cached = keys.get(&k.uri).copied();
                    let key = match cached {
                        Some(v) => v,
                        None => match fetch::fetch_vec(c.ctx, &k.uri, None, 64).await {
                            Ok(v) if v.len() == 16 => {
                                let mut a = [0u8; 16];
                                a.copy_from_slice(&v);
                                keys.insert(k.uri.clone(), a);
                                a
                            }
                            Ok(_) => return TrackEnd::Fatal(Event::StreamRefused(DlError::StreamUnsupported)),
                            Err(f) => return end_of_fail(f),
                        },
                    };
                    match tokio::task::block_in_place(|| fetch::decrypt_aes128_cbc(&key, &k.iv, &bytes)) {
                        Ok(d) => d,
                        Err(_) => return TrackEnd::Fatal(Event::StreamRefused(DlError::StreamUnsupported)),
                    }
                }
            };

            let len = data.len() as u64;
            clock.on_bytes(Instant::now(), len);
            // The session's limiter is shared with torrents (same code as `stream_body`).
            if let (Some(session), Some(bps)) = (self.session.as_ref(), self.global_down_bps()) {
                let step_max = bps.get().min(16 * 1024) as usize;
                let waiting_since = Instant::now();
                let mut left = data.len();
                while left > 0 {
                    let n = left.min(step_max.max(1));
                    if let Some(nz) = NonZeroU32::new(n as u32) {
                        let _ = session.ratelimits.prepare_for_download(nz).await;
                    }
                    left -= n;
                }
                clock.excuse(waiting_since.elapsed(), Instant::now());
            }
            let pos = runs[ti].bytes;
            if let Err(e) = tokio::task::block_in_place(|| write_all_at(&file, &data, pos)) {
                let n = self.update(c.id, |_, l| l.attempts).unwrap_or(0);
                self.flush_stream_side(c, runs);
                let ev = io_event(&e, n);
                return if matches!(ev, Event::Transient { .. }) { TrackEnd::Broken } else { TrackEnd::Fatal(ev) };
            }
            runs[ti].bytes += len;
            runs[ti].done += 1;

            let held: u64 = runs.iter().map(|r| r.bytes).sum();
            let done_sum: usize = runs.iter().map(|r| r.done).sum();
            let alive = self.update(c.id, |rec, live| {
                rec.held = held;
                // The size is an estimate; never show less than what is written.
                if rec.size.map(|s| s < held).unwrap_or(false) {
                    rec.size = Some(held);
                }
                if let Some(s) = rec.stream.as_mut() {
                    s.segments_done = done_sum;
                }
                live.attempts = 0;
                live.denied = 0;
                live.stalled = false;
                rec.state == State::Downloading
            });
            if alive != Some(true) {
                return TrackEnd::Stopped;
            }
            if last_report.elapsed() >= REPORT_EVERY {
                let dt = last_report.elapsed().as_secs_f64().max(0.001);
                let inst = held.saturating_sub(report_held) as f64 / dt;
                bps_smooth = if bps_smooth == 0.0 { inst } else { bps_smooth * 0.6 + inst * 0.4 };
                report_held = held;
                last_report = Instant::now();
                self.update(c.id, |rec, live| {
                    live.bps = bps_smooth as u64;
                    limit = rec.down_limit_bps;
                });
            }
            if self.stall_step(c.id, limit, clock) {
                self.flush_stream_side(c, runs);
                return TrackEnd::Stalled;
            }
            // The final size is unknown: stop when the free space drops below the reserve.
            if last_space.elapsed() >= SIDECAR_FLUSH {
                last_space = Instant::now();
                let free = tokio::task::block_in_place(|| free_space(c.folder));
                if !fits(None, 0, free) {
                    self.flush_stream_side(c, runs);
                    return TrackEnd::Fatal(Event::Enospc);
                }
            }
            if last_flush.elapsed() >= SIDECAR_FLUSH {
                last_flush = Instant::now();
                self.flush_stream_side(c, runs);
            }
            if limit > 0 {
                let wait = pace_delay(runs[ti].bytes - start_bytes, started.elapsed(), limit);
                if !wait.is_zero() {
                    let slept = wait.min(Duration::from_secs(2));
                    tokio::time::sleep(slept).await;
                    clock.excuse(slept, Instant::now());
                }
            }
        }
        self.flush_stream_side(c, runs);
        TrackEnd::Done
    }

    /// Downloads all `Pair` tracks (video + audio) together in one unified `PAIR_IN_FLIGHT`-connection pool:
    /// - Dynamic IDM-style work-stealing: as soon as the queue empties, idle connections atomically split the
    ///   remaining bytes of the slowest active worker in half (down to 512 KiB), eliminating tail speed drops.
    /// - Cursor-preserving retries: transient blips or 7s read timeouts reconnect from the exact byte written so far
    ///   (zero wasted bytes, zero progress rollback, zero aborting other active workers).
    /// - Overlapped double-buffered 512 KiB disk writes via `spawn_blocking` so network reads never wait on disk I/O.
    /// - Single continuous rolling speed window across video + audio (zero `0 B/s` dip between tracks).
    async fn run_pair_tracks(
        self: &Arc<Self>,
        c: &StreamCtx<'_>,
        runs: &mut Vec<TrackRun>,
        clock: &mut StallClock,
    ) -> TrackEnd {
        const PAIR_WRITE_BUF: usize = 512 * 1024;
        const PAIR_OPEN_TIMEOUT: Duration = Duration::from_secs(8);
        const PAIR_READ_TIMEOUT: Duration = Duration::from_secs(7);
        const PAIR_MIN_STEAL_BYTES: u64 = 512 * 1024;

        let n_tracks = c.tracks.len();
        let track_totals: Vec<u64> = c.tracks.iter().map(|t| t.total_bytes.unwrap_or(0)).collect();
        let base_urls: Vec<String> = c.tracks.iter().map(|t| t.base_url.clone().unwrap_or_default()).collect();
        let files: Vec<Arc<File>> = runs.iter().map(|r| r.file.clone()).collect();
        let total_items_all: usize = c.tracks.iter().map(|t| t.items.len()).sum();

        // On Unix (Android ext4/f2fs), sparse ftruncate pre-allocates cleanly in microseconds without zero-fill stalls.
        #[cfg(unix)]
        for ti in 0..n_tracks {
            let tt = track_totals[ti];
            if tt > 0 {
                let f_pre = files[ti].clone();
                if let Ok(Err(e)) = tokio::task::spawn_blocking(move || f_pre.set_len(tt)).await {
                    let n = self.update(c.id, |_, l| l.attempts).unwrap_or(0);
                    let ev = io_event(&e, n);
                    return if matches!(ev, Event::Transient { .. }) { TrackEnd::Broken } else { TrackEnd::Fatal(ev) };
                }
            }
        }

        let mut completed: Vec<Vec<(u64, u64)>> = (0..n_tracks)
            .map(|ti| if runs[ti].bytes > 0 { vec![(0, runs[ti].bytes)] } else { Vec::new() })
            .collect();
        let base_bytes: u64 = runs.iter().map(|r| r.bytes).sum();
        let total_bytes_all: u64 = track_totals.iter().sum();

        // Enqueue all remaining chunks across video + audio into one unified work queue.
        let mut queue: VecDeque<(usize, u64, u64)> = VecDeque::new();
        for ti in 0..n_tracks {
            for seg in c.tracks[ti].items.iter().skip(runs[ti].done) {
                let off = seg.write_offset.unwrap_or(0);
                let len = seg.expected_len.unwrap_or(0);
                if len > 0 {
                    queue.push_back((ti, off, off + len));
                }
            }
        }

        let live_bytes = Arc::new(AtomicU64::new(0));
        let mut active_jobs: HashMap<usize, Arc<PairJob>> = HashMap::new();
        let mut next_job_id: usize = 0;
        let mut set: JoinSet<(usize, usize, u64, u64, Result<(), FetchFail>)> = JoinSet::new();
        let mut tick = tokio::time::interval(REPORT_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let mut limit = self.update(c.id, |r, _| r.down_limit_bps).unwrap_or(0);
        let started = Instant::now();
        let mut last_space = Instant::now();
        let mut last_streamed = 0u64;
        let mut speed_win: VecDeque<(Instant, u64)> = VecDeque::with_capacity(8);
        speed_win.push_back((Instant::now(), 0));

        let outcome = loop {
            while set.len() < c.max_in_flight {
                let next_work = if let Some(item) = queue.pop_front() {
                    Some(item)
                } else {
                    // Dynamic work-stealing: pick the active worker with the largest remaining range and split it in half.
                    let candidate = active_jobs
                        .values()
                        .filter_map(|j| {
                            let st = j.range.lock();
                            let rem = st.1.saturating_sub(st.0);
                            (rem >= PAIR_MIN_STEAL_BYTES).then_some((rem, j.clone()))
                        })
                        .max_by_key(|(rem, _)| *rem)
                        .map(|(_, j)| j);
                    candidate.and_then(|j| j.try_steal_half(PAIR_MIN_STEAL_BYTES).map(|(s, e)| (j.track, s, e)))
                };
                let Some((ti, start, end)) = next_work else { break };
                let job_id = next_job_id;
                next_job_id += 1;
                let job = Arc::new(PairJob {
                    track: ti,
                    base_url: base_urls[ti].clone(),
                    range: Mutex::new((start, end)),
                });
                active_jobs.insert(job_id, job.clone());

                let cx = c.ctx.clone();
                let f = files[ti].clone();
                let counter = live_bytes.clone();
                let session = self.session.clone();
                set.spawn(async move {
                    let mut buf: Vec<u8> = Vec::with_capacity(PAIR_WRITE_BUF);
                    let mut buf_start = start;
                    let mut written_cursor = start;
                    let mut pending_write: Option<(u64, u64, JoinHandle<io::Result<()>>)> = None;
                    let mut retries: u8 = 0;

                    async fn finish_pending(
                        pending: &mut Option<(u64, u64, JoinHandle<io::Result<()>>)>,
                        written_cursor: &mut u64,
                    ) -> Result<(), FetchFail> {
                        if let Some((pos, len, h)) = pending.take() {
                            h.await.map_err(|_| FetchFail::Short)?.map_err(FetchFail::Sink)?;
                            *written_cursor = pos + len;
                        }
                        Ok(())
                    }

                    async fn flush_all(
                        f: &Arc<File>,
                        buf: &mut Vec<u8>,
                        buf_start: &mut u64,
                        pending: &mut Option<(u64, u64, JoinHandle<io::Result<()>>)>,
                        written_cursor: &mut u64,
                    ) -> Result<(), FetchFail> {
                        finish_pending(pending, written_cursor).await?;
                        if !buf.is_empty() {
                            let flush_buf = std::mem::replace(buf, Vec::with_capacity(PAIR_WRITE_BUF));
                            let pos = *buf_start;
                            let len = flush_buf.len() as u64;
                            *buf_start += len;
                            let f2 = f.clone();
                            tokio::task::spawn_blocking(move || write_all_at(&f2, &flush_buf, pos))
                                .await
                                .map_err(|_| FetchFail::Short)?
                                .map_err(FetchFail::Sink)?;
                            *written_cursor = pos + len;
                        }
                        Ok(())
                    }

                    let res: Result<(), FetchFail> = loop {
                        let (cur, cur_end) = *job.range.lock();
                        if cur >= cur_end {
                            if let Err(e) = flush_all(&f, &mut buf, &mut buf_start, &mut pending_write, &mut written_cursor).await {
                                break Err(e);
                            }
                            break Ok(());
                        }
                        let (req_url, req_range) = stream::pair_range_request(&job.base_url, cur, cur_end - cur);
                        let mut resp = match tokio::time::timeout(PAIR_OPEN_TIMEOUT, fetch::open_stream(&cx, &req_url, req_range)).await {
                            Ok(Ok(r)) => r,
                            Ok(Err(e)) => {
                                let retryable = matches!(
                                    e,
                                    FetchFail::Short
                                        | FetchFail::Body(_)
                                        | FetchFail::Status(408 | 429 | 500 | 502 | 503 | 504, _)
                                );
                                if retryable && retries < 4 {
                                    retries += 1;
                                    tokio::time::sleep(Duration::from_millis(150 * u64::from(retries))).await;
                                    continue;
                                }
                                let _ = flush_all(&f, &mut buf, &mut buf_start, &mut pending_write, &mut written_cursor).await;
                                break Err(e);
                            }
                            Err(_) => {
                                if retries < 4 {
                                    retries += 1;
                                    tokio::time::sleep(Duration::from_millis(150 * u64::from(retries))).await;
                                    continue;
                                }
                                let _ = flush_all(&f, &mut buf, &mut buf_start, &mut pending_write, &mut written_cursor).await;
                                break Err(FetchFail::Short);
                            }
                        };

                        let mut read_err: Option<FetchFail> = None;
                        loop {
                            {
                                let st = job.range.lock();
                                if st.0 >= st.1 {
                                    break;
                                }
                            }
                            let chunk = match tokio::time::timeout(PAIR_READ_TIMEOUT, resp.chunk()).await {
                                Ok(Ok(Some(ch))) => ch,
                                Ok(Ok(None)) => break,
                                Ok(Err(e)) => {
                                    read_err = Some(FetchFail::Body(e));
                                    break;
                                }
                                Err(_) => {
                                    read_err = Some(FetchFail::Short);
                                    break;
                                }
                            };
                            if chunk.is_empty() {
                                continue;
                            }
                            let (take, done_now) = {
                                let mut st = job.range.lock();
                                let rem = st.1.saturating_sub(st.0);
                                if rem == 0 {
                                    (0usize, true)
                                } else {
                                    let t = (chunk.len() as u64).min(rem) as usize;
                                    st.0 += t as u64;
                                    (t, st.0 >= st.1)
                                }
                            };
                            if take == 0 {
                                break;
                            }
                            counter.fetch_add(take as u64, Ordering::Relaxed);
                            retries = 0;
                            if let Some(sess) = session.as_ref() {
                                if let Some(gbps) = sess.ratelimits.get_download_bps() {
                                    let step_max = gbps.get().min(16 * 1024) as usize;
                                    let mut left = take;
                                    while left > 0 {
                                        let n = left.min(step_max.max(1));
                                        if let Some(nz) = NonZeroU32::new(n as u32) {
                                            let _ = sess.ratelimits.prepare_for_download(nz).await;
                                        }
                                        left -= n;
                                    }
                                }
                            }
                            buf.extend_from_slice(&chunk[..take]);
                            if buf.len() >= PAIR_WRITE_BUF {
                                if let Err(e) = finish_pending(&mut pending_write, &mut written_cursor).await {
                                    read_err = Some(e);
                                    break;
                                }
                                let flush_buf = std::mem::replace(&mut buf, Vec::with_capacity(PAIR_WRITE_BUF));
                                let pos = buf_start;
                                let len = flush_buf.len() as u64;
                                buf_start += len;
                                let f2 = f.clone();
                                pending_write = Some((pos, len, tokio::task::spawn_blocking(move || write_all_at(&f2, &flush_buf, pos))));
                            }
                            if done_now {
                                break;
                            }
                        }

                        if let Err(e) = flush_all(&f, &mut buf, &mut buf_start, &mut pending_write, &mut written_cursor).await {
                            break Err(e);
                        }
                        if let Some(e) = read_err {
                            let retryable = matches!(e, FetchFail::Short | FetchFail::Body(_));
                            if retryable && retries < 4 {
                                retries += 1;
                                tokio::time::sleep(Duration::from_millis(150 * u64::from(retries))).await;
                                continue;
                            }
                            break Err(e);
                        }
                        // Check if stream ended short of `cur_end`; if so, reconnect from exact `cur`.
                        let (cur_after, end_after) = *job.range.lock();
                        if cur_after < end_after {
                            if retries < 4 {
                                retries += 1;
                                tokio::time::sleep(Duration::from_millis(150 * u64::from(retries))).await;
                                continue;
                            }
                            break Err(FetchFail::Short);
                        }
                        break Ok(());
                    };
                    (job_id, ti, start, written_cursor, res)
                });
            }

            if set.is_empty() {
                break TrackEnd::Done;
            }

            tokio::select! {
                joined = set.join_next() => match joined {
                    None => break TrackEnd::Done,
                    Some(Err(_)) => break TrackEnd::Broken,
                    Some(Ok((jid, ti, s, w, res))) => {
                        active_jobs.remove(&jid);
                        if w > s {
                            completed[ti].push((s, w));
                        }
                        match res {
                            Ok(()) => {}
                            Err(FetchFail::Sink(e)) => {
                                let n = self.update(c.id, |_, l| l.attempts).unwrap_or(0);
                                let ev = io_event(&e, n);
                                break if matches!(ev, Event::Transient { .. }) { TrackEnd::Broken } else { TrackEnd::Fatal(ev) };
                            }
                            Err(f) => break end_of_fail(f),
                        }
                    }
                },
                _ = tick.tick() => {
                    let now = Instant::now();
                    let streamed = live_bytes.load(Ordering::Relaxed);
                    let delta = streamed.saturating_sub(last_streamed);
                    last_streamed = streamed;
                    if delta > 0 {
                        clock.on_bytes(now, delta);
                    }
                    speed_win.push_back((now, streamed));
                    while speed_win.len() > 2 && now.duration_since(speed_win.front().unwrap().0) > Duration::from_secs(1) {
                        speed_win.pop_front();
                    }
                    let (old_t, old_b) = speed_win.front().copied().unwrap_or((now, streamed));
                    let win_dt = now.duration_since(old_t).as_secs_f64().max(0.05);
                    let bps = (streamed.saturating_sub(old_b) as f64 / win_dt) as u64;
                    let held = base_bytes.saturating_add(streamed);
                    let active_conns = set.len() as u32;
                    let est_segs_done = if total_bytes_all > 0 {
                        ((held.min(total_bytes_all) as u128 * total_items_all as u128) / total_bytes_all as u128) as usize
                    } else {
                        0
                    };
                    let alive = self.update(c.id, |rec, live| {
                        rec.held = held;
                        if rec.size.map(|s| s < held).unwrap_or(false) {
                            rec.size = Some(held);
                        }
                        if let Some(s) = rec.stream.as_mut() {
                            s.segments_done = est_segs_done.min(s.segments_total);
                        }
                        live.bps = bps;
                        live.pair_active = active_conns;
                        if delta > 0 {
                            live.attempts = 0;
                            live.denied = 0;
                            live.stalled = false;
                        }
                        limit = rec.down_limit_bps;
                        rec.state == State::Downloading
                    });
                    if alive != Some(true) {
                        break TrackEnd::Stopped;
                    }
                    if self.stall_step(c.id, limit, clock) {
                        break TrackEnd::Stalled;
                    }
                    if last_space.elapsed() >= SIDECAR_FLUSH {
                        last_space = Instant::now();
                        let free = tokio::task::block_in_place(|| free_space(c.folder));
                        if !fits(None, 0, free) {
                            break TrackEnd::Fatal(Event::Enospc);
                        }
                    }
                    if limit > 0 {
                        let wait = pace_delay(streamed, started.elapsed(), limit);
                        if !wait.is_zero() {
                            let slept = wait.min(Duration::from_secs(2));
                            tokio::time::sleep(slept).await;
                            clock.excuse(slept, Instant::now());
                        }
                    }
                }
            }
        };

        set.abort_all();
        while set.join_next().await.is_some() {}
        self.update(c.id, |_, live| live.pair_active = 0);

        if matches!(outcome, TrackEnd::Done) {
            let all_covered = (0..n_tracks).all(|ti| merged_contiguous_prefix(&completed[ti]) >= track_totals[ti]);
            if all_covered {
                for ti in 0..n_tracks {
                    runs[ti].bytes = track_totals[ti];
                    runs[ti].done = c.tracks[ti].items.len();
                }
                return TrackEnd::Done;
            }
        }

        // Non-Done exit (pause, error, break): align each track's resume point to whole `items` prefix and flush sidecar.
        for ti in 0..n_tracks {
            let pref = merged_contiguous_prefix(&completed[ti]);
            let mut done_segs = 0usize;
            let mut done_bytes = 0u64;
            for seg in &c.tracks[ti].items {
                let len = seg.expected_len.unwrap_or(0);
                if done_bytes + len <= pref {
                    done_bytes += len;
                    done_segs += 1;
                } else {
                    break;
                }
            }
            runs[ti].done = done_segs;
            runs[ti].bytes = done_bytes;
            let f_trim = files[ti].clone();
            let _ = tokio::task::spawn_blocking(move || f_trim.set_len(done_bytes)).await;
        }
        self.flush_stream_side(c, runs);
        if matches!(outcome, TrackEnd::Done) { TrackEnd::Broken } else { outcome }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_errors_map_to_download_errors() {
        assert_eq!(stream_dl_error(StreamError::Protected), DlError::StreamProtected);
        assert_eq!(stream_dl_error(StreamError::Live), DlError::StreamLive);
        assert_eq!(stream_dl_error(StreamError::Unsupported), DlError::StreamUnsupported);
        assert_eq!(
            error_message(DlError::StreamProtected, None),
            "This stream is protected. Maglev can't save it."
        );
        assert_eq!(error_message(DlError::MuxFailed, None), "Couldn't join the video and audio. Try again.");
    }

    #[test]
    fn failed_requests_map_to_probe_failures() {
        let st = |s| ResolveFail::Fetch(FetchFail::Status(s, None));
        assert!(matches!(probe_fail_of(st(401), "h"), ProbeFail::Auth(401)));
        assert!(matches!(probe_fail_of(st(403), "h"), ProbeFail::Refused(403)));
        assert!(matches!(probe_fail_of(st(404), "h"), ProbeFail::Status(404)));
        assert!(matches!(probe_fail_of(ResolveFail::Fetch(FetchFail::TooBig), "h"), ProbeFail::Stream(StreamError::Unsupported)));
        assert!(matches!(probe_fail_of(ResolveFail::Fetch(FetchFail::Short), "h"), ProbeFail::Net));
        assert!(matches!(probe_fail_of(ResolveFail::Stream(StreamError::Live), "h"), ProbeFail::Stream(StreamError::Live)));
    }

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-stream-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn waiting_record(id: &str, folder: &Path) -> DlRecord {
        DlRecord {
            id: id.into(),
            url: "https://x.test/index.m3u8".into(),
            name: "Film 1080p.mp4".into(),
            folder: folder.to_string_lossy().into_owned(),
            state: State::Verifying,
            mux_needed: true,
            size: Some(100),
            stream: Some(StreamRec {
                kind: crate::http_dl::stream::StreamKind::Hls,
                variant_id: "v1".into(),
                audio_id: None,
                video_url: None,
                audio_url: None,
                video_bytes: None,
                audio_bytes: None,
                height: None,
                ext: None,
                subtitles: Vec::new(),
                segments_done: 9,
                segments_total: 9,
            }),
            ..DlRecord::default()
        }
    }

    fn manager_with(rt: &tokio::runtime::Runtime, d: &Path, recs: Vec<DlRecord>) -> Arc<Downloads> {
        let file = StoreFile { version: 1, downloads: recs };
        std::fs::write(d.join(STORE_FILE), serde_json::to_vec(&file).unwrap()).unwrap();
        Downloads::build(rt.handle().clone(), None, d, d, None, vec![])
    }

    #[test]
    fn a_restart_keeps_the_wait_for_the_join() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let d = dir("restore");
        let m = manager_with(&rt, &d, vec![waiting_record("dl_s", &d)]);
        assert_eq!(m.state_of("dl_s"), Some(State::Verifying));
        let snap = m.snapshots();
        assert_eq!(snap[0]["state"], "verifying");
        assert_eq!(snap[0]["mux_needed"], true);
        assert_eq!(snap[0]["stream"]["kind"], "hls");
        assert_eq!(snap[0]["stream"]["segments_total"], 9);
        assert_eq!(snap[0]["resumable"], true);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_good_join_finishes_and_removes_the_parts() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let d = dir("join-ok");
        let m = manager_with(&rt, &d, vec![waiting_record("dl_s", &d)]);
        std::fs::write(d.join("Film 1080p.mp4.video.part"), b"v").unwrap();
        std::fs::write(d.join("Film 1080p.mp4.audio.part"), b"a").unwrap();
        std::fs::write(d.join("Film 1080p.mp4"), b"joined!").unwrap();
        m.finish_mux("dl_s", true, None).unwrap();
        assert_eq!(m.state_of("dl_s"), Some(State::Finished));
        assert!(!d.join("Film 1080p.mp4.video.part").exists());
        assert!(!d.join("Film 1080p.mp4.audio.part").exists());
        assert_eq!(std::fs::read(d.join("Film 1080p.mp4")).unwrap(), b"joined!");
        let snap = m.snapshots();
        assert_eq!(snap[0]["size"], 7);
        assert_eq!(snap[0]["mux_needed"], false);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_failed_join_is_mux_failed_and_retry_only_joins_again() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let d = dir("join-bad");
        let m = manager_with(&rt, &d, vec![waiting_record("dl_s", &d)]);
        std::fs::write(d.join("Film 1080p.mp4.video.part"), b"v").unwrap();
        m.finish_mux("dl_s", false, Some("The platform couldn't join the parts (IOException)")).unwrap();
        assert_eq!(m.state_of("dl_s"), Some(State::Error(DlError::MuxFailed)));
        let snap = m.snapshots();
        assert_eq!(snap[0]["error"]["code"], "MUX_FAILED");
        assert_eq!(snap[0]["error"]["message"], "Couldn't join the video and audio. Try again.");
        // The parts stay for the retry.
        assert!(d.join("Film 1080p.mp4.video.part").exists());
        m.retry("dl_s").unwrap();
        assert_eq!(m.state_of("dl_s"), Some(State::Verifying));
        assert_eq!(m.snapshots()[0]["mux_needed"], true);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn finish_mux_refuses_a_download_that_is_not_waiting() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let d = dir("join-state");
        let mut done = waiting_record("dl_s", &d);
        done.state = State::Finished;
        done.mux_needed = false;
        let m = manager_with(&rt, &d, vec![done]);
        assert_eq!(m.finish_mux("dl_s", true, None).unwrap_err().code, ErrorCode::InvalidState);
        assert_eq!(m.finish_mux("dl_nope", true, None).unwrap_err().code, ErrorCode::NotFound);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn removing_a_stream_deletes_its_parts_when_asked() {
        let d = dir("remove");
        let rec = waiting_record("dl_s", &d);
        for n in ["Film 1080p.mp4.video.part", "Film 1080p.mp4.audio.part", "Film 1080p.mp4.mux.tmp"] {
            std::fs::write(d.join(n), b"x").unwrap();
        }
        delete_files(&rec, false, false);
        assert!(d.join("Film 1080p.mp4.video.part").exists());
        delete_files(&rec, true, false);
        for n in ["Film 1080p.mp4.video.part", "Film 1080p.mp4.audio.part", "Film 1080p.mp4.mux.tmp"] {
            assert!(!d.join(n).exists(), "{n}");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn work_stealing_splits_remaining_range_without_overlap() {
        let job = PairJob {
            track: 0,
            base_url: "https://rr1.googlevideo.com/videoplayback?itag=137".into(),
            range: Mutex::new((256 * 1024, 2 * 1024 * 1024)),
        };
        let (s1, e1) = job.try_steal_half(512 * 1024).expect("should split");
        assert_eq!(e1, 2 * 1024 * 1024);
        assert_eq!(s1 % 4096, 0);
        let (cur, new_end) = *job.range.lock();
        assert_eq!(cur, 256 * 1024);
        assert_eq!(new_end, s1);
        // Second steal splits again; once below 512 KiB it refuses to over-fragment.
        let (s2, e2) = job.try_steal_half(512 * 1024).expect("should split again");
        assert_eq!(e2, s1);
        assert_eq!(job.range.lock().1, s2);
        assert!(job.try_steal_half(512 * 1024).is_none());
        // Together the original completed part + all stolen parts cover [0..2MiB) with zero gaps.
        assert_eq!(
            merged_contiguous_prefix(&[(0, cur), (cur, s2), (s2, s1), (s1, e1)]),
            2 * 1024 * 1024
        );
    }

    #[test]
    fn merged_contiguous_prefix_stops_at_gaps() {
        assert_eq!(merged_contiguous_prefix(&[]), 0);
        assert_eq!(merged_contiguous_prefix(&[(100, 200)]), 0);
        assert_eq!(merged_contiguous_prefix(&[(50, 100), (0, 50), (150, 200)]), 100);
        assert_eq!(merged_contiguous_prefix(&[(100, 150), (0, 60), (50, 100), (150, 200)]), 200);
    }
}
