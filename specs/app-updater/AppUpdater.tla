----------------------------- MODULE AppUpdater -----------------------------
(* The in-app updater: Maglev checks GitHub for a newer version, downloads the
   APK, checks it, and hands it to Android to install.

   Two parts can do this. The app's own updater (utils/update/index.ts) runs
   while Maglev is open. A daily background job (UpdateCheckWorker.kt) runs
   even when Maglev is closed. Both call the same native download
   (AppUpdater.download), and Android can close Maglev between any two steps.

   A copy of Maglev signed with someone else's key (a CI or pull request
   build, a fork, an F-Droid build installed by hand, an old debug build) can
   never install a release: Android refuses an update signed with a different
   key. Before 1.1.2 Maglev found that out only after downloading 40 to 115 MB,
   and did it again the next day.

   DESIGN picks which version to check:
     "shipped"       Maglev compares its own signer with the release key before
                     anything else, and the background job and the app share
                     one download lock. This is what the code does.
     "today"         Maglev 1.1.1: no signer check before the download, no
                     background job.
     "naiveWorker"   as shipped, but the background job downloads on its own,
                     without the app's lock.
     "trustRestore"  as shipped, but a file downloaded before Maglev closed is
                     installed without checking it again.                     *)

CONSTANTS
  DESIGN   \* "shipped", "today", "naiveWorker" or "trustRestore"

Modes == {"ask", "download", "auto"}
Nets == {"unmetered", "metered", "offline"}

\* What the app's updater shows. "managed": an app store owns updates.
\* "foreignBuild": this copy can't update itself. Installing the update ends
\* in Android replacing Maglev, which closes it, so "done" is not a state here.
UiStates == {"idle", "checking", "upToDate", "checkFailed", "available", "waiting",
             "waitingForWifi", "downloading", "downloadFailed", "ready", "readyAsk",
             "installing", "needsPermission", "needsUser", "installFailed",
             "skipped", "managed", "foreignBuild"}

\* States with nothing left to do: another app updates Maglev, or it can't update itself.
Final == {"managed", "foreignBuild"}

VARIABLES
  signer,      \* who signed the installed copy: "release" or "foreign". Never changes.
  installer,   \* "self" (sideloaded or updated by Maglev) or "store". Never changes.
  assetGood,   \* the release's APK passes the checks when downloaded. Never changes.
  mode,        \* "When an update is found": ask, download or auto. Never changes here.
  app,         \* "front", "back" or "closed" (no app code running)
  ui,          \* the app updater's state; in memory, so gone when Maglev closes
  net,         \* the network: "unmetered", "metered" or "offline"
  released,    \* a newer version is on GitHub
  found,       \* saved on disk: a check found that version (the app's prefs or the job's record)
  skipped,     \* saved on disk: you skipped that version
  file,        \* the APK in the updates folder: "none", "part" or "done" (checked and renamed)
  stale,       \* the file on disk no longer passes the checks (changed, or the app moved past it)
  dl,          \* who is writing the file right now: a subset of {"app", "job"}; in memory
  restored,    \* the app's "ready" came from a file left by an earlier run; in memory
  meteredAuto, \* history: a download Maglev started on its own began on a metered or no network
  unverified,  \* history: an install went ahead with a file that fails a check
  restoreSkip  \* history: a restored file was installed without the checks running again

vars == <<signer, installer, assetGood, mode, app, ui, net, released, found, skipped,
          file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

TypeOK ==
  /\ signer \in {"release", "foreign"}
  /\ installer \in {"self", "store"}
  /\ assetGood \in BOOLEAN
  /\ mode \in Modes
  /\ app \in {"front", "back", "closed"}
  /\ ui \in UiStates
  /\ net \in Nets
  /\ released \in BOOLEAN /\ found \in BOOLEAN /\ skipped \in BOOLEAN
  /\ file \in {"none", "part", "done"}
  /\ stale \in BOOLEAN
  /\ dl \subseteq {"app", "job"}
  /\ restored \in BOOLEAN
  /\ meteredAuto \in BOOLEAN /\ unverified \in BOOLEAN /\ restoreSkip \in BOOLEAN

Init ==
  /\ signer \in {"release", "foreign"}
  /\ installer \in {"self", "store"}
  /\ assetGood \in BOOLEAN
  /\ mode \in Modes
  /\ app = "closed"
  /\ ui = "idle"
  /\ net \in Nets
  /\ released \in BOOLEAN
  /\ found = FALSE /\ skipped = FALSE
  /\ file = "none" /\ stale = FALSE
  /\ dl = {} /\ restored = FALSE
  /\ meteredAuto = FALSE /\ unverified = FALSE /\ restoreSkip = FALSE

Rigid == <<signer, installer, assetGood, mode>>

\* The four checks in AppUpdater.verify: SHA-256, package name, a higher
\* versionCode, and the installed app's signer. A file signed with another key
\* than the installed copy never passes.
Passes == file = "done" /\ ~stale /\ signer = "release" /\ assetGood

\* The foreign-build check before any download (ReleaseSigner.kt).
SignerChecked == DESIGN # "today"

\* What the app shows when it starts (startUpdates).
StartState ==
  IF installer = "store" THEN "managed"
  ELSE IF SignerChecked /\ signer = "foreign" THEN "foreignBuild"
  ELSE IF file = "done" /\ ~stale THEN "ready"           \* a download from before is restored
  ELSE IF found /\ ~skipped THEN "available"            \* a version found before is routed again
  ELSE "idle"

\* AppUpdater.download. A file that already passes returns at once. Otherwise
\* one thread writes; with the shared lock, a second caller joins it.
StartDownload(who, isAuto) ==
  /\ meteredAuto' = (meteredAuto \/ (isAuto /\ net # "unmetered"))
  /\ IF Passes
       THEN UNCHANGED <<dl, file, stale>>
       ELSE /\ dl' = IF dl = {} \/ DESIGN = "naiveWorker" THEN dl \cup {who} ELSE dl
            /\ file' = "part"
            /\ stale' = FALSE

\* The writes that belong to the install. Committing a session runs the checks
\* first, except for a restored file in the trustRestore design.
Install ==
  LET skipsChecks == DESIGN = "trustRestore" /\ restored
      ok == skipsChecks \/ Passes
  IN /\ restoreSkip' = (restoreSkip \/ skipsChecks)
     /\ unverified' = (unverified \/ (ok /\ ~Passes))
     /\ IF ~ok
          THEN \* the checks fail: the file is deleted and the found version forgotten
               /\ ui' = "installFailed" /\ file' = "none" /\ found' = FALSE
               /\ UNCHANGED <<app, released, restored>>
          ELSE \E r \in {"replaced", "needsUser", "needsPermission", "installFailed"} :
                 IF r = "replaced"
                   THEN \* Android replaces Maglev, which closes it
                        /\ app' = "closed" /\ ui' = "idle" /\ released' = FALSE
                        /\ file' = "none" /\ found' = FALSE /\ restored' = FALSE
                   ELSE /\ ui' = r
                        /\ UNCHANGED <<app, released, file, found, restored>>

\* ---- What you do ----------------------------------------------------------

YouOpenMaglev ==
  /\ app \in {"back", "closed"}
  /\ app' = "front"
  /\ IF app = "closed"
       THEN /\ ui' = StartState
            /\ restored' = (StartState = "ready")
            \* A copy that can't update itself, or a version no longer wanted, leaves no file.
            /\ file' = IF StartState \in {"ready", "available"} THEN file ELSE "none"
       ELSE UNCHANGED <<ui, restored, file>>
  /\ UNCHANGED <<Rigid, net, released, found, skipped, stale, dl, meteredAuto, unverified, restoreSkip>>

YouGoHome ==
  /\ app = "front"
  /\ app' = "back"
  /\ UNCHANGED <<Rigid, ui, net, released, found, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

\* Check for updates, by hand or the daily check when Maglev comes to the front.
\* Since 1.1.2 a failed download or install is checked again too, so a file
\* that failed its checks is fetched afresh instead of waiting for a restart.
YouOrMaglevCheck ==
  /\ app = "front"
  /\ ui \in {"idle", "upToDate", "checkFailed", "skipped"} \cup
            (IF DESIGN = "today" THEN {} ELSE {"downloadFailed", "installFailed"})
  /\ ui' = "checking"
  /\ UNCHANGED <<Rigid, app, net, released, found, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

YouTapDownload ==
  /\ app = "front"
  /\ ui \in {"available", "waiting", "waitingForWifi", "downloadFailed"}
  /\ net # "offline"
  /\ ui' = "downloading"
  /\ StartDownload("app", FALSE)
  /\ UNCHANGED <<Rigid, app, net, released, found, skipped, restored, unverified, restoreSkip>>

\* "Later" on a failed download.
YouDismissFailure ==
  /\ app = "front"
  /\ ui = "downloadFailed"
  /\ ui' = "available"
  /\ UNCHANGED <<Rigid, app, net, released, found, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

YouSkip ==
  /\ app = "front"
  /\ ui \in {"available", "waiting", "waitingForWifi", "ready", "readyAsk"} \cup
            (IF DESIGN = "today" THEN {} ELSE {"installFailed", "needsUser", "needsPermission"})
  /\ ui' = "skipped"
  /\ skipped' = TRUE /\ found' = FALSE
  /\ file' = IF dl = {} THEN "none" ELSE file
  /\ restored' = FALSE
  /\ UNCHANGED <<Rigid, app, net, released, stale, dl, meteredAuto, unverified, restoreSkip>>

\* Install on the card. The permission card offers it too, so that state has a way out.
YouTapInstall ==
  /\ app = "front"
  /\ ui \in {"ready", "readyAsk", "installFailed", "needsUser", "needsPermission"}
  /\ Install
  /\ UNCHANGED <<Rigid, net, skipped, stale, dl, meteredAuto>>

\* Install on the "ready" notification while Maglev is not on screen
\* (UpdateInstallReceiver). It runs the same install, checks included. When it
\* doesn't replace Maglev, the notice comes back and the app's state stays.
YouTapInstallOnNotice ==
  /\ app \in {"back", "closed"}
  /\ file = "done" /\ dl = {}
  /\ ui \notin {"managed", "foreignBuild"}
  /\ LET skipsChecks == DESIGN = "trustRestore" /\ restored
         ok == skipsChecks \/ Passes
     IN /\ restoreSkip' = (restoreSkip \/ skipsChecks)
        /\ unverified' = (unverified \/ (ok /\ ~Passes))
        /\ IF ~ok
             THEN /\ file' = "none" /\ found' = FALSE
                  /\ UNCHANGED <<app, ui, released, restored>>
             ELSE \E replaced \in BOOLEAN :
                    IF replaced
                      THEN /\ app' = "closed" /\ ui' = "idle" /\ released' = FALSE
                           /\ file' = "none" /\ found' = FALSE /\ restored' = FALSE
                      ELSE UNCHANGED <<app, ui, released, file, found, restored>>
  /\ UNCHANGED <<Rigid, net, skipped, stale, dl, meteredAuto>>

\* ---- What the app's updater does --------------------------------------------

CheckReturns ==
  /\ app # "closed"
  /\ ui = "checking"
  /\ \E online \in BOOLEAN, byHand \in BOOLEAN :
       /\ ui' = IF ~online \/ net = "offline" THEN "checkFailed"
                ELSE IF ~released THEN "upToDate"
                ELSE IF skipped /\ ~byHand THEN "skipped"
                ELSE "available"
       /\ found' = (ui' = "available")
  /\ UNCHANGED <<Rigid, app, net, released, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

\* routeFound: what mode and network say to do with a version found.
AppRoutes ==
  /\ app # "closed"
  /\ ui = "available"
  /\ IF mode = "ask"
       THEN /\ ui' = "waiting"
            /\ UNCHANGED <<file, stale, dl, meteredAuto>>
       ELSE IF net = "unmetered"
         THEN /\ ui' = "downloading"
              /\ StartDownload("app", TRUE)
         ELSE /\ ui' = "waitingForWifi"
              /\ UNCHANGED <<file, stale, dl, meteredAuto>>
  /\ UNCHANGED <<Rigid, app, net, released, found, skipped, restored, unverified, restoreSkip>>

\* Wi-Fi is back while the app waits for it (a network change event).
WifiReturns ==
  /\ app # "closed"
  /\ ui = "waitingForWifi"
  /\ net = "unmetered"
  /\ ui' = "downloading"
  /\ StartDownload("app", TRUE)
  /\ UNCHANGED <<Rigid, app, net, released, found, skipped, restored, unverified, restoreSkip>>

\* The native download answers the app: right away for a file already there,
\* or when the thread it waits on is done.
AppGetsFile ==
  /\ app # "closed"
  /\ ui = "downloading"
  /\ IF DESIGN = "naiveWorker" THEN "app" \notin dl ELSE dl = {}
  /\ ui' = IF file = "done" THEN "ready" ELSE "downloadFailed"
  \* A file that failed its checks is gone, and so is the version that pointed to it.
  /\ found' = (found /\ file # "none")
  /\ UNCHANGED <<Rigid, app, net, released, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

\* routeReady: auto installs when nothing is transferring; otherwise it asks.
AppRoutesReady ==
  /\ app # "closed"
  /\ ui = "ready"
  /\ \E quiet \in BOOLEAN :
       IF mode = "auto" /\ quiet
         THEN /\ Install
              /\ UNCHANGED <<Rigid, net, skipped, stale, dl, meteredAuto>>
         ELSE /\ ui' = "readyAsk"
              /\ UNCHANGED <<Rigid, app, net, released, found, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

\* Android's own install screen answers (needsUser) or the install fails.
InstallerAnswers ==
  /\ app # "closed"
  /\ ui = "needsUser"
  /\ \E r \in {"replaced", "installFailed"} :
       IF r = "replaced"
         THEN /\ app' = "closed" /\ ui' = "idle" /\ released' = FALSE
              /\ file' = "none" /\ found' = FALSE /\ restored' = FALSE
         ELSE /\ ui' = "installFailed"
              /\ UNCHANGED <<app, released, file, found, restored>>
  /\ UNCHANGED <<Rigid, net, skipped, stale, dl, meteredAuto, unverified, restoreSkip>>

\* Back from "Install unknown apps": the install is sent again.
PermissionReturned ==
  /\ app = "front"
  /\ ui = "needsPermission"
  /\ Install
  /\ UNCHANGED <<Rigid, net, skipped, stale, dl, meteredAuto>>

\* ---- What the background job does ------------------------------------------

\* The daily job (and its one-off run when Wi-Fi comes back). It runs whether
\* Maglev is open or not, never for a store install, and in every design but
\* "today" never for a copy signed with another key. It saves what it found,
\* and in download or auto mode starts the download only on an unmetered network.
JobRuns ==
  /\ DESIGN # "today"
  /\ installer = "self"
  /\ signer = "release"
  /\ net # "offline"
  /\ released /\ ~skipped
  /\ found' = TRUE
  /\ IF mode # "ask" /\ net = "unmetered" /\ "job" \notin dl
       THEN StartDownload("job", TRUE)
       ELSE UNCHANGED <<file, stale, dl, meteredAuto>>
  /\ UNCHANGED <<Rigid, app, ui, net, released, skipped, restored, unverified, restoreSkip>>

\* ---- What happens on its own ----------------------------------------------

\* A writing thread ends: the bytes are all in and checked, or the network dropped.
DownloadEnds(who) ==
  /\ who \in dl
  /\ dl' = dl \ {who}
  /\ \E complete \in BOOLEAN :
       file' = IF ~complete THEN "part"
               ELSE IF signer = "release" /\ assetGood THEN "done"
               ELSE "none"     \* the checks failed: the file is deleted
  /\ stale' = FALSE
  /\ UNCHANGED <<Rigid, app, ui, net, released, found, skipped, restored, meteredAuto, unverified, restoreSkip>>

NetworkChanges ==
  /\ \E n \in Nets \ {net} : net' = n
  /\ UNCHANGED <<Rigid, app, ui, released, found, skipped, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

ReleasePublished ==
  /\ ~released
  /\ released' = TRUE /\ skipped' = FALSE
  /\ UNCHANGED <<Rigid, app, ui, net, found, file, stale, dl, restored, meteredAuto, unverified, restoreSkip>>

\* The file on disk stops passing: you installed a newer version by hand, say.
FileGoesStale ==
  /\ file = "done" /\ ~stale
  /\ stale' = TRUE
  /\ UNCHANGED <<Rigid, app, ui, net, released, found, skipped, file, dl, restored, meteredAuto, unverified, restoreSkip>>

\* Android closes Maglev's process: when it is in the background, or when only
\* the background job keeps it alive. What was in memory is gone.
AndroidKillsMaglev ==
  /\ app = "back" \/ (app = "closed" /\ dl # {})
  /\ app' = "closed"
  /\ ui' = "idle" /\ dl' = {} /\ restored' = FALSE
  /\ UNCHANGED <<Rigid, net, released, found, skipped, file, stale, meteredAuto, unverified, restoreSkip>>

Next ==
  \/ YouOpenMaglev \/ YouGoHome \/ YouOrMaglevCheck \/ YouTapDownload \/ YouDismissFailure
  \/ YouSkip \/ YouTapInstall \/ YouTapInstallOnNotice
  \/ CheckReturns \/ AppRoutes \/ WifiReturns \/ AppGetsFile \/ AppRoutesReady
  \/ InstallerAnswers \/ PermissionReturned
  \/ JobRuns
  \/ \E w \in {"app", "job"} : DownloadEnds(w)
  \/ NetworkChanges \/ ReleasePublished \/ FileGoesStale \/ AndroidKillsMaglev

Spec == Init /\ [][Next]_vars

\* ---- Rules -----------------------------------------------------------------

\* An install goes ahead only with a file that passes all four checks right then.
NeverInstallUnverified == ~unverified

\* A copy signed with another key never downloads an update.
ForeignNeverDownloads == signer = "foreign" => (dl = {} /\ file = "none")

\* A store install never downloads an update either.
ManagedNeverDownloads == installer = "store" => (dl = {} /\ file = "none")

\* Maglev never starts a download on its own on mobile data or with no network.
NoMeteredAutoDownload == ~meteredAuto

\* The app and the background job never write the update at the same time.
OneDownloadAtATime == dl \in {{}, {"app"}, {"job"}}

\* A file left from before Maglev closed is checked again before it is installed.
RestoreNeverSkipsVerify == ~restoreSkip

\* Whatever the updater shows, something can move it on without restarting
\* Maglev: a button, a check, or a download that is still running.
EveryStateHasAnExit ==
  (app = "front" /\ ui \notin Final) =>
    (dl # {} \/ ENABLED (Next /\ ui' # ui /\ app' = "front"))
=============================================================================
