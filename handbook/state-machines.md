# State machines

Some bugs aren't on any one line of code. They live in an order of events that nobody tried. Maglev 1.0 had one: you shared a link, pressed Start, went home, Android closed Maglev to free memory, and the next time you tapped the icon the same Add screen opened again. Each piece of code was fine on its own. The bug needed those five steps in that order, and one of them was done by Android.

So for any change to how something moves between states, Maglev asks for a small model of it. A model lists what can happen and the rules that must hold. A program called TLC then tries every order of events the model allows and reports any order that breaks a rule. The models live in [`specs/`](../specs/), one folder per feature, and CI checks all of them on every pull request.

You don't need to know TLA+ to write one. Copy [`specs/_template/`](../specs/_template/), which is about 100 lines, and change it. This page covers the parts of the language the template uses, and nothing more.

## When a change needs a model

Yes:

- a new feature that moves between states: a download, a watch, an update, a hand-off between screens;
- a change to how something moves: a new way in, a new step, a new thing Android can interrupt;
- a fix for a bug that only shows up in a certain order of events.

No:

- layout, copy, colours, icons;
- a pure function, where the same input always gives the same output (a parser, a formatter, a size check);
- a new setting that only changes a value an existing model already treats as a constant.

Not sure? Ask on the issue. A maintainer adds the `needs-model` label when one is wanted.

## What TLC proves, and what it doesn't

TLC is a model checker. It starts from the model's first state, tries every action that can happen there, and repeats for every new state it finds, until no new states are left. Then it has checked every rule in every reachable state. A test checks the paths someone thought to write down. TLC checks all of them, within the model's bounds.

That claim has limits, and a reviewer will hold you to them:

- **It checks the model, not the code.** If an action says something the code doesn't do, TLC proves the wrong thing. The table in each model's README that maps actions to code is how a reviewer checks the match.
- **It checks the bounds you gave it.** Two links and one magnet are enough to find most order bugs, because they come from a few things interleaving, not from many. But TLC says nothing about three links if the `.cfg` has two.
- **It checks only what the model contains.** Anything you left out (a clock, a timeout, a second window) can't break a rule. Each README lists what its model leaves out.
- **It checks the rules you wrote.** A rule that says the wrong thing passes just as happily.
- **These models check invariants only:** things that must be true in every state. They don't check that something eventually happens.

## The syntax you need

TLA+ describes states and steps, not instructions. A state is a value for every variable. An action is a condition on two states: the one before the step (`x`) and the one after it (`x'`, read "x prime").

| You write | It means | In JavaScript terms |
|---|---|---|
| `Name == ...` | define `Name` | `const Name = ...` |
| `x = 1` | x equals 1 (a test, never an assignment) | `x === 1` |
| `x' = x + 1` | after this step, x is one more | `next.x = x + 1` |
| `A /\ B` | A and B | `A && B` |
| `A \/ B` | A or B | `A \|\| B` |
| `~A` | not A | `!A` |
| `A => B` | if A, then B (true whenever A is false) | `!A \|\| B` |
| `x # y` | x is not equal to y | `x !== y` |
| `UNCHANGED <<a, b>>` | `a' = a /\ b' = b` | `next.a = a; next.b = b` |
| `IF c THEN x ELSE y` | the usual | `c ? x : y` |
| `LET n == e IN body` | a local name for `e`, used in `body` | `{ const n = e; return body }` |
| `\E d \in S : A(d)` | A can happen for some d in S | `S.some((d) => A(d))` |
| `\*` and `(* ... *)` | comments | `//` and `/* ... */` |

Sets are the only data structure the template needs:

| You write | It means |
|---|---|
| `{"a", "b"}`, `{}` | a set of two strings, the empty set |
| `d \in S`, `d \notin S` | d is (not) in S |
| `S \cup T`, `S \cap T`, `S \ T` | union, intersection, S without T's members |
| `S \subseteq T` | every member of S is in T |
| `BOOLEAN` | `{TRUE, FALSE}` |

Three things catch people out:

- **Every action must say what happens to every variable.** A variable that isn't primed and isn't in `UNCHANGED` can take any value after the step, and TLC stops with an error. The `vars` tuple and the `UNCHANGED` lines are how you keep track.
- **Indentation matters in `/\` and `\/` lists.** A list of `/\` lines lined up in one column is one "and". Indent a line further and it belongs to the line above it.
- **A line with no prime is a guard.** `/\ app = "front"` doesn't set `app`. It says the action can happen only when `app` is `"front"`.

## Write a spec in about 100 lines

Walk through [`specs/_template/Feature.tla`](../specs/_template/Feature.tla) from top to bottom. It models downloads you can pause, and Android closing Maglev in between.

1. **Copy the folder** to `specs/<your-feature>/`. Rename `Feature.tla` and the `MODULE` line inside it to the same name, for example `WatchCheck`. TLC refuses a file whose name differs from its module.
2. **Constants** are small sets of example things: `Downloads = {"a", "b"}`. Their values go in the `.cfg`, so one model can be checked with different values. The template's `DESIGN` constant picks between the design that ships and one that was rejected, so both live in one `.tla`.
3. **Variables** hold the state. Comment each one with the values it takes. Put in only what decides what happens next, and say whether it lives in memory or on disk. That difference decides what survives when Android closes the app:

   ```tla
   VARIABLES
     app,        \* where Maglev is: "front", "back" or "closed"
     added,      \* downloads you added; saved on disk, so they survive Maglev closing
     paused,     \* downloads you paused; saved on disk too
     running,    \* downloads moving right now; in memory, so gone when Maglev closes
     finished    \* downloads that completed
   ```

4. **`TypeOK`** says what kind of value each variable holds. It catches typos, such as `"frnt"`, on the first state where they appear.
5. **`Init`** is the first state.
6. **Actions**, one per thing a person or Android does. Guards first, then the primed lines, then `UNCHANGED` for the rest:

   ```tla
   YouPause(d) ==
     /\ app = "front"                  \* guard: only on screen
     /\ d \in running                  \* guard: only a running download
     /\ running' = running \ {d}
     /\ paused' = paused \cup {d}
     /\ UNCHANGED <<app, added, finished>>
   ```

7. **`Next`** is every action joined with `\/`, so any one of them can be the next step. `\E d \in Downloads : ...` tries the action for each download. **`Spec`** is always `Init /\ [][Next]_vars`; copy it as it is.
8. **Rules** go last, as invariants, each with a one-line comment in plain English.
9. **The `.cfg`** sets the constants and lists the invariants to check. Its first line says what you expect: `\* expect: pass`, or for a rejected design `\* expect: fail PausedStaysPaused in 5 steps` (the step count is optional; when it's there, it must match). A `.cfg` that lists no invariant fails, because TLC would pass it without checking anything.
10. **Run it:** `node scripts/check-models.js specs/<your-feature>`.

Then fill in the folder's `README.md` from the template: what the feature is, a Mermaid state chart of the design that passes, the rules, the designs you tried, and the code each action stands for.

## Name actions after what people and Android do

Good names: `YouShare`, `YouTapIcon`, `YouSwipeAway`, `AndroidKillsMaglev`, `DownloadFinishes`, `MaglevOpens`.

Avoid: `handleIntent`, `onResume`, `setStateB`, `step3`.

TLC prints the action name at every step of a counterexample. With plain names, the counterexample reads as a story: you share a link, Android closes Maglev, you tap the icon. A reviewer can follow that story, and a tester can repeat it on a phone. With code names, someone first has to translate.

Use one action for each thing that happens, even when two of them do the same thing in the code. `YouShare` and `YouOpenAMagnet` are separate actions in the share model because a person does different things, and the counterexample should say which one they did.

## Turn rules into invariants

Start from a sentence anyone on the project would agree with: "A download you paused never runs until you resume it." Find the variables it talks about, then write it as a condition that must be true in every state:

```tla
\* A download you paused never runs until you resume it.
PausedStaysPaused == running \cap paused = {}
```

"When X, then Y" becomes `X => Y`:

```tla
\* When Maglev is on screen, every download you added is running, paused or finished.
NothingLost == app = "front" => added \subseteq (running \cup paused \cup finished)
```

Sometimes no variable holds what the rule is about. Then add one. The share model has `owed`, the newest thing you opened that Maglev hasn't shown yet, so that "Maglev shows the newest thing you opened" becomes `app = "front" => owed = None`. It also has `cardOnShare`, which turns TRUE once the What's New card opens over a shared link and stays TRUE. A variable like that records that something happened, so a rule can talk about it.

Never weaken a rule to make TLC pass. A rule changes only when the maintainer agrees it was wrong. Then change it in the `.tla` and the README, and give the reason in the pull request.

## Model "Android closes the app" and "you leave"

Android is the other actor in most Maglev bugs. Model what it can do as actions, the same as what people do.

**Android closes Maglev.** It can do this whenever Maglev isn't on screen, including while Maglev is still starting. Everything in memory is gone and everything on disk stays. The template has no "starting" state, so its version is short; the share model's version also allows `app = "starting"`:

```tla
AndroidKillsMaglev ==
  /\ app = "back"
  /\ app' = "closed"
  /\ running' = {}                          \* memory is lost
  /\ UNCHANGED <<added, paused, finished>>  \* disk survives
```

**You leave.** Going home (`YouGoHome`) keeps everything. Swiping Maglev away in Recents removes its task. A running download can keep the process alive with no screen, so the share model lets TLC try both:

```tla
YouSwipeAway ==
  /\ task /\ app \in {"back", "closed"}
  /\ \E keepsRunning \in BOOLEAN :
       app' = IF keepsRunning /\ app = "back" THEN "noScreen" ELSE "closed"
  ...
```

`\E x \in BOOLEAN` is how to say "this may or may not happen". TLC tries both values.

**An update** closes Maglev too, and can change what shows on the next start. The share model limits it to once (`updated`) to keep the model small.

When you add these actions, the guard is the part to get right. "Android can close Maglev only while it's in the background" is a claim about Android, and a guard that's too narrow hides bugs.

## Read a counterexample

The template holds a second, rejected design: when Maglev opens after Android closed it, it restarts every download that isn't finished, and forgets which ones you paused. `DESIGN` in the `.cfg` picks the design:

```tla
LET waiting == IF DESIGN = "forgetsPaused" THEN added \ finished
               ELSE added \ (paused \cup finished)
```

Set `DESIGN = "forgetsPaused"` in `Feature.cfg`, and `node scripts/check-models.js specs/_template` prints (trimmed):

```
FAIL _template/Feature.cfg: expected no rule to break, but PausedStaysPaused breaks after 5 steps
    Error: Invariant PausedStaysPaused is violated.
    Error: The behavior up to this point is:
    State 1: <Initial predicate>
    /\ paused = {}
    /\ running = {}
    /\ app = "front"

    State 2: <YouAdd line 41, col 3 to line 45, col 40 of module Feature>
    /\ paused = {}
    /\ running = {"a"}
    /\ app = "front"

    State 3: <YouPause line 48, col 3 to line 52, col 39 of module Feature>
    /\ paused = {"a"}
    /\ running = {}

    State 4: <YouGoHome line 68, col 3 to line 70, col 51 of module Feature>
    /\ app = "back"

    State 5: <AndroidKillsMaglev line 74, col 3 to line 77, col 42 of module Feature>
    /\ app = "closed"

    State 6: <YouOpenMaglev line 82, col 3 to line 87, col 42 of module Feature>
    /\ paused = {"a"}
    /\ running = {"a"}
    /\ app = "front"
```

The template keeps this design in `ForgetsPaused.cfg`, whose first line is `\* expect: fail PausedStaysPaused in 5 steps`. There the break is the expected result, so the run passes and prints one line. The trace appears only when a result differs from its `expect:` line.

How to read it:

- The first line names the rule that broke.
- `State 1` is `Init`. Every later state names the action that led to it and where that action is in the `.tla`.
- TLC prints every variable in every state. Compare each state with the one before to see what the step changed.
- The last state is the one that breaks the rule. Here download `a` is both paused and running.
- The checker asks TLC for the shortest such path, so every step in it matters.

Now tell it as a story: you add a download, pause it, go home, Android closes Maglev, you open Maglev, and the paused download is running again. Then decide whether the design is wrong (fix the design, then the code) or the model is wrong (an action allows something the real app can't do). Either way, write down which in the pull request.

If TLC says `Deadlock reached`, it found a state with no step out. When that state is a real end, like a finished job, add an action that is enabled only there and changes nothing: `Done == phase = "done" /\ UNCHANGED vars`, and add it to `Next`.

## Keep the model in step with the code

Every model's README has a table mapping each action to the file and function that carry it out. That table is the link between the model and the code:

- When you change a file named in the table, check that the action still says what the code does. If it doesn't, update the model in the same pull request.
- When you add a new way for state to change, add an action and a row.
- Comments in the `.tla` name code files, so the next person can find the code without asking.
- Actions that Android performs have no code. Their row says so. They are the events the code has to survive.

## How reviewers and AI agents use a model

- **The rules are the pull request's acceptance criteria.** The PR description lists the rules it keeps and links the model. A reviewer reads the README's chart and rules first, then checks the code against the action table.
- **Every counterexample becomes a check on a phone.** A path TLC found, including one for a rejected design, is a sequence of steps someone can repeat on a phone against the shipped design. For "Android closes Maglev", go home and run `adb shell am kill com.maglev`. If the phone doesn't behave as the model says, assume the model is wrong until shown otherwise, and fix it.
- **Rejected designs stay.** Their `.cfg` keeps `\* expect: fail <Rule> in <N> steps`, so the reason a design was dropped is checked on every run, and nobody brings it back by accident.
- **Agents write the model first.** An AI agent working on a state change updates or writes the model before the code, runs `npm run models`, and reports in the PR which `.cfg` files pass and which fail as expected. Changing an `expect:` line to get a green run needs a sentence in the PR saying why.
- **CI runs the same command.** A pull request whose models don't give their expected results doesn't merge.

## Worked example: share-handoff

[`specs/share-handoff/`](../specs/share-handoff/) models how a link reaches the right screen. A link can come from a share, from a magnet opened in a browser, or from a tap on a Maglev notification.

In Maglev 1.0 every link was the start intent of the app's task. Android keeps that intent and replays it whenever it rebuilds the task, so an old link came back. The model found two problems with it: an old link shows instead of a newer one (`LatestShown`), and a link you already finished opens again (`NoStaleLink`).

The fix keeps links in a one-shot store that Maglev reads once. The first two versions of it still failed:

| Design | What broke |
|---|---|
| `OnceAll`: shares go through the store, notification taps don't, and a real start URL drops the store. | You tap a notification, Android closes Maglev, you share a link. Android replays the notification's intent and the share is dropped. |
| `StoreWins`: as above, but a waiting link wins at a fresh start. | You share a link, Android closes Maglev before it opens, you tap a notification. The old share wins. |
| `AllStore`: every way in, notifications and the tile included, goes through the store. | Nothing. All rules hold in 872 states. |

The `StoreWins` failure needs Android to close Maglev in the moment between the share card and the app's first screen. No test on a phone hits that on cue; TLC found it in four steps. The fix that shipped is the one with a single path for every link: when everything goes through the store, the newest entry replaces the older one.

Read the model next to its [README](../specs/share-handoff/README.md), which has the state chart, the full rule list and the code each action maps to.

## Further reading

- [Learn TLA+](https://learntla.com/), a practical guide by Hillel Wayne.
- [The TLA+ home page](https://lamport.azurewebsites.net/tla/tla.html), with Leslie Lamport's video course.
- [Current versions of the TLA+ tools](https://lamport.azurewebsites.net/tla/current-tools.pdf), which lists every TLC command-line option.
