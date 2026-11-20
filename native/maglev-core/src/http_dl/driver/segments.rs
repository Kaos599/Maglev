//! One link download over several connections (`NATIVE_CONTRACT.md` section 17, "Segments").
//!
//! A child of `driver`, so it can use the manager's private state. The split is only used when the probe proved the
//! server can do it (`Accept-Ranges: bytes`, a 206 for `Range: bytes=0-0`), the size is at least 8 MiB and there is
//! a strong validator (a strong ETag, else Last-Modified).
//!
//! - The part file is pre-allocated and every segment writes at its own offsets (`pwrite`), so there is no
//!   re-assembly. The sidecar holds one `{start, end, pos}` per segment and is flushed at most every 2 s.
//! - One task per segment, all inside the download's one transfer task (a `JoinSet`): pausing or removing the
//!   download aborts the transfer task, which drops the set and so stops every segment.
//! - The per-download speed limit is paced against the bytes of ALL segments together. The global limit is the
//!   session limiter, which every chunk passes through, so it is shared by nature.
//! - One coordinator loop (the transfer task itself) reports the sum of the segments, runs the stall rule on the sum,
//!   flushes the sidecar and decides what a segment's end means.
//! - A 429 or 503 on a segment is a refusal (contract 17.v): servers such as proof.ovh.net allow a few connections
//!   per address and refuse the rest, then hold new connections for minutes. The refused segment waits, the parts
//!   that were accepted keep going, the connection cap drops to what the server accepted, and each finished part
//!   hands its connection slot to the next waiting segment. If every part was refused, the download waits the
//!   server's `Retry-After` and goes on one segment at a time. Nothing already written is thrown away.
//! - Anything else unexpected on a segment (200, 401/403, 416, a Content-Range that does not match, a changed
//!   validator) sets `split_off` for good and the download goes on over ONE connection from the contiguous prefix.
//!   The single connection then does the judging it always did (200 on resume starts over, a changed file is
//!   `FILE_CHANGED`, 429/503 are retried with `Retry-After`). 408/500/502/504 and broken connections are retried on
//!   the segment itself.

use std::collections::VecDeque;

use tokio::task::JoinSet;

use super::*;
use crate::http_dl::rules::{parse_content_range, parse_retry_after, pick_validator, shown_speed, SPEED_QUIET};
use crate::http_dl::sidecar::{contiguous_prefix, held_of, Segment};

/// Below this size a download is never split.
pub(super) const MIN_SPLIT_BYTES: u64 = 8 * 1024 * 1024;
/// The most connections one download may use (the options accept 1 to 8).
pub(super) const MAX_PARTS: u32 = 8;

// ---- pure decisions ---------------------------------------------------------------------------------------------

/// What the split decision looks at.
pub(super) struct SplitFacts<'a> {
    /// `DlRecord.segments`, the user's setting.
    pub requested: u32,
    pub size: Option<u64>,
    pub validator: Option<&'a str>,
    pub resumable: bool,
    /// Probe: 206 for `bytes=0-0` and `Accept-Ranges: bytes`.
    pub probe_ok: bool,
    /// An earlier segment was refused or drifted.
    pub split_off: bool,
}

/// How many connections to use, or `None` for one.
pub(super) fn split_count(f: &SplitFacts) -> Option<u32> {
    let size = f.size?;
    if f.requested < 2 || f.split_off || !f.probe_ok || !f.resumable || size < MIN_SPLIT_BYTES {
        return None;
    }
    // Only a validator we can put in `If-Range` proves that every segment is the same file.
    f.validator.filter(|v| !v.trim().is_empty())?;
    Some(f.requested.min(MAX_PARTS))
}

/// The probe allows segments: it got a 206 and either the server says it counts in bytes, or the 206 itself
/// carries `Content-Range: bytes a-b/total` with a known total. nginx and many CDNs answer a range request with
/// `206` + `Content-Range` and no `Accept-Ranges` (that header is only on their 200), so the 206 is the proof.
/// An explicit `Accept-Ranges: none` still forbids it.
pub(super) fn parts_probe_ok(info: &ProbeInfo, h: &Headers) -> bool {
    if !info.probe_was_206 {
        return false;
    }
    let ar = h.accept_ranges.as_deref().map(|a| a.trim().to_ascii_lowercase());
    match ar.as_deref() {
        Some(a) if a.contains("bytes") => true,
        Some(a) if a.contains("none") => false,
        _ => matches!(
            h.content_range.as_deref().and_then(parse_content_range),
            Some((Some(a), Some(b), Some(total))) if b >= a && total > b
        ),
    }
}

/// `total` bytes cut into `n` ranges of nearly equal size. The first `total % n` ranges take one byte more, so the
/// sizes add up exactly and the ranges are contiguous.
pub(super) fn plan_split(total: u64, n: u32) -> Vec<Segment> {
    if total == 0 {
        return Vec::new();
    }
    let n = u64::from(n.clamp(1, MAX_PARTS)).min(total.max(1));
    let (base, extra) = (total / n, total % n);
    let mut out = Vec::with_capacity(n as usize);
    let mut start = 0u64;
    for i in 0..n {
        let len = base + u64::from(i < extra);
        out.push(Segment { start, end: start + len - 1, pos: start });
        start += len;
    }
    out
}

/// A saved layout is only trusted when it tiles the file exactly and no position is outside its range.
pub(super) fn valid_layout(segs: &[Segment], total: u64) -> bool {
    if segs.len() < 2 || segs.len() > MAX_PARTS as usize || total == 0 {
        return false;
    }
    let mut next = 0u64;
    for s in segs {
        if s.start != next || s.end < s.start || s.end >= total || s.pos < s.start || s.pos > s.end.saturating_add(1) {
            return false;
        }
        next = s.end + 1;
    }
    next == total
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PartReply {
    /// 206 for exactly the range asked: write the body.
    Body,
    /// Retry this segment (408, 500, 502, 504).
    Retry { retry_after: Option<Duration> },
    /// The server will not take this connection now (429, 503): the segment waits for a free slot (contract 17.v).
    Refused { retry_after: Option<Duration> },
    /// Anything else: stop splitting for good.
    Fallback,
}

/// Judges the answer to `Range: bytes=start-end` + `If-Range: <validator>`.
pub(super) fn judge_part(status: u16, h: &Headers, start: u64, end: u64, total: u64, validator: &str) -> PartReply {
    match status {
        206 => {
            let Some((Some(a), Some(b), got_total)) = h.content_range.as_deref().and_then(parse_content_range) else {
                return PartReply::Fallback;
            };
            if a != start || b != end || got_total.map(|t| t != total).unwrap_or(false) {
                return PartReply::Fallback;
            }
            if pick_validator(h.etag.as_deref(), h.last_modified.as_deref()).is_some_and(|v| v != validator) {
                return PartReply::Fallback;
            }
            let html = h.content_type.as_deref().map(|c| c.trim().to_ascii_lowercase().starts_with("text/html"));
            if html == Some(true) {
                return PartReply::Fallback;
            }
            PartReply::Body
        }
        408 | 500 | 502 | 504 => PartReply::Retry { retry_after: parse_retry_after(h.retry_after.as_deref()) },
        429 | 503 => PartReply::Refused { retry_after: parse_retry_after(h.retry_after.as_deref()) },
        _ => PartReply::Fallback,
    }
}

// ---- shared state -----------------------------------------------------------------------------------------------

/// What the segment tasks and the coordinator share for one run.
pub(super) struct PartsShared {
    segs: Mutex<Vec<Segment>>,
    active: AtomicU32,
    /// Bytes received in this run, all segments together (stall rule, speed limit).
    bytes: AtomicU64,
    /// Milliseconds spent waiting on our own limiters, summed over the segment tasks.
    wait_ms: AtomicU64,
    /// `DlRecord.down_limit_bps` of the moment (0 = none).
    limit: AtomicU64,
    started: Instant,
    file: File,
    total: u64,
    validator: String,
}

impl PartsShared {
    fn new(file: File, segs: Vec<Segment>, total: u64, validator: String, limit: u64) -> Self {
        PartsShared {
            segs: Mutex::new(segs),
            active: AtomicU32::new(0),
            bytes: AtomicU64::new(0),
            wait_ms: AtomicU64::new(0),
            limit: AtomicU64::new(limit),
            started: Instant::now(),
            file,
            total,
            validator,
        }
    }

    /// The offsets as they are now.
    pub(super) fn snapshot(&self) -> Vec<Segment> {
        self.segs.lock().clone()
    }

    /// Segment tasks that are running.
    pub(super) fn active(&self) -> u32 {
        self.active.load(Ordering::Relaxed)
    }

    fn add_wait(&self, d: Duration) {
        self.wait_ms.fetch_add(d.as_millis() as u64, Ordering::Relaxed);
    }
}

/// Counts a segment task as live for exactly as long as it exists, aborted or not.
struct ActiveTick(Arc<PartsShared>);

impl ActiveTick {
    fn new(shared: &Arc<PartsShared>) -> Self {
        shared.active.fetch_add(1, Ordering::Relaxed);
        ActiveTick(shared.clone())
    }
}

impl Drop for ActiveTick {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Takes the run out of the list when the transfer task ends or is aborted. Only the run that put itself there
/// removes itself (a quick pause and resume starts a new run before the old guard drops).
struct PartsGuard {
    dl: Arc<Downloads>,
    id: String,
    shared: Arc<PartsShared>,
}

impl Drop for PartsGuard {
    fn drop(&mut self) {
        let mut inner = self.dl.inner.lock();
        let Some(live) = inner.live.get_mut(&self.id) else {
            return;
        };
        if live.parts.as_ref().is_some_and(|p| Arc::ptr_eq(p, &self.shared)) {
            live.parts = None;
        }
    }
}

/// What a segment task reports.
enum SegEnd {
    Done,
    /// Refused before it got a byte; waits for a slot (only a segment that is not yet `patient`).
    Refused { retry_after: Option<Duration> },
    Fallback,
    /// An error the machine must hear about (storage, the local-network refusal).
    Fatal(Event),
    /// Out of retries.
    Exhausted,
    /// The download is no longer `Downloading`.
    Stopped,
}

pub(super) enum Parts {
    Single,
    /// `fresh`: the part file has to be created and pre-allocated; otherwise it holds the saved offsets' bytes.
    Split { segs: Vec<Segment>, fresh: bool },
}

pub(super) enum PartsEnd {
    /// All bytes are in and the machine was told.
    Done,
    /// The machine was told, or the download was stopped from outside.
    Stop,
    /// Go on over one connection: `split_off` is set and the sidecar stands at the contiguous prefix.
    Fallback,
}

enum Outcome {
    AllDone,
    Fallback,
    Event(Event),
    Stopped,
    Stalled,
}

// ---- the manager's side -----------------------------------------------------------------------------------------

impl Downloads {
    /// Decides between one connection and several, and cleans the sidecar for the one chosen. Blocking file IO.
    pub(super) fn choose_parts(&self, id: &str) -> Parts {
        let Some((folder, name, total, validator, resumable, parts_ok, split_off, requested)) = self.update(id, |r, _| {
            (
                PathBuf::from(&r.folder),
                r.name.clone(),
                r.size,
                r.validator.clone(),
                r.resumable,
                r.parts_ok,
                r.split_off,
                r.segments,
            )
        }) else {
            return Parts::Single;
        };
        let want = split_count(&SplitFacts {
            requested,
            size: total,
            validator: validator.as_deref(),
            resumable,
            probe_ok: parts_ok,
            split_off,
        });
        let side_path = sidecar_path(&folder, &name);
        let part_len = std::fs::metadata(part_path(&folder, &name)).map(|m| m.len()).unwrap_or(0);
        let side = Sidecar::load(&side_path);
        let side_matches = side.as_ref().map(|s| s.validator == validator && s.total == total).unwrap_or(false);

        if let (Some(mut s), true) = (side.clone(), side_matches) {
            if s.is_split() {
                let reuse = matches!((want, total), (Some(_), Some(t)) if part_len == t && valid_layout(&s.segments, t));
                if reuse {
                    return Parts::Split { segs: s.segments, fresh: false };
                }
                // Not splitting (any more): one connection continues from the bytes that are all there.
                s.collapse_to_prefix();
                let guard = self.inner.lock();
                if guard.records.contains_key(id) {
                    let _ = s.save(&side_path);
                }
                return Parts::Single;
            }
            // A single-connection partial (an older build, or a fallback) is finished over one connection.
            if s.resume_offset() > 0 {
                return Parts::Single;
            }
        }
        match (want, total) {
            (Some(n), Some(t)) => Parts::Split { segs: plan_split(t, n), fresh: true },
            _ => Parts::Single,
        }
    }

    /// Runs a split download until it is finished, stopped, or has to fall back to one connection.
    pub(super) async fn run_parts(
        self: &Arc<Self>,
        id: &str,
        client: &Client,
        segs: Vec<Segment>,
        fresh: bool,
        typed_host: &str,
    ) -> PartsEnd {
        let Some((folder, name, total, validator, url, limit)) = self.update(id, |r, _| {
            (
                PathBuf::from(&r.folder),
                r.name.clone(),
                r.size,
                r.validator.clone(),
                r.final_url.clone().unwrap_or_else(|| r.url.clone()),
                r.down_limit_bps,
            )
        }) else {
            return PartsEnd::Stop;
        };
        let (Some(total), Some(validator)) = (total, validator) else {
            return PartsEnd::Fallback;
        };
        let file = match tokio::task::block_in_place(|| open_parts_file(&folder, &name, total, held_of(&segs), fresh)) {
            Ok(f) => f,
            Err(ev) => {
                self.dispatch(id, ev);
                return PartsEnd::Stop;
            }
        };
        let side_path = sidecar_path(&folder, &name);
        let mut side = Sidecar::new(&url, &name, Some(total), Some(validator.clone()));
        let n = segs.len();
        let shared = Arc::new(PartsShared::new(file, segs, total, validator, limit));
        self.update(id, |r, live| {
            live.parts = Some(shared.clone());
            r.held = held_of(&shared.snapshot());
        });
        let _guard = PartsGuard { dl: self.clone(), id: id.to_string(), shared: shared.clone() };
        // The layout is on disk before the first byte, so a crash at once still resumes per segment.
        self.flush_parts(id, &shared, &mut side, &side_path);

        let mut clock = StallClock::new(Instant::now());
        let mut tick = tokio::time::interval(REPORT_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_flush = Instant::now();
        let mut last_report = Instant::now();
        let mut last_bytes = 0u64;
        let mut last_held = held_of(&shared.snapshot());
        let mut bps_smooth: f64 = 0.0;
        let mut limit = limit;
        // Contract 17.v. How many connections the server takes: the plan, until a refusal lowers it for the rest of
        // the run. After a refusal every segment started is patient (it retries a 429 instead of giving up its turn).
        let mut max_live = n.max(1);
        let mut refused_once = false;

        loop {
            let mut set: JoinSet<(usize, SegEnd)> = JoinSet::new();
            let mut waiting: VecDeque<usize> = (0..n).collect();
            // Set when every running segment was refused: nothing starts before the server's Retry-After.
            let mut resume_at: Option<Instant> = None;
            let outcome = loop {
                let ready = match resume_at {
                    Some(t) => Instant::now() >= t,
                    None => true,
                };
                if ready {
                    resume_at = None;
                    // One in, one out: a free slot goes to the next waiting segment, lowest index first.
                    while set.len() < max_live {
                        let Some(idx) = waiting.pop_front() else { break };
                        let s = shared.segs.lock()[idx].clone();
                        if s.pos > s.end {
                            continue;
                        }
                        let (me, id2, client2, sh, host) =
                            (self.clone(), id.to_string(), client.clone(), shared.clone(), typed_host.to_string());
                        let patient = refused_once;
                        set.spawn(async move { (idx, me.segment_loop(&id2, &client2, &sh, idx, &host, patient).await) });
                    }
                }
                if set.is_empty() && waiting.is_empty() {
                    break Outcome::AllDone;
                }
                tokio::select! {
                    joined = set.join_next(), if !set.is_empty() => match joined {
                        None | Some(Ok((_, SegEnd::Done))) => {}
                        Some(Ok((idx, SegEnd::Refused { retry_after }))) => {
                            // The server took the others (or none): it stays at that many connections from now on.
                            refused_once = true;
                            waiting.push_back(idx);
                            max_live = max_live.min(set.len().max(1));
                            if set.is_empty() && resume_at.is_none() {
                                resume_at = Some(Instant::now() + backoff_delay(0, retry_after, jitter()));
                            }
                        }
                        Some(Ok((_, SegEnd::Fallback))) | Some(Err(_)) => break Outcome::Fallback,
                        Some(Ok((_, SegEnd::Fatal(ev)))) => break Outcome::Event(ev),
                        Some(Ok((_, SegEnd::Exhausted))) => break Outcome::Event(Event::Transient { attempts: MAX_ATTEMPTS }),
                        Some(Ok((_, SegEnd::Stopped))) => break Outcome::Stopped,
                    },
                    _ = tick.tick() => {
                        let now = Instant::now();
                        let held = held_of(&shared.snapshot());
                        let bytes = shared.bytes.load(Ordering::Relaxed);
                        let delta = bytes.saturating_sub(last_bytes);
                        last_bytes = bytes;
                        if delta > 0 {
                            clock.on_bytes(now, delta);
                        }
                        // Waiting out the server's Retry-After, tick by tick, is not a stall either.
                        if resume_at.is_some() {
                            clock.excuse(last_report.elapsed(), now);
                        }
                        // Time the segments spent in our own limiters is nobody's stall.
                        let waited = shared.wait_ms.swap(0, Ordering::Relaxed);
                        if waited > 0 {
                            let live_tasks = u64::from(shared.active().max(1));
                            clock.excuse(Duration::from_millis(waited / live_tasks), now);
                        }
                        if self.stall_step(id, limit, &mut clock) {
                            break Outcome::Stalled;
                        }
                        let dt = last_report.elapsed().as_secs_f64().max(0.001);
                        last_report = Instant::now();
                        let inst = held.saturating_sub(last_held) as f64 / dt;
                        last_held = held;
                        bps_smooth = if bps_smooth == 0.0 { inst } else { bps_smooth * 0.6 + inst * 0.4 };
                        // Quiet parts show no speed, and the average starts over when bytes come back (17.v).
                        let quiet = clock.quiet(now);
                        if quiet >= SPEED_QUIET {
                            bps_smooth = 0.0;
                        }
                        let held_back = resume_at.is_some();
                        let alive = self.update(id, |rec, live| {
                            rec.held = held;
                            live.bps = shown_speed(bps_smooth, quiet);
                            if held_back {
                                // Every part waits for the server's Retry-After.
                                live.stalled = true;
                            }
                            if delta > 0 {
                                live.stalled = false;
                                live.attempts = 0;
                                live.denied = 0;
                            }
                            limit = rec.down_limit_bps;
                            rec.state == State::Downloading
                        });
                        shared.limit.store(limit, Ordering::Relaxed);
                        if alive != Some(true) {
                            break Outcome::Stopped;
                        }
                        if last_flush.elapsed() >= SIDECAR_FLUSH {
                            last_flush = Instant::now();
                            self.flush_parts(id, &shared, &mut side, &side_path);
                        }
                    }
                }
            };
            // Every segment task is over before anything else happens: no late write can land after this.
            set.abort_all();
            while set.join_next().await.is_some() {}
            drop(set);

            match outcome {
                Outcome::AllDone => {
                    let snap = shared.snapshot();
                    if held_of(&snap) < total || snap.iter().any(|s| s.pos <= s.end) {
                        return self.fall_back(id, &shared, &mut side, &side_path);
                    }
                    self.update(id, |rec, _| {
                        rec.size = Some(total);
                        rec.held = total;
                    });
                    self.finish(id, &shared.file);
                    return PartsEnd::Done;
                }
                Outcome::Fallback => return self.fall_back(id, &shared, &mut side, &side_path),
                Outcome::Event(ev) => {
                    self.flush_parts(id, &shared, &mut side, &side_path);
                    self.update(id, |rec, _| rec.held = held_of(&shared.snapshot()));
                    self.dispatch(id, ev);
                    return PartsEnd::Stop;
                }
                Outcome::Stopped => return PartsEnd::Stop,
                Outcome::Stalled => {
                    self.flush_parts(id, &shared, &mut side, &side_path);
                    self.update(id, |rec, _| rec.held = held_of(&shared.snapshot()));
                    if !self.stall_retry(id, Some(&mut clock)).await {
                        return PartsEnd::Stop;
                    }
                    tick.reset();
                    last_report = Instant::now();
                }
            }
        }
    }

    /// Splitting is over for this download, for good. The sidecar is cut down to the contiguous prefix, which the
    /// single connection resumes from under the usual rules.
    fn fall_back(self: &Arc<Self>, id: &str, shared: &PartsShared, side: &mut Sidecar, side_path: &Path) -> PartsEnd {
        let prefix = contiguous_prefix(&shared.snapshot());
        let alive = self.update(id, |rec, live| {
            rec.split_off = true;
            rec.held = prefix;
            live.bps = 0;
        });
        if alive.is_none() {
            return PartsEnd::Stop;
        }
        tokio::task::block_in_place(|| {
            let _ = shared.file.sync_data();
            side.segments = vec![Segment { start: 0, end: shared.total.saturating_sub(1), pos: prefix }];
            let guard = self.inner.lock();
            if guard.records.contains_key(id) {
                let _ = side.save(side_path);
            }
        });
        // The flag is saved, so a restart does not try to split again.
        self.save();
        PartsEnd::Fallback
    }

    fn flush_parts(&self, id: &str, shared: &PartsShared, side: &mut Sidecar, path: &Path) {
        tokio::task::block_in_place(|| {
            // Snapshot first, then sync: a position only advances after its bytes are written, so every byte the
            // snapshot claims is on disk once sync_data returns. Syncing first could record bytes written after it.
            side.segments = shared.snapshot();
            let _ = shared.file.sync_data();
            let guard = self.inner.lock();
            if guard.records.contains_key(id) {
                let _ = side.save(path);
            }
        });
    }

    /// The ranged GET of one segment, with the same headers as every other request of the download.
    fn build_part_get(
        &self,
        id: &str,
        client: &Client,
        start: u64,
        end: u64,
        validator: &str,
    ) -> Option<(reqwest::RequestBuilder, CookiePicker)> {
        self.update(id, |rec, live| {
            let hdrs = super::LinkHeaders::from_live(live);
            let mut b = hdrs.apply(client.get(rec.url.as_str()).header(ACCEPT_ENCODING, "identity"), rec.url.as_str());
            if let Some((u, p)) = &live.auth {
                b = b.basic_auth(u, Some(p));
            }
            let b = match HeaderValue::from_str(validator) {
                Ok(v) => b.header(RANGE, format!("bytes={start}-{end}")).header(IF_RANGE, v),
                // Cannot happen (it came from a header), and without a range the answer is a 200: a fallback.
                Err(_) => b,
            };
            (b, hdrs.picker(rec.url.as_str()))
        })
    }

    /// One failed attempt of a segment: wait the backoff, say whether to go on. Offline does not use up tries.
    async fn part_retry(&self, attempts: &mut u32, retry_after: Option<Duration>) -> bool {
        if self.is_offline() {
            tokio::time::sleep(Duration::from_secs(2)).await;
            return true;
        }
        let n = *attempts;
        *attempts += 1;
        if n >= MAX_ATTEMPTS {
            return false;
        }
        tokio::time::sleep(backoff_delay(n, retry_after, jitter())).await;
        true
    }

    /// The global limit is the session's limiter, shared with torrents and every other segment.
    async fn throttle_global(&self, shared: &PartsShared, len: usize) {
        let (Some(session), Some(bps)) = (self.session.as_ref(), self.global_down_bps()) else {
            return;
        };
        let step_max = bps.get().min(16 * 1024) as usize;
        let waiting_since = Instant::now();
        let mut left = len;
        while left > 0 {
            let n = left.min(step_max.max(1));
            if let Some(nz) = NonZeroU32::new(n as u32) {
                let _ = session.ratelimits.prepare_for_download(nz).await;
            }
            left -= n;
        }
        shared.add_wait(waiting_since.elapsed());
    }

    /// The per-download limit, against the bytes of all segments together.
    async fn pace_parts(&self, shared: &PartsShared, bytes_so_far: u64) {
        let limit = shared.limit.load(Ordering::Relaxed);
        if limit == 0 {
            return;
        }
        let wait = pace_delay(bytes_so_far, shared.started.elapsed(), limit);
        if !wait.is_zero() {
            let slept = wait.min(Duration::from_secs(2));
            tokio::time::sleep(slept).await;
            shared.add_wait(slept);
        }
    }

    /// One segment: request its remaining range, write the body at its offsets, retry what is retryable.
    async fn segment_loop(
        self: &Arc<Self>,
        id: &str,
        client: &Client,
        shared: &Arc<PartsShared>,
        idx: usize,
        typed_host: &str,
        patient: bool,
    ) -> SegEnd {
        let _live = ActiveTick::new(shared);
        let mut attempts = 0u32;
        loop {
            let (end, mut pos) = {
                let g = shared.segs.lock();
                (g[idx].end, g[idx].pos)
            };
            if pos > end {
                return SegEnd::Done;
            }
            if self.state_of(id) != Some(State::Downloading) {
                return SegEnd::Stopped;
            }
            let Some((builder, picker)) = self.build_part_get(id, client, pos, end, &shared.validator) else {
                return SegEnd::Stopped;
            };
            let mut resp = match send_following(client, builder, &picker).await {
                Ok(r) => r,
                Err(e) => {
                    if let Some(r) = refusal(&e, typed_host) {
                        return SegEnd::Fatal(refusal_event(r));
                    }
                    if !self.part_retry(&mut attempts, None).await {
                        return SegEnd::Exhausted;
                    }
                    continue;
                }
            };
            let status = resp.status().as_u16();
            let headers = read_headers(resp.headers());
            match judge_part(status, &headers, pos, end, shared.total, &shared.validator) {
                PartReply::Body => {}
                PartReply::Fallback => return SegEnd::Fallback,
                PartReply::Retry { retry_after } => {
                    if !self.part_retry(&mut attempts, retry_after).await {
                        return SegEnd::Exhausted;
                    }
                    continue;
                }
                // Refused: give the turn back to the coordinator, unless this segment already got its turn after a
                // refusal, in which case the server is told to wait its Retry-After like any retry.
                PartReply::Refused { retry_after } => {
                    if !patient {
                        return SegEnd::Refused { retry_after };
                    }
                    if !self.part_retry(&mut attempts, retry_after).await {
                        return SegEnd::Exhausted;
                    }
                    continue;
                }
            }
            // The body is collected per connection and written in 1 MiB blocks. `segs[idx].pos` (what the sidecar, the
            // progress sum and the contiguous prefix read) moves only to `wb.written()`, after a write returned Ok,
            // so no persisted position is ever ahead of the part file. `pos` below is that written position.
            let mut wb = WriteBuf::new(pos);
            let mut write = |b: &[u8], off: u64| tokio::task::block_in_place(|| write_all_at(&shared.file, b, off));
            loop {
                let chunk = match tokio::time::timeout(STALL_TICK, resp.chunk()).await {
                    Ok(Ok(Some(c))) => c,
                    Ok(Ok(None)) | Ok(Err(_)) => break,
                    Err(_) => {
                        // Nothing for a few seconds: the coordinator's stall rule judges the sum. Held bytes go to
                        // disk now, so a quiet link does not sit on them and a pause finds them written.
                        let flushed = wb.flush(&mut write);
                        publish(shared, idx, &wb, &mut pos);
                        if let Err(e) = flushed {
                            let ev = io_event(&e, attempts);
                            if matches!(ev, Event::Transient { .. }) {
                                break;
                            }
                            return SegEnd::Fatal(ev);
                        }
                        if self.state_of(id) != Some(State::Downloading) {
                            return SegEnd::Stopped;
                        }
                        continue;
                    }
                };
                let len = chunk.len() as u64;
                // More than the range asked for: not the server we probed. The held bytes are dropped.
                if wb.received().saturating_add(len) > end.saturating_add(1) {
                    return SegEnd::Fallback;
                }
                self.throttle_global(shared, chunk.len()).await;
                let now = Instant::now();
                let mut stored = wb.push(&chunk, now, &mut write);
                if stored.is_ok() && wb.due(now) {
                    stored = wb.flush(&mut write);
                }
                publish(shared, idx, &wb, &mut pos);
                if let Err(e) = stored {
                    let ev = io_event(&e, attempts);
                    if matches!(ev, Event::Transient { .. }) {
                        break;
                    }
                    return SegEnd::Fatal(ev);
                }
                // Speed and the stall clock count what arrived; progress counts what is written.
                let so_far = shared.bytes.fetch_add(len, Ordering::Relaxed) + len;
                attempts = 0;
                self.pace_parts(shared, so_far).await;
            }
            // The connection ended or broke: write what is held (a failure only means those bytes are asked for again).
            let _ = wb.flush(&mut write);
            publish(shared, idx, &wb, &mut pos);
            if pos > end {
                return SegEnd::Done;
            }
            // The connection broke or ended early: ask again for what is missing.
            if !self.part_retry(&mut attempts, None).await {
                return SegEnd::Exhausted;
            }
        }
    }
}

/// Moves a segment's recorded position up to what is on disk. Never past it: `wb.written()` only advances after a
/// successful write.
fn publish(shared: &PartsShared, idx: usize, wb: &WriteBuf, pos: &mut u64) {
    let written = wb.written();
    if written != *pos {
        *pos = written;
        shared.segs.lock()[idx].pos = written;
    }
}

/// Opens the part file. A fresh one is emptied and pre-allocated to the full size after the free-space check; a
/// resumed one keeps its bytes (the check counts only what is still missing).
fn open_parts_file(folder: &Path, name: &str, total: u64, held: u64, fresh: bool) -> Result<File, Event> {
    std::fs::create_dir_all(folder).map_err(|e| io_event(&e, 0))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(part_path(folder, name))
        .map_err(|e| io_event(&e, 0))?;
    let held = if fresh { 0 } else { held };
    if !fits(Some(total), held, free_space(folder)) {
        return Err(Event::Enospc);
    }
    if fresh {
        file.set_len(0).map_err(|e| io_event(&e, 0))?;
    }
    if file.metadata().map(|m| m.len()).unwrap_or(0) != total {
        file.set_len(total).map_err(|e| io_event(&e, 0))?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_dl::sidecar::sidecar_path;
    use serde_json::Value;
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    use super::super::{DlRecord, Live};

    // ---- pure ----

    fn facts<'a>(v: Option<&'a str>) -> SplitFacts<'a> {
        SplitFacts { requested: 4, size: Some(MIN_SPLIT_BYTES), validator: v, resumable: true, probe_ok: true, split_off: false }
    }

    #[test]
    fn a_plan_adds_up_to_the_file_and_gives_the_remainder_to_the_first_ranges() {
        let total = 8 * 1024 * 1024 + 3;
        let plan = plan_split(total, 4);
        assert_eq!(plan.len(), 4);
        assert_eq!(plan[0].start, 0);
        assert_eq!(plan[3].end, total - 1);
        let sizes: Vec<u64> = plan.iter().map(|s| s.end - s.start + 1).collect();
        assert_eq!(sizes.iter().sum::<u64>(), total);
        assert_eq!(sizes, vec![2097153, 2097153, 2097153, 2097152]);
        for w in plan.windows(2) {
            assert_eq!(w[0].end + 1, w[1].start);
        }
        assert!(plan.iter().all(|s| s.pos == s.start));
        assert!(valid_layout(&plan, total));
    }

    #[test]
    fn a_plan_of_one_or_an_exact_division_is_still_exact() {
        assert_eq!(plan_split(100, 1), vec![Segment { start: 0, end: 99, pos: 0 }]);
        let even = plan_split(80, 8);
        assert!(even.iter().all(|s| s.end - s.start + 1 == 10));
        // More parts than the cap are cut to the cap; more parts than bytes to one byte each.
        assert_eq!(plan_split(1000, 20).len(), 8);
        assert_eq!(plan_split(3, 8).len(), 3);
    }

    #[test]
    fn eight_mib_is_the_threshold() {
        let mut f = facts(Some("\"v\""));
        f.size = Some(MIN_SPLIT_BYTES - 1);
        assert_eq!(split_count(&f), None);
        f.size = Some(MIN_SPLIT_BYTES);
        assert_eq!(split_count(&f), Some(4));
        f.size = None;
        assert_eq!(split_count(&f), None);
    }

    #[test]
    fn one_connection_unless_the_server_proved_it_can_do_more() {
        // Strong validator, ranges, 206: split.
        assert_eq!(split_count(&facts(Some("\"v\""))), Some(4));
        // No validator (a weak ETag with no Last-Modified is no validator at all).
        assert_eq!(split_count(&facts(None)), None);
        assert_eq!(pick_validator(Some("W/\"weak\""), None), None);
        // The probe was a 200, or the server did not say bytes.
        let mut f = facts(Some("\"v\""));
        f.probe_ok = false;
        assert_eq!(split_count(&f), None);
        // Setting of 1, not resumable, or an earlier fallback.
        let mut f = facts(Some("\"v\""));
        f.requested = 1;
        assert_eq!(split_count(&f), None);
        let mut f = facts(Some("\"v\""));
        f.resumable = false;
        assert_eq!(split_count(&f), None);
        let mut f = facts(Some("\"v\""));
        f.split_off = true;
        assert_eq!(split_count(&f), None);
        // Eight is the most.
        let mut f = facts(Some("\"v\""));
        f.requested = 8;
        assert_eq!(split_count(&f), Some(8));
    }

    #[test]
    fn the_probe_must_be_a_206_with_accept_ranges_bytes_or_a_content_range() {
        let info = |is206| ProbeInfo { size: Some(1), validator: Some("v".into()), resumable: true, probe_was_206: is206 };
        let h = |ar: Option<&str>| Headers { accept_ranges: ar.map(str::to_string), ..Headers::default() };
        let hc = |ar: Option<&str>, cr: &str| Headers {
            accept_ranges: ar.map(str::to_string),
            content_range: Some(cr.to_string()),
            ..Headers::default()
        };
        assert!(parts_probe_ok(&info(true), &h(Some("bytes"))));
        assert!(!parts_probe_ok(&info(false), &h(Some("bytes"))));
        assert!(!parts_probe_ok(&info(true), &h(Some("none"))));
        assert!(!parts_probe_ok(&info(true), &h(None)));
        // nginx (proof.ovh.net, Hetzner): 206 + Content-Range, no Accept-Ranges on the 206.
        assert!(parts_probe_ok(&info(true), &hc(None, "bytes 0-0/104857600")));
        // Not a 206, an explicit none, an unknown total or a broken range: no split.
        assert!(!parts_probe_ok(&info(false), &hc(None, "bytes 0-0/104857600")));
        assert!(!parts_probe_ok(&info(true), &hc(Some("none"), "bytes 0-0/104857600")));
        assert!(!parts_probe_ok(&info(true), &hc(None, "bytes 0-0/*")));
        assert!(!parts_probe_ok(&info(true), &hc(None, "bytes */104857600")));
        assert!(!parts_probe_ok(&info(true), &hc(None, "bytes 5-2/100")));
    }

    #[test]
    fn progress_is_the_sum_of_the_segments() {
        let segs = vec![
            Segment { start: 0, end: 99, pos: 40 },
            Segment { start: 100, end: 199, pos: 200 },
            Segment { start: 200, end: 299, pos: 250 },
        ];
        assert_eq!(held_of(&segs), 40 + 100 + 50);
        assert_eq!(contiguous_prefix(&segs), 40);
    }

    #[test]
    fn a_saved_layout_must_tile_the_file() {
        let ok = vec![Segment { start: 0, end: 49, pos: 10 }, Segment { start: 50, end: 99, pos: 50 }];
        assert!(valid_layout(&ok, 100));
        assert!(!valid_layout(&ok, 101), "does not reach the end");
        let gap = vec![Segment { start: 0, end: 49, pos: 0 }, Segment { start: 60, end: 99, pos: 60 }];
        assert!(!valid_layout(&gap, 100));
        let outside = vec![Segment { start: 0, end: 49, pos: 51 }, Segment { start: 50, end: 99, pos: 50 }];
        assert!(!valid_layout(&outside, 100));
        assert!(!valid_layout(&ok[..1], 50), "a single segment is not a split");
    }

    fn part_headers(range: &str, etag: Option<&str>) -> Headers {
        Headers { content_range: Some(range.to_string()), etag: etag.map(str::to_string), ..Headers::default() }
    }

    #[test]
    fn a_segment_needs_a_206_for_exactly_its_range() {
        let v = "\"v\"";
        let good = part_headers("bytes 100-199/1000", Some(v));
        assert_eq!(judge_part(206, &good, 100, 199, 1000, v), PartReply::Body);
        // A response without a validator header cannot be compared and is let through (as for a single GET).
        assert_eq!(judge_part(206, &part_headers("bytes 100-199/1000", None), 100, 199, 1000, v), PartReply::Body);
        // Wrong start, wrong end, wrong total, no Content-Range, drifted validator.
        assert_eq!(judge_part(206, &part_headers("bytes 0-199/1000", Some(v)), 100, 199, 1000, v), PartReply::Fallback);
        assert_eq!(judge_part(206, &part_headers("bytes 100-150/1000", Some(v)), 100, 199, 1000, v), PartReply::Fallback);
        assert_eq!(judge_part(206, &part_headers("bytes 100-199/2000", Some(v)), 100, 199, 1000, v), PartReply::Fallback);
        assert_eq!(judge_part(206, &Headers::default(), 100, 199, 1000, v), PartReply::Fallback);
        assert_eq!(judge_part(206, &part_headers("bytes 100-199/1000", Some("\"other\"")), 100, 199, 1000, v), PartReply::Fallback);
    }

    #[test]
    fn a_200_or_another_status_on_a_segment_ends_the_split() {
        let h = Headers::default();
        for s in [200u16, 401, 403, 416, 404, 301] {
            assert_eq!(judge_part(s, &h, 0, 9, 10, "v"), PartReply::Fallback, "{s}");
        }
        for s in [408u16, 500, 502, 504] {
            assert!(matches!(judge_part(s, &h, 0, 9, 10, "v"), PartReply::Retry { .. }), "{s}");
        }
    }

    #[test]
    fn a_429_or_a_503_on_a_segment_is_a_refusal_that_keeps_the_split() {
        let h = Headers { retry_after: Some("10".into()), ..Headers::default() };
        for s in [429u16, 503] {
            assert_eq!(
                judge_part(s, &h, 0, 9, 10, "v"),
                PartReply::Refused { retry_after: Some(Duration::from_secs(10)) },
                "{s}"
            );
        }
        assert_eq!(judge_part(429, &Headers::default(), 0, 9, 10, "v"), PartReply::Refused { retry_after: None });
    }

    // ---- a small HTTP server on localhost ----

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        Normal,
        /// A closed range that does not start at 0 is answered with the whole file (a server that ignores it).
        Segment200,
        /// 50 ms between 64 KiB pieces, so a download can be paused while it runs.
        Slow,
        /// Like Slow, but at most this many bodies of closed ranges at once; the rest get 429 + `Retry-After: 1`
        /// (proof.ovh.net allows 4 per address).
        Limit(usize),
        /// Like Slow, but the first this-many closed-range requests get 429 + `Retry-After: 1`, whatever is running.
        RefuseFirst(usize),
        /// Every body (ranged or not) sends 1 MiB at a network-like pace (64 KiB per 50 ms, so progress is reported),
        /// goes silent for 5 s, then sends the rest at full speed.
        Gap,
    }

    #[derive(Default)]
    struct Stats {
        /// The text after `bytes=` of every ranged request.
        ranges: Mutex<Vec<String>>,
        /// Bodies being sent right now.
        inflight: AtomicUsize,
        /// Closed-range bodies admitted under `Limit` and not finished.
        admitted: AtomicUsize,
        /// 429s sent.
        refused: AtomicUsize,
    }

    struct Admitted(Arc<Stats>);
    impl Drop for Admitted {
        fn drop(&mut self) {
            self.0.admitted.fetch_sub(1, Ordering::SeqCst);
        }
    }

    struct Inflight(Arc<Stats>);
    impl Drop for Inflight {
        fn drop(&mut self) {
            self.0.inflight.fetch_sub(1, Ordering::SeqCst);
        }
    }

    const ETAG: &str = "\"v1\"";

    async fn serve(data: Arc<Vec<u8>>, mode: Mode) -> (u16, Arc<Stats>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let stats = Arc::new(Stats::default());
        let st = stats.clone();
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                let (data, st) = (data.clone(), st.clone());
                tokio::spawn(async move {
                    let _ = answer(sock, data, mode, st).await;
                });
            }
        });
        (port, stats)
    }

    async fn answer(mut sock: TcpStream, data: Arc<Vec<u8>>, mode: Mode, st: Arc<Stats>) -> std::io::Result<()> {
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
        let total = data.len() as u64;
        let range = header("range").and_then(|r| r.strip_prefix("bytes=").map(str::to_string));
        if let Some(r) = &range {
            st.ranges.lock().push(r.clone());
        }
        let if_range_ok = header("if-range").map(|v| v == ETAG).unwrap_or(true);
        // (start, end, closed)
        let parsed = range.as_deref().filter(|_| if_range_ok).and_then(|r| {
            let (a, b) = r.split_once('-')?;
            let a: u64 = a.parse().ok()?;
            let b = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
            Some((a, b, !r.ends_with('-')))
        });
        let refuse = mode == Mode::Segment200 && matches!(parsed, Some((a, _, true)) if a > 0);
        // A closed range other than the 0-0 probe: what a part asks for.
        let part = matches!(parsed, Some((a, b, true)) if !(a == 0 && b == 0));
        let mut _admitted = None;
        let too_many = match mode {
            Mode::Limit(n) if part => {
                if st.admitted.fetch_add(1, Ordering::SeqCst) >= n {
                    st.admitted.fetch_sub(1, Ordering::SeqCst);
                    true
                } else {
                    _admitted = Some(Admitted(st.clone()));
                    false
                }
            }
            Mode::RefuseFirst(n) if part => st.refused.load(Ordering::SeqCst) < n,
            _ => false,
        };
        if too_many {
            st.refused.fetch_add(1, Ordering::SeqCst);
            sock.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await?;
            return sock.shutdown().await;
        }
        let (status, (from, to), content_range) = match parsed {
            Some((a, b, _)) if !refuse => ("206 Partial Content", (a, b), Some(format!("bytes {a}-{b}/{total}"))),
            _ => ("200 OK", (0, total - 1), None),
        };
        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nETag: {ETAG}\r\nConnection: close\r\n",
            to - from + 1
        );
        if let Some(cr) = content_range {
            head.push_str(&format!("Content-Range: {cr}\r\n"));
        }
        head.push_str("\r\n");
        sock.write_all(head.as_bytes()).await?;
        st.inflight.fetch_add(1, Ordering::SeqCst);
        let _gone = Inflight(st.clone());
        let (start, mut at, end) = (from as usize, from as usize, to as usize + 1);
        let slow = matches!(mode, Mode::Slow | Mode::Limit(_) | Mode::RefuseFirst(_));
        let mut gapped = false;
        while at < end {
            let next = (at + 64 * 1024).min(end);
            sock.write_all(&data[at..next]).await?;
            at = next;
            if slow || (mode == Mode::Gap && !gapped) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if mode == Mode::Gap && !gapped && at - start >= 1024 * 1024 {
                gapped = true;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
        // A finished part frees its slot before the client can ask again.
        drop(_admitted);
        sock.shutdown().await
    }

    fn sample(n: usize) -> Vec<u8> {
        (0..n).map(|i| ((i.wrapping_mul(31)) ^ (i >> 7)) as u8).collect()
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("maglev-dl-parts-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn manager(dir: &Path) -> Arc<Downloads> {
        Downloads::build(tokio::runtime::Handle::current(), None, dir, dir, None, Vec::new())
    }

    async fn wait_for(d: &Arc<Downloads>, state: &str) -> Value {
        let t0 = Instant::now();
        loop {
            let snap = d.snapshots();
            let cur = snap.first().cloned().unwrap_or(Value::Null);
            if cur["state"] == state {
                return cur;
            }
            assert!(cur["state"] != "error", "download failed: {cur}");
            assert!(t0.elapsed() < Duration::from_secs(60), "timed out in {}: {cur}", cur["state"]);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    /// The closed ranges that were asked for, as (start, end), not counting the 0-0 probe.
    fn closed_ranges(stats: &Stats) -> Vec<(u64, u64)> {
        let mut v: Vec<(u64, u64)> = stats
            .ranges
            .lock()
            .iter()
            .filter(|r| !r.ends_with('-') && r.as_str() != "0-0")
            .filter_map(|r| {
                let (a, b) = r.split_once('-')?;
                Some((a.parse().ok()?, b.parse().ok()?))
            })
            .collect();
        v.sort();
        v
    }

    const BIG: usize = 9 * 1024 * 1024 + 123;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn four_parts_are_written_at_their_offsets_and_make_the_file() {
        let dir = tmpdir("e2e");
        let data = Arc::new(sample(BIG));
        let (port, stats) = serve(data.clone(), Mode::Normal).await;
        let d = manager(&dir);
        d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":4}"#).unwrap();
        let snap = wait_for(&d, "finished").await;
        assert_eq!(snap["downloaded"].as_u64(), Some(BIG as u64));
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        let want: Vec<(u64, u64)> = plan_split(BIG as u64, 4).iter().map(|s| (s.start, s.end)).collect();
        assert_eq!(closed_ranges(&stats), want);
        assert!(!part_path(&dir, "big.bin").exists());
        assert!(!sidecar_path(&dir, "big.bin").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_setting_of_one_uses_one_plain_connection() {
        let dir = tmpdir("one");
        let data = Arc::new(sample(BIG));
        let (port, stats) = serve(data.clone(), Mode::Normal).await;
        let d = manager(&dir);
        d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":1}"#).unwrap();
        wait_for(&d, "finished").await;
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        assert!(closed_ranges(&stats).is_empty(), "{:?}", stats.ranges.lock());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_200_on_a_segment_falls_back_to_one_connection_for_good() {
        let dir = tmpdir("fallback");
        let data = Arc::new(sample(BIG));
        let (port, _stats) = serve(data.clone(), Mode::Segment200).await;
        let d = manager(&dir);
        d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":4}"#).unwrap();
        let snap = wait_for(&d, "finished").await;
        assert_eq!(snap["downloaded"].as_u64(), Some(BIG as u64));
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        assert!(d.inner.lock().records.values().all(|r| r.split_off));
        // Saved, so a restart does not try to split again.
        let saved = std::fs::read_to_string(dir.join("maglev-downloads.json")).unwrap();
        assert!(saved.contains("\"split_off\":true"), "{saved}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn each_segment_resumes_from_its_own_saved_offset() {
        let dir = tmpdir("resume");
        let data = Arc::new(sample(BIG));
        let total = BIG as u64;
        let (port, stats) = serve(data.clone(), Mode::Normal).await;
        let url = format!("http://127.0.0.1:{port}/big.bin");
        let mut segs = plan_split(total, 4);
        segs[0].pos = segs[0].end + 1; // done
        segs[1].pos = segs[1].start + 1000;
        // segment 2 has not started
        segs[3].pos = segs[3].start + 777_777;
        // The bytes that were "saved" are right; everything else in the file is junk that must be overwritten.
        let mut part = vec![0xAAu8; BIG];
        for s in &segs {
            let (a, b) = (s.start as usize, s.pos as usize);
            part[a..b].copy_from_slice(&data[a..b]);
        }
        std::fs::write(part_path(&dir, "big.bin"), &part).unwrap();
        let mut sc = Sidecar::new(&url, "big.bin", Some(total), Some(ETAG.into()));
        sc.segments = segs.clone();
        sc.save(&sidecar_path(&dir, "big.bin")).unwrap();

        let d = manager(&dir);
        let rec = DlRecord {
            id: "dl_1".into(),
            url: url.clone(),
            final_url: Some(url.clone()),
            name: "big.bin".into(),
            folder: dir.to_string_lossy().into_owned(),
            state: State::Downloading,
            size: Some(total),
            held: held_of(&segs),
            validator: Some(ETAG.into()),
            resumable: true,
            parts_ok: true,
            segments: 4,
            ..DlRecord::default()
        };
        {
            let mut inner = d.inner.lock();
            inner.live.insert("dl_1".into(), Live::default());
            inner.records.insert("dl_1".into(), rec);
        }
        d.clone().transfer("dl_1".into()).await;
        wait_for(&d, "finished").await;
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        // Only what was missing was asked for, from each segment's own offset; the finished one not at all.
        let want: Vec<(u64, u64)> = segs.iter().filter(|s| s.pos <= s.end).map(|s| (s.pos, s.end)).collect();
        assert_eq!(want.len(), 3);
        assert_eq!(closed_ranges(&stats), want);
        assert!(!stats.ranges.lock().iter().any(|r| r == "0-0"), "no probe on resume");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_download_limit_is_shared_by_every_part() {
        let dir = tmpdir("limit");
        let data = Arc::new(sample(BIG));
        let (port, _stats) = serve(data.clone(), Mode::Normal).await;
        let d = manager(&dir);
        let t0 = Instant::now();
        // 8 MiB/s for the whole download. A limit that applied to each of the 4 parts would allow 32 MiB/s and finish
        // in a third of a second.
        d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":4,"down_limit_bps":8388608}"#).unwrap();
        wait_for(&d, "finished").await;
        let took = t0.elapsed();
        assert!(took >= Duration::from_millis(900), "finished in {took:?}");
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pausing_stops_every_part_and_resuming_goes_on_from_the_saved_offsets() {
        let dir = tmpdir("pause");
        let data = Arc::new(sample(BIG));
        let (port, stats) = serve(data.clone(), Mode::Slow).await;
        let d = manager(&dir);
        let id = d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":4}"#).unwrap().id;
        let t0 = Instant::now();
        loop {
            let snap = d.snapshots();
            if snap[0]["segments_active"].as_u64().unwrap_or(0) >= 2 && snap[0]["downloaded"].as_u64().unwrap_or(0) > 0 {
                break;
            }
            assert!(t0.elapsed() < Duration::from_secs(20), "never ran in parts: {}", snap[0]);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        d.pause(&id).unwrap();
        let t1 = Instant::now();
        loop {
            let snap = d.snapshots();
            let none_left = d.inner.lock().live.get(&id).map(|l| l.parts.is_none()).unwrap_or(true);
            if snap[0]["state"] == "paused"
                && snap[0]["segments_active"].as_u64() == Some(0)
                && none_left
                && stats.inflight.load(Ordering::SeqCst) == 0
            {
                break;
            }
            assert!(t1.elapsed() < Duration::from_secs(5), "parts kept running: {}", snap[0]);
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let saved = Sidecar::load(&sidecar_path(&dir, "big.bin")).expect("sidecar after a pause");
        assert!(saved.is_split());
        assert!(saved.held() > 0 && saved.held() < BIG as u64);
        d.resume(&id).unwrap();
        let snap = wait_for(&d, "finished").await;
        assert_eq!(snap["downloaded"].as_u64(), Some(BIG as u64));
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        // Every unfinished segment was asked again from its own saved offset, not from its start.
        let asked = closed_ranges(&stats);
        for s in saved.segments.iter().filter(|s| s.pos <= s.end) {
            assert!(asked.contains(&(s.pos, s.end)), "{s:?} not in {asked:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    // ---- contract 17.v: refused parts, and no speed while nothing moves ----

    /// proof.ovh.net took 4 of 8 parts and refused the rest with 429. The accepted parts keep going, each refused
    /// part waits for a slot, nothing falls back to one connection, and no range is fetched twice.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refused_parts_wait_for_a_slot_and_the_accepted_parts_keep_their_bytes() {
        let dir = tmpdir("refused");
        let data = Arc::new(sample(BIG));
        let (port, stats) = serve(data.clone(), Mode::Limit(2)).await;
        let d = manager(&dir);
        d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":4}"#).unwrap();
        let snap = wait_for(&d, "finished").await;
        assert_eq!(snap["downloaded"].as_u64(), Some(BIG as u64));
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        let refused = stats.refused.load(Ordering::SeqCst);
        assert!(refused >= 2, "the server refused {refused}");
        assert!(!stats.ranges.lock().iter().any(|r| r.ends_with('-')), "fell back to one connection: {:?}", stats.ranges.lock());
        assert!(d.inner.lock().records.values().all(|r| !r.split_off));
        // Every request was one of the planned parts; each accepted part was asked once, each refusal once more.
        let plan: Vec<(u64, u64)> = plan_split(BIG as u64, 4).iter().map(|s| (s.start, s.end)).collect();
        let asked = closed_ranges(&stats);
        assert!(asked.iter().all(|r| plan.contains(r)), "{asked:?}");
        assert!(plan.iter().all(|r| asked.contains(r)), "{asked:?}");
        assert_eq!(asked.len(), plan.len() + refused, "{asked:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every part refused: the download waits the server's Retry-After and goes on one part at a time, keeping the
    /// layout, instead of opening a new connection for the whole rest of the file.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn when_every_part_is_refused_the_download_waits_then_goes_on_one_part_at_a_time() {
        let dir = tmpdir("allrefused");
        let data = Arc::new(sample(BIG));
        let (port, stats) = serve(data.clone(), Mode::RefuseFirst(4)).await;
        let d = manager(&dir);
        let t0 = Instant::now();
        d.add(&format!("http://127.0.0.1:{port}/big.bin"), r#"{"segments":4}"#).unwrap();
        // The engine's own count of running parts, once the server has refused all four.
        let mut most_after = 0u64;
        loop {
            let snap = d.snapshots();
            let cur = snap.first().cloned().unwrap_or(Value::Null);
            if cur["state"] == "finished" {
                break;
            }
            assert!(cur["state"] != "error", "download failed: {cur}");
            assert!(t0.elapsed() < Duration::from_secs(60), "timed out: {cur}");
            if stats.refused.load(Ordering::SeqCst) >= 4 {
                most_after = most_after.max(cur["segments_active"].as_u64().unwrap_or(0));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
        assert_eq!(stats.refused.load(Ordering::SeqCst), 4);
        assert!(t0.elapsed() >= Duration::from_millis(950), "did not wait Retry-After: {:?}", t0.elapsed());
        assert_eq!(most_after, 1, "more than one part at a time after a full refusal");
        assert!(!stats.ranges.lock().iter().any(|r| r.ends_with('-')), "fell back: {:?}", stats.ranges.lock());
        assert!(d.inner.lock().records.values().all(|r| !r.split_off));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AGENTS reality rule 2: a download whose server goes quiet shows no speed within a few seconds, over one
    /// connection and over parts. (On the phone a fading average read "15.2 KB/s, 50 min left" while nothing moved.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_download_that_goes_quiet_shows_no_speed() {
        for parts in [1u32, 4] {
            let dir = tmpdir(&format!("quiet{parts}"));
            let data = Arc::new(sample(BIG));
            let (port, _stats) = serve(data.clone(), Mode::Gap).await;
            let d = manager(&dir);
            d.add(&format!("http://127.0.0.1:{port}/big.bin"), &format!(r#"{{"segments":{parts}}}"#)).unwrap();
            let t0 = Instant::now();
            let (mut last_bytes, mut last_change) = (0u64, Instant::now());
            let mut seen_quiet = false;
            loop {
                let snap = d.snapshots();
                let cur = snap.first().cloned().unwrap_or(Value::Null);
                if cur["state"] == "finished" {
                    break;
                }
                assert!(cur["state"] != "error", "download failed: {cur}");
                assert!(t0.elapsed() < Duration::from_secs(60), "timed out: {cur}");
                let got = cur["downloaded"].as_u64().unwrap_or(0);
                if got != last_bytes {
                    last_bytes = got;
                    last_change = Instant::now();
                }
                // SPEED_QUIET is 2 s; a second more covers the report tick and the read timeout.
                if got > 0 && last_change.elapsed() >= SPEED_QUIET + Duration::from_secs(1) {
                    assert_eq!(cur["down_bps"].as_u64(), Some(0), "{parts} part(s), quiet {:?}: {cur}", last_change.elapsed());
                    seen_quiet = true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(seen_quiet, "{parts} part(s): the server's 5 s silence was never seen");
            assert_eq!(std::fs::read(dir.join("big.bin")).unwrap(), *data);
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// Redirect cookies: the link is on 127.0.0.1 and redirects to `localhost` (another host name). Only that second
    /// host answers, and only with its own cookie; the first host's cookie must not follow the redirect.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_redirect_to_another_host_carries_that_hosts_cookie_and_not_the_first() {
        let data = Arc::new(sample(3000));
        let cookies: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));

        // The second "host": needs `Cookie: c=1`, honours Range.
        let second = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let pb = second.local_addr().unwrap().port();
        let (d2, seen) = (data.clone(), cookies.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = second.accept().await else { return };
                let (data, seen) = (d2.clone(), seen.clone());
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    let header = |name: &str| {
                        text.lines().find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.trim().eq_ignore_ascii_case(name).then(|| v.trim().to_string())
                        })
                    };
                    let cookie = header("cookie");
                    seen.lock().push(cookie.clone());
                    if cookie.as_deref() != Some("c=1") {
                        let _ = sock
                            .write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                            .await;
                        return;
                    }
                    let total = data.len() as u64;
                    let range = header("range").and_then(|r| {
                        let (a, b) = r.strip_prefix("bytes=")?.split_once('-')?;
                        let a: u64 = a.parse().ok()?;
                        let b = if b.is_empty() { total - 1 } else { b.parse::<u64>().ok()?.min(total - 1) };
                        Some((a, b))
                    });
                    let (status, (from, to), cr) = match range {
                        Some((a, b)) => ("206 Partial Content", (a, b), format!("Content-Range: bytes {a}-{b}/{total}\r\n")),
                        None => ("200 OK", (0, total - 1), String::new()),
                    };
                    let head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nAccept-Ranges: bytes\r\nETag: {ETAG}\r\n{cr}Connection: close\r\n\r\n",
                        to - from + 1
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(&data[from as usize..=to as usize]).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        // The first "host": redirects every request to the second one.
        let first = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let pa = first.local_addr().unwrap().port();
        let first_saw: Arc<Mutex<Vec<Option<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let fs = first_saw.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = first.accept().await else { return };
                let fs = fs.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 2048];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    fs.lock().push(text.lines().find_map(|l| {
                        let (k, v) = l.split_once(':')?;
                        k.trim().eq_ignore_ascii_case("cookie").then(|| v.trim().to_string())
                    }));
                    let reply = format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://localhost:{pb}/file.bin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = sock.write_all(reply.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });

        let dir = tmpdir("redir-cookie");
        let d = manager(&dir);
        let opts = r#"{"headers":{"Cookie":"sid=1","Cookies":[{"host":"localhost","cookie":"c=1"}]}}"#;
        d.add(&format!("http://127.0.0.1:{pa}/dl"), opts).unwrap();
        wait_for(&d, "finished").await;
        assert_eq!(std::fs::read(dir.join("file.bin")).unwrap(), *data);
        // The first host got its own cookie; the second only ever saw its own.
        assert!(first_saw.lock().iter().all(|c| c.as_deref() == Some("sid=1")));
        let seen = cookies.lock();
        assert!(!seen.is_empty());
        assert!(seen.iter().all(|c| c.as_deref() == Some("c=1")), "{seen:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
