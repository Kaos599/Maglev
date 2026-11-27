--------------------------- MODULE ServiceRestart ---------------------------
(* Models the background foreground service, EngineHost lifecycle and headless
   restart rules across process death:
     - MaglevTorrentService.kt (START_STICKY, notification actions)
     - MaglevTileService.kt (Quick Settings tile Pause all / Resume all)
     - EngineHost.kt (lifecycleLock, shutdownEpoch, driveService, headlessStart,
       engineReadyForAction, setWanted)
     - RestartPolicy.kt (RestartPolicy.decide)

   After Android kills the process, a sticky restart, a schedule alarm, a
   Shut down tap, and a notification/tile Pause all or Resume all tap can race.
   The rules below ensure a user shutdown stays stopped headlessly, Pause all
   stays stopped after process death, a schedule hold keeps the service down,
   and no orphan foreground service stays up without an engine. *)

CONSTANTS
  DESIGN  \* "fixed", "holdClearsPaused", "noEpochGuard", or "noIntentFlags"

VARIABLES
  process,        \* "alive" or "dead"
  app,            \* "front", "back" or "closed"
  engine,         \* "stopped" or "running" (EngineHost.initialized)
  service,        \* "stopped" or "foreground" (MaglevTorrentService)
  hasActive,      \* persisted: any downloading / seeding / queued / resolving transfer
  hasRulePaused,  \* persisted: any transfer paused by a governance rule (Wi-Fi, VPN, battery, offline, ...)
  hasUserPaused,  \* persisted: any transfer paused by the user
  hasSchedPaused, \* persisted: any transfer paused by the schedule
  wanted,         \* persisted KEY_WANTED (service_wanted)
  userShutdown,   \* persisted KEY_USER_SHUTDOWN (user_shutdown)
  userPausedAll,  \* persisted KEY_USER_PAUSED_ALL (user_paused_all)
  scheduleHeld,   \* persisted ScheduleManager.isHeld
  holdForPaused,  \* in-memory EngineHost.holdForPaused
  queuedHeadless  \* pending headlessStart coroutine: "none", "fresh", "stale"

vars == <<process, app, engine, service, hasActive, hasRulePaused,
          hasUserPaused, hasSchedPaused, wanted, userShutdown,
          userPausedAll, scheduleHeld, holdForPaused, queuedHeadless>>

TypeOK ==
  /\ process \in {"alive", "dead"}
  /\ app \in {"front", "back", "closed"}
  /\ engine \in {"stopped", "running"}
  /\ service \in {"stopped", "foreground"}
  /\ hasActive \in BOOLEAN
  /\ hasRulePaused \in BOOLEAN
  /\ hasUserPaused \in BOOLEAN
  /\ hasSchedPaused \in BOOLEAN
  /\ wanted \in BOOLEAN
  /\ userShutdown \in BOOLEAN
  /\ userPausedAll \in BOOLEAN
  /\ scheduleHeld \in BOOLEAN
  /\ holdForPaused \in BOOLEAN
  /\ queuedHeadless \in {"none", "fresh", "stale"}

RealWork == hasActive \/ hasRulePaused

Init ==
  /\ process = "alive"
  /\ app = "front"
  /\ engine = "running"
  /\ service = "stopped"
  /\ hasActive = FALSE
  /\ hasRulePaused = FALSE
  /\ hasUserPaused = FALSE
  /\ hasSchedPaused = FALSE
  /\ wanted = FALSE
  /\ userShutdown = FALSE
  /\ userPausedAll = FALSE
  /\ scheduleHeld = FALSE
  /\ holdForPaused = FALSE
  /\ queuedHeadless = "none"

\* The user adds a transfer or resumes one in the app (setWanted(true) clears stop flags).
YouAddWork ==
  /\ process = "alive"
  /\ app = "front"
  /\ ~hasActive
  /\ engine' = "running"
  /\ hasActive' = TRUE
  /\ service' = "foreground"
  /\ wanted' = TRUE
  /\ userShutdown' = FALSE
  /\ userPausedAll' = FALSE
  /\ scheduleHeld' = FALSE
  /\ holdForPaused' = FALSE
  /\ UNCHANGED <<process, app, hasRulePaused, hasUserPaused, hasSchedPaused, queuedHeadless>>

\* All active transfers finish while the engine is running.
WorkFinishes ==
  /\ process = "alive"
  /\ engine = "running"
  /\ hasActive
  /\ LET nextReal == hasRulePaused
         nextHold == holdForPaused /\ hasUserPaused
         nextWanted == IF DESIGN = "holdClearsPaused"
                       THEN nextReal \/ nextHold \/ hasSchedPaused
                       ELSE nextReal \/ hasSchedPaused
     IN /\ hasActive' = FALSE
        /\ wanted' = nextWanted
        /\ service' = IF nextReal \/ nextHold THEN "foreground"
                      ELSE IF queuedHeadless /= "none" THEN service
                      ELSE "stopped"
        /\ holdForPaused' = nextHold
  /\ UNCHANGED <<process, app, engine, hasRulePaused, hasUserPaused, hasSchedPaused,
                 userShutdown, userPausedAll, scheduleHeld, queuedHeadless>>

\* A governance rule (Wi-Fi only, VPN, battery, offline) pauses active work.
\* Rule-paused transfers still count as real work so the service stays up to auto-resume.
RulePausesWork ==
  /\ process = "alive"
  /\ engine = "running"
  /\ hasActive
  /\ ~hasRulePaused
  /\ hasActive' = FALSE
  /\ hasRulePaused' = TRUE
  /\ UNCHANGED <<process, app, engine, service, hasUserPaused, hasSchedPaused,
                 wanted, userShutdown, userPausedAll, scheduleHeld, holdForPaused, queuedHeadless>>

\* The blocking governance rule clears and rule-paused work resumes.
RuleClearsWork ==
  /\ process = "alive"
  /\ engine = "running"
  /\ hasRulePaused
  /\ hasRulePaused' = FALSE
  /\ hasActive' = TRUE
  /\ UNCHANGED <<process, app, engine, service, hasUserPaused, hasSchedPaused,
                 wanted, userShutdown, userPausedAll, scheduleHeld, holdForPaused, queuedHeadless>>

\* The user leaves Maglev for the home screen or another app.
YouGoHome ==
  /\ process = "alive"
  /\ app = "front"
  /\ app' = "back"
  /\ UNCHANGED <<process, engine, service, hasActive, hasRulePaused, hasUserPaused,
                 hasSchedPaused, wanted, userShutdown, userPausedAll, scheduleHeld,
                 holdForPaused, queuedHeadless>>

\* The user opens Maglev: EngineHost.init starts the engine and onForeground drops holdForPaused.
\* Opening the app does NOT clear user_shutdown (only setWanted(true) when real work exists does).
YouOpenApp ==
  /\ app \in {"back", "closed"}
  /\ process' = "alive"
  /\ app' = "front"
  /\ engine' = "running"
  /\ holdForPaused' = FALSE
  /\ service' = IF RealWork THEN "foreground"
                ELSE IF queuedHeadless /= "none" THEN service
                ELSE "stopped"
  /\ UNCHANGED <<hasActive, hasRulePaused, hasUserPaused, hasSchedPaused,
                 wanted, userShutdown, userPausedAll, scheduleHeld, queuedHeadless>>

\* The user taps "Pause all" on the foreground notification or Quick Settings tile.
\* The momentary sticky-restart placeholder (engine = "stopped") has no Pause all button;
\* after process death without shutdown, engineReadyForAction starts the engine first.
YouPauseAllFromNotification ==
  /\ ((process = "alive" /\ service = "foreground" /\ engine = "running")
      \/ (process = "dead" /\ ~userShutdown))
  /\ hasActive
  /\ process' = "alive"
  /\ app' = IF process = "dead" THEN "closed" ELSE app
  /\ engine' = "running"
  /\ service' = "foreground"
  /\ hasActive' = FALSE
  /\ hasUserPaused' = TRUE
  /\ wanted' = FALSE
  /\ userPausedAll' = TRUE
  /\ holdForPaused' = TRUE
  /\ UNCHANGED <<hasRulePaused, hasSchedPaused, userShutdown, scheduleHeld, queuedHeadless>>

\* The user taps "Resume all" on the foreground notification or Quick Settings tile.
\* After process death, engineReadyForAction starts the engine first; poll then calls setWanted(true).
YouResumeAllFromNotification ==
  /\ ((process = "alive" /\ service = "foreground" /\ engine = "running")
      \/ process = "dead")
  /\ hasUserPaused
  /\ process' = "alive"
  /\ app' = IF process = "dead" THEN "closed" ELSE app
  /\ engine' = "running"
  /\ service' = "foreground"
  /\ hasUserPaused' = FALSE
  /\ hasActive' = TRUE
  /\ wanted' = TRUE
  /\ userPausedAll' = FALSE
  /\ userShutdown' = FALSE
  /\ scheduleHeld' = FALSE
  /\ holdForPaused' = FALSE
  /\ UNCHANGED <<hasRulePaused, hasSchedPaused, queuedHeadless>>

\* The 1 s telemetry poll calls EngineHost.driveService(summary).
\* In the rejected "holdClearsPaused" design, holding the notification for a user
\* Pause all counts as wanted = TRUE, which clears user_paused_all.
PollAndDriveService ==
  /\ process = "alive"
  /\ engine = "running"
  /\ LET holdingPaused == (holdForPaused /\ hasUserPaused)
         newWanted == IF DESIGN = "holdClearsPaused"
                      THEN RealWork \/ holdingPaused \/ hasSchedPaused
                      ELSE RealWork \/ hasSchedPaused
     IN /\ wanted' = newWanted
        /\ userPausedAll' = IF newWanted THEN FALSE ELSE userPausedAll
        /\ userShutdown' = IF newWanted THEN FALSE ELSE userShutdown
        /\ scheduleHeld' = IF hasActive /\ service = "foreground" THEN FALSE ELSE scheduleHeld
        /\ service' = IF RealWork \/ holdingPaused THEN "foreground"
                      ELSE IF queuedHeadless /= "none" THEN service
                      ELSE "stopped"
        /\ holdForPaused' = IF ~hasActive /\ ~hasUserPaused THEN FALSE ELSE holdForPaused
  /\ UNCHANGED <<process, app, engine, hasActive, hasRulePaused, hasUserPaused,
                 hasSchedPaused, queuedHeadless>>

\* The schedule window closes and the 10 s grace expires: pause active work, persist scheduleHeld,
\* and stop the service if no rule-paused work or notification hold keeps it up.
SchedulePauses ==
  /\ process = "alive"
  /\ engine = "running"
  /\ hasActive
  /\ ~hasRulePaused
  /\ ~(holdForPaused /\ hasUserPaused)
  /\ hasActive' = FALSE
  /\ hasSchedPaused' = TRUE
  /\ scheduleHeld' = TRUE
  /\ wanted' = TRUE
  /\ service' = "stopped"
  /\ holdForPaused' = FALSE
  /\ UNCHANGED <<process, app, engine, hasRulePaused, hasUserPaused,
                 userShutdown, userPausedAll, queuedHeadless>>

\* The schedule alarm fires (ACTION_SCHEDULE_RESUME): clear scheduleHeld and queue headlessStart.
ScheduleWindowOpens ==
  /\ hasSchedPaused
  /\ scheduleHeld
  /\ process' = "alive"
  /\ app' = IF process = "dead" THEN "closed" ELSE app
  /\ service' = "foreground"
  /\ scheduleHeld' = FALSE
  /\ hasSchedPaused' = FALSE
  /\ hasActive' = TRUE
  /\ queuedHeadless' = "fresh"
  /\ UNCHANGED <<engine, hasRulePaused, hasUserPaused, wanted, userShutdown,
                 userPausedAll, holdForPaused>>

\* The user taps "Shut down" on the notification: bump shutdownEpoch, stop engine and service,
\* close the app task (finishAppTasks), and persist user_shutdown.
YouShutdown ==
  /\ process = "alive"
  /\ service = "foreground"
  /\ app' = "closed"
  /\ engine' = "stopped"
  /\ service' = "stopped"
  /\ wanted' = FALSE
  /\ userShutdown' = TRUE
  /\ holdForPaused' = FALSE
  /\ queuedHeadless' = IF queuedHeadless = "fresh" THEN "stale" ELSE queuedHeadless
  /\ UNCHANGED <<process, hasActive, hasRulePaused, hasUserPaused, hasSchedPaused,
                 userPausedAll, scheduleHeld>>

\* Android kills the process while Maglev is not in front. All in-memory state is lost.
AndroidKillsProcess ==
  /\ process = "alive"
  /\ app /= "front"
  /\ process' = "dead"
  /\ app' = "closed"
  /\ engine' = "stopped"
  /\ service' = "stopped"
  /\ holdForPaused' = FALSE
  /\ queuedHeadless' = "none"
  /\ UNCHANGED <<hasActive, hasRulePaused, hasUserPaused, hasSchedPaused,
                 wanted, userShutdown, userPausedAll, scheduleHeld>>

\* Android restarts the START_STICKY service with a null intent: enterForeground, then queue headlessStart.
AndroidStickyRestart ==
  /\ process = "dead"
  /\ process' = "alive"
  /\ app' = "closed"
  /\ service' = "foreground"
  /\ queuedHeadless' = "fresh"
  /\ UNCHANGED <<engine, hasActive, hasRulePaused, hasUserPaused, hasSchedPaused,
                 wanted, userShutdown, userPausedAll, scheduleHeld, holdForPaused>>

\* The queued EngineHost.headlessStartLocked coroutine acquires lifecycleLock and runs.
RunQueuedHeadless ==
  /\ process = "alive"
  /\ queuedHeadless /= "none"
  /\ IF queuedHeadless = "stale" /\ DESIGN /= "noEpochGuard" THEN
       \* Shutdown happened after this start was queued: never resurrect the engine.
       /\ service' = IF engine = "stopped" THEN "stopped" ELSE service
       /\ queuedHeadless' = "none"
       /\ UNCHANGED <<process, app, engine, hasActive, hasRulePaused, hasUserPaused,
                      hasSchedPaused, wanted, userShutdown, userPausedAll,
                      scheduleHeld, holdForPaused>>
     ELSE IF queuedHeadless = "stale" /\ DESIGN = "noEpochGuard" THEN
       \* Rejected design: without the shutdownEpoch guard, the stale start brings the engine back.
       /\ engine' = "running"
       /\ service' = "foreground"
       /\ queuedHeadless' = "none"
       /\ UNCHANGED <<process, app, hasActive, hasRulePaused, hasUserPaused,
                      hasSchedPaused, wanted, userShutdown, userPausedAll,
                      scheduleHeld, holdForPaused>>
     ELSE
       LET allow == IF DESIGN = "noIntentFlags"
                    THEN (hasActive \/ hasRulePaused \/ hasUserPaused \/ hasSchedPaused)
                    ELSE (~userShutdown /\ ~userPausedAll /\ ~scheduleHeld /\ wanted)
           hasCounted == RealWork \/ hasSchedPaused
       IN IF ~allow THEN
            /\ service' = "stopped"
            /\ queuedHeadless' = "none"
            /\ UNCHANGED <<process, app, engine, hasActive, hasRulePaused, hasUserPaused,
                           hasSchedPaused, wanted, userShutdown, userPausedAll,
                           scheduleHeld, holdForPaused>>
          ELSE
            \* Start the engine, then keep the service only if active, rule-paused, or schedule-paused work exists.
            /\ engine' = "running"
            /\ wanted' = IF hasCounted THEN wanted ELSE FALSE
            /\ service' = IF hasCounted THEN "foreground" ELSE "stopped"
            /\ queuedHeadless' = "none"
            /\ UNCHANGED <<process, app, hasActive, hasRulePaused, hasUserPaused,
                           hasSchedPaused, userShutdown, userPausedAll,
                           scheduleHeld, holdForPaused>>

Next ==
  \/ YouAddWork
  \/ WorkFinishes
  \/ RulePausesWork
  \/ RuleClearsWork
  \/ YouGoHome
  \/ YouOpenApp
  \/ YouPauseAllFromNotification
  \/ YouResumeAllFromNotification
  \/ PollAndDriveService
  \/ SchedulePauses
  \/ ScheduleWindowOpens
  \/ YouShutdown
  \/ AndroidKillsProcess
  \/ AndroidStickyRestart
  \/ RunQueuedHeadless

Spec == Init /\ [][Next]_vars

\* --- Rules (invariants) ---

\* In-memory state is always cleared when the process is dead.
MemoryDiesWithProcess ==
  process = "dead" =>
    (app = "closed" /\ engine = "stopped" /\ service = "stopped"
     /\ ~holdForPaused /\ queuedHeadless = "none")

\* After the user taps Shut down, nothing starts headlessly until the user starts work again
\* (opening the app starts the engine in foreground without clearing user_shutdown).
ShutdownStaysStopped ==
  (userShutdown /\ app = "closed") =>
    (engine = "stopped" /\ (queuedHeadless = "none" => service = "stopped"))

\* After the user taps Pause all with no active, rule-paused or schedule-paused work left,
\* once the notification hold is gone (e.g. after process death), service_wanted must stay FALSE,
\* the service must stay stopped, and a headless restart must never start the engine.
PausedAllStaysStopped ==
  (hasUserPaused /\ ~hasActive /\ ~hasRulePaused /\ ~hasSchedPaused /\ app = "closed" /\ ~holdForPaused) =>
    (~wanted /\ (queuedHeadless = "none" => service = "stopped") /\ (userPausedAll => engine = "stopped"))

\* While the schedule holds transfers (and no other work or notification hold is active),
\* the foreground service does not stay running.
ScheduleHoldStopsService ==
  (scheduleHeld /\ ~RealWork /\ ~(holdForPaused /\ hasUserPaused)) =>
    (queuedHeadless = "none" => service = "stopped")

\* The foreground service never stays up with no running engine once any queued start has finished.
NoOrphanService ==
  (queuedHeadless = "none" /\ service = "foreground") => engine = "running"
=============================================================================
