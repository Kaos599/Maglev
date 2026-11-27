--------------------------- MODULE LinkDownloads ---------------------------
(* Models the link download state machine across Rust and Kotlin:
     - native/maglev-core/src/http_dl/machine.rs (step, State, Event)
     - native/maglev-core/src/http_dl/driver.rs (governance, secrets, restore)
     - modules/maglev-engine/.../AutoRetryWorker.kt (background auto-retry)

   Covers adding, probing, queuing, downloading, verifying, finishing, pausing
   (user vs governance), retry budgets, process death dropping in-memory cookies
   or signed links (SecretsLost -> needs_link), rebinding a new link, mux retry,
   auto-retry racing user actions, and removal. *)

EXTENDS Naturals

CONSTANTS
  DESIGN  \* "shipped", "restoreIgnoresSecrets", "govClearWakesUserPause", or "autoRetryIgnoresGov"

MaxAttempts == 2

States == {
  "none", "resolving", "queued", "downloading",
  "paused_user", "paused_gov", "verifying", "finished",
  "needs_link", "error_net", "error_mux", "gone"
}

VARIABLES
  state,           \* current State in machine.rs
  hasSecret,       \* TRUE when the link relies on in-memory cookies / auth / signed URL
  secretsPresent,  \* TRUE while those in-memory secrets are still alive
  userPaused,      \* ground truth: the user paused this download and hasn't resumed it
  attempts,        \* retry count (0..MaxAttempts)
  govBlocked       \* TRUE while a governance rule blocks transfers

vars == <<state, hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

TypeOK ==
  /\ state \in States
  /\ hasSecret \in BOOLEAN
  /\ secretsPresent \in BOOLEAN
  /\ userPaused \in BOOLEAN
  /\ attempts \in 0..MaxAttempts
  /\ govBlocked \in BOOLEAN

Init ==
  /\ state = "none"
  /\ hasSecret = FALSE
  /\ secretsPresent = FALSE
  /\ userPaused = FALSE
  /\ attempts = 0
  /\ govBlocked = FALSE

\* User adds a link (with or without in-memory cookies/signed URL).
Add(secret) ==
  /\ state = "none"
  /\ secret \in BOOLEAN
  /\ hasSecret' = secret
  /\ secretsPresent' = secret
  /\ state' = IF govBlocked THEN "paused_gov" ELSE "resolving"
  /\ UNCHANGED <<userPaused, attempts, govBlocked>>

\* Probe succeeds: starts downloading if governance allows, else queues.
ProbeOk ==
  /\ state = "resolving"
  /\ state' = IF govBlocked THEN "queued" ELSE "downloading"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* Probe hits 401/403 -> needs_link.
ProbeAuth ==
  /\ state = "resolving"
  /\ state' = "needs_link"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* Probe fails with a network error -> error_net.
ProbeNetErr ==
  /\ state = "resolving"
  /\ state' = "error_net"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* Queued download gets a slot when governance allows.
SlotFree ==
  /\ state = "queued"
  /\ ~govBlocked
  /\ state' = "downloading"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* Retryable transient failure while downloading (bounded by MaxAttempts).
TransientFail ==
  /\ state = "downloading"
  /\ IF attempts < MaxAttempts THEN
       /\ attempts' = attempts + 1
       /\ state' = "downloading"
     ELSE
       /\ attempts' = attempts
       /\ state' = "error_net"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, govBlocked>>

\* All bytes received -> verifying.
AllBytes ==
  /\ state = "downloading"
  /\ state' = "verifying"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* Verification succeeds -> finished.
HashOk ==
  /\ state = "verifying"
  /\ state' = "finished"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* Stream muxing fails -> error_mux; RetryMux returns directly to verifying.
MuxFailed ==
  /\ state = "verifying"
  /\ state' = "error_mux"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

RetryMux ==
  /\ state = "error_mux"
  /\ state' = "verifying"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts, govBlocked>>

\* User pauses from resolving, queued, downloading, or paused_gov (Pause all).
UserPause ==
  /\ state \in {"resolving", "queued", "downloading", "paused_gov"}
  /\ state' = "paused_user"
  /\ userPaused' = TRUE
  /\ UNCHANGED <<hasSecret, secretsPresent, attempts, govBlocked>>

\* User resumes from any pause -> queued (or stays paused if gov blocks later).
UserResume ==
  /\ state \in {"paused_user", "paused_gov"}
  /\ (~hasSecret \/ secretsPresent)
  /\ state' = "queued"
  /\ userPaused' = FALSE
  /\ UNCHANGED <<hasSecret, secretsPresent, attempts, govBlocked>>

\* Governance turns on: pauses resolving, queued, or downloading; never overwrites paused_user.
GovTurnsOn ==
  /\ ~govBlocked
  /\ govBlocked' = TRUE
  /\ state' = IF state \in {"resolving", "queued", "downloading"} THEN "paused_gov" ELSE state
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts>>

\* Governance clears: paused_gov -> queued; paused_user stays paused_user in shipped design.
GovTurnsOff ==
  /\ govBlocked
  /\ govBlocked' = FALSE
  /\ state' = IF state = "paused_gov" THEN "queued"
              ELSE IF state = "paused_user" /\ DESIGN = "govClearWakesUserPause" THEN "queued"
              ELSE state
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, attempts>>

\* User or AutoRetryWorker retries an error_net download.
RetryError ==
  /\ state = "error_net"
  /\ attempts' = 0
  /\ state' = IF govBlocked THEN
                IF DESIGN = "autoRetryIgnoresGov" THEN "downloading" ELSE "paused_gov"
              ELSE "resolving"
  /\ UNCHANGED <<hasSecret, secretsPresent, userPaused, govBlocked>>

\* User supplies a fresh matching link for needs_link (restores secrets).
NewLink ==
  /\ state = "needs_link"
  /\ secretsPresent' = hasSecret
  /\ state' = IF govBlocked THEN "paused_gov" ELSE "queued"
  /\ userPaused' = FALSE
  /\ UNCHANGED <<hasSecret, attempts, govBlocked>>

\* Process dies and restarts: in-memory secrets are lost.
\* Shipped design emits SecretsLost (-> needs_link) for active/paused/verifying secret downloads,
\* and Restore (downloading/resolving -> queued) for non-secret downloads.
ProcessRestart ==
  /\ state \notin {"none", "gone"}
  /\ secretsPresent' = FALSE
  /\ state' = IF hasSecret /\ state \in {"resolving", "queued", "downloading", "paused_user", "paused_gov", "verifying"} THEN
                IF DESIGN = "restoreIgnoresSecrets" THEN
                  IF state \in {"resolving", "downloading"} THEN "queued" ELSE state
                ELSE "needs_link"
              ELSE IF state \in {"resolving", "downloading"} THEN "queued"
              ELSE state
  /\ UNCHANGED <<hasSecret, userPaused, attempts, govBlocked>>

\* User removes the download from any state (terminal).
Remove ==
  /\ state \notin {"none", "gone"}
  /\ state' = "gone"
  /\ userPaused' = FALSE
  /\ UNCHANGED <<hasSecret, secretsPresent, attempts, govBlocked>>

Next ==
  \/ \E s \in BOOLEAN : Add(s)
  \/ ProbeOk
  \/ ProbeAuth
  \/ ProbeNetErr
  \/ SlotFree
  \/ TransientFail
  \/ AllBytes
  \/ HashOk
  \/ MuxFailed
  \/ RetryMux
  \/ UserPause
  \/ UserResume
  \/ GovTurnsOn
  \/ GovTurnsOff
  \/ RetryError
  \/ NewLink
  \/ ProcessRestart
  \/ Remove

Spec == Init /\ [][Next]_vars

\* --- Rules (invariants) ---

\* A user-paused download never wakes up on governance clear, restore, or auto-retry.
UserPauseWins ==
  userPaused => (state \notin {"resolving", "queued", "downloading", "verifying"})

\* A download whose in-memory cookies or signed link were lost on restart never resolves,
\* queues, downloads, or verifies until a new link is supplied.
NoTransferWithoutSecrets ==
  (hasSecret /\ ~secretsPresent) => (state \notin {"resolving", "queued", "downloading", "verifying"})

\* While governance blocks, no download actively transfers bytes.
GovBlocksDownload ==
  govBlocked => (state /= "downloading")

\* Retry attempts never exceed MaxAttempts.
AttemptsBounded ==
  attempts <= MaxAttempts
=============================================================================
