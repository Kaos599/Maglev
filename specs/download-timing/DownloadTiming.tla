--------------------------- MODULE DownloadTiming ---------------------------
(* Models what the detail screen's Timing row and Timing sheet show for a
   transfer across queuing, downloading, pausing, 1-second ticks, and finishing
   (including finishing inside the first second, before the first tick).

   Code: utils/stats/format.ts (timingView), components/detail/TimingRow.tsx. *)

EXTENDS Naturals

CONSTANTS
  DESIGN  \* "fixed" or "activeOnly"

VARIABLES
  state,       \* "queued", "downloading", "paused", "finished"
  activeSecs,  \* 0 (under 1 s), 1 (1 s), 2 (2+ s)
  addedAt,     \* 0 (unknown / pre-0.26) or 1 (known)
  finishedAt   \* 0 (not finished), 1 (same second as added), 2 (>= 1 s after added)

vars == <<state, activeSecs, addedAt, finishedAt>>

TypeOK ==
  /\ state \in {"queued", "downloading", "paused", "finished"}
  /\ activeSecs \in 0..2
  /\ addedAt \in {0, 1}
  /\ finishedAt \in 0..2

Init ==
  /\ state = "queued"
  /\ activeSecs = 0
  /\ addedAt \in {0, 1}
  /\ finishedAt = 0

StartDownload ==
  /\ state = "queued"
  /\ state' = "downloading"
  /\ UNCHANGED <<activeSecs, addedAt, finishedAt>>

Pause ==
  /\ state = "downloading"
  /\ state' = "paused"
  /\ UNCHANGED <<activeSecs, addedAt, finishedAt>>

Resume ==
  /\ state = "paused"
  /\ state' = "downloading"
  /\ UNCHANGED <<activeSecs, addedAt, finishedAt>>

\* One-second engine accounting tick while downloading.
Tick ==
  /\ state = "downloading"
  /\ activeSecs < 2
  /\ activeSecs' = activeSecs + 1
  /\ UNCHANGED <<state, addedAt, finishedAt>>

\* Transfer finishes inside the same unix second it was added (can happen with activeSecs = 0).
FinishSameSecond ==
  /\ state = "downloading"
  /\ activeSecs = 0
  /\ state' = "finished"
  /\ finishedAt' = 1
  /\ UNCHANGED <<activeSecs, addedAt>>

\* Transfer finishes in a later unix second (can still happen with activeSecs = 0 if < 1 s crossed a second boundary).
FinishLaterSecond ==
  /\ state = "downloading"
  /\ state' = "finished"
  /\ finishedAt' = 2
  /\ UNCHANGED <<activeSecs, addedAt>>

\* Terminal stuttering step so TLC deadlock checking stays on.
Done ==
  /\ state = "finished"
  /\ UNCHANGED vars

Next ==
  \/ StartDownload
  \/ Pause
  \/ Resume
  \/ Tick
  \/ FinishSameSecond
  \/ FinishLaterSecond
  \/ Done

Spec == Init /\ [][Next]_vars

\* --- Display predicates (matching utils/stats/format.ts timingView) ---

IsDone == finishedAt > 0

RowShowsTook ==
  IF DESIGN = "activeOnly"
  THEN activeSecs > 0
  ELSE (activeSecs > 0 \/ IsDone)

SheetShowsSpan == IsDone /\ addedAt > 0

\* --- Rules (invariants) ---

\* A finished transfer always shows how long it took on the detail row.
DoneShowsTook ==
  IsDone => RowShowsTook

\* The detail row and the Timing sheet never disagree on whether time is known.
RowAndSheetAgree ==
  SheetShowsSpan => RowShowsTook
=============================================================================
