----------------------------- MODULE YtDlpUpdate -----------------------------
(* The part that reads video pages (yt-dlp) replaces itself from yt-dlp's own
   GitHub releases, with no Maglev release in between. An update checks for a
   newer release, downloads it next to the copy in use, checks its SHA-256
   against the release's SHA2-256SUMS, swaps it in and runs it once
   (`--version`). The run passes: the update is kept. It fails (a release that
   needs a newer Python than the app ships): the previous copy goes back.

   Reads of a video page can run at any moment, and Android can close Maglev
   between any two steps. The rules: a read never runs a copy that wasn't
   checked, never sees the file change under it, and the last copy that worked
   is always on disk.

   Copies, by name:
     "builtin"  the copy inside the app; it works and the app's signature vouches for it
     "good"     a new release that works on the app's Python
     "broken"   a new release that fails on the app's Python (its checksum is fine)
     "tampered" a download whose bytes aren't the release's (cut short, or changed on the way)
     "none"     no file at that path *)

CONSTANTS
  DESIGN  \* "owned" (passes), or a rejected one: "today", "noLock", "unlockBeforeTest", "noStartupRollback"

Copies == {"builtin", "good", "broken", "tampered", "none"}
Releases == {"good", "broken"}

\* The checksum matches, or the app's own signature covers it.
Verified(c) == c \in {"builtin", "good", "broken"}
\* It runs on the app's Python.
Works(c) == c \in {"builtin", "good"}

VARIABLES
  app,       \* "up" or "down": whether Maglev's process is running
  ready,     \* in memory: the start-up step (VideoSites.ensureInit) ran since Maglev came up
  file,      \* on disk: the copy at the path the library runs (no_backup/.../yt-dlp/yt-dlp)
  prev,      \* on disk: the copy kept as yt-dlp.prev until the new one passed its first run, or "none"
  tmp,       \* on disk: the download in progress, yt-dlp.new, or "none"
  step,      \* in memory: where the one updater is: "idle", "checked", "downloaded", "verified", "deleted", "kept", "swapped"
  release,   \* in memory: the release the check found, or "none"
  lock,      \* in memory: "free", "read" (a read runs) or "write" (the updater swaps and test-runs)
  reading,   \* in memory: the copy the running read opened, "idle" when none runs
  lastGood   \* no code: the newest copy that has worked so far. It exists only so a rule can name it.

vars == <<app, ready, file, prev, tmp, step, release, lock, reading, lastGood>>

TypeOK ==
  /\ app \in {"up", "down"}
  /\ ready \in BOOLEAN
  /\ file \in Copies
  /\ prev \in Copies
  /\ tmp \in Copies
  /\ step \in {"idle", "checked", "downloaded", "verified", "deleted", "kept", "swapped"}
  /\ release \in Releases \cup {"none"}
  /\ lock \in {"free", "read", "write"}
  /\ reading \in Copies \cup {"idle"}
  /\ lastGood \in Copies

\* A fresh install: the built-in copy is in place and nothing else.
Init ==
  /\ app = "up"
  /\ ready = FALSE
  /\ file = "builtin"
  /\ prev = "none"
  /\ tmp = "none"
  /\ step = "idle"
  /\ release = "none"
  /\ lock = "free"
  /\ reading = "idle"
  /\ lastGood = "builtin"

Owned == DESIGN \in {"owned", "noLock", "unlockBeforeTest", "noStartupRollback"}

\* The first read or update after Maglev comes up. The shipped design first puts
\* back a copy whose test run never finished, and drops a half download. Then the
\* library copies its built-in copy in only when the path is empty.
MaglevGetsReady ==
  /\ app = "up" /\ ~ready /\ lock = "free"
  /\ LET back == Owned /\ DESIGN # "noStartupRollback" /\ prev # "none"
         f == IF back THEN prev ELSE file
     IN /\ file' = IF f = "none" THEN "builtin" ELSE f
        /\ prev' = IF back THEN "none" ELSE prev
  /\ tmp' = IF Owned THEN "none" ELSE tmp
  /\ ready' = TRUE
  /\ UNCHANGED <<app, step, release, lock, reading, lastGood>>

\* You open a video link (or a refused download asks for fresh links): yt-dlp runs
\* once. The shipped design waits for a swap to finish (read lock).
ReadStarts ==
  /\ app = "up" /\ ready /\ reading = "idle"
  /\ IF DESIGN \in {"today", "noLock"} THEN UNCHANGED lock
     ELSE /\ lock = "free"
          /\ lock' = "read"
  /\ reading' = file
  /\ UNCHANGED <<app, ready, file, prev, tmp, step, release, lastGood>>

ReadEnds ==
  /\ reading # "idle"
  /\ reading' = "idle"
  /\ lock' = IF lock = "read" THEN "free" ELSE lock
  /\ UNCHANGED <<app, ready, file, prev, tmp, step, release, lastGood>>

\* The daily job, "Check now" or the card's Update button. The shipped design
\* compares the release's SHA-256 with the file's own, so a copy already in place
\* is never downloaded again. Today the library compares a tag it saved.
CheckFindsNewer ==
  /\ app = "up" /\ ready /\ step = "idle"
  /\ \E r \in Releases :
       /\ r # file
       /\ release' = r
  /\ step' = "checked"
  /\ UNCHANGED <<app, ready, file, prev, tmp, lock, reading, lastGood>>

\* The download lands next to the copy in use. Its bytes may not be the release's.
Download ==
  /\ app = "up" /\ step = "checked"
  /\ \E intact \in BOOLEAN : tmp' = IF intact THEN release ELSE "tampered"
  /\ step' = IF DESIGN = "today" THEN "verified" ELSE "downloaded"
  /\ UNCHANGED <<app, ready, file, prev, release, lock, reading, lastGood>>

\* SHA-256 of the download against SHA2-256SUMS. A mismatch is deleted.
ChecksumChecked ==
  /\ app = "up" /\ step = "downloaded"
  /\ IF tmp = release
     THEN /\ step' = "verified"
          /\ UNCHANGED tmp
     ELSE /\ step' = "idle"
          /\ tmp' = "none"
  /\ UNCHANGED <<app, ready, file, prev, release, lock, reading, lastGood>>

\* Today: the library deletes the yt-dlp folder, then copies the download in, and
\* nothing runs it before reads do.
TodayDeletesOld ==
  /\ DESIGN = "today" /\ app = "up" /\ step = "verified"
  /\ file' = "none"
  /\ step' = "deleted"
  /\ UNCHANGED <<app, ready, prev, tmp, release, lock, reading, lastGood>>

TodayCopiesNew ==
  /\ DESIGN = "today" /\ app = "up" /\ step = "deleted"
  /\ file' = tmp
  /\ tmp' = "none"
  /\ step' = "idle"
  /\ lastGood' = IF Works(tmp) THEN tmp ELSE lastGood
  /\ UNCHANGED <<app, ready, prev, release, lock, reading>>

\* The shipped design takes the write lock (it waits for a running read), then
\* keeps a copy of the file in use as yt-dlp.prev.
KeepPrevious ==
  /\ Owned /\ app = "up" /\ step = "verified"
  /\ IF DESIGN = "noLock" THEN UNCHANGED lock
     ELSE /\ lock = "free"
          /\ lock' = "write"
  /\ prev' = file
  /\ step' = "kept"
  /\ UNCHANGED <<app, ready, file, tmp, release, reading, lastGood>>

\* One rename puts the download at the path. The rejected "unlockBeforeTest" lets
\* reads in again before the new copy has run once.
Swap ==
  /\ Owned /\ app = "up" /\ step = "kept"
  /\ file' = tmp
  /\ tmp' = "none"
  /\ step' = "swapped"
  /\ lock' = IF DESIGN = "unlockBeforeTest" THEN "free" ELSE lock
  /\ UNCHANGED <<app, ready, prev, release, reading, lastGood>>

\* `yt-dlp --version` on the new copy. It runs: delete yt-dlp.prev. It fails: rename
\* yt-dlp.prev back. Either way the lock is let go.
TestRunPasses ==
  /\ Owned /\ app = "up" /\ step = "swapped" /\ Works(file)
  /\ prev' = "none"
  /\ lastGood' = file
  /\ lock' = IF lock = "write" THEN "free" ELSE lock
  /\ step' = "idle"
  /\ UNCHANGED <<app, ready, file, tmp, release, reading>>

TestRunFailsRollBack ==
  /\ Owned /\ app = "up" /\ step = "swapped" /\ ~Works(file)
  /\ file' = prev
  /\ prev' = "none"
  /\ lock' = IF lock = "write" THEN "free" ELSE lock
  /\ step' = "idle"
  /\ UNCHANGED <<app, ready, tmp, release, reading, lastGood>>

\* Android can close Maglev at any moment, the daily job's process included.
\* Memory goes; the files stay as they are.
AndroidKillsMaglev ==
  /\ app = "up"
  /\ app' = "down"
  /\ ready' = FALSE
  /\ step' = "idle"
  /\ release' = "none"
  /\ lock' = "free"
  /\ reading' = "idle"
  /\ UNCHANGED <<file, prev, tmp, lastGood>>

\* You open Maglev, or WorkManager starts it for the daily job.
MaglevStarts ==
  /\ app = "down"
  /\ app' = "up"
  /\ UNCHANGED <<ready, file, prev, tmp, step, release, lock, reading, lastGood>>

Next ==
  \/ MaglevGetsReady \/ ReadStarts \/ ReadEnds
  \/ CheckFindsNewer \/ Download \/ ChecksumChecked
  \/ TodayDeletesOld \/ TodayCopiesNew
  \/ KeepPrevious \/ Swap \/ TestRunPasses \/ TestRunFailsRollBack
  \/ AndroidKillsMaglev \/ MaglevStarts

Spec == Init /\ [][Next]_vars

\* Rules.

\* A read only ever runs a copy whose checksum matched (or the app's own built-in copy).
NeverRunUnverified == reading \notin {"idle", "none"} => Verified(reading)

\* While a read runs, the file at the path is the complete copy it opened. Python
\* opens yt-dlp again by name for every module it loads, so a swap under a read breaks it.
NoReadSeesHalfSwap == reading # "idle" => (reading # "none" /\ file = reading)

\* The last copy that worked is always on disk: in use, or kept to roll back to.
AlwaysAWorkingCopy == lastGood \in {file, prev}

\* A read only ever runs a copy that works on the app's Python.
ReadsRunAWorkingCopy == reading # "idle" => Works(reading)
=============================================================================
