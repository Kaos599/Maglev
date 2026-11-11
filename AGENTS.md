# AGENTS.md: Operating Guide for AI Agents and Engineers

> **Project:** Maglev, a minimal and fast Android torrent client
> **Stack:** React Native 0.88 + Expo SDK 58 (expo-router, Hermes, new arch) · Kotlin Expo Module · Rust (`librqbit` 9.x)
> **Integration branch:** `dev` · **Releases:** `main` (tags)
> **Rule 0:** Zero bloat, zero jargon, pure utility. **Rule 1:** Nothing is "done" until a contract proves it on real code.

---

## 1. Identity

Maglev replaces LibreTorrent and Flood on a phone. It should feel minimal, quick and playful, with a retro feel that stays modern and readable for a general audience.

| Token | Value | Use |
|---|---|---|
| Void | `#05070A` | OLED background |
| Card / border | `#0D1117` / `#1F2937` | Surfaces with a 1px hairline border, no shadows |
| Accent | `#CCFF00` (lime) | Primary actions, active state, done |
| Accent 2 | `#00E5FF` (cyan) | Downloading, inbound speed |
| Danger | `#FF3366` | Destructive actions, errors |
| Muted | `#8B949E` | Telemetry, paused |
| App icon | `#282828` tile, `#D0FF00` angular "M" | See `screens/1.css`. The launcher icon only. |

Colours are reached through `useTheme()` and never written as hex outside `constants/`. Fonts are Silkscreen (brand and headers), Space Mono (filenames and telemetry, `tabular-nums`) and Inter (copy). **Never use `fontFamily: 'monospace'`.** Use one icon family only: the pixel glyphs in `components/PixelIcons.tsx`.

---

## 2. Repository map

```
app/                     expo-router screens (tabs, add-torrent, torrent/[id], onboarding, settings/*)
components/              UI components and PixelIcons
constants/               design tokens, theme palettes, haptics
context/                 EngineContext, SettingsContext
utils/                   permissions, formatting
modules/maglev-engine/
  src/                   TS bridge (MaglevNativeBridge), mock engine (dev/web only), settings store, toNativeConfig
  android/               Kotlin: NativeCore (JNI), MaglevEngineModule, foreground service, storage, governance
native/maglev-core/      Rust: librqbit session, scheduler (pure), JNI exports, stream server
plugins/                 Expo config plugins (ABI splits)
scripts/                 contract tests (test-p3-reality-contracts.js, test-abi-splits.js)
screens/                 design mockups (HTML) and the app icon spec (1.css)
docs/                    the law (see §3)
.github/workflows/       ci.yml (every push), release-apk.yml (tags), _rust-android.yml (reusable)
```

---

## 3. Documents (read before writing code)

| File | Purpose |
|---|---|
| `docs/ROADMAP.md` | Phases, task list, state-machine priorities (P0/P1/P2), the phase-out list. **The only task list.** |
| `docs/NATIVE_CONTRACT.md` | The exact Rust ⇄ Kotlin ⇄ TS boundary: JNI signatures, JSON shapes, error codes, state rules, storage policy. Change this file **first** whenever the boundary changes. |
| `docs/STATE_MACHINES_AND_SCREENS.md` | Screens and state machines. Implement transitions 1:1 and never invent ad-hoc states. |
| `docs/DESIGN_SYSTEM_TOKENS.md` | Tokens, type scale, component specs, anti-slop rules. |
| `docs/ARCHITECTURE_AND_GOAL.md` | Layers, SLAs and the memory/battery budget. |
| `LEDGER.md` | A dated log of what landed, with commit hash and CI run. Only history, never plans. |

---

## 4. Reality rules (non-negotiable)

These rules exist because Phase 1 was once marked "complete" while the engine was a simulator.

1. **No simulation in release builds.** The mock engine (`MaglevMockEngine.ts`) runs only under `__DEV__` or on web. If the native engine fails to load in release, the app shows "Engine failed to start". It never shows fake data.
2. **No fabricated values in the bridge.** No hardcoded files, peers, trackers, sizes or speeds. Unknown is shown as unknown (for example `eta: -1`, shown as "—").
3. **Contracts are the definition of done.** `npm run test:contracts` exits 1 while any P0 fails. A ledger or roadmap entry may say "Done" only with a green CI run and the passing contract IDs.
4. **CI is the compiler.** Rust and Gradle are never installed locally. CI rejects a `.so` under 3 MB, a `.so` without librqbit symbols, or a `.so` without 16 KB page alignment.
5. **Native binaries are never committed.** `jniLibs/` is gitignored. CI builds the binaries on every push.
6. **Settings must round-trip.** Every user-facing setting is persisted (expo-sqlite kv-store) and reaches Rust through `toNativeConfig`. `nativeGetEffectiveConfig` proves it. A toggle that does nothing must not ship.
7. **Errors are plain English and recoverable.** Each error code in `NATIVE_CONTRACT.md` maps to a message and an action (Retry, Recheck, Pick folder again, Open settings).

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
- **Foreground service:** type `specialUse` on API 34+ (no 6-hour cap) and `dataSync` below it. A future Play build flips back to `dataSync` and its `onTimeout` handling. The service runs only while a torrent is downloading or seeding, restarts headless after process death (`NATIVE_CONTRACT.md` §8), and offers Pause all / Resume all / Shut down. On API 36+ the notification is a promoted Live Update while downloading (§10.4).
- **Release APKs:** universal, arm64-v8a, armeabi-v7a and x86_64, all from one build (`plugins/withAbiSplits.js`). No x86.

---

## 7. Git workflow

- Branch from `dev` as `feature/<phase>-<task>` (for example `feature/p2-onboarding`). Merge to `dev` when CI and the phase contracts pass. Release with a tag on `main`.
- Use Conventional Commits: `feat|fix|refactor|test|docs|ci(<scope>): …`. Keep commits atomic.
- After a merge, append to `LEDGER.md`: date, task IDs, commit, CI run URL, and the contract IDs that turned green.

---

## 8. Orchestration protocol (multi-agent)

The lead agent (orchestrator) writes specs and reviews. Worker agents write code.

1. **Contract first.** The orchestrator writes or updates the contract (a `NATIVE_CONTRACT.md` section, state machine, or contract test) **before** dispatching any work.
2. **Workers run on cheaper models.** Code-writing agents use Sonnet, or Haiku for mechanical work such as CI and renames. Each gets **one contract scope** and an explicit list of files it owns. Two agents never own the same file in one wave.
3. **Ground unfamiliar APIs.** Workers verify every library API against its real source or docs (librqbit tag source, expo-modules-core, expo-router) and cite URLs in their report.
4. **Review is mandatory.** The orchestrator reads the diff, runs the contract and unit tests, and checks CI before accepting. Compiler errors from CI go back to the owning agent.
5. **Workers never commit or push.** The orchestrator commits atomically per contract scope.

---

## 9. Skills

| Skill | When |
|---|---|
| `superpowers:test-driven-development` | Every contract change: red, then green |
| `code-review` / `nemesis-review` agent | Before merging a phase |
| `anti-slop-writing` | UI copy, release notes, docs |
| `make-interfaces-feel-better`, `unslop` | Phase 2 UI work |
| `building-components` | New RN components (accessible, composable) |
