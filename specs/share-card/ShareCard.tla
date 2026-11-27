------------------------------ MODULE ShareCard ------------------------------
(* How the share card treats a shared http(s) link that the link text alone can't
   place: its name has no extension on the file list, and it isn't a video site.
   Example: https://proof.ovh.net/files/10Mb.dat.

   The card asks the server once, the same request "Add a link" makes
   (EngineHost.probeUrl), and waits at most 5 s. A file answer gets the file card
   with Download. A page answer, an error or no answer in time gets the page card.

   One shared link per run is enough: each share opens its own card, and cards
   share nothing but the engine. *)

CONSTANTS
  DESIGN      \* "asks" (ShareCard.cfg), "today" (Today.cfg) or "waitsForever" (WaitsForever.cfg)

VARIABLES
  card,       \* what the card shows: "none" (nothing shared yet), "checking", "file", "page" or "closed"
  server,     \* what the server says about the link: "unasked" before the share, then "file", "page" or "error"
  probe,      \* the card's request: "idle", "running" (the card waits for it), "answered", or "dropped"
              \* (the card stopped waiting; the request may still finish, and its answer changes nothing)
  late,       \* TRUE once 5 s have passed while the card said "Checking the link…"
  downloaded  \* TRUE once a download started from this card

vars == <<card, server, probe, late, downloaded>>

TypeOK ==
  /\ card \in {"none", "checking", "file", "page", "closed"}
  /\ server \in {"unasked", "file", "page", "error"}
  /\ probe \in {"idle", "running", "answered", "dropped"}
  /\ late \in BOOLEAN
  /\ downloaded \in BOOLEAN

Init ==
  /\ card = "none"
  /\ server = "unasked"
  /\ probe = "idle"
  /\ late = FALSE
  /\ downloaded = FALSE

\* You share a link with an unknown extension. What the server will answer is
\* fixed now, so TLC tries each answer. Today's card shows the page card at once.
YouShare(s) ==
  /\ card = "none"
  /\ server' = s
  /\ IF DESIGN = "today"
       THEN card' = "page" /\ probe' = "idle"
       ELSE card' = "checking" /\ probe' = "running"
  /\ UNCHANGED <<late, downloaded>>

\* The request comes back. "error" covers a refused or failed request and a
\* blocked network. An answer the card stopped waiting for changes nothing.
ServerAnswers ==
  /\ probe \in {"running", "dropped"}
  /\ IF probe = "running"
       THEN /\ probe' = "answered"
            /\ card' = IF server = "file" THEN "file" ELSE "page"
       ELSE UNCHANGED <<probe, card>>
  /\ UNCHANGED <<server, late, downloaded>>

\* Five seconds pass with no answer. The shipped card stops waiting and shows
\* the page card. The rejected design keeps waiting.
FiveSecondsPass ==
  /\ card = "checking"
  /\ ~late
  /\ late' = TRUE
  /\ IF DESIGN = "waitsForever"
       THEN UNCHANGED <<card, probe>>
       ELSE card' = "page" /\ probe' = "dropped"
  /\ UNCHANGED <<server, downloaded>>

\* You close the card: the X, Back, a tap outside it, "Find videos on this page".
\* Android destroying the card ends the same way.
YouClose ==
  /\ card \in {"checking", "file", "page"}
  /\ card' = "closed"
  /\ probe' = IF probe = "running" THEN "dropped" ELSE probe
  /\ UNCHANGED <<server, late, downloaded>>

\* You tap Download. The card adds the link and closes.
YouTapDownload ==
  /\ card = "file"
  /\ downloaded' = TRUE
  /\ card' = "closed"
  /\ UNCHANGED <<server, probe, late>>

\* The card is gone. Nothing more happens.
Done ==
  /\ card = "closed"
  /\ UNCHANGED vars

Next ==
  \/ \E s \in {"file", "page", "error"} : YouShare(s)
  \/ ServerAnswers
  \/ FiveSecondsPass
  \/ YouClose
  \/ YouTapDownload
  \/ Done

Spec == Init /\ [][Next]_vars

\* Rules: each one is an invariant, true in every state TLC can reach.

\* Download is never offered, or started, for a link the server called a page or didn't answer for.
NoDownloadForPage == (card = "file" \/ downloaded) => server = "file"

\* A closed card waits for nothing, so no late answer can change it or start a download.
QuietAfterClose == card = "closed" => probe # "running"

\* After 5 s the card no longer says "Checking the link…".
NeverStuck == ~(card = "checking" /\ late)

\* A link the server calls a file, within 5 s, is offered as a file.
FileOffered == (card = "page" /\ server = "file") => late
=============================================================================
