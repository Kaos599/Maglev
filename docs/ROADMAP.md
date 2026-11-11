# Maglev Roadmap (supersedes PHASE_ROADMAP_AND_CONTRACTS.md and GAP_AUDIT_AND_TASKS.md)

> Status is measured, not claimed. A task is **Done** only when its contract passes in `npm run test:contracts` **and** CI is green on the merge commit.
> Engine boundary: [`NATIVE_CONTRACT.md`](NATIVE_CONTRACT.md). State machines: [`STATE_MACHINES_AND_SCREENS.md`](STATE_MACHINES_AND_SCREENS.md).

## 1. Baseline (audited 2026-11-11)

What existed before Phase 1:

| Area | Problem | Evidence |
|---|---|---|
| Engine | Rust core simulated progress. librqbit was never imported. The `.so` was 0.8 MB and stale. | `engine.rs:208-219` |
| Service | The foreground service did not compile in any meaningful form and was never started. | `MaglevTorrentService.kt:32-55` |
| Settings | Saved to `localStorage`, which does not exist on Hermes, so everything reset on launch. Only the speed presets ever reached Rust. | `MaglevSettingsStore.ts:107` |
| Permissions | No first-run flow. A notification denial was ignored. | `add-torrent.tsx:297-300` |
| Storage | No folder picker. Files went to the hidden `Android/data` folder. | `StorageManager.kt:12` |
| Intents | `magnet:` and `.torrent` taps opened the app and did nothing. | — |
| UI | Mixed icon families at 10 sizes. 107 styles fell back to the system `monospace` font. One 1,490-line settings page. The theme setting only swapped the background colour. | UI audit |
| APK | 85 MB: 4 ABIs at about 20 MB each, plus 19 unused icon fonts. | APK breakdown |

---

## 2. State machines: broken or missing

Each machine is listed with its state and priority. "Spec" means it exists in `STATE_MACHINES_AND_SCREENS.md`. "Code" means it is implemented for real, not in the mock.

### P0: the app does not work without these

| # | State machine | Spec | Code | What is wrong / missing |
|---|---|---|---|---|
| SM-1 | **Torrent lifecycle** (Resolving → Ready → Downloading ⇄ Paused → Seeding → Completed, plus Error, Queued, Checking) | partial | ❌ simulated | Every state was faked. Missing states: `QUEUED`, `CHECKING`, `COMPLETED`, and the `paused_by` reason (user vs Wi-Fi vs battery vs seed limit). The metadata timeout was spec'd at 15 s; the contract now uses 60 s with Retry. |
| SM-2 | **App boot / engine availability** (Booting → Ready ⎮ EngineUnavailable) | ❌ | ❌ | A release build fell back to the mock engine silently. Needs a blocking "Engine failed to start" state. |
| SM-3 | **First run / onboarding** (Welcome → Notifications → Folder → Background → Done) | ❌ | ❌ | Does not exist. Permissions were never requested up front. |
| SM-4 | **Permission states** per permission: Undetermined → Granted ⎮ Denied ⎮ PermanentlyDenied (open Settings) | ❌ | ❌ | A denial was ignored and there was no recovery path. |
| SM-5 | **Storage location** (Default public ⎮ Fallback private ⎮ Custom direct ⎮ Custom staging → copy-on-complete ⎮ AccessLost) | partial (POSIX/SAF) | ❌ | The picker was not wired. There was no copy-on-complete and no revoked-access detection. |
| SM-6 | **Foreground service** (Stopped → Active ⇄ Updating → TimedOut (Android 15 6 h) → Stopped) | partial | ❌ broken | Never started. No `onTimeout`. Notification actions were dead. |
| SM-7 | **Session persistence** (Cold start → Restoring → Ready; process death → same list) | ❌ | ❌ | The torrent list was empty after any kill. |
| SM-8 | **Settings persistence and apply** (Edited → Persisted → Applied ⎮ RestartRequired) | ❌ | ❌ | Settings never persisted and never reached the engine. |
| SM-9 | **Add torrent flow** (Input → Validating → InvalidSource ⎮ Resolving → MetadataTimeout ⎮ Preview → Duplicate ⎮ Added) | partial | ❌ | Invalid and duplicate sources were accepted. A duplicate add reset progress. |
| SM-10 | **Incoming intent** (magnet or .torrent from another app → Add sheet prefilled) | ❌ | ❌ | Not handled. |

### P1: required to match LibreTorrent / Flood

| # | State machine | Spec | Code | What is wrong / missing |
|---|---|---|---|---|
| SM-11 | **Network governance** (Evaluating → Wi-Fi allowed ⎮ SSID blocked ⎮ Cellular blocked ⎮ Offline → auto-resume) | ✅ | ❌ | Rules were never evaluated. SSID matching needs location permission on Android 10+, which was unhandled. |
| SM-12 | **Power governance** (Charging ⎮ Battery OK ⎮ Battery cutoff ⎮ Charging-only block → Auto-exit) | ✅ | ❌ | `configure()` was never called. |
| SM-13 | **Queue scheduler** (max active downloads and seeds, promotion order) | ❌ | mock only | — |
| SM-14 | **Seeding limits** (ratio / time reached → Paused with reason `seed_limit`) | ✅ | ❌ | — |
| SM-15 | **Error recovery** (DiskFull ⎮ Permission ⎮ FilesMissing ⎮ Network → Retry / Recheck / Locate) | partial | ❌ | Nothing ever set the ERROR state. |
| SM-16 | **Transfers list modes** (Browse ⇄ Filtered ⇄ Sorted ⇄ Multi-select with a bulk-action bar) | ❌ | ❌ | No sort or multi-select. |
| SM-17 | **Completed file actions** (Open / Share / Open folder; staging copy pending) | ❌ | ❌ | — |
| SM-18 | **Notification actions** (Pause all ⎮ Resume all ⎮ Shut down → app exits cleanly) | partial | ❌ | Shut down did not exist. |
| SM-19 | **Async request states for Search and Feeds** (Idle → Loading → Results ⎮ Empty ⎮ Error with Retry) | ❌ | partial | Failures silently fell back to hardcoded feeds. |
| SM-20 | **Theme** (OLED ⎮ Dim ⎮ Light × accent, persisted, applied without restart) | partial | ❌ | Only the background colour changed. |

### P2: polish

| # | State machine | Notes |
|---|---|---|
| SM-21 | **Modal and back-stack** | Back closes the top modal only; keyboard avoidance. |
| SM-22 | **Card action button `BUSY`** | Debounce while a pause or resume is in flight (spec'd, not built). |
| SM-23 | **Clipboard magnet detection on resume** | Was checked only at mount. |
| SM-24 | **Piece grid** (missing / partial / have) | Fed from the real bitfield. Remove the `BLOCK_CORRUPT` flash unless librqbit exposes hash failures. |
| SM-25 | **RSS auto-download rules** (Rule → Match → Queued → Added ⎮ Skipped duplicate) | — |
| SM-26 | **Scheduler** (time windows → limit profile or pause) | — |

---

## 3. Phases

Each phase builds the foundation for the next. **Do not start a phase until the previous phase's P0 contracts are green.**

### Phase 1: Foundation (engine, service, persistence, CI)

Covers SM-1, 2, 6, 7, 8, 9, 10, 13, 14, 15.

| Task | Owner (agent) | Contract |
|---|---|---|
| 1.1 Real librqbit 9.x engine per `NATIVE_CONTRACT.md` | Rust | C-ENG-1, C-ENG-2 |
| 1.2 Pure scheduler module: queue, seed limits, governance gate, error mapping | Rust | Rust unit tests |
| 1.3 Session and metadata persistence with fast resume | Rust | C-PERSIST-2 |
| 1.4 `NativeCore` JNI holder, Expo module API, real foreground service, notification actions, Android 15 timeout | Kotlin | C-SVC-1, C-SVC-2 |
| 1.5 Storage policy (public `Download/Maglev`, SAF picker, staging copy) and permission helpers | Kotlin | C-SAF-1, C-PERM-2 |
| 1.6 Typed bridge, no release mock, `toNativeConfig`, settings in expo-sqlite kv-store, intents | TS | C-ENG-3, C-PERSIST-1, C-SET-1, C-INTENT-1 |
| 1.7 Mock engine enforces the same validation as the real engine (dev and web only) | TS | C-DUP-1, C-MAG-1 |
| 1.8 CI: build the `.so` on every push, size/reality/16 KB-alignment gate, APK artifact on every branch, stop committing binaries | CI | C-ENG-2 (gate) |
| 1.10 **Background survival**: START_STICKY with headless re-init, persisted governance and user intent, `specialUse` service on API 34+ (no 6 h cap), battery-kill nudge (`NATIVE_CONTRACT.md` §8) | Kotlin | C-SVC-3 (todo) |
| 1.9 Delete the simulator and its redundant tests (`test-e2e.js`, `test-p2-contracts.js`, `test-verification-playbook.js` exercise the old mock API) | Orchestrator | — |

**Exit gate:** all P0 engine, service and persistence contracts pass. A CI APK installed on a device downloads a real public torrent (for example a Debian netinst) into `Download/Maglev`, survives `adb shell am kill`, and keeps running for 10 minutes in the background with the notification visible.

### Phase 2: Usable app (first run, UI foundation, icons, settings)

Covers SM-3, 4, 5 (UI), 11, 12, 16, 17, 18, 20, 21.

| Task | Contract |
|---|---|
| 2.1 **Theme foundation**: `useTheme()` with semantic tokens; OLED / Dim / Light × Lime / Cyan / Pink accents; no hex values outside `constants/` | C-UI-THEME |
| 2.2 **Type foundation**: replace all 107 `'monospace'` uses with the token fonts; load ≤ 4 faces (Silkscreen 400, Space Mono 400/700, Inter 400/600); `tabular-nums` on all telemetry | C-APK-1 |
| 2.3 **Icon foundation**: one pixel-glyph family (8×8 grid, sizes 16/20/24); about 30 glyphs including settings categories; remove `@expo/vector-icons` | C-ICON-1 |
| 2.4 **App icon** from `screens/1.css`: rebuilt as a vector "M" in a #282828 rounded tile, with launcher, adaptive and splash variants | — |
| 2.5 **Onboarding** (SM-3/4/5): Notifications → Download folder → Background running → Done; gated by `onboarded` | C-PERM-1 |
| 2.6 **Settings index**: icon-labelled rows (Storage · Bandwidth · Torrents & Queue · Interface · Network · Power · Scheduling · Feeds · About), each a sub-screen with a value preview | C-UI-SET |
| 2.7 **Transfers**: sort sheet, long-press multi-select with bulk bar, clipboard chip, real state badges (Queued, Waiting for Wi-Fi, Storage full, Files missing) | C-UI-SORT |
| 2.8 **Detail**: real files (include/exclude), peers, trackers, piece grid; Open / Share / Open folder; Recheck | — |
| 2.9 **Engine-unavailable screen, storage banners** (fallback, access lost) | C-ENG-3 |
| 2.10 a11y and back: 44 px minimum touch targets, `onRequestClose` and `BackHandler`, keyboard avoidance | C-A11Y-1, C-BACK-1 |
| 2.11 Remove copy slop and fix nav label consistency | — |

**Exit gate:** every contract passes. A fresh install walks through onboarding, adds a magnet from the browser, downloads it, opens the file, and changes the theme.

### Phase 3: Parity and power features

Covers SM-19, 22–26.

- Per-torrent speed limits (custom in Rust)
- Tracker add / remove / reannounce
- Move storage
- Share magnet / export .torrent
- Create torrent
- Scheduler
- RSS rules with regex and episode filters
- Search providers with error and retry states
- IP blocklist via librqbit
- Encryption setting (verify librqbit MSE support; hide the setting if unsupported)
- Streaming polish

### Phase 4: Exploration (only after Phase 3)

- **AI assistant, bring your own key.** An OpenAI-compatible client, provider presets, keys stored in `expo-secure-store`, and OpenRouter OAuth. See the research notes in `LEDGER.md` (2026-11-11).
- **Download from any URL.** Rust `reqwest` on the shared runtime and service; Range/ETag resume; segmented downloads; a User-Initiated Data Transfer job on API 34+.

### Phase-out (removed or retired)

| Item | Action | Reason |
|---|---|---|
| Rust simulator code (`governance.rs` token bucket, fake trackers, fake stream) | **Delete** (Phase 1) | Replaced by librqbit |
| `.so` binaries committed to git and `build-engine.yml` | **Delete** (Phase 1) | Stale, and they bloat the repo. CI builds them. |
| `scripts/test-e2e.js`, `test-p2-contracts.js`, `test-verification-playbook.js` | **Delete** (Phase 1) | They test the old mock API and produced false greens |
| `docs/PHASE_ROADMAP_AND_CONTRACTS.md`, `docs/GAP_AUDIT_AND_TASKS.md` | **Deleted** | Superseded by this file |
| `docs/BITTORRENT_AND_NATIVE_RESEARCH.md` | **Deleted** | Generic BEP background. The engine details now live in `NATIVE_CONTRACT.md`. |
| `@expo/vector-icons`, JetBrains Mono, unused font weights | **Remove** (Phase 2) | About 4.5 MB of APK |
| `react-native-web` in native builds | **Review** (Phase 2) | Kept only if the web dev preview is still wanted |
| `scripts/generate-icons.js` | **Replace** (Phase 2.4) | New vector icon pipeline |
| x86 (32-bit) ABI | **Dropped** | Only used by emulators; about 20 MB |
