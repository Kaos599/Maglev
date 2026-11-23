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

        let max_in_flight = if spec.kind == StreamKind::Pair { PAIR_IN_FLIGHT } else { MAX_IN_FLIGHT };
        let c = StreamCtx { id: &id, ctx: &ctx, folder: &folder, name: &name, url: &url, est, tracks, max_in_flight };
        let mut keys: HashMap<String, [u8; 16]> = HashMap::new();
        let mut clock = StallClock::new(Instant::now());
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

        // Every segment of every track is on disk.
        let held: u64 = runs.iter().map(|r| r.bytes).sum();
        let mux = resolved.mux_needed();

        // Fast pure-Rust MP4 muxing for direct `Pair` downloads (YouTube):
        // avoids Android MediaExtractor/MediaMuxer frame-by-frame JNI overhead (finishes in < 0.5s)
        // and embeds all available YouTube subtitle languages as standard `tx3g` (`sbtl`) tracks.
        let want_rust_mux = spec.kind == StreamKind::Pair
            && (mux || (!spec.subtitles.is_empty() && matches!(resolved.extension(), "mp4" | "m4a")));
        if want_rust_mux {
            // Drop open part file handles before reading/removing them.
            drop(runs);

            // Fetch all subtitle srv3 XML tracks in parallel (tiny 5-30 KB each; failures are ignored).
            let parsed_subs: Vec<mp4_mux::SubtitleTrack> = if spec.subtitles.is_empty() {
                Vec::new()
            } else {
                let mut sub_set: JoinSet<(usize, Option<mp4_mux::SubtitleTrack>)> = JoinSet::new();
                for (si, sub) in spec.subtitles.iter().enumerate() {
                    let cx = ctx.clone();
                    let lang = sub.lang.clone();
                    let sname = sub.name.clone();
                    let surl = sub.url.clone();
                    sub_set.spawn(async move {
                        let fetched = tokio::time::timeout(Duration::from_secs(6), fetch::fetch_text(&cx, &surl)).await;
                        let track = match fetched {
                            Ok(Ok((xml, _))) => {
                                let cues = mp4_mux::parse_srv3_xml(&xml);
                                if cues.is_empty() { None } else { Some(mp4_mux::SubtitleTrack { lang, name: sname, cues }) }
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

        // Parallel out-of-order chunked streaming for direct `Pair` downloads (e.g. YouTube):
        // zero head-of-line blocking, direct pwrite to offset, real-time speed/progress ticks.
        if c.max_in_flight == PAIR_IN_FLIGHT && !items.is_empty() && items.iter().all(|s| s.write_offset.is_some()) {
            return self.run_pair_track(c, ti, runs, clock).await;
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

    /// Streams `Pair` chunks across `PAIR_IN_FLIGHT` concurrent HTTP/1.1 connections with zero
    /// head-of-line blocking, 512 KiB buffered `spawn_blocking` disk writes (never starving Tokio's
    /// network reactor), pre-allocated file length, no mid-transfer `fdatasync` stalls, and a
    /// 1-second rolling speed window for smooth, full-line-speed downloads.
    async fn run_pair_track(
        self: &Arc<Self>,
        c: &StreamCtx<'_>,
        ti: usize,
        runs: &mut Vec<TrackRun>,
        clock: &mut StallClock,
    ) -> TrackEnd {
        const PAIR_WRITE_BUF: usize = 512 * 1024;
        let items = &c.tracks[ti].items;
        let total = items.len();
        let file = runs[ti].file.clone();
        let start_done = runs[ti].done;
        let other_bytes: u64 = runs.iter().enumerate().filter(|(i, _)| *i != ti).map(|(_, r)| r.bytes).sum();
        let other_done: usize = runs.iter().enumerate().filter(|(i, _)| *i != ti).map(|(_, r)| r.done).sum();
        let base_bytes = runs[ti].bytes;
        let track_total: u64 = items.iter().filter_map(|s| s.expected_len).sum();

        // Pre-allocate the part file once so parallel out-of-order pwrite never contends on file-size metadata.
        if track_total > 0 {
            let f_pre = file.clone();
            if let Ok(Err(e)) = tokio::task::spawn_blocking(move || f_pre.set_len(track_total)).await {
                let n = self.update(c.id, |_, l| l.attempts).unwrap_or(0);
                let ev = io_event(&e, n);
                return if matches!(ev, Event::Transient { .. }) { TrackEnd::Broken } else { TrackEnd::Fatal(ev) };
            }
        }

        let mut done_flags = vec![false; total];
        for flag in done_flags.iter_mut().take(start_done) {
            *flag = true;
        }
        let mut completed_count = start_done;
        let mut next = start_done;

        let live_bytes = Arc::new(AtomicU64::new(0));
        let mut set: JoinSet<(usize, Result<u64, FetchFail>)> = JoinSet::new();
        let mut tick = tokio::time::interval(REPORT_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let mut limit = self.update(c.id, |r, _| r.down_limit_bps).unwrap_or(0);
        let started = Instant::now();
        let mut last_space = Instant::now();
        let mut last_streamed = 0u64;
        // 1-second rolling window (4 x 250ms ticks) for stable, accurate speed display.
        let mut speed_win: VecDeque<(Instant, u64)> = VecDeque::with_capacity(8);
        speed_win.push_back((Instant::now(), 0));

        let outcome = loop {
            while set.len() < c.max_in_flight && next < total {
                let idx = next;
                next += 1;
                let seg = items[idx].clone();
                let cx = c.ctx.clone();
                let f = file.clone();
                let counter = live_bytes.clone();
                let write_off = seg.write_offset.unwrap_or(0);
                set.spawn(async move {
                    // Retry a single chunk up to 3 times on transient read/timeout blips without
                    // aborting the other 7 active connections.
                    const CHUNK_READ_TIMEOUT: Duration = Duration::from_secs(12);
                    let mut last_err: Option<FetchFail> = None;
                    for attempt in 0..3u8 {
                        if attempt > 0 {
                            tokio::time::sleep(Duration::from_millis(250 * u64::from(attempt))).await;
                        }
                        let mut attempt_added = 0u64;
                        let res: Result<u64, FetchFail> = async {
                            let mut resp = match tokio::time::timeout(CHUNK_READ_TIMEOUT, fetch::open_stream(&cx, &seg.url, seg.range)).await {
                                Ok(r) => r?,
                                Err(_) => return Err(FetchFail::Short),
                            };
                            let promised = seg.range.map(|(_, l)| l).or(seg.expected_len).or_else(|| resp.content_length());
                            let mut pos = write_off;
                            let mut written = 0u64;
                            let mut buf: Vec<u8> = Vec::with_capacity(PAIR_WRITE_BUF);

                            loop {
                                let next_chunk = match tokio::time::timeout(CHUNK_READ_TIMEOUT, resp.chunk()).await {
                                    Ok(Ok(Some(c))) => c,
                                    Ok(Ok(None)) => break,
                                    Ok(Err(e)) => return Err(FetchFail::Body(e)),
                                    Err(_) => return Err(FetchFail::Short),
                                };
                                if next_chunk.is_empty() {
                                    continue;
                                }
                                let clen = next_chunk.len() as u64;
                                counter.fetch_add(clen, Ordering::Relaxed);
                                attempt_added += clen;
                                buf.extend_from_slice(&next_chunk);
                                if buf.len() >= PAIR_WRITE_BUF {
                                    let flush_buf = std::mem::replace(&mut buf, Vec::with_capacity(PAIR_WRITE_BUF));
                                    let flush_pos = pos;
                                    let flush_len = flush_buf.len() as u64;
                                    pos += flush_len;
                                    written += flush_len;
                                    let f2 = f.clone();
                                    tokio::task::spawn_blocking(move || write_all_at(&f2, &flush_buf, flush_pos))
                                        .await
                                        .map_err(|_| FetchFail::Short)?
                                        .map_err(FetchFail::Sink)?;
                                }
                            }
                            if !buf.is_empty() {
                                let flush_pos = pos;
                                let flush_len = buf.len() as u64;
                                written += flush_len;
                                let f2 = f.clone();
                                tokio::task::spawn_blocking(move || write_all_at(&f2, &buf, flush_pos))
                                    .await
                                    .map_err(|_| FetchFail::Short)?
                                    .map_err(FetchFail::Sink)?;
                            }
                            if let Some(p) = promised {
                                if written != p {
                                    return Err(FetchFail::Short);
                                }
                            }
                            Ok(written)
                        }
                        .await;
                        match res {
                            Ok(w) => return (idx, Ok(w)),
                            Err(e) => {
                                // Roll back partial bytes from failed attempt before retrying this chunk.
                                if attempt_added > 0 {
                                    counter.fetch_sub(attempt_added, Ordering::Relaxed);
                                }
                                let retryable = matches!(
                                    e,
                                    FetchFail::Short | FetchFail::Body(_) | FetchFail::Status(408 | 429 | 500 | 502 | 503 | 504, _)
                                );
                                last_err = Some(e);
                                if !retryable {
                                    break;
                                }
                            }
                        }
                    }
                    (idx, Err(last_err.unwrap_or(FetchFail::Short)))
                });
            }
            if set.is_empty() {
                break TrackEnd::Done;
            }
            tokio::select! {
                joined = set.join_next() => match joined {
                    None => break TrackEnd::Done,
                    Some(Err(_)) => break TrackEnd::Broken,
                    Some(Ok((_, Err(FetchFail::Sink(e))))) => {
                        let n = self.update(c.id, |_, l| l.attempts).unwrap_or(0);
                        let ev = io_event(&e, n);
                        break if matches!(ev, Event::Transient { .. }) { TrackEnd::Broken } else { TrackEnd::Fatal(ev) };
                    }
                    Some(Ok((_, Err(f)))) => break end_of_fail(f),
                    Some(Ok((idx, Ok(_)))) => {
                        done_flags[idx] = true;
                        completed_count += 1;
                        while runs[ti].done < total && done_flags[runs[ti].done] {
                            let seg = &items[runs[ti].done];
                            runs[ti].bytes += seg.expected_len.unwrap_or(0);
                            runs[ti].done += 1;
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
                    let held = other_bytes.saturating_add(base_bytes).saturating_add(streamed);
                    let alive = self.update(c.id, |rec, live| {
                        rec.held = held;
                        if rec.size.map(|s| s < held).unwrap_or(false) {
                            rec.size = Some(held);
                        }
                        if let Some(s) = rec.stream.as_mut() {
                            s.segments_done = other_done + completed_count;
                        }
                        live.bps = bps;
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
        // Only trim and flush sidecar on non-Done exits; when Done, transfer_stream proceeds straight
        // to muxing/finalization without redundant fdatasync stalls on temporary part files.
        if !matches!(outcome, TrackEnd::Done) {
            let trim_len = runs[ti].bytes;
            let f_trim = file.clone();
            let _ = tokio::task::spawn_blocking(move || f_trim.set_len(trim_len)).await;
            self.flush_stream_side(c, runs);
        }
        outcome
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
}
