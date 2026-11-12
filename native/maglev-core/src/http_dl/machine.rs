//! SM-30 URL download state machine (`docs/STATE_MACHINES_AND_SCREENS.md` section 4, `NATIVE_CONTRACT.md` section 17).
//!
//! Pure: `step(state, event)` returns the next state and the effects the driver must run. No IO, no clock.
//! Every row of the transition table has a unit test at the bottom of this file.
//!
//! Additions to the table, each one marked "extra" below: `Queued` + `UserPause`, `Downloading` + `HttpFatal`,
//! and `Resolving` + `ProbeHtml` when the URL does not look like a file (the driver then treats the page as a
//! normal response and never sends this event).

use serde::{Deserialize, Serialize};

/// Max retries of one transfer before it gives up (contract section 17, retry policy).
pub const MAX_ATTEMPTS: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PauseReason {
    User,
    Schedule,
    Network,
    Battery,
    Storage,
}

impl PauseReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            PauseReason::User => "user",
            PauseReason::Schedule => "schedule",
            PauseReason::Network => "network",
            PauseReason::Battery => "battery",
            PauseReason::Storage => "storage_full",
        }
    }
}

/// The error states of SM-30 (`Error(code)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DlError {
    HttpStatus,
    Network,
    FileChanged,
    NotAFile,
    ChecksumMismatch,
    Permission,
}

impl DlError {
    pub fn as_str(&self) -> &'static str {
        match self {
            DlError::HttpStatus => "HTTP_STATUS",
            DlError::Network => "NETWORK",
            DlError::FileChanged => "FILE_CHANGED",
            DlError::NotAFile => "NOT_A_FILE",
            DlError::ChecksumMismatch => "CHECKSUM_MISMATCH",
            DlError::Permission => "PERMISSION",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum State {
    /// Before `Add`. The machine's start.
    None,
    Resolving,
    Queued,
    Downloading,
    Paused(PauseReason),
    Verifying,
    Finished,
    NeedsLink,
    Error(DlError),
    /// After `Remove`.
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// `url_ok` is true for an http or https URL.
    Add { url_ok: bool },
    ProbeOk { slot_free: bool, gov_allows: bool, space_ok: bool },
    /// 401 or 403 on the probe.
    ProbeAuth,
    /// 404, 410 or any other failing status on the probe.
    ProbeStatus,
    /// The probe answered with a web page.
    ProbeHtml { url_looks_like_file: bool },
    NetErr,
    SlotFree { gov_allows: bool },
    UserPause,
    GovBlock(PauseReason),
    GovClear(PauseReason),
    UserResume,
    /// A retryable failure. `attempts` is the number of retries already made.
    Transient { attempts: u32 },
    Got200OnResume,
    ValidatorChanged,
    Got416 { held_equals_total: bool },
    /// 401/403 three times, or 410, while downloading.
    Auth,
    Enospc,
    Eacces,
    AllBytes,
    HashOk,
    HashBad,
    NewLink { matches: bool },
    UserRetry,
    Remove { delete_files: bool },
    /// Process start.
    Restore,
    /// Extra: 400, 404 or another status that must never be retried, while downloading.
    HttpFatal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    DiskFull,
    /// "Server sent the whole file again; starting over."
    ServerSentWholeFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    Persist,
    Probe,
    CreatePart,
    StartSegments,
    Notice(Notice),
    CancelTasks,
    FlushSidecar,
    Backoff,
    RetrySegment,
    KeepPart,
    TruncatePart,
    RestartFromZero,
    RenamePart,
    MediaScan,
    NotifyFinished,
    KeepFile,
    RebindUrl,
    DeletePartIf(bool),
    /// `Add` with another scheme: the call returns `INVALID_SOURCE`.
    RejectInvalidSource,
}

/// One transition. Events that have no row for the current state leave it unchanged with no effects.
pub fn step(state: State, event: Event) -> (State, Vec<Effect>) {
    use Event as E;
    use State as S;

    // `Remove` applies to every state.
    if let E::Remove { delete_files } = event {
        return (S::Gone, vec![Effect::CancelTasks, Effect::DeletePartIf(delete_files)]);
    }
    // `Restore`: a download that was working when the process died goes back in the queue.
    if event == E::Restore {
        return match state {
            S::Downloading | S::Resolving => (S::Queued, vec![]),
            other => (other, vec![]),
        };
    }

    match (state, event) {
        (S::None, E::Add { url_ok: true }) => (S::Resolving, vec![Effect::Persist, Effect::Probe]),
        (S::None, E::Add { url_ok: false }) => (S::None, vec![Effect::RejectInvalidSource]),

        (S::Resolving, E::ProbeOk { slot_free, gov_allows, space_ok }) => {
            if !space_ok {
                (S::Paused(PauseReason::Storage), vec![Effect::Notice(Notice::DiskFull)])
            } else if slot_free && gov_allows {
                (S::Downloading, vec![Effect::CreatePart, Effect::StartSegments])
            } else {
                (S::Queued, vec![])
            }
        }
        (S::Resolving, E::ProbeAuth) => (S::NeedsLink, vec![]),
        (S::Resolving, E::ProbeStatus) => (S::Error(DlError::HttpStatus), vec![]),
        (S::Resolving, E::ProbeHtml { url_looks_like_file: true }) => {
            (S::Error(DlError::NotAFile), vec![])
        }
        (S::Resolving, E::NetErr) => (S::Error(DlError::Network), vec![]),

        (S::Queued, E::SlotFree { gov_allows: true }) => (S::Downloading, vec![Effect::StartSegments]),
        // Extra: a queued download can be paused by the user.
        (S::Queued, E::UserPause) => (S::Paused(PauseReason::User), vec![]),

        (S::Downloading, E::UserPause) => {
            (S::Paused(PauseReason::User), vec![Effect::CancelTasks, Effect::FlushSidecar])
        }
        (S::Downloading, E::GovBlock(r)) => {
            (S::Paused(r), vec![Effect::CancelTasks, Effect::FlushSidecar])
        }

        // The user's pause wins over every governance clear.
        (S::Paused(PauseReason::User), E::GovClear(_)) => (S::Paused(PauseReason::User), vec![]),
        (S::Paused(r), E::GovClear(r2)) if r == r2 => (S::Queued, vec![]),
        (S::Paused(_), E::UserResume) => (S::Queued, vec![]),

        (S::Downloading, E::Transient { attempts }) => {
            if attempts < MAX_ATTEMPTS {
                (S::Downloading, vec![Effect::Backoff, Effect::RetrySegment])
            } else {
                (S::Error(DlError::Network), vec![Effect::KeepPart])
            }
        }
        (S::Downloading, E::Got200OnResume) => (
            S::Downloading,
            vec![
                Effect::TruncatePart,
                Effect::RestartFromZero,
                Effect::Notice(Notice::ServerSentWholeFile),
            ],
        ),
        (S::Downloading, E::ValidatorChanged) => (S::Error(DlError::FileChanged), vec![Effect::KeepPart]),
        (S::Downloading, E::Got416 { held_equals_total: true }) => (S::Verifying, vec![]),
        (S::Downloading, E::Got416 { held_equals_total: false }) => {
            (S::Error(DlError::FileChanged), vec![Effect::KeepPart])
        }
        (S::Downloading, E::Auth) => (S::NeedsLink, vec![Effect::KeepPart]),
        (S::Downloading, E::Enospc) => (S::Paused(PauseReason::Storage), vec![Effect::FlushSidecar]),
        (S::Downloading, E::Eacces) => (S::Error(DlError::Permission), vec![]),
        (S::Downloading, E::AllBytes) => (S::Verifying, vec![]),
        // Extra.
        (S::Downloading, E::HttpFatal) => (S::Error(DlError::HttpStatus), vec![Effect::KeepPart]),

        (S::Verifying, E::HashOk) => (
            S::Finished,
            vec![Effect::RenamePart, Effect::MediaScan, Effect::NotifyFinished],
        ),
        (S::Verifying, E::HashBad) => (S::Error(DlError::ChecksumMismatch), vec![Effect::KeepFile]),

        (S::NeedsLink, E::NewLink { matches: true }) => (S::Queued, vec![Effect::RebindUrl]),
        (S::NeedsLink, E::NewLink { matches: false }) => (S::Error(DlError::FileChanged), vec![]),

        (S::Error(_), E::UserRetry) => (S::Resolving, vec![Effect::Probe]),

        (s, _) => (s, vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Effect as F;
    use Event as E;
    use State as S;

    fn ok(slot_free: bool, gov_allows: bool, space_ok: bool) -> Event {
        E::ProbeOk { slot_free, gov_allows, space_ok }
    }

    // ---- one test per table row ----

    #[test]
    fn add_with_http_url_resolves() {
        assert_eq!(step(S::None, E::Add { url_ok: true }), (S::Resolving, vec![F::Persist, F::Probe]));
    }

    #[test]
    fn add_with_other_scheme_is_rejected() {
        assert_eq!(
            step(S::None, E::Add { url_ok: false }),
            (S::None, vec![F::RejectInvalidSource])
        );
    }

    #[test]
    fn probe_ok_with_slot_governance_and_space_starts() {
        assert_eq!(
            step(S::Resolving, ok(true, true, true)),
            (S::Downloading, vec![F::CreatePart, F::StartSegments])
        );
    }

    #[test]
    fn probe_ok_with_no_slot_queues() {
        assert_eq!(step(S::Resolving, ok(false, true, true)), (S::Queued, vec![]));
    }

    #[test]
    fn probe_ok_with_governance_blocking_queues() {
        assert_eq!(step(S::Resolving, ok(true, false, true)), (S::Queued, vec![]));
    }

    #[test]
    fn probe_ok_with_low_space_pauses_for_storage() {
        assert_eq!(
            step(S::Resolving, ok(true, true, false)),
            (S::Paused(PauseReason::Storage), vec![F::Notice(Notice::DiskFull)])
        );
    }

    #[test]
    fn probe_auth_needs_a_link() {
        assert_eq!(step(S::Resolving, E::ProbeAuth), (S::NeedsLink, vec![]));
    }

    #[test]
    fn probe_status_is_http_status_error() {
        assert_eq!(step(S::Resolving, E::ProbeStatus), (S::Error(DlError::HttpStatus), vec![]));
    }

    #[test]
    fn probe_html_for_a_file_url_is_not_a_file() {
        assert_eq!(
            step(S::Resolving, E::ProbeHtml { url_looks_like_file: true }),
            (S::Error(DlError::NotAFile), vec![])
        );
    }

    #[test]
    fn probe_html_for_a_page_url_changes_nothing() {
        assert_eq!(
            step(S::Resolving, E::ProbeHtml { url_looks_like_file: false }),
            (S::Resolving, vec![])
        );
    }

    #[test]
    fn probe_network_error_is_network() {
        assert_eq!(step(S::Resolving, E::NetErr), (S::Error(DlError::Network), vec![]));
    }

    #[test]
    fn queued_slot_free_with_governance_starts() {
        assert_eq!(
            step(S::Queued, E::SlotFree { gov_allows: true }),
            (S::Downloading, vec![F::StartSegments])
        );
    }

    #[test]
    fn queued_slot_free_with_governance_blocking_waits() {
        assert_eq!(step(S::Queued, E::SlotFree { gov_allows: false }), (S::Queued, vec![]));
    }

    #[test]
    fn queued_user_pause_pauses() {
        assert_eq!(step(S::Queued, E::UserPause), (S::Paused(PauseReason::User), vec![]));
    }

    #[test]
    fn downloading_user_pause_pauses() {
        assert_eq!(
            step(S::Downloading, E::UserPause),
            (S::Paused(PauseReason::User), vec![F::CancelTasks, F::FlushSidecar])
        );
    }

    #[test]
    fn downloading_gov_block_pauses_with_the_reason() {
        assert_eq!(
            step(S::Downloading, E::GovBlock(PauseReason::Network)),
            (S::Paused(PauseReason::Network), vec![F::CancelTasks, F::FlushSidecar])
        );
    }

    #[test]
    fn user_pause_wins_over_gov_clear() {
        assert_eq!(
            step(S::Paused(PauseReason::User), E::GovClear(PauseReason::Network)),
            (S::Paused(PauseReason::User), vec![])
        );
        assert_eq!(
            step(S::Paused(PauseReason::User), E::GovClear(PauseReason::User)),
            (S::Paused(PauseReason::User), vec![])
        );
    }

    #[test]
    fn gov_clear_of_the_same_reason_queues() {
        assert_eq!(
            step(S::Paused(PauseReason::Battery), E::GovClear(PauseReason::Battery)),
            (S::Queued, vec![])
        );
    }

    #[test]
    fn gov_clear_of_another_reason_changes_nothing() {
        assert_eq!(
            step(S::Paused(PauseReason::Battery), E::GovClear(PauseReason::Network)),
            (S::Paused(PauseReason::Battery), vec![])
        );
    }

    #[test]
    fn user_resume_queues_from_any_pause() {
        for r in [
            PauseReason::User,
            PauseReason::Schedule,
            PauseReason::Network,
            PauseReason::Battery,
            PauseReason::Storage,
        ] {
            assert_eq!(step(S::Paused(r), E::UserResume), (S::Queued, vec![]));
        }
    }

    #[test]
    fn transient_below_the_cap_backs_off_and_retries() {
        assert_eq!(
            step(S::Downloading, E::Transient { attempts: 9 }),
            (S::Downloading, vec![F::Backoff, F::RetrySegment])
        );
    }

    #[test]
    fn transient_at_the_cap_is_a_network_error() {
        assert_eq!(
            step(S::Downloading, E::Transient { attempts: 10 }),
            (S::Error(DlError::Network), vec![F::KeepPart])
        );
    }

    #[test]
    fn a_200_on_resume_restarts_from_zero() {
        assert_eq!(
            step(S::Downloading, E::Got200OnResume),
            (
                S::Downloading,
                vec![F::TruncatePart, F::RestartFromZero, F::Notice(Notice::ServerSentWholeFile)]
            )
        );
    }

    #[test]
    fn validator_change_is_file_changed() {
        assert_eq!(
            step(S::Downloading, E::ValidatorChanged),
            (S::Error(DlError::FileChanged), vec![F::KeepPart])
        );
    }

    #[test]
    fn a_416_with_everything_held_verifies() {
        assert_eq!(
            step(S::Downloading, E::Got416 { held_equals_total: true }),
            (S::Verifying, vec![])
        );
    }

    #[test]
    fn a_416_otherwise_is_file_changed() {
        assert_eq!(
            step(S::Downloading, E::Got416 { held_equals_total: false }),
            (S::Error(DlError::FileChanged), vec![F::KeepPart])
        );
    }

    #[test]
    fn auth_while_downloading_needs_a_link() {
        assert_eq!(step(S::Downloading, E::Auth), (S::NeedsLink, vec![F::KeepPart]));
    }

    #[test]
    fn enospc_pauses_for_storage() {
        assert_eq!(
            step(S::Downloading, E::Enospc),
            (S::Paused(PauseReason::Storage), vec![F::FlushSidecar])
        );
    }

    #[test]
    fn eacces_is_a_permission_error() {
        assert_eq!(step(S::Downloading, E::Eacces), (S::Error(DlError::Permission), vec![]));
    }

    #[test]
    fn all_bytes_verifies() {
        assert_eq!(step(S::Downloading, E::AllBytes), (S::Verifying, vec![]));
    }

    #[test]
    fn http_fatal_while_downloading_is_http_status() {
        assert_eq!(
            step(S::Downloading, E::HttpFatal),
            (S::Error(DlError::HttpStatus), vec![F::KeepPart])
        );
    }

    #[test]
    fn hash_ok_finishes() {
        assert_eq!(
            step(S::Verifying, E::HashOk),
            (S::Finished, vec![F::RenamePart, F::MediaScan, F::NotifyFinished])
        );
    }

    #[test]
    fn hash_bad_is_a_checksum_error() {
        assert_eq!(
            step(S::Verifying, E::HashBad),
            (S::Error(DlError::ChecksumMismatch), vec![F::KeepFile])
        );
    }

    #[test]
    fn new_link_that_matches_requeues() {
        assert_eq!(
            step(S::NeedsLink, E::NewLink { matches: true }),
            (S::Queued, vec![F::RebindUrl])
        );
    }

    #[test]
    fn new_link_that_differs_is_file_changed() {
        assert_eq!(
            step(S::NeedsLink, E::NewLink { matches: false }),
            (S::Error(DlError::FileChanged), vec![])
        );
    }

    #[test]
    fn retry_from_any_error_probes_again() {
        for e in [
            DlError::HttpStatus,
            DlError::Network,
            DlError::FileChanged,
            DlError::NotAFile,
            DlError::ChecksumMismatch,
            DlError::Permission,
        ] {
            assert_eq!(step(S::Error(e), E::UserRetry), (S::Resolving, vec![F::Probe]));
        }
    }

    #[test]
    fn remove_from_any_state_deletes_when_asked() {
        for s in [
            S::Resolving,
            S::Queued,
            S::Downloading,
            S::Paused(PauseReason::User),
            S::Verifying,
            S::Finished,
            S::NeedsLink,
            S::Error(DlError::Network),
        ] {
            assert_eq!(
                step(s, E::Remove { delete_files: true }),
                (S::Gone, vec![F::CancelTasks, F::DeletePartIf(true)])
            );
            assert_eq!(
                step(s, E::Remove { delete_files: false }),
                (S::Gone, vec![F::CancelTasks, F::DeletePartIf(false)])
            );
        }
    }

    #[test]
    fn restore_requeues_a_download_that_was_working() {
        assert_eq!(step(S::Downloading, E::Restore), (S::Queued, vec![]));
        assert_eq!(step(S::Resolving, E::Restore), (S::Queued, vec![]));
    }

    #[test]
    fn restore_keeps_every_other_state() {
        for s in [
            S::Queued,
            S::Paused(PauseReason::User),
            S::Paused(PauseReason::Storage),
            S::Finished,
            S::NeedsLink,
            S::Error(DlError::Network),
        ] {
            assert_eq!(step(s, E::Restore), (s, vec![]));
        }
    }

    #[test]
    fn events_without_a_row_change_nothing() {
        assert_eq!(step(S::Finished, E::UserPause), (S::Finished, vec![]));
        assert_eq!(step(S::Queued, E::AllBytes), (S::Queued, vec![]));
    }
}
