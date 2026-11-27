----------------------------- MODULE ListUpdate -----------------------------
EXTENDS Naturals

(* The ad block list updates itself from its upstream addresses, once a day,
   with Maglev open or closed. An update fetches the list, checks it, writes it
   in place of the one in use, and records when. Settings shows "Updated 3 h
   ago" from that record.

   What arrives may be fine ("good"), broken ("bad": not a hosts list, or too
   few names), or cut short ("cut": a real list, but far shorter than the one
   from the same addresses). The signed search-sources file follows the same
   steps: there "bad" is a wrong signature and "cut" an older serial.

   Android can close Maglev at any moment, and a backup restore or a device
   transfer brings the list file back with a new file time. The rules: the list
   in use always passed every check, and the time shown is when it did. *)

CONSTANTS
  DESIGN  \* "owned" (passes), or a rejected one: "today", "timeInMeta"

Kinds == {"good", "bad", "cut"}
MaxTime == 3

VARIABLES
  app,        \* "up" or "down": whether Maglev's process is running
  now,        \* the clock, 1..MaxTime
  step,       \* in memory: "idle", "fetched", "checked", or "listWritten" (only between two separate writes)
  got,        \* in memory: what the fetch brought, or "none"
  applied,    \* on disk: the list in use: "builtin" (inside the app) or one that was written
  fileTime,   \* on disk: the list file's modification time; 0 when Android can't tell
  metaTime,   \* on disk: an update time kept in a separate file (blocklist.json)
  headerTime, \* on disk: the update time written inside the list file itself, in the same write
  fetchedAt   \* no code: when the list in use really passed its checks; 0 for the built-in one

vars == <<app, now, step, got, applied, fileTime, metaTime, headerTime, fetchedAt>>

TypeOK ==
  /\ app \in {"up", "down"}
  /\ now \in 1..MaxTime
  /\ step \in {"idle", "fetched", "checked", "listWritten"}
  /\ got \in Kinds \cup {"none"}
  /\ applied \in Kinds \cup {"builtin"}
  /\ fileTime \in 0..MaxTime
  /\ metaTime \in 0..MaxTime
  /\ headerTime \in 0..MaxTime
  /\ fetchedAt \in 0..MaxTime

\* What Settings shows as "Updated ...".
Shown ==
  CASE DESIGN = "today" -> fileTime
    [] DESIGN = "timeInMeta" -> metaTime
    [] OTHER -> headerTime

Init ==
  /\ app = "up"
  /\ now = 1
  /\ step = "idle"
  /\ got = "none"
  /\ applied = "builtin"
  /\ fileTime = 0
  /\ metaTime = 0
  /\ headerTime = 0
  /\ fetchedAt = 0

TimePasses ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<app, step, got, applied, fileTime, metaTime, headerTime, fetchedAt>>

\* The daily job, the app's own daily check, or "Check now". "cut" only means
\* something once a list from the same addresses is in use.
Fetch ==
  /\ app = "up" /\ step = "idle"
  /\ \E k \in Kinds :
       /\ k = "cut" => applied = "good"
       /\ got' = k
  /\ step' = "fetched"
  /\ UNCHANGED <<app, now, applied, fileTime, metaTime, headerTime, fetchedAt>>

\* The checks. Today a broken list is refused (too few names, not a list), but a
\* list cut short passes. The shipped design also refuses a list that shrank to
\* under half of the one from the same addresses, and keeps the one in use.
Check ==
  /\ app = "up" /\ step = "fetched"
  /\ IF got = "bad" \/ (got = "cut" /\ DESIGN # "today")
     THEN /\ step' = "idle"
          /\ got' = "none"
     ELSE /\ step' = "checked"
          /\ UNCHANGED got
  /\ UNCHANGED <<app, now, applied, fileTime, metaTime, headerTime, fetchedAt>>

\* One atomic write (temp file, fsync, rename). The shipped design writes the
\* update time into the list file's first line, so the content and its time land
\* together.
WriteList ==
  /\ app = "up" /\ step = "checked"
  /\ applied' = got
  /\ fetchedAt' = now
  /\ fileTime' = now
  /\ headerTime' = IF DESIGN = "owned" THEN now ELSE headerTime
  /\ step' = IF DESIGN = "timeInMeta" THEN "listWritten" ELSE "idle"
  /\ got' = "none"
  /\ UNCHANGED <<app, now, metaTime>>

\* The rejected "timeInMeta": the time goes into blocklist.json, a second write.
WriteMeta ==
  /\ DESIGN = "timeInMeta" /\ app = "up" /\ step = "listWritten"
  /\ metaTime' = fetchedAt
  /\ step' = "idle"
  /\ UNCHANGED <<app, now, got, applied, fileTime, headerTime, fetchedAt>>

AndroidKillsMaglev ==
  /\ app = "up"
  /\ app' = "down"
  /\ step' = "idle"
  /\ got' = "none"
  /\ UNCHANGED <<now, applied, fileTime, metaTime, headerTime, fetchedAt>>

MaglevStarts ==
  /\ app = "down"
  /\ app' = "up"
  /\ UNCHANGED <<now, step, got, applied, fileTime, metaTime, headerTime, fetchedAt>>

\* A backup restore or a device transfer writes the files back. Their content is
\* the same; the file time is the restore's, or 0.
AndroidRestoresBackup ==
  /\ app = "down"
  /\ \E t \in {0, now} : fileTime' = t
  /\ UNCHANGED <<app, now, step, got, applied, metaTime, headerTime, fetchedAt>>

Next ==
  \/ TimePasses \/ Fetch \/ Check \/ WriteList \/ WriteMeta
  \/ AndroidKillsMaglev \/ MaglevStarts \/ AndroidRestoresBackup

Spec == Init /\ [][Next]_vars

\* Rules.

\* The list in use passed every check: a failed, broken or cut update leaves the last good one.
KeepLastGood == applied \in {"builtin", "good"}

\* The "Updated" time is when the list in use passed its checks, never a file's time.
TimeIsReal == applied # "builtin" => Shown = fetchedAt
=============================================================================
