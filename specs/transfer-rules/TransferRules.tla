--------------------------- MODULE TransferRules ---------------------------
(* Models how governance rules hold and release a transfer across Kotlin and Rust:
     - EngineHost.kt (evaluateGovernance, startup hold, active blocks)
     - scheduler.rs (EXEMPTABLE_TAGS, tag_blocks, plan)
     - engine.rs (pause, resume, resume_anyway, set_transfers_allowed, finish tick)

   Rules are plain strings pushed by Kotlin into Rust's `blocked` set. Some rules
   can be overridden per transfer ("Resume anyway"), safety and physical rules
   never can, `seed_metered` applies only while seeding, `storage_full` applies
   only while downloading, and a user pause always wins over rule changes. *)

CONSTANTS
  DESIGN  \* "shipped", "overrideBypassesAll", "overrideLeaksToSeeding", or "userPauseOverwritten"

Exemptable    == {"wifi_only", "battery", "schedule", "seed_metered"}
NonExemptable == {"vpn_required", "storage_full", "startup"}
AllBlocks     == Exemptable \cup NonExemptable

VARIABLES
  phase,                \* "downloading" or "seeding"
  running,              \* TRUE while librqbit is actively transferring
  userPaused,           \* ground truth: the user paused this transfer and has not resumed it
  pausedBy,             \* persisted meta.paused_by: "none", "user", or a tag in AllBlocks
  allowedAnyway,        \* persisted meta.allowed_anyway ("Resume anyway")
  allowedAnywaySeeding, \* persisted meta.allowed_anyway_seeding (override granted while already seeding)
  blocks                \* active governance tags in Rust's Engine.blocked

vars == <<phase, running, userPaused, pausedBy, allowedAnyway, allowedAnywaySeeding, blocks>>

TypeOK ==
  /\ phase \in {"downloading", "seeding"}
  /\ running \in BOOLEAN
  /\ userPaused \in BOOLEAN
  /\ pausedBy \in ({"none", "user"} \cup AllBlocks)
  /\ allowedAnyway \in BOOLEAN
  /\ allowedAnywaySeeding \in BOOLEAN
  /\ blocks \subseteq AllBlocks

\* Exact Rust tag_blocks(tag, facts) logic from scheduler.rs.
TagBlocks(tag, ph, exempt) ==
  IF tag = "seed_metered" /\ ph /= "seeding" THEN FALSE
  ELSE IF tag = "storage_full" /\ ph /= "downloading" THEN FALSE
  ELSE IF DESIGN = "overrideBypassesAll" THEN ~exempt
  ELSE ~(exempt /\ tag \in Exemptable)

\* Pick one blocking tag from bset that applies to (ph, exempt), or "none".
BlockingTag(bset, ph, exempt) ==
  LET matching == {t \in bset : TagBlocks(t, ph, exempt)}
  IN IF matching = {} THEN "none" ELSE CHOOSE t \in matching : TRUE

\* Reconcile (running', pausedBy') via scheduler.rs plan().
Reconcile(curPausedBy, bset, ph, exempt) ==
  IF curPausedBy = "user" /\ DESIGN /= "userPauseOverwritten" THEN
    [run |-> FALSE, by |-> "user"]
  ELSE
    LET blocker == BlockingTag(bset, ph, exempt)
    IN IF blocker /= "none" THEN
         [run |-> FALSE, by |-> blocker]
       ELSE IF curPausedBy = "user" THEN
         [run |-> FALSE, by |-> "user"]
       ELSE
         [run |-> TRUE, by |-> "none"]

Init ==
  /\ phase = "downloading"
  /\ running = TRUE
  /\ userPaused = FALSE
  /\ pausedBy = "none"
  /\ allowedAnyway = FALSE
  /\ allowedAnywaySeeding = FALSE
  /\ blocks = {}

\* Kotlin pushes a rule block (e.g. mobile data, VPN dropped, low battery, schedule, low storage).
RuleTurnsOn(t) ==
  /\ t \in (AllBlocks \ {"startup"})
  /\ t \notin blocks
  /\ LET nextBlocks == blocks \cup {t}
         res == Reconcile(pausedBy, nextBlocks, phase, allowedAnyway)
     IN /\ blocks' = nextBlocks
        /\ running' = res.run
        /\ pausedBy' = res.by
  /\ UNCHANGED <<phase, userPaused, allowedAnyway, allowedAnywaySeeding>>

\* Kotlin lifts a rule block when the condition clears.
RuleTurnsOff(t) ==
  /\ t \in blocks
  /\ LET nextBlocks == blocks \ {t}
         res == Reconcile(pausedBy, nextBlocks, phase, allowedAnyway)
     IN /\ blocks' = nextBlocks
        /\ running' = res.run
        /\ pausedBy' = res.by
  /\ UNCHANGED <<phase, userPaused, allowedAnyway, allowedAnywaySeeding>>

\* The user pauses the transfer: clears allowed_anyway and sets paused_by = "user".
YouPause ==
  /\ ~userPaused
  /\ userPaused' = TRUE
  /\ pausedBy' = "user"
  /\ running' = FALSE
  /\ allowedAnyway' = FALSE
  /\ allowedAnywaySeeding' = FALSE
  /\ UNCHANGED <<phase, blocks>>

\* The user taps Resume (without override): clears user pause and lets the planner decide.
YouResume ==
  /\ userPaused
  /\ LET res == Reconcile("none", blocks, phase, allowedAnyway)
     IN /\ userPaused' = FALSE
        /\ running' = res.run
        /\ pausedBy' = res.by
  /\ UNCHANGED <<phase, allowedAnyway, allowedAnywaySeeding, blocks>>

\* The user taps "Resume anyway": sets allowed_anyway (and remembers if already seeding), then runs planner.
YouResumeAnyway ==
  /\ ~running
  /\ LET nextSeeding == (phase = "seeding")
         res == Reconcile("none", blocks, phase, TRUE)
     IN /\ userPaused' = FALSE
        /\ allowedAnyway' = TRUE
        /\ allowedAnywaySeeding' = nextSeeding
        /\ running' = res.run
        /\ pausedBy' = res.by
  /\ UNCHANGED <<phase, blocks>>

\* A downloading transfer finishes: engine.rs drops allowed_anyway unless granted while already seeding.
DownloadFinishes ==
  /\ phase = "downloading"
  /\ running
  /\ LET nextExempt == IF DESIGN = "overrideLeaksToSeeding" THEN allowedAnyway
                       ELSE IF allowedAnyway /\ ~allowedAnywaySeeding THEN FALSE
                       ELSE allowedAnyway
         res == Reconcile(pausedBy, blocks, "seeding", nextExempt)
     IN /\ phase' = "seeding"
        /\ allowedAnyway' = nextExempt
        /\ running' = res.run
        /\ pausedBy' = res.by
  /\ UNCHANGED <<userPaused, allowedAnywaySeeding, blocks>>

\* Engine restarts: nativeInit holds every transfer with "startup" until Kotlin evaluates governance.
EngineRestarts ==
  /\ "startup" \notin blocks
  /\ LET nextBlocks == blocks \cup {"startup"}
         res == Reconcile(pausedBy, nextBlocks, phase, allowedAnyway)
     IN /\ blocks' = nextBlocks
        /\ running' = res.run
        /\ pausedBy' = res.by
  /\ UNCHANGED <<phase, userPaused, allowedAnyway, allowedAnywaySeeding>>

Next ==
  \/ \E t \in (AllBlocks \ {"startup"}) : RuleTurnsOn(t)
  \/ \E t \in AllBlocks : RuleTurnsOff(t)
  \/ YouPause
  \/ YouResume
  \/ YouResumeAnyway
  \/ DownloadFinishes
  \/ EngineRestarts

Spec == Init /\ [][Next]_vars

\* --- Rules (invariants) ---

\* A transfer the user paused never runs and never keeps an old "Resume anyway" override.
UserPauseStaysPaused ==
  userPaused => (~running /\ ~allowedAnyway)

\* Safety and physical rules (VPN, low storage while downloading, startup hold) always stop
\* the transfer, even if the user tapped "Resume anyway".
SafetyRulesAlwaysHold ==
  ( "vpn_required" \in blocks
    \/ ("storage_full" \in blocks /\ phase = "downloading")
    \/ "startup" \in blocks ) => ~running

\* A "Resume anyway" tapped during a download never leaks into seeding on a metered link.
NoSeedLeak ==
  (phase = "seeding" /\ ~allowedAnywaySeeding /\ ("seed_metered" \in blocks \/ "wifi_only" \in blocks))
    => ~running

\* When the user didn't pause it and no active rule applies, the transfer is never stuck with a stale tag.
NoStuckRuleTag ==
  (~userPaused /\ BlockingTag(blocks, phase, allowedAnyway) = "none")
    => (running /\ pausedBy = "none")
=============================================================================
