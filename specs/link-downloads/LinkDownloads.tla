--------------------------- MODULE LinkDownloads ---------------------------
(* Models the link-download state machine across process death, governance
   rules, user pauses, in-memory secrets (cookies / signed URLs), and retries:
     - native/maglev-core/src/http_dl/machine.rs (step, State, Event)
     - native/maglev-core/src/http_dl/driver.rs (restore, SecretsLost, retries)
     - modules/maglev-engine/android/.../AutoRetryWorker.kt *)

EXTENDS Naturals

CONSTANTS
  DESIGN  \* "shipped", "retryWithoutSecrets", "govClearWakesUserPause", or "infiniteRetries"

MaxAttempts == 2

States == {
  "none", "resolving", "queued", "downloading",
  "paused_user", "paused_gov", "verifying",
  "finished", "needs_link", "error", "gone"
}

VARIABLES
  state,         \* current machine State
  needsSecrets,  \* TRUE if the link relies on in-memory cookies / signed headers
  hasSecrets,    \* TRUE while those secrets are still in memory
  govBlocked,    \* TRUE while a governance rule blocks transfers
  userPaused,    \* ground truth: user paused and has not resumed
  attempts       \* retry counter (0..MaxAttempts+1)

vars == <<state, needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

TypeOK ==
  /\ state \in States
  /\ needsSecrets \in BOOLEAN
  /\ hasSecrets \in BOOLEAN
  /\ govBlocked \in BOOLEAN
  /\ userPaused \in BOOLEAN
  /\ attempts \in 0..(MaxAttempts + 1)

Init ==
  /\ state = "none"
  /\ needsSecrets = FALSE
  /\ hasSecrets = FALSE
  /\ govBlocked = FALSE
  /\ userPaused = FALSE
  /\ attempts = 0

\* User adds a link (plain or secret-bearing). Blocked if governance is on.
AddDownload(withSecrets) ==
  /\ state = "none"
  /\ needsSecrets' = withSecrets
  /\ hasSecrets' = withSecrets
  /\ state' = IF govBlocked THEN "paused_gov" ELSE "resolving"
  /\ UNCHANGED <<govBlocked, userPaused, attempts>>

\* Probe succeeds: starts downloading if slot free & gov allows, else queues.
ProbeOk(slotFree) ==
  /\ state = "resolving"
  /\ state' = IF slotFree /\ ~govBlocked THEN "downloading" ELSE "queued"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

\* Probe fails with 401/403 -> needs_link.
ProbeAuth ==
  /\ state = "resolving"
  /\ state' = "needs_link"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

\* Probe fails with HTTP/network error -> error.
ProbeFail ==
  /\ state = "resolving"
  /\ state' = "error"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

\* A download slot frees up while queued.
SlotFree ==
  /\ state = "queued"
  /\ ~govBlocked
  /\ state' = "downloading"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

\* Retryable failure while downloading.
TransientFail ==
  /\ state = "downloading"
  /\ IF DESIGN = "infiniteRetries" THEN
       /\ attempts' = IF attempts <= MaxAttempts THEN attempts + 1 ELSE attempts
       /\ state' = "downloading"
     ELSE IF attempts < MaxAttempts THEN
       /\ attempts' = attempts + 1
       /\ state' = "downloading"
     ELSE
       /\ state' = "error"
       /\ UNCHANGED attempts
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused>>

\* Auth expired (401/403/410) while downloading.
DownloadAuthFail ==
  /\ state = "downloading"
  /\ state' = "needs_link"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

\* All bytes received -> verifying.
AllBytes ==
  /\ state = "downloading"
  /\ state' = "verifying"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

VerifyOk ==
  /\ state = "verifying"
  /\ state' = "finished"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

VerifyBad ==
  /\ state = "verifying"
  /\ state' = "error"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused, attempts>>

\* User pauses from resolving, queued, downloading, or paused_gov.
YouPause ==
  /\ state \in {"resolving", "queued", "downloading", "paused_gov"}
  /\ state' = "paused_user"
  /\ userPaused' = TRUE
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, attempts>>

\* User resumes from any paused state.
YouResume ==
  /\ state \in {"paused_user", "paused_gov"}
  /\ state' = "queued"
  /\ userPaused' = FALSE
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, attempts>>

\* Governance rule turns on.
GovTurnsOn ==
  /\ ~govBlocked
  /\ govBlocked' = TRUE
  /\ state' = IF state \in {"resolving", "queued", "downloading"} THEN "paused_gov" ELSE state
  /\ UNCHANGED <<needsSecrets, hasSecrets, userPaused, attempts>>

\* Governance rule clears.
GovClears ==
  /\ govBlocked
  /\ govBlocked' = FALSE
  /\ state' = IF state = "paused_gov" THEN "queued"
              ELSE IF state = "paused_user" /\ DESIGN = "govClearWakesUserPause" THEN "queued"
              ELSE state
  /\ UNCHANGED <<needsSecrets, hasSecrets, userPaused, attempts>>

\* User supplies a fresh link when needs_link.
YouGiveNewLink(matches) ==
  /\ state = "needs_link"
  /\ IF matches THEN
       /\ state' = "queued"
       /\ hasSecrets' = needsSecrets
       /\ attempts' = 0
     ELSE
       /\ state' = "error"
       /\ UNCHANGED <<hasSecrets, attempts>>
  /\ UNCHANGED <<needsSecrets, govBlocked, userPaused>>

\* User or AutoRetryWorker retries from error.
RetryFromError ==
  /\ state = "error"
  /\ (~needsSecrets \/ hasSecrets)
  /\ attempts' = 0
  /\ state' = IF govBlocked THEN "paused_gov" ELSE "resolving"
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, userPaused>>

\* Process dies and restarts: in-memory secrets are lost.
ProcessRestarts ==
  /\ state \notin {"none", "gone"}
  /\ hasSecrets' = FALSE
  /\ state' = IF needsSecrets /\ state \in {"resolving", "queued", "downloading", "paused_user", "paused_gov", "verifying"} THEN
                IF DESIGN = "retryWithoutSecrets" THEN
                  IF state \in {"resolving", "downloading"} THEN "queued" ELSE state
                ELSE "needs_link"
              ELSE IF state \in {"resolving", "downloading"} THEN "queued"
              ELSE state
  /\ userPaused' = IF needsSecrets /\ state = "paused_user" /\ DESIGN /= "retryWithoutSecrets" THEN FALSE ELSE userPaused
  /\ UNCHANGED <<needsSecrets, govBlocked, attempts>>

\* User removes the download from any state.
YouRemove ==
  /\ state \notin {"none", "gone"}
  /\ state' = "gone"
  /\ userPaused' = FALSE
  /\ UNCHANGED <<needsSecrets, hasSecrets, govBlocked, attempts>>

Next ==
  \/ \E s \in BOOLEAN : AddDownload(s)
  \/ \E sf \in BOOLEAN : ProbeOk(sf)
  \/ ProbeAuth
  \/ ProbeFail
  \/ SlotFree
  \/ TransientFail
  \/ DownloadAuthFail
  \/ AllBytes
  \/ VerifyOk
  \/ VerifyBad
  \/ YouPause
  \/ YouResume
  \/ GovTurnsOn
  \/ GovClears
  \/ \E m \in BOOLEAN : YouGiveNewLink(m)
  \/ RetryFromError
  \/ ProcessRestarts
  \/ YouRemove

Spec == Init /\ [][Next]_vars

\* --- Rules (invariants) ---

\* A download relying on in-memory secrets never resolves or downloads once those secrets are lost.
NoWorkWithoutSecrets ==
  (needsSecrets /\ ~hasSecrets) => state \notin {"resolving", "downloading"}

\* A download paused by the user never wakes up into queued, resolving, or downloading.
UserPauseStaysPaused ==
  userPaused => state = "paused_user"

\* Retries never exceed the configured attempt budget.
RetryBudgetRespected ==
  attempts <= MaxAttempts

\* Downloading never runs while a governance rule is blocking.
RespectsGovernance ==
  govBlocked => state /= "downloading"
=============================================================================
