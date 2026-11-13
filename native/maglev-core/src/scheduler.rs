//! Pure queue, seed-limit and governance planner (contract section 4).
//!
//! Input: facts about each torrent, the limits, and the set of active governance blocks.
//! Output: the actions the engine must apply. Nothing here touches a session, so it is
//! unit tested on its own.
//!
//! Vocabulary for `paused_by`: `"user"`, `"seed_limit"`, or any other string, which is treated
//! as a governance tag (`"wifi_only"`, `"battery"`, `"charging_only"`). The health tags
//! (`"files_missing"`, `"files_changed"`, `"storage_full"`, `"storage_unavailable"`, `"no_peers"`,
//! contract section 18.2) are governance tags too, set by a torrent's own `health` field.

use serde::{Deserialize, Serialize};

pub const PAUSED_BY_USER: &str = "user";
pub const PAUSED_BY_SEED_LIMIT: &str = "seed_limit";

/// Rule tags a single torrent or download can be exempted from ("Resume anyway", contract section 25).
/// Safety and physical tags (storage, VPN, offline, unvalidated) are never in this list.
pub const EXEMPTABLE_TAGS: [&str; 5] = ["wifi_only", "battery", "charging_only", "schedule", "seed_metered"];

/// Pause tag for seeding on a metered link. It applies to finished torrents only.
pub const TAG_SEED_METERED: &str = "seed_metered";

/// Governance tag for the low-storage reserve (contract 0.19 play-and-storage section 2). Same string as
/// `HEALTH_STORAGE_FULL`, so a paused transfer shows the one "Storage full" state either way.
pub const TAG_STORAGE_FULL: &str = HEALTH_STORAGE_FULL;

pub fn is_exemptable(tag: &str) -> bool {
    EXEMPTABLE_TAGS.contains(&tag)
}

/// Does `tag` pause this torrent? An exempt torrent ignores the exemptable tags, and `seed_metered`
/// only touches finished torrents.
fn tag_blocks(tag: &str, f: &TorrentFacts) -> bool {
    if tag == TAG_SEED_METERED && !f.finished {
        return false;
    }
    // Seeding writes nothing, so the low-storage reserve never stops a finished torrent.
    if tag == TAG_STORAGE_FULL && f.finished {
        return false;
    }
    !(f.exempt && is_exemptable(tag))
}

pub fn is_governance_tag(tag: &str) -> bool {
    tag != PAUSED_BY_USER && tag != PAUSED_BY_SEED_LIMIT
}

/// Health tags (contract section 18.2 and 20).
pub const HEALTH_FILES_MISSING: &str = "files_missing";
pub const HEALTH_FILES_CHANGED: &str = "files_changed";
pub const HEALTH_STORAGE_FULL: &str = "storage_full";
pub const HEALTH_STORAGE_UNAVAILABLE: &str = "storage_unavailable";
pub const HEALTH_NO_PEERS: &str = "no_peers";
pub const HEALTH_TAGS: [&str; 5] = [
    HEALTH_FILES_MISSING,
    HEALTH_FILES_CHANGED,
    HEALTH_STORAGE_FULL,
    HEALTH_STORAGE_UNAVAILABLE,
    HEALTH_NO_PEERS,
];

pub fn is_health_tag(tag: &str) -> bool {
    HEALTH_TAGS.contains(&tag)
}

/// A magnet that is still looking for its metadata gives up and shows `no_peers` after this long (section 20).
pub const NO_PEERS_AFTER_MS: i64 = 10 * 60 * 1000;

/// True when a magnet has been resolving for `NO_PEERS_AFTER_MS` or more.
pub fn no_peers_due(resolving_since_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(resolving_since_ms) >= NO_PEERS_AFTER_MS
}

/// Whole seconds a magnet has been resolving, never negative.
pub fn resolving_secs(resolving_since_ms: i64, now_ms: i64) -> i64 {
    now_ms.saturating_sub(resolving_since_ms).max(0) / 1000
}

/// The clock a magnet resumes with after the engine starts again (section 20). A lookup still inside
/// its ten minute window keeps its start time, so restarts do not push `no_peers` back for ever. A
/// clock that is already older than the window belongs to a process that was not running, so the
/// lookup gets a fresh window.
pub fn carry_resolving_since(existing: Option<i64>, now_ms: i64) -> i64 {
    match existing {
        Some(since) if since <= now_ms && !no_peers_due(since, now_ms) => since,
        _ => now_ms,
    }
}

/// How a magnet without metadata shows up in a snapshot: `(state, paused_by, resolving_secs)`.
/// After it gave up (`no_peers`) it is PAUSED with `paused_by = no_peers`, which is what the card and
/// the detail screen read to show "No one is sharing this yet" and Keep trying. While it looks it is
/// INITIALIZING with the seconds so far.
pub fn pending_view(
    health: Option<&str>,
    paused_by: Option<&str>,
    has_error: bool,
    resolving_since_ms: Option<i64>,
    now_ms: i64,
) -> (TorrentState, Option<String>, Option<i64>) {
    if !has_error && health == Some(HEALTH_NO_PEERS) {
        return (TorrentState::Paused, Some(HEALTH_NO_PEERS.to_string()), None);
    }
    let state = if has_error {
        TorrentState::Error
    } else {
        TorrentState::Initializing
    };
    (
        state,
        paused_by.map(str::to_string),
        resolving_since_ms.map(|since| resolving_secs(since, now_ms)),
    )
}

/// librqbit reports `finished` for a live torrent whose chunk tracker it could not read (total 0, needs
/// nothing). That is not a finished download: a torrent with included bytes is finished only when its
/// selected total is known and non-zero.
pub fn finished_is_real(finished: bool, total_bytes: u64, included_bytes: u64) -> bool {
    finished && (total_bytes > 0 || included_bytes == 0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TorrentState {
    Initializing,
    Queued,
    Downloading,
    Seeding,
    Paused,
    Checking,
    Error,
    Completed,
    /// Files are being moved to another folder (contract section 11.3). Set by the engine, never derived
    /// from librqbit state. The planner never sees a moving torrent.
    Moving,
}

/// What librqbit says about a torrent, reduced to the cases we care about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RqState {
    /// Checking existing files. `paused` is true when it should stay paused after the check.
    Initializing { paused: bool },
    Live,
    Paused,
    Error,
}

#[derive(Debug, Clone, Copy)]
pub struct StateInputs<'a> {
    pub rq: RqState,
    pub finished: bool,
    pub paused_by: Option<&'a str>,
    pub queued: bool,
    pub has_error: bool,
    /// True while a magnet link is still looking for its metadata.
    pub resolving: bool,
}

pub fn derive_state(i: StateInputs<'_>) -> TorrentState {
    if i.has_error {
        return TorrentState::Error;
    }
    if i.resolving {
        return TorrentState::Initializing;
    }
    // QUEUED is reserved for unfinished torrents; a finished one without a seed slot is COMPLETED.
    if i.queued && !i.finished {
        return TorrentState::Queued;
    }
    if let Some(by) = i.paused_by {
        return if by == PAUSED_BY_SEED_LIMIT {
            TorrentState::Completed
        } else {
            TorrentState::Paused
        };
    }
    match i.rq {
        RqState::Error => TorrentState::Error,
        RqState::Initializing { paused: false } => TorrentState::Checking,
        RqState::Initializing { paused: true } | RqState::Paused => {
            if i.finished {
                TorrentState::Completed
            } else {
                TorrentState::Paused
            }
        }
        RqState::Live => {
            if i.finished {
                TorrentState::Seeding
            } else {
                TorrentState::Downloading
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SchedulerConfig {
    /// 0 = unlimited.
    pub max_active_downloads: u32,
    /// 0 = unlimited.
    pub max_active_seeds: u32,
    /// 0 = none.
    pub seed_ratio_limit: f64,
    /// 0 = none.
    pub seed_time_limit_mins: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TorrentFacts {
    pub id: String,
    pub added_at: i64,
    /// Every selected piece is verified.
    pub finished: bool,
    /// librqbit is actively running it (live, or checking and not paused).
    pub running: bool,
    pub paused_by: Option<String>,
    /// Paused by the queue, waiting for a free slot.
    pub queued: bool,
    /// In an error state. The planner leaves these alone until the user resumes or rechecks.
    pub errored: bool,
    pub ratio: f64,
    pub seeding_secs: i64,
    /// The user resumed this torrent after it hit a seed limit; do not pause it for limits again.
    pub limits_waived: bool,
    /// A health tag (section 18.2). While set the torrent is not a candidate and is kept paused with
    /// that tag, unless the user or a seed limit paused it first.
    pub health: Option<String>,
    /// "Resume anyway" (section 25): the exemptable rule tags do not pause this torrent.
    pub exempt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Tag with a reason and make sure it is not running.
    Pause { id: String, reason: String },
    /// Clear tags, mark as waiting for a slot and make sure it is not running.
    Queue { id: String },
    /// A finished torrent without a seed slot: clear tags, not running, shown as COMPLETED (never QUEUED).
    Park { id: String },
    /// Clear tags and make sure it is running.
    Resume { id: String },
}

fn seed_limit_hit(f: &TorrentFacts, cfg: &SchedulerConfig) -> bool {
    if !f.finished || f.limits_waived {
        return false;
    }
    let by_ratio = cfg.seed_ratio_limit > 0.0 && f.ratio >= cfg.seed_ratio_limit;
    let by_time = cfg.seed_time_limit_mins > 0
        && f.seeding_secs >= i64::from(cfg.seed_time_limit_mins) * 60;
    by_ratio || by_time
}

/// `blocked` lists the governance reasons currently blocking transfers, in a stable order.
pub fn plan(facts: &[TorrentFacts], cfg: &SchedulerConfig, blocked: &[String]) -> Vec<Action> {
    let mut actions = Vec::new();

    // Candidates are torrents the planner may start or stop: untagged ones, and ones tagged by
    // a governance reason that no longer blocks. User pauses and seed-limit pauses are never touched.
    let mut candidates: Vec<&TorrentFacts> = Vec::new();
    for f in facts.iter().filter(|f| !f.errored) {
        // Health first: a torrent with a health tag is never started, and is stopped with that tag
        // unless the user (or a seed limit) already paused it. The user's pause wins and is kept.
        if let Some(tag) = f.health.as_deref() {
            let user_or_limit = matches!(
                f.paused_by.as_deref(),
                Some(PAUSED_BY_USER) | Some(PAUSED_BY_SEED_LIMIT)
            );
            let already = f.paused_by.as_deref() == Some(tag) && !f.running;
            if !user_or_limit && !already {
                actions.push(Action::Pause {
                    id: f.id.clone(),
                    reason: tag.to_string(),
                });
            }
            continue;
        }
        match f.paused_by.as_deref() {
            None => candidates.push(f),
            Some(tag) if is_governance_tag(tag) && !blocked.iter().any(|b| b == tag && tag_blocks(b, f)) => {
                candidates.push(f)
            }
            Some(_) => {}
        }
    }

    // Governance gate: a candidate that a blocking tag still applies to is paused with the first such tag.
    // The rest go on to seed limits and the queue.
    let mut free: Vec<&TorrentFacts> = Vec::new();
    for f in candidates {
        match blocked.iter().find(|b| tag_blocks(b, f)) {
            Some(reason) => actions.push(Action::Pause {
                id: f.id.clone(),
                reason: reason.clone(),
            }),
            None => free.push(f),
        }
    }
    let candidates = free;

    // Seed limits.
    let mut remaining: Vec<&TorrentFacts> = Vec::new();
    for f in candidates {
        if seed_limit_hit(f, cfg) {
            actions.push(Action::Pause {
                id: f.id.clone(),
                reason: PAUSED_BY_SEED_LIMIT.to_string(),
            });
        } else {
            remaining.push(f);
        }
    }

    // Queue: downloads and seeds each get their own number of slots, filled in added_at order.
    for (want_finished, max) in [
        (false, cfg.max_active_downloads),
        (true, cfg.max_active_seeds),
    ] {
        let mut group: Vec<&TorrentFacts> = remaining
            .iter()
            .copied()
            .filter(|f| f.finished == want_finished)
            .collect();
        group.sort_by(|a, b| a.added_at.cmp(&b.added_at).then_with(|| a.id.cmp(&b.id)));
        for (idx, f) in group.into_iter().enumerate() {
            let has_slot = max == 0 || idx < max as usize;
            if has_slot {
                if !f.running || f.queued || f.paused_by.is_some() {
                    actions.push(Action::Resume { id: f.id.clone() });
                }
            } else if want_finished {
                if f.running || f.queued || f.paused_by.is_some() {
                    actions.push(Action::Park { id: f.id.clone() });
                }
            } else if f.running || !f.queued || f.paused_by.is_some() {
                actions.push(Action::Queue { id: f.id.clone() });
            }
        }
    }
    actions
}

/// Wall-clock seeding time. `delta` is capped so a suspended process does not count the gap as seeding.
pub fn accumulate_seed_ms(prev_ms: u64, delta: std::time::Duration, seeding: bool) -> u64 {
    if !seeding {
        return prev_ms;
    }
    let capped = delta.min(std::time::Duration::from_secs(5));
    prev_ms.saturating_add(capped.as_millis() as u64)
}

/// Uploaded bytes accumulate across restarts and pauses, because librqbit's counter restarts
/// from zero whenever the torrent goes live again.
///
/// Returns `(total, new_base, new_last_seen)`.
pub fn uploaded_total(base: u64, last_seen: u64, current: u64) -> (u64, u64, u64) {
    let base = if current < last_seen {
        base.saturating_add(last_seen)
    } else {
        base
    };
    (base.saturating_add(current), base, current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> SchedulerConfig {
        SchedulerConfig {
            max_active_downloads: 2,
            max_active_seeds: 1,
            seed_ratio_limit: 0.0,
            seed_time_limit_mins: 0,
        }
    }

    fn f(id: &str, added_at: i64) -> TorrentFacts {
        TorrentFacts {
            id: id.into(),
            added_at,
            finished: false,
            running: true,
            paused_by: None,
            queued: false,
            errored: false,
            ratio: 0.0,
            seeding_secs: 0,
            limits_waived: false,
            health: None,
            exempt: false,
        }
    }

    fn queued(mut t: TorrentFacts) -> TorrentFacts {
        t.running = false;
        t.queued = true;
        t
    }

    fn seed(mut t: TorrentFacts) -> TorrentFacts {
        t.finished = true;
        t
    }

    fn pause(id: &str, reason: &str) -> Action {
        Action::Pause {
            id: id.into(),
            reason: reason.into(),
        }
    }

    #[test]
    fn moving_state_serialises_as_screaming_snake_case() {
        assert_eq!(serde_json::to_string(&TorrentState::Moving).unwrap(), "\"MOVING\"");
    }

    #[test]
    fn extra_downloads_are_queued_newest_first_out() {
        let facts = vec![f("a", 1), f("b", 2), f("c", 3), f("d", 4)];
        let actions = plan(&facts, &cfg(), &[]);
        assert_eq!(
            actions,
            vec![
                Action::Queue { id: "c".into() },
                Action::Queue { id: "d".into() }
            ]
        );
    }

    #[test]
    fn queue_promotion_follows_added_at_order() {
        // a finished and is now a seed, freeing a download slot; c is older than d.
        let facts = vec![
            seed(f("a", 1)),
            f("b", 2),
            queued(f("d", 4)),
            queued(f("c", 3)),
            queued(f("e", 5)),
        ];
        let actions = plan(&facts, &cfg(), &[]);
        assert_eq!(actions, vec![Action::Resume { id: "c".into() }]);

        // b is removed as well: both c and d start, e keeps waiting.
        let facts = vec![queued(f("d", 4)), queued(f("c", 3)), queued(f("e", 5))];
        let actions = plan(&facts, &cfg(), &[]);
        assert_eq!(
            actions,
            vec![
                Action::Resume { id: "c".into() },
                Action::Resume { id: "d".into() }
            ]
        );
    }

    #[test]
    fn already_queued_torrents_produce_no_repeat_actions() {
        let facts = vec![f("a", 1), f("b", 2), queued(f("c", 3))];
        assert!(plan(&facts, &cfg(), &[]).is_empty());
    }

    #[test]
    fn seeds_have_their_own_slots() {
        let facts = vec![seed(f("s1", 1)), seed(f("s2", 2)), f("d1", 3)];
        let actions = plan(&facts, &cfg(), &[]);
        assert_eq!(actions, vec![Action::Park { id: "s2".into() }]);
    }

    #[test]
    fn finished_torrents_beyond_seed_slots_are_parked_never_queued() {
        let mut parked = seed(f("s2", 2));
        parked.running = false;
        let facts = vec![seed(f("s1", 1)), parked.clone(), seed(f("s3", 3))];
        // s3 is still running without a slot; s2 is already parked and needs no action.
        assert_eq!(plan(&facts, &cfg(), &[]), vec![Action::Park { id: "s3".into() }]);
        // A finished torrent carrying a stale queued flag is cleaned up.
        parked.queued = true;
        assert_eq!(
            plan(&[seed(f("s1", 1)), parked], &cfg(), &[]),
            vec![Action::Park { id: "s2".into() }]
        );
        // No Queue action is ever produced for finished torrents.
        let many: Vec<_> = (0..6).map(|i| seed(f(&format!("s{i}"), i))).collect();
        assert!(plan(&many, &cfg(), &[])
            .iter()
            .all(|a| !matches!(a, Action::Queue { .. })));
    }

    #[test]
    fn parked_seed_is_promoted_when_a_slot_frees() {
        let mut parked = seed(f("s2", 2));
        parked.running = false;
        assert_eq!(plan(&[parked], &cfg(), &[]), vec![Action::Resume { id: "s2".into() }]);
    }

    #[test]
    fn zero_means_unlimited() {
        let mut c = cfg();
        c.max_active_downloads = 0;
        c.max_active_seeds = 0;
        let facts = vec![f("a", 1), f("b", 2), f("c", 3), queued(f("d", 4)), seed(f("s", 5))];
        assert_eq!(plan(&facts, &c, &[]), vec![Action::Resume { id: "d".into() }]);
    }

    #[test]
    fn ratio_limit_pauses_with_seed_limit_tag() {
        let mut c = cfg();
        c.max_active_seeds = 0;
        c.seed_ratio_limit = 1.5;
        let mut a = seed(f("a", 1));
        a.ratio = 1.5;
        let mut b = seed(f("b", 2));
        b.ratio = 1.49;
        let actions = plan(&[a, b], &c, &[]);
        assert_eq!(actions, vec![pause("a", "seed_limit")]);
    }

    #[test]
    fn time_limit_pauses_and_zero_disables() {
        let mut c = cfg();
        c.max_active_seeds = 0;
        c.seed_time_limit_mins = 10;
        let mut a = seed(f("a", 1));
        a.seeding_secs = 600;
        let mut b = seed(f("b", 2));
        b.seeding_secs = 599;
        assert_eq!(plan(&[a.clone(), b.clone()], &c, &[]), vec![pause("a", "seed_limit")]);
        c.seed_time_limit_mins = 0;
        a.seeding_secs = 10_000_000;
        assert!(plan(&[a, b], &c, &[]).is_empty());
    }

    #[test]
    fn limits_never_apply_to_unfinished_or_waived_torrents() {
        let mut c = cfg();
        c.seed_ratio_limit = 0.1;
        let mut downloading = f("d", 1);
        downloading.ratio = 5.0;
        let mut waived = seed(f("w", 2));
        waived.ratio = 5.0;
        waived.limits_waived = true;
        assert!(plan(&[downloading, waived], &c, &[]).is_empty());
    }

    #[test]
    fn seed_limit_pause_is_not_resumed_by_the_queue() {
        let mut c = cfg();
        c.seed_ratio_limit = 1.0;
        let mut a = seed(f("a", 1));
        a.running = false;
        a.paused_by = Some("seed_limit".into());
        a.ratio = 2.0;
        assert!(plan(&[a], &c, &[]).is_empty());
    }

    #[test]
    fn governance_pauses_running_and_queued_but_never_user_paused() {
        let mut user = f("u", 1);
        user.running = false;
        user.paused_by = Some("user".into());
        let facts = vec![user, f("r", 2), queued(f("q", 3)), seed(f("s", 4))];
        let blocked = vec!["wifi_only".to_string()];
        let actions = plan(&facts, &cfg(), &blocked);
        assert_eq!(
            actions,
            vec![
                pause("r", "wifi_only"),
                pause("q", "wifi_only"),
                pause("s", "wifi_only")
            ]
        );
    }

    #[test]
    fn governance_does_not_repause_already_tagged_torrents() {
        let mut t = f("a", 1);
        t.running = false;
        t.paused_by = Some("wifi_only".into());
        assert!(plan(&[t], &cfg(), &["wifi_only".to_string()]).is_empty());
    }

    #[test]
    fn resume_touches_only_torrents_with_the_same_reason() {
        let mut wifi = f("w", 1);
        wifi.running = false;
        wifi.paused_by = Some("wifi_only".into());
        let mut battery = f("b", 2);
        battery.running = false;
        battery.paused_by = Some("battery".into());
        let mut user = f("u", 3);
        user.running = false;
        user.paused_by = Some("user".into());
        let facts = vec![wifi, battery, user];

        // Wi-Fi comes back but battery still blocks: the battery-tagged torrent is untouched and
        // the Wi-Fi one is re-tagged instead of starting.
        let actions = plan(&facts, &cfg(), &["battery".to_string()]);
        assert_eq!(actions, vec![pause("w", "battery")]);

        // Everything clear: the governance-tagged torrents resume, the user pause stays.
        let actions = plan(&facts, &cfg(), &[]);
        assert_eq!(
            actions,
            vec![
                Action::Resume { id: "w".into() },
                Action::Resume { id: "b".into() }
            ]
        );
    }

    #[test]
    fn released_torrents_still_respect_the_queue() {
        let mut tagged: Vec<TorrentFacts> = (1..=3)
            .map(|i| {
                let mut t = f(&format!("t{i}"), i);
                t.running = false;
                t.paused_by = Some("charging_only".into());
                t
            })
            .collect();
        tagged[0].added_at = 9;
        let actions = plan(&tagged, &cfg(), &[]);
        // Slots go to t2 and t3 (older), the torrent added last waits.
        assert!(actions.contains(&Action::Resume { id: "t2".into() }));
        assert!(actions.contains(&Action::Resume { id: "t3".into() }));
        assert!(actions.contains(&Action::Queue { id: "t1".into() }));
    }

    #[test]
    fn blocked_gate_retags_a_torrent_whose_own_reason_cleared() {
        let mut t = f("a", 1);
        t.running = false;
        t.paused_by = Some("wifi_only".into());
        let actions = plan(&[t], &cfg(), &["battery".to_string()]);
        assert_eq!(actions, vec![pause("a", "battery")]);
    }

    #[test]
    fn errored_torrents_are_ignored_and_do_not_take_slots() {
        let mut bad = f("bad", 1);
        bad.errored = true;
        let facts = vec![bad, f("b", 2), f("c", 3)];
        assert!(plan(&facts, &cfg(), &[]).is_empty());
        assert!(plan(&facts, &cfg(), &["battery".to_string()])
            .iter()
            .all(|a| !matches!(a, Action::Pause { id, .. } if id == "bad")));
    }

    #[test]
    fn user_resume_of_an_untagged_paused_torrent_gets_a_slot() {
        let mut t = f("a", 1);
        t.running = false;
        t.queued = true; // resume() releases it into the queue
        assert_eq!(plan(&[t], &cfg(), &[]), vec![Action::Resume { id: "a".into() }]);
    }

    fn with_health(mut t: TorrentFacts, tag: &str) -> TorrentFacts {
        t.health = Some(tag.into());
        t
    }

    #[test]
    fn health_tag_pauses_a_running_torrent_with_that_tag() {
        for tag in HEALTH_TAGS {
            let facts = vec![with_health(f("a", 1), tag)];
            assert_eq!(plan(&facts, &cfg(), &[]), vec![pause("a", tag)]);
        }
        // A queued or untagged-but-parked torrent gets the tag too.
        let mut parked = with_health(f("p", 1), "storage_full");
        parked.running = false;
        parked.queued = true;
        assert_eq!(plan(&[parked], &cfg(), &[]), vec![pause("p", "storage_full")]);
    }

    #[test]
    fn storage_reserve_tag_pauses_unfinished_and_spares_seeders() {
        let blocked = vec![TAG_STORAGE_FULL.to_string()];
        let mut seeding = f("s", 1);
        seeding.finished = true;
        let facts = vec![f("d", 2), seeding];
        let actions = plan(&facts, &cfg(), &blocked);
        assert!(actions.contains(&pause("d", "storage_full")));
        assert!(!actions.iter().any(|a| matches!(a, Action::Pause { id, .. } if id == "s")));
    }

    #[test]
    fn storage_reserve_tag_clearing_resumes_what_it_paused() {
        let mut t = f("d", 1);
        t.running = false;
        t.paused_by = Some("storage_full".into());
        // Still blocked: stays paused. Cleared: it runs again.
        assert!(plan(&[t.clone()], &cfg(), &[TAG_STORAGE_FULL.to_string()]).is_empty());
        assert_eq!(plan(&[t], &cfg(), &[]), vec![Action::Resume { id: "d".into() }]);
    }

    #[test]
    fn storage_reserve_never_overrides_a_user_pause() {
        let mut t = f("u", 1);
        t.running = false;
        t.paused_by = Some("user".into());
        assert!(plan(&[t], &cfg(), &[TAG_STORAGE_FULL.to_string()]).is_empty());
    }

    #[test]
    fn health_pause_is_not_repeated_once_applied() {
        let mut t = with_health(f("a", 1), "files_missing");
        t.running = false;
        t.paused_by = Some("files_missing".into());
        assert!(plan(&[t], &cfg(), &[]).is_empty());
    }

    #[test]
    fn health_torrent_takes_no_queue_slot() {
        // Two download slots: the health torrent does not use one, so b and c both run.
        let facts = vec![with_health(f("a", 1), "storage_full"), f("b", 2), f("c", 3)];
        assert_eq!(plan(&facts, &cfg(), &[]), vec![pause("a", "storage_full")]);
    }

    #[test]
    fn user_pause_wins_over_health() {
        for tag in HEALTH_TAGS {
            let mut t = with_health(f("u", 1), tag);
            t.running = false;
            t.paused_by = Some("user".into());
            // Never re-tagged and never resumed, while the health is set.
            assert!(plan(&[t.clone()], &cfg(), &[]).is_empty());
            // And after the health clears it is still a user pause: not a candidate.
            t.health = None;
            assert!(plan(&[t], &cfg(), &[]).is_empty());
        }
        // Even while a running user-paused torrent is being stopped, the tag stays "user".
        let mut running = with_health(f("r", 1), "files_missing");
        running.paused_by = Some("user".into());
        assert!(plan(&[running], &cfg(), &[]).is_empty());
    }

    #[test]
    fn seed_limit_pause_wins_over_health() {
        let mut t = with_health(seed(f("s", 1)), "files_changed");
        t.running = false;
        t.paused_by = Some("seed_limit".into());
        assert!(plan(&[t], &cfg(), &[]).is_empty());
    }

    #[test]
    fn clearing_health_resumes_a_torrent_paused_by_it() {
        for tag in HEALTH_TAGS {
            let mut t = f("a", 1);
            t.running = false;
            t.paused_by = Some(tag.into());
            // Health cleared (health: None), the tag on paused_by is a governance tag that no longer blocks.
            assert_eq!(plan(&[t], &cfg(), &[]), vec![Action::Resume { id: "a".into() }]);
        }
    }

    #[test]
    fn cleared_health_torrent_still_respects_the_queue() {
        let mut a = f("a", 5);
        a.running = false;
        a.paused_by = Some("storage_full".into());
        let facts = vec![a, f("b", 2), f("c", 3)];
        // b and c fill the two slots; a waits in the queue.
        assert_eq!(plan(&facts, &cfg(), &[]), vec![Action::Queue { id: "a".into() }]);
    }

    #[test]
    fn health_overrides_a_governance_pause_tag() {
        let mut t = with_health(f("a", 1), "files_missing");
        t.running = false;
        t.paused_by = Some("wifi_only".into());
        assert_eq!(plan(&[t], &cfg(), &["wifi_only".to_string()]), vec![pause("a", "files_missing")]);
    }

    #[test]
    fn health_vocabulary() {
        assert!(is_health_tag("no_peers") && is_health_tag("storage_unavailable"));
        assert!(!is_health_tag("user") && !is_health_tag("") && !is_health_tag("wifi_only"));
    }

    #[test]
    fn no_peers_after_ten_minutes() {
        let t0 = 1_000_000;
        assert!(!no_peers_due(t0, t0));
        assert!(!no_peers_due(t0, t0 + NO_PEERS_AFTER_MS - 1));
        assert!(no_peers_due(t0, t0 + NO_PEERS_AFTER_MS));
        assert_eq!(resolving_secs(t0, t0 + 61_500), 61);
        assert_eq!(resolving_secs(t0, t0 - 5), 0);
    }

    #[test]
    fn resolving_clock_survives_a_quick_restart_but_not_a_long_gap() {
        let t0 = 5_000_000;
        assert_eq!(carry_resolving_since(Some(t0), t0 + 60_000), t0);
        assert_eq!(
            carry_resolving_since(Some(t0), t0 + NO_PEERS_AFTER_MS),
            t0 + NO_PEERS_AFTER_MS
        );
        assert_eq!(carry_resolving_since(None, t0), t0);
        assert_eq!(carry_resolving_since(Some(t0 + 10), t0), t0);
    }

    #[test]
    fn a_magnet_that_gave_up_is_paused_with_no_peers() {
        use TorrentState as S;
        let (s, by, secs) = pending_view(Some("no_peers"), None, false, Some(1_000), 900_000);
        assert_eq!((s, by.as_deref(), secs), (S::Paused, Some("no_peers"), None));
        let (s, by, secs) = pending_view(None, None, false, Some(1_000), 61_000);
        assert_eq!((s, by, secs), (S::Initializing, None, Some(60)));
        let (s, _, _) = pending_view(None, None, true, Some(1_000), 61_000);
        assert_eq!(s, S::Error);
        let (s, by, _) = pending_view(None, Some("user"), false, None, 0);
        assert_eq!((s, by.as_deref()), (S::Initializing, Some("user")));
    }

    #[test]
    fn finished_with_nothing_selected_is_not_finished() {
        assert!(finished_is_real(true, 100, 100));
        assert!(!finished_is_real(true, 0, 100));
        assert!(finished_is_real(true, 0, 0));
        assert!(!finished_is_real(false, 100, 100));
    }

    fn inputs(rq: RqState) -> StateInputs<'static> {
        StateInputs {
            rq,
            finished: false,
            paused_by: None,
            queued: false,
            has_error: false,
            resolving: false,
        }
    }

    #[test]
    fn state_table() {
        use TorrentState as S;
        assert_eq!(derive_state(inputs(RqState::Live)), S::Downloading);
        let mut i = inputs(RqState::Live);
        i.finished = true;
        assert_eq!(derive_state(i), S::Seeding);
        assert_eq!(derive_state(inputs(RqState::Initializing { paused: false })), S::Checking);
        assert_eq!(derive_state(inputs(RqState::Paused)), S::Paused);
        let mut i = inputs(RqState::Paused);
        i.finished = true;
        assert_eq!(derive_state(i), S::Completed);
        let mut i = inputs(RqState::Paused);
        i.queued = true;
        assert_eq!(derive_state(i), S::Queued);
        // Finished + parked/queued flag: COMPLETED, never QUEUED.
        i.finished = true;
        assert_eq!(derive_state(i), S::Completed);
        let mut i = inputs(RqState::Paused);
        i.paused_by = Some("wifi_only");
        assert_eq!(derive_state(i), S::Paused);
        let mut i = inputs(RqState::Paused);
        i.paused_by = Some("seed_limit");
        i.finished = true;
        assert_eq!(derive_state(i), S::Completed);
        let mut i = inputs(RqState::Live);
        i.has_error = true;
        assert_eq!(derive_state(i), S::Error);
        let mut i = inputs(RqState::Paused);
        i.resolving = true;
        assert_eq!(derive_state(i), S::Initializing);
        assert_eq!(derive_state(inputs(RqState::Error)), S::Error);
    }

    #[test]
    fn seed_time_is_wall_clock_not_tick_count() {
        use std::time::Duration as D;
        // Many on-demand ticks a few ms apart add only the elapsed time.
        let mut ms = 0;
        for _ in 0..100 {
            ms = accumulate_seed_ms(ms, D::from_millis(5), true);
        }
        assert_eq!(ms, 500);
        assert_eq!(accumulate_seed_ms(ms, D::from_secs(1), false), 500);
        assert_eq!(accumulate_seed_ms(0, D::from_secs(3600), true), 5000);
    }

    #[test]
    fn uploaded_total_survives_counter_resets() {
        assert_eq!(uploaded_total(0, 0, 500), (500, 0, 500));
        assert_eq!(uploaded_total(0, 500, 800), (800, 0, 800));
        // Counter restarted after a pause or an app restart.
        assert_eq!(uploaded_total(0, 800, 100), (900, 800, 100));
        assert_eq!(uploaded_total(800, 100, 150), (950, 800, 150));
    }

    #[test]
    fn exempt_torrent_ignores_rule_tags_but_not_safety_tags() {
        let mut t = f("a", 1);
        t.exempt = true;
        let wifi = vec!["wifi_only".to_string()];
        assert!(plan(&[t.clone()], &cfg(), &wifi).is_empty());
        let mut paused = t.clone();
        paused.running = false;
        paused.paused_by = Some("wifi_only".into());
        assert_eq!(plan(&[paused], &cfg(), &wifi), vec![Action::Resume { id: "a".into() }]);
        let vpn = vec!["vpn_required".to_string()];
        assert_eq!(plan(&[t], &cfg(), &vpn), vec![pause("a", "vpn_required")]);
    }

    #[test]
    fn seed_metered_pauses_seeds_only() {
        let blocked = vec!["seed_metered".to_string()];
        let facts = vec![f("dl", 1), seed(f("s", 2))];
        assert_eq!(plan(&facts, &cfg(), &blocked), vec![pause("s", "seed_metered")]);
        let mut exempt_seed = seed(f("s", 2));
        exempt_seed.exempt = true;
        assert!(plan(&[exempt_seed], &cfg(), &blocked).is_empty());
    }

    #[test]
    fn exemptable_set_has_no_safety_tags() {
        assert!(is_exemptable("schedule") && is_exemptable("seed_metered"));
        assert!(!is_exemptable("storage_full") && !is_exemptable("vpn_required") && !is_exemptable("offline"));
    }
}
