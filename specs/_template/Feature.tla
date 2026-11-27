------------------------------- MODULE Feature -------------------------------
(* Copy this folder to specs/<your-feature>/, rename Feature.tla, Feature.cfg
   and the MODULE line above to match, then replace the example below.
   ForgetsPaused.cfg shows how a rejected design is kept: replace it with your
   own, or delete it.

   The example: downloads you can pause. Android may close Maglev whenever it
   is not on screen, and Maglev restarts the downloads it remembers when it
   opens again. The rule worth checking: a download you paused stays paused. *)

CONSTANTS
  Downloads,  \* a few example downloads; the .cfg sets it, e.g. {"a", "b"}
  DESIGN      \* which design to check: "remembersPaused" (Feature.cfg) or "forgetsPaused" (ForgetsPaused.cfg)

VARIABLES
  app,        \* where Maglev is: "front", "back" or "closed"
  added,      \* downloads you added; saved on disk, so they survive Maglev closing
  paused,     \* downloads you paused; saved on disk too
  running,    \* downloads moving right now; in memory, so gone when Maglev closes
  finished    \* downloads that completed

vars == <<app, added, paused, running, finished>>

\* Every variable holds the kind of value the comments above promise.
TypeOK ==
  /\ app \in {"front", "back", "closed"}
  /\ added \subseteq Downloads
  /\ paused \subseteq Downloads
  /\ running \subseteq Downloads
  /\ finished \subseteq Downloads

Init ==
  /\ app = "front"
  /\ added = {}
  /\ paused = {}
  /\ running = {}
  /\ finished = {}

\* One action per thing a person or Android does. Each says when it can happen
\* (the lines without a prime) and what changes (the primed lines).

YouAdd(d) ==
  /\ app = "front"
  /\ d \notin added
  /\ added' = added \cup {d}
  /\ running' = running \cup {d}
  /\ UNCHANGED <<app, paused, finished>>

YouPause(d) ==
  /\ app = "front"
  /\ d \in running
  /\ running' = running \ {d}
  /\ paused' = paused \cup {d}
  /\ UNCHANGED <<app, added, finished>>

YouResume(d) ==
  /\ app = "front"
  /\ d \in paused
  /\ paused' = paused \ {d}
  /\ running' = running \cup {d}
  /\ UNCHANGED <<app, added, finished>>

DownloadFinishes(d) ==
  /\ d \in running
  /\ running' = running \ {d}
  /\ finished' = finished \cup {d}
  /\ UNCHANGED <<app, added, paused>>

YouGoHome ==
  /\ app = "front"
  /\ app' = "back"
  /\ UNCHANGED <<added, paused, running, finished>>

\* Android can close Maglev whenever it is not on screen. What was in memory is lost.
AndroidKillsMaglev ==
  /\ app = "back"
  /\ app' = "closed"
  /\ running' = {}
  /\ UNCHANGED <<added, paused, finished>>

\* You open Maglev again. After it was closed, it restarts what it remembers.
\* The rejected design forgets which downloads you paused.
YouOpenMaglev ==
  /\ app \in {"back", "closed"}
  /\ LET waiting == IF DESIGN = "forgetsPaused" THEN added \ finished
                    ELSE added \ (paused \cup finished)
     IN running' = IF app = "closed" THEN waiting ELSE running
  /\ app' = "front"
  /\ UNCHANGED <<added, paused, finished>>

Next ==
  \/ \E d \in Downloads : YouAdd(d) \/ YouPause(d) \/ YouResume(d) \/ DownloadFinishes(d)
  \/ YouGoHome
  \/ AndroidKillsMaglev
  \/ YouOpenMaglev

Spec == Init /\ [][Next]_vars

\* Rules: each one is an invariant, true in every state TLC can reach.

\* A download you paused never runs until you resume it.
PausedStaysPaused == running \cap paused = {}

\* When Maglev is on screen, every download you added is running, paused or finished.
NothingLost == app = "front" => added \subseteq (running \cup paused \cup finished)
=============================================================================
