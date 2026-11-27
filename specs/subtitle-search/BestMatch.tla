------------------------------ MODULE BestMatch ------------------------------
(* "Use best match" for a season pack. Each episode of the pack is searched on
   its own, two at a time (components/subtitles/useSubtitleRequests.ts). An
   episode whose search ends with only close matches waits for you ("needs
   pick") and keeps its best match. "Use best match" saves the kept best match
   of every waiting episode whose match is sure enough, two at a time
   (components/subtitles/bulkSave.ts, utils/subtitles/season.ts runBulk).

   The button never waits for the other episodes: it shows as soon as one
   episode qualifies, and episodes still searching are simply not in it. What
   can go wrong is the order of events around a tap: you skip the pack, or pick
   an episode by hand, while the bulk is working through its list.

   Two episodes are enough: the bulk takes its list at the tap, and the bugs
   come from one episode changing under it. *)

EXTENDS Naturals

CONSTANTS
  Episodes,   \* e.g. {"e1", "e2"}
  DESIGN      \* "recheck" (BestMatch.cfg) or "noRecheck" (BestMatchNoRecheck.cfg)

VARIABLES
  run,        \* [Episodes -> "searching", "waiting" (needs your pick), "saved" or "skipped"]
  sure,       \* [Episodes -> BOOLEAN]: the kept best match qualifies (title, season and episode, your language)
  bulk,       \* "idle" or "running"
  todo,       \* episodes the bulk took at your tap and hasn't started yet
  saving,     \* episodes the bulk is downloading right now
  files,      \* [Episodes -> 0..2]: subtitle files written next to the episode
  lateWrite   \* TRUE once the bulk wrote a file for an episode you had already skipped

vars == <<run, sure, bulk, todo, saving, files, lateWrite>>

TypeOK ==
  /\ run \in [Episodes -> {"searching", "waiting", "saved", "skipped"}]
  /\ sure \in [Episodes -> BOOLEAN]
  /\ bulk \in {"idle", "running"}
  /\ todo \subseteq Episodes
  /\ saving \subseteq Episodes
  /\ files \in [Episodes -> 0..2]
  /\ lateWrite \in BOOLEAN

Qualifying == {e \in Episodes : run[e] = "waiting" /\ sure[e]}

\* The bulk's check before it starts an episode: still waiting for a pick, not skipped.
Valid(e) == run[e] = "waiting"

Init ==
  /\ run = [e \in Episodes |-> "searching"]
  /\ sure = [e \in Episodes |-> FALSE]
  /\ bulk = "idle"
  /\ todo = {}
  /\ saving = {}
  /\ files = [e \in Episodes |-> 0]
  /\ lateWrite = FALSE

\* An episode's own search ends. A result that fits the file is saved at once;
\* otherwise it waits for you, with or without a sure best match.
SearchEnds(e, outcome) ==
  /\ run[e] = "searching"
  /\ CASE outcome = "fits" -> run' = [run EXCEPT ![e] = "saved"] /\ files' = [files EXCEPT ![e] = 1] /\ UNCHANGED sure
       [] outcome = "sure" -> run' = [run EXCEPT ![e] = "waiting"] /\ sure' = [sure EXCEPT ![e] = TRUE] /\ UNCHANGED files
       [] OTHER -> run' = [run EXCEPT ![e] = "waiting"] /\ UNCHANGED <<sure, files>>
  /\ UNCHANGED <<bulk, todo, saving, lateWrite>>

\* You tap Use best match. It shows as soon as one episode qualifies, whatever
\* the others are doing; the bulk takes the qualifying episodes of this moment.
YouTapUseBestMatch ==
  /\ bulk = "idle"
  /\ Qualifying # {}
  /\ bulk' = "running"
  /\ todo' = Qualifying
  /\ UNCHANGED <<run, sure, saving, files, lateWrite>>

\* The bulk starts the next episode on its list. The shipped bulk checks it is
\* still waiting first; "noRecheck" doesn't.
BulkStarts(e) ==
  /\ e \in todo
  /\ todo' = todo \ {e}
  /\ saving' = IF DESIGN = "noRecheck" \/ Valid(e) THEN saving \cup {e} ELSE saving
  /\ UNCHANGED <<run, sure, bulk, files, lateWrite>>

\* The download ends and the file is written, unless a file of that name is
\* already there (the bulk never replaces one). The episode is marked saved
\* only if it is still waiting.
BulkSaveEnds(e) ==
  /\ e \in saving
  /\ saving' = saving \ {e}
  /\ files' = IF files[e] = 0 THEN [files EXCEPT ![e] = 1] ELSE files
  /\ lateWrite' = (lateWrite \/ (files[e] = 0 /\ run[e] = "skipped"))
  /\ run' = IF run[e] = "waiting" /\ files[e] = 0 THEN [run EXCEPT ![e] = "saved"] ELSE run
  /\ UNCHANGED <<sure, bulk, todo>>

\* The bulk's list is done.
BulkEnds ==
  /\ bulk = "running"
  /\ todo = {} /\ saving = {}
  /\ bulk' = "idle"
  /\ UNCHANGED <<run, sure, todo, saving, files, lateWrite>>

\* You open a waiting episode and save a row by hand. If a file of that name is
\* there already, the sheet asks Replace / Keep both / Cancel; the model keeps
\* the file and leaves the episode to you.
YouPickByHand(e) ==
  /\ run[e] = "waiting"
  /\ files[e] = 0
  /\ run' = [run EXCEPT ![e] = "saved"]
  /\ files' = [files EXCEPT ![e] = 1]
  /\ UNCHANGED <<sure, bulk, todo, saving, lateWrite>>

\* You skip subtitles for the pack. Every running search and download of the
\* pack is cancelled.
YouSkip ==
  /\ \E e \in Episodes : run[e] \in {"searching", "waiting"}
  /\ run' = [e \in Episodes |-> IF run[e] \in {"searching", "waiting"} THEN "skipped" ELSE run[e]]
  /\ saving' = IF DESIGN = "noRecheck" THEN saving ELSE {}
  /\ UNCHANGED <<sure, bulk, todo, files, lateWrite>>

\* Nothing left to happen.
Done ==
  /\ bulk = "idle"
  /\ \A e \in Episodes : run[e] \in {"saved", "skipped"} \/ (run[e] = "waiting" /\ ~sure[e])
  /\ UNCHANGED vars

Next ==
  \/ \E e \in Episodes, o \in {"fits", "sure", "close"} : SearchEnds(e, o)
  \/ YouTapUseBestMatch
  \/ \E e \in Episodes : BulkStarts(e) \/ BulkSaveEnds(e) \/ YouPickByHand(e)
  \/ BulkEnds
  \/ YouSkip
  \/ Done

Spec == Init /\ [][Next]_vars

\* Rules: each one is an invariant, true in every state TLC can reach.

\* An episode never gets two subtitle files on its own; a second one needs your Keep both.
OneFilePerEpisode == \A e \in Episodes : files[e] <= 1

\* After you skip the pack, the bulk writes nothing more for it.
NothingSavedAfterSkip == ~lateWrite

\* The bulk works only on episodes whose own search has ended: never one still searching.
OnlyFinishedEpisodes == \A e \in saving : run[e] # "searching"
=============================================================================
