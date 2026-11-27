------------------------------ MODULE StreamJoin ------------------------------
(* Joining a video download's separate video and audio parts into one file.

   Most video-site downloads come as two parts. When both are in, the engine
   waits ("Finishing") until the app has joined them into one mp4 and says so.
   Then the engine marks the download done and deletes the parts.

   The join writes a file of the same size as the two parts together, sample
   by sample. Writing that straight into a shared folder such as
   Download/Maglev is slow, so the design joins into the app's own storage
   first and moves the finished file over. That adds files and steps, and
   Android can close Maglev between any two of them. The rules below must
   hold anyway: nobody sees a half-written file under the real name, the
   parts stay until the joined file is in place, and the engine never calls a
   download done without its file.

   One download is enough: the joins of two downloads use different files and
   never touch each other's. *)

CONSTANTS
  DESIGN  \* "viaWork" (the design that ships), "directOnly" (Maglev 1.1),
          \* "muxIntoFinal" or "deletePartsEarly" (both rejected)

VARIABLES
  app,      \* "up" or "closed"
  engine,   \* the engine's record, saved on disk: "finishing", "done" or "failed"
  parts,    \* the video and audio parts in the save folder: "present" or "gone"
  work,     \* the join file in the app's own storage: "none", "partial" or "complete"
  destTmp,  \* the temporary name in the save folder (<name>.mux.tmp): "none", "partial" or "complete"
  final,    \* the file under its real name in the save folder: "none", "partial" or "complete"
  job,      \* the app's join job, in memory, so gone when Maglev closes:
            \* "idle", "claimed", "muxing", "copying", "placing" or "telling"
  route     \* where this job joins, in memory: "work" (app storage) or "direct" (the save folder)

vars == <<app, engine, parts, work, destTmp, final, job, route>>

Files == {"none", "partial", "complete"}

TypeOK ==
  /\ app \in {"up", "closed"}
  /\ engine \in {"finishing", "done", "failed"}
  /\ parts \in {"present", "gone"}
  /\ work \in Files
  /\ destTmp \in Files
  /\ final \in Files
  /\ job \in {"idle", "claimed", "muxing", "copying", "placing", "telling"}
  /\ route \in {"work", "direct"}

\* Both parts are in and the engine waits for the join.
Init ==
  /\ app = "up"
  /\ engine = "finishing"
  /\ parts = "present"
  /\ work = "none"
  /\ destTmp = "none"
  /\ final = "none"
  /\ job = "idle"
  /\ route = "direct"

\* The app notices the download is waiting and starts a job. It first clears
\* what an earlier, interrupted job of this download left behind. A non-empty
\* file under the real name means an earlier job finished before Maglev was
\* closed, so the job goes straight to telling the engine.
\* With "viaWork" the free-space check picks the route: both answers are tried.
AppClaimsJoin ==
  /\ app = "up"
  /\ engine = "finishing"
  /\ job = "idle"
  /\ work' = "none"
  /\ destTmp' = "none"
  /\ IF final # "none"
       THEN /\ job' = "telling"
            /\ UNCHANGED route
       ELSE /\ job' = "claimed"
            /\ \E room \in BOOLEAN :
                 route' = IF DESIGN \in {"viaWork", "deletePartsEarly"} /\ room THEN "work" ELSE "direct"
  /\ UNCHANGED <<app, engine, parts, final>>

\* The muxer opens its output and starts writing samples.
MuxStarts ==
  /\ app = "up"
  /\ job = "claimed"
  /\ job' = "muxing"
  /\ IF DESIGN = "muxIntoFinal"
       THEN /\ final' = "partial"
            /\ UNCHANGED <<work, destTmp>>
       ELSE IF route = "work"
       THEN /\ work' = "partial"
            /\ UNCHANGED <<destTmp, final>>
       ELSE /\ destTmp' = "partial"
            /\ UNCHANGED <<work, final>>
  /\ UNCHANGED <<app, engine, parts, route>>

\* The muxer stops cleanly: its output is complete.
\* "deletePartsEarly" frees the parts' space at this point.
MuxEnds ==
  /\ app = "up"
  /\ job = "muxing"
  /\ IF DESIGN = "muxIntoFinal"
       THEN /\ final' = "complete"
            /\ job' = "telling"
            /\ UNCHANGED <<work, destTmp>>
       ELSE IF route = "work"
       THEN /\ work' = "complete"
            /\ job' = "copying"
            /\ UNCHANGED <<destTmp, final>>
       ELSE /\ destTmp' = "complete"
            /\ job' = "placing"
            /\ UNCHANGED <<work, final>>
  /\ parts' = IF DESIGN = "deletePartsEarly" /\ route = "work" THEN "gone" ELSE parts
  /\ UNCHANGED <<app, engine, route>>

\* The joined file is copied from app storage to the temporary name in the save folder.
CopyStarts ==
  /\ app = "up"
  /\ job = "copying"
  /\ destTmp = "none"
  /\ destTmp' = "partial"
  /\ UNCHANGED <<app, engine, parts, work, final, job, route>>

\* The copy is complete and synced; the file in app storage is deleted.
CopyEnds ==
  /\ app = "up"
  /\ job = "copying"
  /\ destTmp = "partial"
  /\ destTmp' = "complete"
  /\ work' = "none"
  /\ job' = "placing"
  /\ UNCHANGED <<app, engine, parts, final, route>>

\* One rename in the same folder: the file appears under its real name whole, or not at all.
RenameIntoPlace ==
  /\ app = "up"
  /\ job = "placing"
  /\ final' = destTmp
  /\ destTmp' = "none"
  /\ job' = "telling"
  /\ UNCHANGED <<app, engine, parts, work, route>>

\* The app tells the engine the join is done. The engine checks the file is
\* there, marks the download done and deletes the parts and any temporary name.
EngineHearsDone ==
  /\ app = "up"
  /\ job = "telling"
  /\ final # "none"
  /\ engine' = "done"
  /\ parts' = "gone"
  /\ destTmp' = "none"
  /\ job' = "idle"
  /\ UNCHANGED <<app, work, final, route>>

\* Joining fails (an unreadable part, a full disk). The job deletes what it
\* wrote and tells the engine, which shows the error with Retry.
JoinFails ==
  /\ app = "up"
  /\ job \in {"muxing", "copying", "placing"}
  /\ work' = "none"
  /\ destTmp' = "none"
  /\ final' = IF DESIGN = "muxIntoFinal" THEN "none" ELSE final
  /\ engine' = "failed"
  /\ job' = "idle"
  /\ UNCHANGED <<app, parts, route>>

YouRetry ==
  /\ app = "up"
  /\ engine = "failed"
  /\ engine' = "finishing"
  /\ UNCHANGED <<app, parts, work, destTmp, final, job, route>>

\* Android can close Maglev at any moment, even with a foreground service
\* running (low memory, or you force-stop it). Files stay; the job is lost.
AndroidKillsMaglev ==
  /\ app = "up"
  /\ app' = "closed"
  /\ job' = "idle"
  /\ UNCHANGED <<engine, parts, work, destTmp, final, route>>

MaglevStarts ==
  /\ app = "closed"
  /\ app' = "up"
  /\ UNCHANGED <<engine, parts, work, destTmp, final, job, route>>

Next ==
  \/ AppClaimsJoin
  \/ MuxStarts
  \/ MuxEnds
  \/ CopyStarts
  \/ CopyEnds
  \/ RenameIntoPlace
  \/ EngineHearsDone
  \/ JoinFails
  \/ YouRetry
  \/ AndroidKillsMaglev
  \/ MaglevStarts

Spec == Init /\ [][Next]_vars

\* Rules.

\* Nothing under the real name is ever half written: a gallery, a file
\* manager or the app's own "already joined" check only ever sees a whole file.
NoHalfFileVisible == final # "partial"

\* The parts are deleted only once the joined file is in place under its real name.
NoLostOutput == parts = "gone" => final = "complete"

\* The engine never calls the download done without its file.
DoneMeansFile == engine = "done" => final = "complete"

\* A finished download leaves no temporary files behind.
NoLeftoverWhenDone == engine = "done" => (work = "none" /\ destTmp = "none")
=============================================================================
