-------------------------- MODULE WatchRiskySources --------------------------
(* A watch re-runs a search in the background (utils/watch/task.ts) and posts
   "<title> is up" when a new copy shows up (utils/watch/cycle.ts). Some search
   sources are known for fake or malware uploads (a provider's unsafeReason).
   Search marks a result "Risky source" when every source behind it is one of
   them, and asks before adding it.

   The model follows one new copy from the moment it appears until you download
   it or let it go. The question: can that copy reach a download without you
   ever seeing the warning Search would have shown?

   The notification's buttons are routes (maglev://search?..., maglev://add-
   torrent?...) that go through the one-shot store (ShareHandoff.kt), which is
   on disk, so a route survives Android closing Maglev before it reads it. *)

CONSTANTS
  DESIGN      \* "shipped" (WatchRiskySources.cfg), "today" (Today.cfg),
              \* "memoryOnly" (MemoryOnly.cfg) or "ignoresTrusted" (IgnoresTrusted.cfg)

VARIABLES
  kind,         \* the new copy: "none" (not up yet), "safe" (at least one source not known for fakes) or "risky"
  trusted,      \* TRUE when its uploader has a trusted status; only a risky source (The Pirate Bay) reports one
  warnUnsafe,   \* Search setting "Warn about risky sources"; on disk
  trustedOnly,  \* Search setting "Trusted uploaders only"; on disk
  allowRisky,   \* Watches setting "Download from risky sources", default off; on disk
  app,          \* Maglev: "closed", "back" (running, not on screen) or "front"
  note,         \* the watch notification: "none" (not posted yet), "posted", or "gone" (tapped or dismissed)
  noteDownload, \* TRUE when the posted notification has a Download button
  noteRisky,    \* TRUE when the notification says "risky source" (and its Download route carries it)
  store,        \* the one-shot store: "empty", "search" or "add"; on disk
  storeRisky,   \* TRUE when the stored add route carries the risky mark; on disk with the route
  memRisky,     \* a risky mark kept in memory instead (the rejected memoryOnly design); lost when Maglev closes
  screen,       \* what Maglev shows: "home", "search" (the watch's title) or "add" (the Add screen); in memory
  addBanner,    \* TRUE when the Add screen shows the "Risky source" banner; in memory
  seenWarning,  \* TRUE once you started a download while a risky-source warning was on screen
  downloaded    \* TRUE once a download of this copy started

vars == <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, app, note, noteDownload, noteRisky,
          store, storeRisky, memRisky, screen, addBanner, seenWarning, downloaded>>

TypeOK ==
  /\ kind \in {"none", "safe", "risky"}
  /\ trusted \in BOOLEAN
  /\ warnUnsafe \in BOOLEAN
  /\ trustedOnly \in BOOLEAN
  /\ allowRisky \in BOOLEAN
  /\ app \in {"closed", "back", "front"}
  /\ note \in {"none", "posted", "gone"}
  /\ noteDownload \in BOOLEAN
  /\ noteRisky \in BOOLEAN
  /\ store \in {"empty", "search", "add"}
  /\ storeRisky \in BOOLEAN
  /\ memRisky \in BOOLEAN
  /\ screen \in {"home", "search", "add"}
  /\ addBanner \in BOOLEAN
  /\ seenWarning \in BOOLEAN
  /\ downloaded \in BOOLEAN

\* What Search does with this copy, for the current settings (app/(tabs)/search.tsx).
\* Search lists it unless "Trusted uploaders only" hides it (utils/search/providers/tpb.ts).
SearchLists == kind # "none" /\ (kind = "safe" \/ trusted \/ ~trustedOnly)
\* Search marks it "Risky source" (riskySources in utils/search/safety.ts).
SearchWarns == warnUnsafe /\ kind = "risky"

\* What the watch's own search keeps, and whether it calls the copy risky.
WatchLists == IF DESIGN = "ignoresTrusted" THEN kind # "none" ELSE SearchLists
WatchMarksRisky == IF DESIGN = "today" THEN FALSE ELSE SearchWarns

Init ==
  /\ kind = "none"
  /\ trusted = TRUE
  /\ warnUnsafe \in BOOLEAN
  /\ trustedOnly \in BOOLEAN
  /\ allowRisky \in BOOLEAN
  /\ app = "closed"
  /\ note = "none"
  /\ noteDownload = FALSE
  /\ noteRisky = FALSE
  /\ store = "empty"
  /\ storeRisky = FALSE
  /\ memRisky = FALSE
  /\ screen = "home"
  /\ addBanner = FALSE
  /\ seenWarning = FALSE
  /\ downloaded = FALSE

\* Someone uploads the copy the watch is waiting for. TLC tries every kind and uploader.
CopyAppears(k, t) ==
  /\ kind = "none"
  /\ kind' = k
  /\ trusted' = t
  /\ UNCHANGED <<warnUnsafe, trustedOnly, allowRisky, app, note, noteDownload, noteRisky,
                 store, storeRisky, memRisky, screen, addBanner, seenWarning, downloaded>>

\* Android runs the watch's background check. It runs in Maglev's process, so a closed Maglev starts without a
\* screen. A copy the watch's search keeps is announced once. With the shipped design a copy only on risky sources
\* gets Download only when "Download from risky sources" is on, and then the notification says so.
WatchChecks ==
  /\ kind # "none"
  /\ note = "none"
  /\ WatchLists
  /\ note' = "posted"
  /\ noteRisky' = WatchMarksRisky
  /\ noteDownload' = IF DESIGN = "today" THEN TRUE ELSE (~WatchMarksRisky \/ allowRisky)
  /\ memRisky' = IF DESIGN = "memoryOnly" THEN WatchMarksRisky ELSE memRisky
  /\ app' = IF app = "closed" THEN "back" ELSE app
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, store, storeRisky, screen, addBanner,
                 seenWarning, downloaded>>

\* You tap the notification, or its Open button: the route to Search for the watch's title goes into the store.
YouTapOpen ==
  /\ note = "posted"
  /\ note' = "gone"
  /\ store' = "search"
  /\ storeRisky' = FALSE
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, app, noteDownload, noteRisky, memRisky,
                 screen, addBanner, seenWarning, downloaded>>

\* You tap Download: the Add screen route goes into the store. In the shipped design the route carries the mark.
YouTapDownload ==
  /\ note = "posted"
  /\ noteDownload
  /\ note' = "gone"
  /\ store' = "add"
  /\ storeRisky' = IF DESIGN \in {"shipped", "ignoresTrusted"} THEN noteRisky ELSE FALSE
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, app, noteDownload, noteRisky, memRisky,
                 screen, addBanner, seenWarning, downloaded>>

YouDismiss ==
  /\ note = "posted"
  /\ note' = "gone"
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, app, noteDownload, noteRisky, store,
                 storeRisky, memRisky, screen, addBanner, seenWarning, downloaded>>

\* Maglev comes to the front with a route waiting (the tap started it, or you opened it from the icon) and opens it
\* once. The Add screen shows the banner when the route, or in the rejected design memory, carries the mark.
MaglevShowsLink ==
  /\ store # "empty"
  /\ app' = "front"
  /\ screen' = store
  /\ addBanner' = (store = "add" /\ (storeRisky \/ memRisky))
  /\ store' = "empty"
  /\ storeRisky' = FALSE
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, note, noteDownload, noteRisky, memRisky,
                 seenWarning, downloaded>>

YouOpenMaglev ==
  /\ store = "empty"
  /\ app # "front"
  /\ app' = "front"
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, note, noteDownload, noteRisky, store,
                 storeRisky, memRisky, screen, addBanner, seenWarning, downloaded>>

YouGoHome ==
  /\ app = "front"
  /\ app' = "back"
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, note, noteDownload, noteRisky, store,
                 storeRisky, memRisky, screen, addBanner, seenWarning, downloaded>>

\* Android closes Maglev whenever it is not on screen. Memory is lost; the store, settings and notification stay.
AndroidKillsMaglev ==
  /\ app = "back"
  /\ app' = "closed"
  /\ screen' = "home"
  /\ addBanner' = FALSE
  /\ memRisky' = FALSE
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, note, noteDownload, noteRisky, store,
                 storeRisky, seenWarning, downloaded>>

\* On the Add screen you tap Start download.
YouStartOnAdd ==
  /\ app = "front"
  /\ screen = "add"
  /\ ~downloaded
  /\ downloaded' = TRUE
  /\ seenWarning' = (seenWarning \/ addBanner)
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, app, note, noteDownload, noteRisky, store,
                 storeRisky, memRisky, screen, addBanner>>

\* In Search you tap Add on the copy. A marked row asks "Add from a risky source?" first.
YouAddFromSearch ==
  /\ app = "front"
  /\ screen = "search"
  /\ SearchLists
  /\ ~downloaded
  /\ downloaded' = TRUE
  /\ seenWarning' = (seenWarning \/ SearchWarns)
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, allowRisky, app, note, noteDownload, noteRisky, store,
                 storeRisky, memRisky, screen, addBanner>>

\* You flip "Download from risky sources" in Settings, Watches. A notification already posted keeps its buttons.
YouFlipSetting ==
  /\ app = "front"
  /\ allowRisky' = ~allowRisky
  /\ UNCHANGED <<kind, trusted, warnUnsafe, trustedOnly, app, note, noteDownload, noteRisky, store, storeRisky,
                 memRisky, screen, addBanner, seenWarning, downloaded>>

Next ==
  \/ \E k \in {"safe", "risky"}, t \in BOOLEAN : CopyAppears(k, t)
  \/ WatchChecks
  \/ YouTapOpen
  \/ YouTapDownload
  \/ YouDismiss
  \/ MaglevShowsLink
  \/ YouOpenMaglev
  \/ YouGoHome
  \/ AndroidKillsMaglev
  \/ YouStartOnAdd
  \/ YouAddFromSearch
  \/ YouFlipSetting

Spec == Init /\ [][Next]_vars

\* Rules: each one is an invariant, true in every state TLC can reach.

\* A copy Search would mark as risky never starts downloading unless its warning was on screen when you started it.
NoSilentRiskyDownload == (downloaded /\ SearchWarns) => seenWarning

\* The watch announces only what Search would list for the same settings, and calls it risky exactly when Search does.
SameRulesAsSearch == note = "posted" => (SearchLists /\ noteRisky = SearchWarns)

\* An Add screen opened for a copy Search would mark as risky shows the banner, even after Android closed Maglev
\* between the notification and the screen.
WarningTravels == (app = "front" /\ screen = "add" /\ SearchWarns) => addBanner
=============================================================================
