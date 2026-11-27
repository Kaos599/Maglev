# Testing

Maglev has about 190 automated checks. Almost all of them are plain Node scripts in `scripts/` that finish in under a second. You can run all of them in about ten seconds.

## Run them

```
node scripts/run-checks.js
```

(`npm run check` does the same once the script line is in `package.json`.)

It runs what CI runs on every push: `tsc --noEmit`, everything `npm test` chains, and everything `npm run test:assistant` chains. It prints one line per check with PASS, FAIL or SKIP, the seconds, and one sentence saying what the check covers. A short summary follows. It exits 1 if anything fails.

```
node scripts/run-checks.js --area search      only the checks for one area (tsc always runs)
node scripts/run-checks.js --area ui,settings several areas
node scripts/run-checks.js --list             the areas and how many checks each has
node scripts/run-checks.js --quiet            print only what did not pass
node scripts/run-checks.js --all              also the checks CI does not run (see below)
node scripts/run-checks.js --jobs 8           run more checks at once (default 4)
```

The list of checks is read from `package.json`, so a script added to `npm test` is picked up. The sentence for each check lives in a table at the top of `scripts/run-checks.js`. If you add a check, add its row there. The runner warns when a row is missing.

The one-sentence description of every check is in that table and in the output. It is not copied into this page, so there is only one place to keep current.

### Why not just `npm test`

`npm test` stops at the first script that exits non-zero and says nothing about the rest. `run-checks.js` runs every check, reads the output as well as the exit code, and lists every failure at the end. It matters for two cases:

- **A check can print FAIL and still exit 0.** The reality contracts (`test-p3-reality-contracts.js`) exit 1 only when a P0 contract fails. A failing P1 or P2 contract prints a red line and exits 0, so `npm test` and the CI step pass. The runner treats a line that starts with `FAIL` or `❌` as a failure even when the exit code is 0, and marks it `[exit 0 but printed FAIL]`.
- **A check can skip part of itself.** See [Checks that skip](#checks-that-skip).

## Which checks for which change

Run the area that matches what you touched, then the full run before you open the PR.

| You changed | Run | Notes |
|---|---|---|
| Search screen, providers, sources, sort and filter | `--area search` | Includes the provider parsers, which run on recorded pages with no network |
| Browser, found files, tabs, history, bookmarks | `--area browser` | Kotlin is never compiled here. These read the Kotlin source as text |
| Transfers list, cards, swipe, filters | `--area transfers` | |
| Add flows, link downloads, share and quick share | `--area downloads` | |
| Torrent files, trackers, file health, remove files | `--area torrents` | |
| Native boundary, engine start and restart, foreground service, stream server | `--area engine` | The Rust and Kotlin sides are compiled only by CI |
| Settings pages, setting rows, the settings index | `--area settings` | A new row needs an entry in `utils/settingsIndex.ts` or `test-settings-coverage` fails |
| Theme, copy, fonts, motion, haptics, components | `--area ui` | `test-design-system` and `test-copy-voice` are the strict ones |
| Assistant | `--area assistant` | |
| Subtitles | `--area subtitles` | |
| Stats | `--area stats` | |
| Feeds and follow rules | `--area feeds` | |
| Watches | `--area watch` | |
| In-app updater | `--area updates` | |
| Version, plugins, manifest, release notes, icons, website | `--area build` | |

A check can belong to more than one area. `--list` shows the areas.

Speed: `tsc` takes about six seconds and is the slowest. `test-browser-found-files` and `test-p3-reality-contracts` take one to two seconds. Every other check runs in under a second on a laptop. All of them in a row take about 25 seconds, and four at a time take about ten.

## What the checks look like

There are four kinds. Knowing which one failed tells you where to look.

1. **Pure logic.** Imports a TypeScript module and calls it with known inputs: formatters, state machines, parsers, scoring, date and gate rules. Most of `utils/` is covered this way. Node 22.18 or newer runs the `.ts` source directly by stripping types, so there is no build step.
2. **Fixture parsers.** Search and subtitle providers run on recorded pages in `scripts/fixtures/`. No network. If a site changes its markup, the live app breaks and these still pass until someone records a new page.
3. **Source checks.** Reads files as text and asserts that the wiring is there: a Kotlin function exists, a JNI name matches on all three sides, a screen reads from a token, a setting reaches `toNativeConfig`. Kotlin and Rust are never compiled on a dev machine, so this is how the app side of the boundary is guarded between CI builds. They fail when code moves. Update the check in the same PR as the move.
4. **Repo rules.** Walk the whole tree: `test-design-system` (no hex outside `constants/`, no `fontFamily: 'monospace'`), `test-copy-voice`, `test-settings-coverage`, `test-route-guards`, `test-manifest-permissions`, `test-bundle-slim`.

### The reality contracts

`test-p3-reality-contracts.js` (also `npm run test:contracts`) is the check for "nothing is done until a contract proves it on real code". It runs named contracts (`C-ENG-1`, `C-PERM-1`, and so on) at three severities. P0 failures exit 1. P1 and P2 failures print but exit 0. Run it with `--only=P0`, `--only=P1` or `--only=P2` to narrow it. It also calls `test-search.js` as one of its contracts.

It skips what it cannot see on a dev machine: the compiled `.so` is gitignored, so the "real engine, not a simulator" size check is skipped locally and enforced by CI (see below).

## What CI runs

| Workflow | When | Job | What it runs |
|---|---|---|---|
| `ci.yml` | every push to `main` and `dev` (not for markdown, `docs/`, `screens/` or LICENSE changes), every pull request, manual | **Rust tests** | `cargo test` on `native/maglev-core` without the JNI feature, and on the TLS verifier shim. Clippy runs but does not block |
| | | **JS checks** | `npm run typecheck`, `npm test`, `npm run test:assistant`, and `node scripts/eval-assistant/run.js --fake` (a scripted model, no key, no network) |
| | | **Rust Android** | Builds `libmaglev_core.so` for each ABI. Fails on a `.so` under 3 MB, a `.so` with fewer than 5 `librqbit` or `dht` strings, or a `.so` without 16 KB page alignment |
| | | **Build APK** | Prebuild and release build, APK signing check, versionCode check (base × 10 + ABI digit), then the Kotlin unit tests (`:maglev-engine:testDebugUnitTest`) |
| | | **Contract tests** | The reality contracts (this step is `continue-on-error`), ABI splits, config plugins, a subset of the search checks, feed rules, version scheme |
| | | **Reuse pull request APKs** | On a push to `main`, takes the APKs from the pull request's own CI run when the tree is identical, so the build is not repeated. Not a test |
| `e2e.yml` | a `v*` tag, manual | **Maestro flows** | The flows in `.maestro/` on an API 34 x86_64 emulator, against the APK CI built. Report-only: a failing flow warns and writes a summary but never turns the run red |
| `audit.yml` | Mondays 04:17 UTC, manual, and pull requests that change a lockfile | **cargo audit**, **npm audit** | Known advisories in Rust and npm dependencies. npm fails on high severity, production dependencies only |
| `release-apk.yml` | a `v*` tag, manual | **Reuse CI APKs**, **Build Android APK**, **Publish release** | Checks the tag against `app.json` (`bump-version.js check`) and that the release notes build, then reuses or builds the APKs and publishes. It adds no tests of its own |
| `checks.yml` | pull requests, pushes to `dev` and `main` | **Models**, **No private references** | See [Models](#models) and the line below |

`checks.yml` is added in the same wave as this page. **Models** installs Java and runs `npm run models`. **No private references** runs `scripts/check-private-refs.js` over the lines your PR adds, and fails if a comment, doc or label cites a private design document. Run `npm run check:refs` before you push.

The Rust and Kotlin tests, the APK build, the signing check and the `.so` gate run only in CI. Nobody installs Rust or Gradle locally. If CI reports a compiler error, fix it from the log.

### Checks CI does not run

Some checks exist and are not in `npm test`, so CI never runs them. You need to run them yourself:

- **`npm run test:search`** adds `test-search-general`, `test-search-dht`, `test-search-anime`, `test-search-niche` and `test-search-outage` to the five search checks CI already runs. If you touched a search provider, run it. `--area search` does.
- **`test-ux-027`** is chained only by `npm run test:update`.
- **`test-browser-tabs-native`** is listed in no npm script.

`node scripts/run-checks.js --all` runs all three groups. When this page was written, `test-ux-027` and `test-browser-tabs-native` failed, because the code moved and nobody updated them. Fix or delete a stale check you find; do not leave it red and unlisted.

## Reading a failure

A check prints `ok  <what it asserted>` for each assertion and `FAIL <what it asserted>` for each failure, then a count and exit code 1. The FAIL text is the assertion's own name, so read it as a sentence: `FAIL held redirect: !request.hasGesture()` means a source check looked for that text in the Kotlin file and did not find it.

`run-checks.js` collects those lines under **Failures** with the command to rerun just that check:

```
Failures

test-browser-tabs-native (exit 1), reproduce with: node scripts/test-browser-tabs-native.js
  FAIL handleNewWindow: gesture emits onNewWindow gesture true
```

To find what to fix:

1. Rerun the one script. Its full output has the assertions around the failure.
2. Open the script and search for the FAIL text. The assertion shows which file it reads and what it expects.
3. Decide which side is wrong. A source check that fails after you moved code usually needs the check updated. A state machine or fixture check that fails usually means your change broke the behaviour.
4. If a check complains about Node, use Node 22.18 or newer.

To read logs for FAIL lines, use `grep -n FAIL`.

## Checks that skip

Some private design documents are not in this repository. They sit in `docs/`, which is gitignored and lives in a separate private repository. A few checks compare code to those documents.

`scripts/lib/privateDocs.js` handles it:

- **No `docs/` folder** (a public checkout, any contributor's clone, and CI): the document comparison is skipped with the line `skip document checks: docs/ is private and not in this checkout`. The rest of that script still runs.
- **A `docs/` folder that lacks the document**: the check throws. A partial checkout is never mistaken for a pass. Under `CI=1` it skips instead.

`run-checks.js` shows these as `SKIP` with the reason and ends with a list. `SKIP` here means "part of this check did not run". Everything in the same script that does not need the document still ran and passed, because a script that failed would be `FAIL`.

Nine checks read a document: `test-backup`, `test-download-native`, `test-font-style`, `test-peer-timeout`, `test-rules-override`, `test-service-downloads`, `test-stream-contract`, `test-stream-headers`, `test-private-docs`. `test-p3-reality-contracts` also skips one contract that needs the document, and the `.so` check described above.

Is a skipping run still worth anything? Yes. The skipped part only checks that prose and code agree. The code-side assertions (the wiring, the types, the values) are the ones that catch regressions, and they are the same ones CI runs, because CI has no `docs/` either. A maintainer with `docs/` checked out gets a few more assertions than a contributor or CI does.

## Models

State machines are modelled in TLA+ under `specs/`. `npm run models` (script `scripts/check-models.js`) downloads `tla2tools.jar` once into `.cache/tla/`, verifies its checksum, and runs TLC on every `.cfg` file under `specs/`. Each cfg's first line says whether it should pass or should fail on a named invariant, and the run fails when the result differs. It needs Java 11 or newer and says so if Java is missing. `run-checks.js` does not run it, because it needs Java and a download. CI runs it in the **Models** job of `checks.yml`.

Run it when you change a state machine or add a feature that moves between states. See [state-machines.md](state-machines.md) for when a change needs a model and how to write one.

## End-to-end and phone checks

These are not part of `run-checks.js`. They need a device.

- **Maestro flows** (`.maestro/`, 21 flows). Each drives the real app: onboarding, adding a magnet, pause and resume, search and add, transfers filters and removal, every Settings screen, a settings round trip through a restart, feeds, the browser's found files. `.maestro/README.md` lists each flow. CI runs them after a tag. To run them on a phone: `npm run e2e:phone`. **This clears the app's data and deletes downloads on that device.** Use a spare phone or an emulator.
- **Device checks** (`scripts/device/`). `test-link-faults.sh` breaks link downloads on purpose (dropped parts, short bodies, servers that refuse extra connections, no range support) and checks each file's SHA-256. `test-service-restart.sh` checks that the service comes back after Android kills the app. They run over `adb` and delete only files they made.
- **Performance snapshot** (`scripts/perf/measure.sh <label>`). Cold start, scroll jank, idle CPU and memory on a device. Run it before and after a change you think affects speed.
- **Assistant eval** (`npm run eval:assistant`). Runs the real Assistant code against a real model over 25 scenarios. Needs an OpenRouter key in `.env.local`. With `--fake` it uses a scripted model and needs neither a key nor a network, and CI runs that form.

A PR that changes something on screen should list the steps a reviewer can repeat on a phone. See [contributing-well.md](contributing-well.md).

## The npm scripts

| Script | What it runs |
|---|---|
| `npm test` | All unit, source and contract checks, one after another, stopping at the first failure |
| `npm run test:assistant` | The 27 Assistant checks. Run it separately: CI does, and the prompt has a 2,400-token budget |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test:contracts` | The reality contracts only |
| `npm run test:search` | The ten search and source checks, including five CI does not run |
| `npm run test:update` | Updater checks, including `test-ux-027` |
| `npm run test:manifest-permissions` | The release manifest asks only for permissions Maglev uses on purpose |
| `npm run test:version`, `test:feeds`, `test:rates`, `test:format`, `test:trackers`, `test:error-actions`, `test:admission`, `test:remove-files`, `test:tracker-edit`, `test:follow`, `test:done-actions`, `test:url-download`, `test:font-style`, `test:search-title-lines` | One check each, for a quick loop while you work |
| `npm run models` | TLA+ model checks (needs Java) |
| `npm run check` | `scripts/run-checks.js` |
| `npm run check:refs` | No private references in the lines your PR adds |
| `npm run eval:assistant` | The Assistant eval above |
| `npm run e2e:phone` | The Maestro flows on a phone |

Before you push, run `node scripts/run-checks.js`, plus `npm run models` if you touched a state machine.
