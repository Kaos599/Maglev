------------------------------ MODULE Torrents ------------------------------
(* Models the torrent lifecycle and scheduler planner across librqbit and Rust:
     - native/maglev-core/src/scheduler.rs (plan, derive_state, Action)
     - native/maglev-core/src/engine.rs (pause, resume, move_storage, tick)

   Two torrents ("a" added before "b") compete for 1 active download slot and
   1 active seed slot while finishing, hitting seed limits, getting paused or
   resumed by the user, triggering health tags, or moving storage. *)

EXTENDS FiniteSets, Naturals

CONSTANTS
  DESIGN  \* "shipped", "queueFinished", "healthIgnored", or "noLimitsWaived"

Torrents == {"a", "b"}
MaxActiveDownloads == 1
MaxActiveSeeds == 1

VARIABLES
  finished,      \* [Torrents -> BOOLEAN] every selected piece verified
  running,       \* [Torrents -> BOOLEAN] librqbit actively downloading or seeding
  queued,        \* [Torrents -> BOOLEAN] waiting for a download slot (never finished)
  pausedBy,      \* [Torrents -> {"none", "user", "seed_limit", "health"}]
  health,        \* [Torrents -> {"none", "files_missing"}]
  limitsWaived,  \* [Torrents -> BOOLEAN] resumed after hitting a seed limit
  moving         \* [Torrents -> BOOLEAN] files being moved; planner skips it

vars == <<finished, running, queued, pausedBy, health, limitsWaived, moving>>

TypeOK ==
  /\ finished \in [Torrents -> BOOLEAN]
  /\ running \in [Torrents -> BOOLEAN]
  /\ queued \in [Torrents -> BOOLEAN]
  /\ pausedBy \in [Torrents -> {"none", "user", "seed_limit", "health"}]
  /\ health \in [Torrents -> {"none", "files_missing"}]
  /\ limitsWaived \in [Torrents -> BOOLEAN]
  /\ moving \in [Torrents -> BOOLEAN]

\* Deterministic slot assignment: "a" has earlier added_at than "b".
IsCandidate(t, pb, hl, mv) ==
  /\ ~mv[t]
  /\ (DESIGN = "healthIgnored" \/ hl[t] = "none")
  /\ pb[t] \notin {"user", "seed_limit"}

\* Does torrent t win a slot among candidates in its group (downloading vs seeding)?
HasSlot(t, fin, pb, hl, mv) ==
  IF ~IsCandidate(t, pb, hl, mv) THEN FALSE
  ELSE IF t = "a" THEN TRUE
  ELSE \* t = "b": wins a slot only if "a" is not competing in the same (finished) group
    ~(IsCandidate("a", pb, hl, mv) /\ fin["a"] = fin["b"])

\* Apply scheduler.rs plan() to produce (running', queued', pausedBy').
ReconcileRun(t, fin, pb, hl, mv, curRun) ==
  IF mv[t] THEN curRun
  ELSE IF hl[t] /= "none" /\ DESIGN /= "healthIgnored" THEN FALSE
  ELSE IF pb[t] \in {"user", "seed_limit"} THEN FALSE
  ELSE HasSlot(t, fin, pb, hl, mv)

ReconcileQueued(t, fin, pb, hl, mv, curQ) ==
  IF mv[t] THEN curQ
  ELSE IF hl[t] /= "none" /\ DESIGN /= "healthIgnored" THEN FALSE
  ELSE IF pb[t] \in {"user", "seed_limit"} THEN FALSE
  ELSE IF HasSlot(t, fin, pb, hl, mv) THEN FALSE
  ELSE IF fin[t] THEN (DESIGN = "queueFinished")  \* Park -> FALSE; buggy Queue -> TRUE
  ELSE TRUE

ReconcilePausedBy(t, fin, pb, hl, mv) ==
  IF mv[t] THEN pb[t]
  ELSE IF hl[t] /= "none" /\ DESIGN /= "healthIgnored" THEN
    IF pb[t] \in {"user", "seed_limit"} THEN pb[t] ELSE "health"
  ELSE IF pb[t] \in {"user", "seed_limit"} THEN pb[t]
  ELSE "none"

Init ==
  /\ finished = [t \in Torrents |-> FALSE]
  /\ running = [t \in Torrents |-> (t = "a")]
  /\ queued = [t \in Torrents |-> (t = "b")]
  /\ pausedBy = [t \in Torrents |-> "none"]
  /\ health = [t \in Torrents |-> "none"]
  /\ limitsWaived = [t \in Torrents |-> FALSE]
  /\ moving = [t \in Torrents |-> FALSE]

\* A running download finishes all selected pieces.
DownloadFinishes(t) ==
  /\ ~finished[t]
  /\ running[t]
  /\ ~moving[t]
  /\ LET nextFin == [finished EXCEPT ![t] = TRUE]
     IN /\ finished' = nextFin
        /\ running' = [x \in Torrents |-> ReconcileRun(x, nextFin, pausedBy, health, moving, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, nextFin, pausedBy, health, moving, queued[x])]
        /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, nextFin, pausedBy, health, moving)]
  /\ UNCHANGED <<health, limitsWaived, moving>>

\* A seeding torrent hits its ratio or time limit (unless waived, in the shipped design).
SeedLimitHits(t) ==
  /\ finished[t]
  /\ running[t]
  /\ ~moving[t]
  /\ (DESIGN = "noLimitsWaived" \/ ~limitsWaived[t])
  /\ LET nextPb == [pausedBy EXCEPT ![t] = "seed_limit"]
     IN /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, nextPb, health, moving)]
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, nextPb, health, moving, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, nextPb, health, moving, queued[x])]
  /\ UNCHANGED <<finished, health, limitsWaived, moving>>

\* The user pauses a torrent (rejected while moving).
YouPause(t) ==
  /\ ~moving[t]
  /\ pausedBy[t] /= "user"
  /\ LET nextPb == [pausedBy EXCEPT ![t] = "user"]
     IN /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, nextPb, health, moving)]
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, nextPb, health, moving, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, nextPb, health, moving, queued[x])]
  /\ UNCHANGED <<finished, health, limitsWaived, moving>>

\* The user resumes a paused torrent (rejected while moving or while a health tag is set).
\* Resuming a seed_limit-paused torrent sets limits_waived = TRUE.
YouResume(t) ==
  /\ ~moving[t]
  /\ health[t] = "none"
  /\ pausedBy[t] \in {"user", "seed_limit"}
  /\ LET nextWaived == IF pausedBy[t] = "seed_limit" THEN [limitsWaived EXCEPT ![t] = TRUE] ELSE limitsWaived
         nextPb == [pausedBy EXCEPT ![t] = "none"]
     IN /\ limitsWaived' = nextWaived
        /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, nextPb, health, moving)]
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, nextPb, health, moving, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, nextPb, health, moving, queued[x])]
  /\ UNCHANGED <<finished, health, moving>>

\* File health check detects missing files on disk.
HealthTriggers(t) ==
  /\ ~moving[t]
  /\ health[t] = "none"
  /\ LET nextHl == [health EXCEPT ![t] = "files_missing"]
     IN /\ health' = nextHl
        /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, pausedBy, nextHl, moving)]
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, pausedBy, nextHl, moving, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, pausedBy, nextHl, moving, queued[x])]
  /\ UNCHANGED <<finished, limitsWaived, moving>>

\* User rechecks or relocates files, clearing the health tag.
HealthClears(t) ==
  /\ ~moving[t]
  /\ health[t] /= "none"
  /\ LET nextHl == [health EXCEPT ![t] = "none"]
         nextPb == IF pausedBy[t] = "health" THEN [pausedBy EXCEPT ![t] = "none"] ELSE pausedBy
     IN /\ health' = nextHl
        /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, nextPb, nextHl, moving)]
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, nextPb, nextHl, moving, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, nextPb, nextHl, moving, queued[x])]
  /\ UNCHANGED <<finished, limitsWaived, moving>>

\* Storage move starts: pauses the torrent and hides it from the planner until done.
MoveStarts(t) ==
  /\ ~moving[t]
  /\ LET nextMv == [moving EXCEPT ![t] = TRUE]
         nextRun == [running EXCEPT ![t] = FALSE]
         nextQ == [queued EXCEPT ![t] = FALSE]
     IN /\ moving' = nextMv
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, pausedBy, health, nextMv, nextRun[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, pausedBy, health, nextMv, nextQ[x])]
        /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, pausedBy, health, nextMv)]
  /\ UNCHANGED <<finished, health, limitsWaived>>

\* Storage move completes: torrent returns to the planner.
MoveFinishes(t) ==
  /\ moving[t]
  /\ LET nextMv == [moving EXCEPT ![t] = FALSE]
     IN /\ moving' = nextMv
        /\ running' = [x \in Torrents |-> ReconcileRun(x, finished, pausedBy, health, nextMv, running[x])]
        /\ queued' = [x \in Torrents |-> ReconcileQueued(x, finished, pausedBy, health, nextMv, queued[x])]
        /\ pausedBy' = [x \in Torrents |-> ReconcilePausedBy(x, finished, pausedBy, health, nextMv)]
  /\ UNCHANGED <<finished, health, limitsWaived>>

Next ==
  \E t \in Torrents :
    \/ DownloadFinishes(t)
    \/ SeedLimitHits(t)
    \/ YouPause(t)
    \/ YouResume(t)
    \/ HealthTriggers(t)
    \/ HealthClears(t)
    \/ MoveStarts(t)
    \/ MoveFinishes(t)

Spec == Init /\ [][Next]_vars

\* --- Rules (invariants) ---

\* Active downloading torrents never exceed max_active_downloads.
DownloadSlotsRespected ==
  Cardinality({t \in Torrents : ~finished[t] /\ running[t] /\ ~moving[t]}) <= MaxActiveDownloads

\* Active seeding torrents never exceed max_active_seeds.
SeedSlotsRespected ==
  Cardinality({t \in Torrents : finished[t] /\ running[t] /\ ~moving[t]}) <= MaxActiveSeeds

\* A finished torrent without a seed slot is parked as COMPLETED, never QUEUED.
FinishedNeverQueued ==
  \A t \in Torrents : finished[t] => ~queued[t]

\* A torrent with a health tag never runs.
HealthNeverRuns ==
  \A t \in Torrents : health[t] /= "none" => ~running[t]

\* A user-paused torrent never runs and is never queued.
UserPauseWins ==
  \A t \in Torrents : pausedBy[t] = "user" => (~running[t] /\ ~queued[t])

\* Once the user resumes a torrent past its seed limit, it is never paused for seed limits again.
WaivedNeverSeedLimited ==
  \A t \in Torrents : limitsWaived[t] => pausedBy[t] /= "seed_limit"
=============================================================================
