----------------------------- MODULE AutoHandOver -----------------------------
(* Automatic subtitles for one video, and the sheet taking over from them.

   With automatic subtitles on, the runner (components/subtitles/useSubtitleRequests.ts)
   searches every source for a new video and only decides once all of them have
   answered: a result that fits is saved, otherwise the video waits for your pick.
   That can take a while, and before this change the Subtitles row offered only
   Cancel meanwhile, so nothing found so far could be seen or picked.

   Now the row offers the sheet while the runner is queued or searching. Opening
   the sheet hands the video over: the runner's search is cancelled and no new run
   or save starts while the sheet is open. The sheet runs its own search, whose
   rows show as they come. When it closes without a save, the row gets what the
   sheet found.

   Saving a file has two parts: the download, which can be cancelled, and the
   phone writing the file next to the video, which can't. A write already under
   way when the sheet opens, or when it closes, finishes on its own. *)

CONSTANTS
  DESIGN   \* "handOver" (AutoHandOver.cfg), "today", "noAbort" or "noWait"

VARIABLES
  phase,       \* the video's run as the row shows it: "unasked", "queued", "searching",
               \* "needsPick" (rows found, waiting for you), "none" (nothing found) or "saved"
  runner,      \* the runner for this video: "idle", "searching" or "writing" (the phone is writing its file)
  sheet,       \* "closed" or "open"
  found,       \* what the sheet's own search has shown: "nothing" or "rows"
  sheetDone,   \* TRUE once every source of the sheet's search has answered
  pick,        \* the sheet's pick: "idle", "waiting" (for another write to end), "downloading" or "writing"
  lateWrite,   \* TRUE while a write the sheet started is still running after the sheet closed
  autoUnder    \* TRUE once the runner started a save while the sheet was open

vars == <<phase, runner, sheet, found, sheetDone, pick, lateWrite, autoUnder>>

TypeOK ==
  /\ phase \in {"unasked", "queued", "searching", "needsPick", "none", "saved"}
  /\ runner \in {"idle", "searching", "writing"}
  /\ sheet \in {"closed", "open"}
  /\ found \in {"nothing", "rows"}
  /\ sheetDone \in BOOLEAN
  /\ pick \in {"idle", "waiting", "downloading", "writing"}
  /\ lateWrite \in BOOLEAN
  /\ autoUnder \in BOOLEAN

\* The row shows "Getting subtitles…" or "Waiting…": the automatic run is queued or searching.
Auto == phase \in {"queued", "searching"}

\* What the row offers. Before this change, a queued or searching run had only Cancel.
RowOffersSheet == IF DESIGN = "today" THEN ~Auto ELSE TRUE

\* Whether the sheet holds the video, so the runner starts nothing for it.
Holds == DESIGN # "today"

\* A write for this video is running, from the sheet or left over from a closed sheet.
SheetWriting == pick = "writing" \/ lateWrite

Init ==
  /\ phase = "unasked"
  /\ runner = "idle"
  /\ sheet = "closed"
  /\ found = "nothing"
  /\ sheetDone = FALSE
  /\ pick = "idle"
  /\ lateWrite = FALSE
  /\ autoUnder = FALSE

\* A new video arrives with automatic subtitles on: it is queued.
AutoAsks ==
  /\ phase = "unasked"
  /\ phase' = "queued"
  /\ UNCHANGED <<runner, sheet, found, sheetDone, pick, lateWrite, autoUnder>>

\* The runner starts the queued search. It waits while the sheet holds the
\* video and while any write for it is running.
RunnerStarts ==
  /\ phase = "queued" /\ runner = "idle"
  /\ Holds => (sheet = "closed" /\ ~SheetWriting)
  /\ phase' = "searching"
  /\ runner' = "searching"
  /\ UNCHANGED <<sheet, found, sheetDone, pick, lateWrite, autoUnder>>

\* Every source has answered the runner. A result that fits is saved (the
\* write starts); close matches wait for you; nothing found is "none".
RunnerDecides(outcome) ==
  /\ runner = "searching"
  /\ CASE outcome = "fits" ->
            /\ runner' = "writing"
            /\ autoUnder' = (autoUnder \/ sheet = "open")
            /\ UNCHANGED phase
       [] outcome = "close" -> runner' = "idle" /\ phase' = "needsPick" /\ UNCHANGED autoUnder
       [] OTHER -> runner' = "idle" /\ phase' = "none" /\ UNCHANGED autoUnder
  /\ UNCHANGED <<sheet, found, sheetDone, pick, lateWrite>>

\* The phone has written the runner's file.
RunnerWriteEnds ==
  /\ runner = "writing"
  /\ runner' = "idle"
  /\ phase' = "saved"
  /\ UNCHANGED <<sheet, found, sheetDone, pick, lateWrite, autoUnder>>

\* You tap the row's sheet button (Pick now while automatic, Pick one, Change, ...).
\* The shipped sheet cancels the runner's search; "noAbort" leaves it running.
\* A write can't be cancelled, so a runner already writing goes on.
YouOpenSheet ==
  /\ sheet = "closed"
  /\ phase # "unasked"
  /\ RowOffersSheet
  /\ sheet' = "open"
  /\ found' = "nothing"
  /\ sheetDone' = FALSE
  /\ IF DESIGN \in {"handOver", "noWait"} /\ runner = "searching"
       THEN runner' = "idle" /\ phase' = "queued"
       ELSE UNCHANGED <<runner, phase>>
  /\ UNCHANGED <<pick, lateWrite, autoUnder>>

\* The sheet's search shows its first rows, or ends.
SheetFindsRows ==
  /\ sheet = "open" /\ found = "nothing" /\ ~sheetDone
  /\ found' = "rows"
  /\ UNCHANGED <<phase, runner, sheet, sheetDone, pick, lateWrite, autoUnder>>

SheetSearchEnds ==
  /\ sheet = "open" /\ ~sheetDone
  /\ sheetDone' = TRUE
  /\ UNCHANGED <<phase, runner, sheet, found, pick, lateWrite, autoUnder>>

\* You pick a row and tap Download subtitle. The shipped sheet first waits for
\* any other write for this video to end; "noWait" doesn't.
YouTapDownload ==
  /\ sheet = "open" /\ found = "rows" /\ pick = "idle"
  /\ pick' = IF DESIGN = "noWait" THEN "downloading" ELSE "waiting"
  /\ UNCHANGED <<phase, runner, sheet, found, sheetDone, lateWrite, autoUnder>>

OtherWriteEnded ==
  /\ pick = "waiting"
  /\ runner # "writing" /\ ~lateWrite
  /\ pick' = "downloading"
  /\ UNCHANGED <<phase, runner, sheet, found, sheetDone, lateWrite, autoUnder>>

\* The download ends: the phone starts writing, or it failed and the list is back.
SheetDownloadEnds(ok) ==
  /\ pick = "downloading"
  /\ pick' = IF ok THEN "writing" ELSE "idle"
  /\ UNCHANGED <<phase, runner, sheet, found, sheetDone, lateWrite, autoUnder>>

\* The phone has written the sheet's file: the row is saved and the sheet closes.
SheetWriteEnds ==
  /\ pick = "writing"
  /\ pick' = "idle"
  /\ phase' = "saved"
  /\ sheet' = "closed"
  /\ UNCHANGED <<runner, found, sheetDone, lateWrite, autoUnder>>

\* You close the sheet without a save. The shipped sheet hands the video back:
\* a run it took over becomes what the sheet found (rows: waiting for your pick;
\* every source done with nothing: none; closed early with nothing: queued, so
\* the runner tries again). A write already under way finishes on its own.
YouCloseSheet ==
  /\ sheet = "open"
  /\ sheet' = "closed"
  /\ lateWrite' = (lateWrite \/ pick = "writing")
  /\ pick' = "idle"
  /\ phase' = IF Holds /\ Auto /\ runner = "idle"
                THEN IF found = "rows" THEN "needsPick" ELSE IF sheetDone THEN "none" ELSE "queued"
                ELSE phase
  /\ UNCHANGED <<runner, found, sheetDone, autoUnder>>

\* A write that outlived its sheet ends.
LateWriteEnds ==
  /\ lateWrite
  /\ lateWrite' = FALSE
  /\ phase' = "saved"
  /\ UNCHANGED <<runner, sheet, found, sheetDone, pick, autoUnder>>

\* Nothing more happens.
Done ==
  /\ runner = "idle" /\ sheet = "closed" /\ ~lateWrite
  /\ UNCHANGED vars

Next ==
  \/ AutoAsks
  \/ RunnerStarts
  \/ \E o \in {"fits", "close", "nothing"} : RunnerDecides(o)
  \/ RunnerWriteEnds
  \/ YouOpenSheet
  \/ SheetFindsRows
  \/ SheetSearchEnds
  \/ YouTapDownload
  \/ OtherWriteEnded
  \/ \E ok \in BOOLEAN : SheetDownloadEnds(ok)
  \/ SheetWriteEnds
  \/ YouCloseSheet
  \/ LateWriteEnds
  \/ Done

Spec == Init /\ [][Next]_vars

\* Rules: each one is an invariant, true in every state TLC can reach.

\* While the automatic run is queued or searching, the row offers the sheet, so what is found can be picked.
PickableWhileAuto == (Auto /\ sheet = "closed") => RowOffersSheet

\* The runner and the sheet never write a subtitle for the video at the same time.
OneWriter == ~(runner = "writing" /\ SheetWriting)

\* The runner never starts a save while the sheet is open for the video.
NoAutoSaveUnderSheet == ~autoUnder

\* After the sheet closes, the row says "Getting subtitles…" only while a run is really going,
\* and "Waiting" only when the runner is free to start one or a write is about to end.
NoStuckGetting ==
  sheet = "closed" =>
    /\ (phase = "searching" => runner \in {"searching", "writing"})
    /\ (phase = "queued" => (runner = "idle" \/ runner = "writing"))
=============================================================================
