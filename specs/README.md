# State-machine models

Each folder here is a small TLA+ model of one Maglev feature that moves between states: what can happen, in any order, and the rules that must hold whatever happens. A program called TLC tries every reachable state and reports any order of events that breaks a rule.

Why Maglev asks for these and how to write one: [handbook/state-machines.md](../handbook/state-machines.md).

## Run the models

You need Java 11 or newer (`java -version`). Nothing else: the first run downloads TLC (`tla2tools.jar` v1.7.4 from the [tlaplus release](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)) into `.cache/tla/`, which git ignores, and checks its sha256 before running it.

```bash
npm run models                                     # every model
node scripts/check-models.js specs/share-handoff   # one folder
node scripts/check-models.js specs/share-handoff/AllStore.cfg   # one design
```

One line per `.cfg`:

```
PASS share-handoff/AllStore.cfg 872 states (0.8s)
PASS share-handoff/StoreWins.cfg LatestShown breaks, as expected, after 4 steps (0.7s)
```

When a result differs from what the `.cfg` expects, the line says `FAIL`, the command prints TLC's counterexample, and it exits with 1. CI runs the same command.

## A spec folder

```
specs/<feature>/
  <Feature>.tla      the model: variables, actions, rules
  <Design>.cfg       one per design: the constants, and which rules to check
  README.md          the feature, a state chart, the rules, the designs tried, and the code each action maps to
```

- A `.cfg` checks the `.tla` named on its second line as `\* module: <Name>`, else the `.tla` with the same name, else the only `.tla` in its folder. A folder with helper modules needs the `module:` line.
- The first line of every `.cfg` says what TLC should find:
  - `\* expect: pass`: no rule breaks.
  - `\* expect: fail LatestShown in 4 steps`: this rule breaks, on a shortest path of 4 steps. Use it for a design you tried and rejected, so the reason stays checked. The step count is optional; when it's there, it must match.
- Every `.cfg` lists at least one rule under `INVARIANTS` (or `PROPERTIES`). One with none fails, because TLC would pass it without checking anything.
- Keep constants small, such as two links and one magnet. A model that TLC finishes in a few seconds gets run; a slow one gets skipped.

Start from [`_template/`](_template/). It is a working model, so `npm run models` checks it too.

## Models

| Folder | Feature |
|---|---|
| [`share-handoff/`](share-handoff/) | How a shared link, a magnet or a notification tap reaches the right screen when Android closes, rebuilds or updates Maglev in between. |
| [`download-timing/`](download-timing/) | How the detail row and Timing sheet agree for transfers that finish in under a second, in seconds, or in hours. |
| [`_template/`](_template/) | Pausable downloads. The example to copy, with one design that passes and one that was rejected. |
