---------------------------- MODULE SubtitleSearch ----------------------------
(* The one-video subtitle sheet ("Find subtitles"): many sources are asked at
   once, their rows show as each one answers, and you pick a row and download
   it while the others are still being asked.

   One search asks every source in parallel (utils/subtitles/search.ts). Each
   source that answers adds rows; the model gives it one row, named after the
   source. A late row may be ranked above the rows already shown, so the list
   can reorder under your finger. A pick goes: downloading (the network),
   saving (the native write next to the video), and then saved (the sheet
   closes with a toast), a name question (Replace, Keep both, Cancel) or an
   error with the list still there.

   Two sources, two videos and two searches are enough: the bugs come from a
   late answer, a new search or a close landing in the middle of a pick, not
   from many sources. *)

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Sources,      \* the sources one search asks, e.g. {"s1", "s2"}
  Videos,       \* videos the sheet can open for, e.g. {"A", "B"}
  MaxSearches,  \* how many searches TLC lets you start (opening the sheet starts one)
  DESIGN        \* "streams" (SubtitleSearch.cfg), "today", "waitsForAll", "byIndex" or "pickSurvives"

None == "none"
\* No selection, in the form the design stores it.
NoSel == IF DESIGN = "byIndex" THEN 0 ELSE None
Searches == 1..MaxSearches
\* A pick in these states is still running: the list is hidden or locked.
InFlight == {"downloading", "saving", "nameQuestion"}

VARIABLES
  sheet,        \* "open" or "closed"
  video,        \* the video the sheet is open for, None while closed
  search,       \* the number of the current search, 0 before the first
  searchVideo,  \* [Searches -> Videos \cup {None}]: the video each search was for
  src,          \* [Sources -> state] in the current search: "asking", "row" (answered with rows),
                \* "nothing" (answered empty, timed out or failed) or "stopped" (the search was cancelled)
  seen,         \* [Sources -> state]: what the sheet shows for each source (its rows, "Asked n of N")
  shown,        \* the rows on screen, in order (a sequence of source names)
  tapped,       \* the row you tapped last in this search, or None (what you meant to pick)
  sel,          \* the selection as the sheet stores it: a row name or None; in "byIndex" a position, 0 for none
  pick,         \* "idle", "downloading", "saving", "nameQuestion" or "failed" (the list with an error line)
  pickRow,      \* the row being downloaded or saved, or None
  pickSearch,   \* the search the pick was made in
  pickVideo,    \* the video the pick was made for
  lateSaves,    \* set of <<video, search>>: saves already handed to the phone when the sheet closed;
                \* they finish on their own and mark the video's card
  saved         \* set of <<video, search>>: subtitles written next to a video

vars == <<sheet, video, search, searchVideo, src, seen, shown, tapped, sel, pick, pickRow, pickSearch, pickVideo, lateSaves, saved>>

SourceStates == {"asking", "row", "nothing", "stopped"}
Range(q) == {q[i] : i \in 1..Len(q)}
IndexOf(q, r) == CHOOSE i \in 1..Len(q) : q[i] = r

TypeOK ==
  /\ sheet \in {"open", "closed"}
  /\ video \in Videos \cup {None}
  /\ search \in 0..MaxSearches
  /\ searchVideo \in [Searches -> Videos \cup {None}]
  /\ src \in [Sources -> SourceStates]
  /\ seen \in [Sources -> SourceStates]
  /\ shown \in Seq(Sources)
  /\ tapped \in Sources \cup {None}
  /\ IF DESIGN = "byIndex" THEN sel \in 0..Cardinality(Sources) ELSE sel \in Sources \cup {None}
  /\ pick \in {"idle", "failed"} \cup InFlight
  /\ pickRow \in Sources \cup {None}
  /\ pickSearch \in 0..MaxSearches
  /\ pickVideo \in Videos \cup {None}
  /\ lateSaves \subseteq (Videos \X Searches)
  /\ saved \subseteq (Videos \X Searches)

\* The row the sheet would download now. "byIndex" keeps a position, so the row
\* at that position may have changed since you tapped.
SelRow == IF DESIGN = "byIndex"
            THEN IF sel \in 1..Len(shown) THEN shown[sel] ELSE None
            ELSE sel

\* No pick is running: the list is on screen and answers to taps.
Free == sheet = "open" /\ pick \in {"idle", "failed"}

\* When a tap on a row is accepted. "waitsForAll" is the behaviour the bug
\* report describes: rows show, but taps count only once every source is done.
TapAllowed == Free /\ (DESIGN = "waitsForAll" => \A s \in Sources : seen[s] # "asking")

\* Whether the sheet takes in a source's answer now. Today's sheet drops answers
\* that land while a pick is running (sheetMachine.ts ignored SEARCH_UPDATE
\* outside searching and results), and the search sends each answer once.
Listening == sheet = "open" /\ (DESIGN = "today" => pick \in {"idle", "failed"})

\* The asking sources of the current search are cancelled.
StopAsking == [s \in Sources |-> IF src[s] = "asking" THEN "stopped" ELSE src[s]]

\* A fresh search: every source asked, nothing on screen, nothing chosen.
FreshSearch(v) ==
  /\ search' = search + 1
  /\ searchVideo' = [searchVideo EXCEPT ![search + 1] = v]
  /\ src' = [s \in Sources |-> "asking"]
  /\ seen' = [s \in Sources |-> "asking"]
  /\ shown' = <<>>
  /\ tapped' = None
  /\ sel' = NoSel

Init ==
  /\ sheet = "closed"
  /\ video = None
  /\ search = 0
  /\ searchVideo = [n \in Searches |-> None]
  /\ src = [s \in Sources |-> "stopped"]
  /\ seen = [s \in Sources |-> "stopped"]
  /\ shown = <<>>
  /\ tapped = None
  /\ sel = NoSel
  /\ pick = "idle"
  /\ pickRow = None
  /\ pickSearch = 0
  /\ pickVideo = None
  /\ lateSaves = {}
  /\ saved = {}

\* You open Find subtitles for a video. The sheet searches at once.
\* "pickSurvives" keeps a pick that was running when the sheet last closed.
YouOpen(v) ==
  /\ sheet = "closed"
  /\ search < MaxSearches
  /\ sheet' = "open"
  /\ video' = v
  /\ FreshSearch(v)
  /\ IF DESIGN = "pickSurvives"
       THEN UNCHANGED <<pick, pickRow, pickSearch, pickVideo>>
       ELSE /\ pick' = "idle" /\ pickRow' = None
            /\ UNCHANGED <<pickSearch, pickVideo>>
  /\ UNCHANGED <<lateSaves, saved>>

\* A source answers. With rows, its row goes above the rows shown (it ranks
\* higher) or below them; TLC tries both. Answers of a closed sheet's search go
\* nowhere.
SourceAnswers(s, hasRow, above) ==
  /\ src[s] = "asking"
  /\ src' = [src EXCEPT ![s] = IF hasRow THEN "row" ELSE "nothing"]
  /\ IF Listening
       THEN /\ seen' = src'
            /\ shown' = IF ~hasRow THEN shown
                        ELSE IF above THEN <<s>> \o shown ELSE Append(shown, s)
       ELSE UNCHANGED <<seen, shown>>
  \* "byIndex" keeps the position, so nothing else moves; by name, nothing moves either.
  /\ UNCHANGED <<sheet, video, search, searchVideo, tapped, sel, pick, pickRow, pickSearch, pickVideo, lateSaves, saved>>

\* You tap a row on screen. A tap after a failed pick clears its error line.
YouTapRow(r) ==
  /\ TapAllowed
  /\ r \in Range(shown)
  /\ tapped' = r
  /\ sel' = IF DESIGN = "byIndex" THEN IndexOf(shown, r) ELSE r
  /\ pick' = "idle"
  /\ UNCHANGED <<sheet, video, search, searchVideo, src, seen, shown, pickRow, pickSearch, pickVideo, lateSaves, saved>>

\* You tap Download subtitle. The pick belongs to this search and this video.
\* The search goes on: the sources still asking keep answering.
YouTapDownload ==
  /\ Free
  /\ SelRow # None
  /\ pick' = "downloading"
  /\ pickRow' = SelRow
  /\ pickSearch' = search
  /\ pickVideo' = video
  /\ UNCHANGED <<sheet, video, search, searchVideo, src, seen, shown, tapped, sel, lateSaves, saved>>

\* The source sends the file, or fails (an expired link, a timeout, a bot check).
DownloadEnds(ok) ==
  /\ pick = "downloading"
  /\ pick' = IF ok THEN "saving" ELSE "failed"
  /\ pickRow' = IF ok THEN pickRow ELSE None
  /\ UNCHANGED <<sheet, video, search, searchVideo, src, seen, shown, tapped, sel, pickSearch, pickVideo, lateSaves, saved>>

\* The phone writes the subtitle next to the video: saved, the name is taken, or
\* the write fails. A save closes the sheet with a toast. The shipped sheet then
\* cancels the sources still asking; today's sheet left them running.
\* "pickSurvives" writes for whatever video the sheet shows now.
SaveEnds(result) ==
  /\ pick = "saving"
  /\ CASE result = "saved" ->
            /\ saved' = saved \cup {<<IF DESIGN = "pickSurvives" /\ video # None THEN video ELSE pickVideo, pickSearch>>}
            /\ sheet' = "closed"
            /\ video' = None
            /\ src' = IF DESIGN = "today" THEN src ELSE StopAsking
            /\ pick' = "idle"
            /\ pickRow' = None
       [] result = "taken" ->
            /\ pick' = "nameQuestion"
            /\ UNCHANGED <<saved, sheet, video, src, pickRow>>
       [] OTHER ->
            /\ pick' = "failed"
            /\ pickRow' = None
            /\ UNCHANGED <<saved, sheet, video, src>>
  /\ UNCHANGED <<search, searchVideo, seen, shown, tapped, sel, pickSearch, pickVideo, lateSaves>>

\* The name is taken: Replace or Keep both writes again; Cancel goes back to the list.
YouAnswerNameQuestion(write) ==
  /\ pick = "nameQuestion"
  /\ pick' = IF write THEN "saving" ELSE "idle"
  /\ pickRow' = IF write THEN pickRow ELSE None
  /\ UNCHANGED <<sheet, video, search, searchVideo, src, seen, shown, tapped, sel, pickSearch, pickVideo, lateSaves, saved>>

\* You start a new search: a typed name, Use file name, Retry, or coming back
\* from Settings with other sources on. The old search is cancelled. The
\* shipped sheet allows it only while no pick runs (the pencil and the tabs are
\* off during a pick). "pickSurvives" allows it any time and keeps the pick.
YouSearchAgain ==
  /\ sheet = "open"
  /\ search < MaxSearches
  /\ DESIGN = "pickSurvives" \/ Free
  /\ FreshSearch(video)
  /\ IF DESIGN = "pickSurvives"
       THEN UNCHANGED <<pick, pickRow>>
       ELSE pick' = "idle" /\ pickRow' = None
  /\ UNCHANGED <<sheet, video, pickSearch, pickVideo, lateSaves, saved>>

\* You close the sheet: the X, Back, a swipe down, a tap outside, Not now.
\* The search is cancelled. A download still on the network is dropped; a save
\* already handed to the phone can't be stopped, so it finishes for its own
\* video. "pickSurvives" keeps the pick as it is.
YouClose ==
  /\ sheet = "open"
  /\ sheet' = "closed"
  /\ video' = None
  /\ src' = StopAsking
  /\ IF DESIGN = "pickSurvives"
       THEN UNCHANGED <<pick, pickRow, lateSaves>>
       ELSE /\ lateSaves' = IF pick = "saving" THEN lateSaves \cup {<<pickVideo, pickSearch>>} ELSE lateSaves
            /\ pick' = "idle"
            /\ pickRow' = None
  /\ UNCHANGED <<search, searchVideo, seen, shown, tapped, sel, pickSearch, pickVideo, saved>>

\* A save that outlived its sheet ends: written, or not.
LateSaveEnds(x, ok) ==
  /\ x \in lateSaves
  /\ lateSaves' = lateSaves \ {x}
  /\ saved' = IF ok THEN saved \cup {x} ELSE saved
  /\ UNCHANGED <<sheet, video, search, searchVideo, src, seen, shown, tapped, sel, pick, pickRow, pickSearch, pickVideo>>

\* Nothing more is allowed to happen (every search used up).
Done ==
  /\ sheet = "closed"
  /\ search = MaxSearches
  /\ UNCHANGED vars

Next ==
  \/ \E v \in Videos : YouOpen(v)
  \/ \E s \in Sources, hasRow \in BOOLEAN, above \in BOOLEAN : SourceAnswers(s, hasRow, above)
  \/ \E r \in Sources : YouTapRow(r)
  \/ YouTapDownload
  \/ \E ok \in BOOLEAN : DownloadEnds(ok)
  \/ \E result \in {"saved", "taken", "failed"} : SaveEnds(result)
  \/ \E write \in BOOLEAN : YouAnswerNameQuestion(write)
  \/ YouSearchAgain
  \/ YouClose
  \/ \E x \in lateSaves, ok \in BOOLEAN : LateSaveEnds(x, ok)
  \/ Done

Spec == Init /\ [][Next]_vars

\* Rules: each one is an invariant, true in every state TLC can reach.

\* Any row on screen can be tapped whenever no pick is running, whatever the other sources are doing.
PickableWhenShown == Free => \A r \in Range(shown) : TapAllowed

\* Once no pick is running, the sheet shows what every source has said: no answer that came in is
\* missing from the list, and a source that finished never still counts as being asked.
NothingFoundIsLost == Free => seen = src

\* A row you tapped stays on screen and stays the one chosen, however the list reorders as sources answer.
ResultsNeverDisappear == (sheet = "open" /\ tapped # None) => (tapped \in Range(shown) /\ SelRow = tapped)

\* The row being downloaded is the row you tapped.
PickIsWhatYouTapped == (sheet = "open" /\ pick \in InFlight /\ pickSearch = search) => pickRow = tapped

\* A running pick always belongs to the search and the video on screen: a new search or a reopened
\* sheet never inherits one.
NoStalePick == (sheet = "open" /\ pick \in InFlight) => (pickSearch = search /\ pickVideo = video)

\* Every subtitle is written next to the video its search was for.
SavedToItsVideo == \A x \in saved : searchVideo[x[2]] = x[1]

\* One pick at a time: while a pick runs, no row can be tapped and no second download starts, and
\* one search saves at most one subtitle (a second copy only through Keep both, which rewrites the same pick).
OnePickAtATime ==
  /\ pick \in InFlight => ~TapAllowed
  /\ \A n \in Searches : Cardinality({x \in saved : x[2] = n}) <= 1

\* A pick never stops the search: the sources still being asked go on answering.
SearchGoesOnDuringPick == (sheet = "open" /\ pick \in InFlight) => \A s \in Sources : src[s] # "stopped"

\* A closed sheet asks no source, so it costs no data and no late answer can reach the next sheet.
QuietAfterClose == sheet = "closed" => \A s \in Sources : src[s] # "asking"
=============================================================================
