# AGENTS.md: Operating Guide for AI Agents and Engineers

> **Project:** Maglev, an Android app that downloads almost any link: video pages, files and torrents
> **Stack:** React Native 0.88 + Expo SDK 58 (expo-router, Hermes, new arch) · Kotlin Expo Module · Rust (`librqbit` 9.x)
> **Integration branch:** `dev` · **Releases:** `main` (tags)
> **Rule 0:** Zero bloat, zero jargon, pure utility. **Rule 1:** Nothing is "done" until a contract proves it on real code.

---

## 1. Identity

Maglev downloads almost any link on a phone: a video page, a file, a magnet link or a torrent, in one app. It replaces a torrent client (LibreTorrent, Flud) and a download manager. It should feel minimal, quick and playful, with a retro feel that stays modern and readable for a general audience.

| Token | Value | Use |
|---|---|---|
| Void | `#05070A` | OLED background |
| Card / border | `#0D1117` / `#1F2937` | Surfaces with a 1px hairline border, no shadows |
| Accent | `#CCFF00` (lime) | Primary actions, active state, done |
| Accent 2 | `#00E5FF` (cyan) | Downloading, inbound speed |
| Danger | `#FF4D79` | Destructive actions, errors |
| Muted | `#8B949E` | Telemetry, paused |
| App icon | `#0B2A30` (deep teal) tile, pixel maglev train (lime `#A5FB48` body, cyan `#01E5EF` speed lines and rails) | Geometry and cruise sprite frames in `scripts/build-logo.py` → `assets/brand/maglev-mark.svg`, `maglev-icon.svg`, `readme-header.svg` (animated), `components/brand/markPaths.ts` (rendered by `components/brand/MaglevMark.tsx`); rasters from `node scripts/generate-icons.js`. |

Colours are reached through `useTheme()` and never written as hex outside `constants/`. The user picks one of three font styles in Settings → Interface (`fontStyle`, default **Clean**, UI only, applies live; table in `constants/fontStyles.ts`). **Clean**: Inter Bold headings, Inter Medium/SemiBold for filenames and telemetry (`tabular-nums`). **Retro**: Silkscreen headings, Space Mono filenames and telemetry. **Mono**: Space Mono Bold headings, Space Mono filenames and telemetry. Copy is always Inter, and the MAGLEV wordmark is always Silkscreen (`type.brand`, used by `HeaderBar` only). Use `type.heading`, `type.mono`, `type.body` and never a font file name. **Never use `fontFamily: 'monospace'`.** The full guide for new screens is [DESIGN.md](DESIGN.md). Use one icon family only: **Pixelarticons** (MIT), rendered through `components/PixelIcon.tsx` from `components/icons.generated.ts` (`node scripts/gen-icons.js`). Default size is 24px.

---

## 2. Repository map

```
app/                     expo-router screens (tabs, add-torrent, torrent/[id], onboarding, settings/*)
components/              UI components and PixelIcons
constants/               design tokens, theme palettes, copy, haptics
context/                 EngineContext, SettingsContext
utils/                   feature logic: search, browser, assistant, subtitles, stats, watches, updates
modules/maglev-engine/
  src/                   TS bridge (MaglevNativeBridge), mock engine (dev/web only), settings store, toNativeConfig
  android/               Kotlin: NativeCore (JNI), MaglevEngineModule, foreground service, storage, share card
native/maglev-core/      Rust: librqbit session, scheduler (pure), JNI exports, stream server
plugins/                 Expo config plugins (ABI splits, share intents, signing)
specs/                   TLA+ state machines, one folder per feature, checked by `npm run models`
handbook/                how Maglev works and how to contribute (start at handbook/README.md)
scripts/                 checks (`npm run check` explains each one), icon and licence generators
.github/workflows/       ci.yml (every push), checks.yml (models, private references), release-apk.yml (tags)
```

The maintainer keeps private planning notes in a gitignored folder. They are not part of the project: never cite them in code, comments, tests or docs, and write the rule itself instead.

---

## 3. Documents (read before writing code)

| File | Purpose |
|---|---|
| [handbook/architecture.md](handbook/architecture.md) | The three layers, how a download flows, where state lives, the service and process death. |
| [handbook/engine-boundary.md](handbook/engine-boundary.md) | The exact TS ⇄ Kotlin ⇄ Rust boundary: bridge functions, events, JNI exports, JSON shapes, error codes. Change this page **first** whenever the boundary changes. |
| [handbook/state-machines.md](handbook/state-machines.md) + [specs/](specs/) | How each feature moves between states, written as a lean TLA+ model and checked by TLC. Implement transitions 1:1 and never invent ad-hoc states. |
| [handbook/feature-map.md](handbook/feature-map.md) | Every feature: screens, code, states, model, checks. Also the list of models still wanted. |
| [handbook/testing.md](handbook/testing.md) | What every check proves, when to run it, and what CI runs. |
| [handbook/contributing-well.md](handbook/contributing-well.md) | What a good and a verifiable PR looks like. |
| [handbook/maintaining.md](handbook/maintaining.md) | Branches, versions, tags, releases, signing, store channels. |
| [DESIGN.md](DESIGN.md) | Tokens, components, patterns, copy voice, a checklist for new screens. Checked by `scripts/test-design-system.js`. |

Planned work lives in GitHub issues. History lives in git and in `release-notes/`.

---

## 4. Reality rules (non-negotiable)

These rules exist because an early phase was once marked "complete" while the engine was a simulator.

1. **No simulation in release builds.** The mock engine (`MaglevMockEngine.ts`) runs only under `__DEV__` or on web. If the native engine fails to load in release, the app shows "The downloader didn't start". It never shows fake data.
2. **No fabricated values in the bridge.** No hardcoded files, peers, trackers, sizes or speeds. Unknown is shown as unknown (for example `eta: -1`, shown as "—").
3. **Checks are the definition of done.** `npm run test:contracts` exits 1 while any P0 check fails. Work is "done" only with a green CI run.
4. **CI is the compiler.** Rust and Gradle need not be installed locally. CI rejects a `.so` under 3 MB, a `.so` without librqbit symbols, or a `.so` without 16 KB page alignment.
5. **Native binaries are never committed.** `jniLibs/` is gitignored. CI builds the binaries on every push.
6. **Settings must round-trip.** Every user-facing setting is persisted (expo-sqlite kv-store) and reaches Rust through `toNativeConfig`. `nativeGetEffectiveConfig` proves it. A toggle that does nothing must not ship.
7. **Settings must be searchable.** Every user-facing setting row gets an entry in `utils/settingsIndex.ts` (title = the visible label, with keywords people would type). `ListRow` and `ChipGroup` already wrap themselves in `FocusAnchor` by title, so a search result scrolls to and highlights the row. `scripts/test-settings-coverage.js` fails on a row with no entry and on an entry with no row.
8. **Errors are plain English and recoverable.** Each error code in [handbook/engine-boundary.md](handbook/engine-boundary.md) maps to a message and an action (Retry, Recheck, Pick folder again, Open settings).
9. **State machines first.** A new feature, or a change to how one moves between states, starts with a model in `specs/<feature>/` (copy `specs/_template/`). Its rules (invariants) are the PR's acceptance rules, and `npm run models` must pass. Layout, copy and pure functions need no model.
10. **Comments stand on their own.** Explain why in the comment itself. `npm run check:refs` fails on new lines that point at private notes.

---

## 5. Anti-slop creed

Work containing any of the following is rejected:

1. `// Heading`-style labels, version strings in headers, or fake status displays (`● CORE OK`, pulsing dots).
2. Cryptic codes or raw info-hashes on consumer screens. Hashes belong only under Detail → "Copy magnet".
3. Pipeline jargon. Say "Add torrent", "Settings", "Resume", "Pieces", "Waiting for Wi-Fi", "Storage full".
4. Desktop artifacts such as "Save configuration" buttons or SaaS avatars.
5. Touch targets under 44×44 px. Use `hitSlop` when the visual element is smaller.
6. Marketing claims in release notes or About that the code does not prove.
7. Mixed icon families or system `monospace`.

---

## 6. Android platform rules

- **Storage:** default to `Download/Maglev`, which is visible in file managers. A custom folder goes through the SAF picker, using direct POSIX writes when possible and otherwise staging plus copy-on-complete. Never request `MANAGE_EXTERNAL_STORAGE` in the Play build.
- **Permissions** are requested during onboarding, each with a reason screen. `POST_NOTIFICATIONS` is requested on API 33+. Battery optimization goes through the system settings intent. Every denial must have a recovery path.
- **Foreground service:** type `specialUse` on API 34+ (no 6-hour cap) and `dataSync` below it. A future Play build flips back to `dataSync` and its `onTimeout` handling. The service runs only while there is work (see [handbook/architecture.md](handbook/architecture.md)), restarts headless after process death, and offers Pause all / Resume all / Shut down. On API 36+ the notification is a promoted Live Update while downloading.
- **Release APKs:** universal, arm64-v8a, armeabi-v7a and x86_64, all from one build (`plugins/withAbiSplits.js`). No x86.

---

## 7. Git workflow

- Branch from `dev` as `feature/<area>-<task>` or `fix/<area>-<task>`. Open the pull request against `dev`. `main` holds releases, tagged.
- **Versions are `<major>.<minor>[.<patch>]`.** Bump with `npm run version:patch`, `version:minor` or `version:major`, which write `app.json` (version, and `android.versionCode = major*10000 + minor*100 + patch`; ABI splits use code*10 + digit) and mirror `package.json`. Tags are `v<major>.<minor>[.<patch>]`; the release workflow refuses a tag that doesn't match `app.json`. Details: [handbook/maintaining.md](handbook/maintaining.md).
- Use Conventional Commits: `feat|fix|refactor|test|docs|ci(<scope>): …`. Keep commits atomic.
- **Release signing:** `plugins/withReleaseSigning.js` signs release builds (v2+v3) from repo secrets `MAGLEV_KEYSTORE_B64`, `MAGLEV_KEYSTORE_PASSWORD`, `MAGLEV_KEY_ALIAS`, `MAGLEV_KEY_PASSWORD`. Without them the build falls back to debug signing, so forks and PRs still build. CI fails a push to `main` or a tag if any APK still carries the Android debug certificate (other branches warn).

---

## 8. Working with several agents

If you split work across several AI agents:

1. **Spec first.** Write the model (`specs/`), the boundary change ([handbook/engine-boundary.md](handbook/engine-boundary.md)) or the acceptance rules before any agent writes code.
2. **One owner per file.** Give each agent one scope and an explicit list of files it owns. Two agents never edit the same file at once.
3. **Ground unfamiliar APIs.** Check every library API against its real source or docs (librqbit, expo-modules-core, expo-router) and cite the URL.
4. **Review everything.** Read the whole diff, run the checks, and wait for CI before calling it done. A human who opens the PR has read every line.

---

## 9. Before you call it done

```bash
npm run check        # every check, one line each, with what it covers
npx tsc --noEmit     # types
npm run models       # TLA+ models, if you touched a feature's states (needs Java)
npm run check:refs   # no new references to private notes
```

CI runs these plus the Rust tests and an APK build. [handbook/testing.md](handbook/testing.md) explains each one and how to read a failure.
