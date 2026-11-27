---------------------------- MODULE ShareHandoff ----------------------------
(* How a shared link, a magnet from another app, or a tap on one of Maglev's own
   notifications reaches the right screen, even when Android closes Maglev,
   rebuilds its task, or updates it in between.

   Android keeps a task's start intent and hands it to the app again whenever it
   rebuilds the task. A link sent as the start intent therefore comes back long
   after you dealt with it. The fix keeps each link in a one-shot store instead
   (ShareHandoff.kt): it is read once and then gone, and the app always starts
   from the plain launcher intent.

   DESIGN picks which version of the hand-off to check:
     "startIntent"  Maglev 1.0: every link is the task's start intent.
     "onceAll"      shares and magnets go through the store; it is used only on a
                    plain start, so any real start URL drops it.
     "storeWins"    as onceAll, but at a fresh start a waiting link wins.
     "allStore"     as storeWins, and notification and tile taps go through the
                    store too. This is what the code does.                     *)

CONSTANTS
  Links,   \* links you share into Maglev, e.g. {"a", "b"}
  Mags,    \* magnets you open from a browser, e.g. {"m"}
  Routes,  \* pages a Maglev notification or tile opens, e.g. {"d"}
  DESIGN   \* which hand-off design to check (see above)

None == "none"
Items == Links \cup Mags          \* things that open an Add screen
Handoff == DESIGN # "startIntent" \* shares and magnets go through the store

VARIABLES
  app,         \* "closed", "starting", "front", "back", or "noScreen" (swiped away, a download keeps it running)
  task,        \* TRUE while Android keeps a task for Maglev in Recents
  root,        \* the start intent Android replays when it rebuilds the task: "launcher" or a link
  startUrl,    \* the start URL the opening screen reports, or None for a plain start
  screen,      \* what Maglev shows: None, "transfers", or a link, magnet or route
  store,       \* the one-shot store: what waits to be opened, or None
  done,        \* links and magnets you already finished (pressed Start or Back on)
  owed,        \* the newest thing you opened that Maglev has not shown yet, or None
  cardDue,     \* the What's New card waits for a plain start after an update
  updated,     \* Maglev has been updated once (this keeps the model small)
  cardOnShare  \* the What's New card once opened on top of a shared link's screen

vars == <<app, task, root, startUrl, screen, store, done, owed, cardDue, updated, cardOnShare>>

TypeOK ==
  /\ app \in {"closed", "starting", "front", "back", "noScreen"}
  /\ task \in BOOLEAN
  /\ root \in Items \cup Routes \cup {"launcher"}
  /\ startUrl \in Items \cup Routes \cup {None}
  /\ screen \in Items \cup Routes \cup {None, "transfers"}
  /\ store \in Items \cup Routes \cup {None}
  /\ done \subseteq Items
  /\ owed \in Items \cup Routes \cup {None}
  /\ cardDue \in BOOLEAN /\ updated \in BOOLEAN /\ cardOnShare \in BOOLEAN

Init ==
  /\ app = "closed" /\ task = FALSE /\ root = "launcher" /\ startUrl = None
  /\ screen = None /\ store = None /\ done = {} /\ owed = None
  /\ cardDue = FALSE /\ updated = FALSE /\ cardOnShare = FALSE

\* Maglev is not on screen, so a link from outside starts or resumes it.
Away == {"closed", "back", "noScreen"}

\* The start URL a plain launcher start reports: a task Android rebuilds after
\* Maglev closed replays its root intent.
PlainStartUrl ==
  IF task /\ app = "closed" /\ root # "launcher" THEN root ELSE None

\* Android starts Maglev's screen with this start URL. A new screen starts empty.
Start(url) ==
  /\ app' = "starting" /\ startUrl' = url
  /\ screen' = IF app \in {"closed", "noScreen"} THEN None ELSE screen

\* How x reaches Maglev: kept in the store with a plain start, or as the start intent.
Arrive(x, viaStore) ==
  /\ task' = TRUE
  /\ IF viaStore
       THEN /\ store' = x
            /\ root' = (IF task THEN root ELSE "launcher")
            /\ Start(PlainStartUrl)
       ELSE /\ store' = store
            /\ root' = (IF task THEN root ELSE x)
            /\ Start(x)

\* You share a link from another app. Sharing it again makes it new again.
YouShare(l) ==
  /\ app \in Away /\ owed' = l /\ done' = done \ {l}
  /\ Arrive(l, Handoff)
  /\ UNCHANGED <<cardDue, updated, cardOnShare>>

\* You open a magnet from a browser (a VIEW intent).
YouOpenAMagnet(m) ==
  /\ app \in Away /\ owed' = m /\ done' = done \ {m}
  /\ Arrive(m, Handoff)
  /\ UNCHANGED <<cardDue, updated, cardOnShare>>

\* You tap a Maglev notification or the Quick Settings tile.
YouTapANotification(r) ==
  /\ app \in Away /\ owed' = r
  /\ Arrive(r, DESIGN = "allStore")
  /\ UNCHANGED <<done, cardDue, updated, cardOnShare>>

\* You tap the Maglev icon. Android brings the task back, or starts a new one.
YouTapIcon ==
  /\ app \in Away
  /\ IF ~task
       THEN /\ task' = TRUE /\ root' = "launcher" /\ Start(None)
       ELSE /\ UNCHANGED <<task, root>>
            /\ Start(IF app = "back" \/ root = "launcher" THEN None ELSE root)
  /\ UNCHANGED <<store, done, owed, cardDue, updated, cardOnShare>>

\* Maglev's screen is up and its routing picks what to show.
MaglevOpens ==
  /\ app = "starting"
  /\ LET fresh == screen = None
         fromStore ==
           CASE DESIGN = "startIntent" -> None
             [] DESIGN = "onceAll"     -> IF startUrl = None THEN store ELSE None
             [] OTHER                  -> IF fresh \/ startUrl = None THEN store ELSE None
         target == IF fromStore # None THEN fromStore ELSE startUrl
         plain == target = None
         showCard == fresh /\ plain /\ cardDue
         newScreen == IF target # None THEN target
                      ELSE IF screen = None THEN "transfers" ELSE screen
     IN /\ screen' = newScreen
        /\ store' = IF Handoff THEN None ELSE store  \* read once, then gone
        /\ owed' = IF newScreen = owed THEN None ELSE owed
        /\ cardDue' = IF showCard THEN FALSE ELSE cardDue
        /\ cardOnShare' = (cardOnShare \/ (showCard /\ newScreen \in Items))
  /\ app' = "front"
  /\ UNCHANGED <<task, root, startUrl, done, updated>>

\* You press Start or Back on an Add screen.
YouFinish ==
  /\ app = "front" /\ screen \in Items
  /\ done' = done \cup {screen} /\ screen' = "transfers"
  /\ UNCHANGED <<app, task, root, startUrl, store, owed, cardDue, updated, cardOnShare>>

\* You go to the home screen.
YouGoHome ==
  /\ app = "front" /\ app' = "back"
  /\ UNCHANGED <<task, root, startUrl, screen, store, done, owed, cardDue, updated, cardOnShare>>

\* Android closes Maglev to free memory. The task stays in Recents.
AndroidKillsMaglev ==
  /\ app \in {"back", "starting", "noScreen"}
  /\ app' = "closed" /\ screen' = None
  /\ UNCHANGED <<task, root, startUrl, store, done, owed, cardDue, updated, cardOnShare>>

\* A new version is installed. Maglev closes and the What's New card is due.
MaglevUpdates ==
  /\ ~updated /\ app \in {"back", "closed", "noScreen"}
  /\ updated' = TRUE /\ cardDue' = TRUE /\ app' = "closed" /\ screen' = None
  /\ UNCHANGED <<task, root, startUrl, store, done, owed, cardOnShare>>

\* You swipe Maglev away in Recents. The task goes. A running download may keep
\* the process alive with no screen.
YouSwipeAway ==
  /\ task /\ app \in {"back", "closed"}
  /\ \E keepsRunning \in BOOLEAN :
       app' = IF keepsRunning /\ app = "back" THEN "noScreen" ELSE "closed"
  /\ task' = FALSE /\ screen' = None /\ owed' = None /\ root' = "launcher"
  /\ UNCHANGED <<startUrl, store, done, cardDue, updated, cardOnShare>>

Next ==
  \/ \E l \in Links : YouShare(l)
  \/ \E m \in Mags : YouOpenAMagnet(m)
  \/ \E r \in Routes : YouTapANotification(r)
  \/ YouTapIcon \/ MaglevOpens \/ YouFinish \/ YouGoHome
  \/ AndroidKillsMaglev \/ MaglevUpdates \/ YouSwipeAway

Spec == Init /\ [][Next]_vars

\* A link or magnet you already finished never opens its Add screen again.
NoStaleLink == screen \in Items => screen \notin done

\* When Maglev is in front, it shows the newest thing you opened.
LatestShown == app = "front" => owed = None

\* The What's New card never opens on top of a link you shared.
NoCardOverShare == ~cardOnShare
=============================================================================
