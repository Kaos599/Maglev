# Architecture

Maglev is one Android app built from three layers. TypeScript draws every screen and decides nothing about bytes. Kotlin talks to Android. Rust moves the bytes. This page says what each layer owns, how a download travels through them, where state is kept, and what happens when Android kills the app.

The exact calls and JSON between the layers are in [engine-boundary.md](engine-boundary.md).

## The three layers

```
┌───────────────────────────────────────────────────────────────┐
│ TypeScript: React Native 0.88, Expo SDK 58, expo-router       │
│ app/  components/  context/  utils/  constants/               │
│ Screens, copy, settings, search, feeds, browser UI, assistant │
└──────────────────────────────┬────────────────────────────────┘
                 maglevEngine  │  MaglevNativeBridge.ts
┌──────────────────────────────▼────────────────────────────────┐
│ Kotlin: Expo module MaglevEngine (modules/maglev-engine/android)│
│ EngineHost: start/stop, poll loop, rules, service, storage,   │
│ notifications, WebView, updater, yt-dlp, WorkManager jobs     │
└──────────────────────────────┬────────────────────────────────┘
                   NativeCore  │  JNI, JSON strings
┌──────────────────────────────▼────────────────────────────────┐
│ Rust: native/maglev-core → libmaglev_core.so                  │
│ librqbit 9.1 session, queue planner, link downloader,         │
│ HLS/DASH saver, loopback stream server                        │
└───────────────────────────────────────────────────────────────┘
```

| Layer | Owns | Doesn't own |
|---|---|---|
| **TypeScript** | Every screen and every word on it. Settings and their storage. Search sources, feed parsing in the foreground, Watches, subtitles, the assistant, Stats, backups. Turning engine codes into plain English and buttons. | Any transfer state. TS shows what the engine reports and never makes up a value. |
| **Kotlin** | Starting and stopping the engine. The poll loop and telemetry events. The foreground service, its notification and the Quick Settings tile. The rules that hold transfers (network, VPN, battery, charging, schedule, low storage). The download folder, SAF and the copy into a picked folder. Restarts after reboot, app update or process death. The browser WebView, the in-app updater, yt-dlp, feed and retry jobs. | Torrent or download state. Kotlin tells Rust "transfers allowed / not allowed, because of tag X" and reads back what Rust decided. |
| **Rust** | The librqbit session and everything it persists. Torrent state, the queue and seed limits (`scheduler.rs`, pure). Link downloads (`http_dl/`, with a pure state machine in `machine.rs`). Saving HLS and DASH streams. The stream server on `127.0.0.1`. File health checks. Plain-English error messages. | Anything Android: no permissions, no notifications, no folders it didn't receive as a path. |

Rule of thumb: if it needs an Android API, it goes in Kotlin. If it decides what a transfer does next, it goes in Rust. If a person reads it, it goes in TypeScript.

## A download, start to finish

Here is a link download from the Add screen. A torrent follows the same path with `resolveMetadata` and `addTorrent` in place of `probeUrl` and `addDownload`.

| Step | Layer | What happens | Code |
|---|---|---|---|
| 1 | TS | The user pastes a link. The screen checks it looks like a link and probes it. | `app/add-download.tsx` |
| 2 | TS → Kotlin → Rust | `probeUrl` asks the server for name, size and whether it can resume. Nothing is saved yet. | `EngineHost.probeUrl` → `nativeProbeUrl` |
| 3 | TS | The free-space check compares the size with free space minus what running transfers still need and a 200 MB reserve: `Fits`, `Tight` or `DoesntFit`. | `utils/admission.ts`, `utils/useDownloadAdmission.ts` |
| 4 | TS → Kotlin | `addDownload`. Kotlin fills in the active download folder when the caller didn't pick one. | `EngineHost.addDownload` |
| 5 | Rust | The record is created. The link-download machine moves it `resolving` → `queued` or `downloading`, or straight to `paused` when a rule holds transfers. The record and a resume file beside the partial file are written to disk. | `RS/http_dl/machine.rs`, `RS/http_dl/sidecar.rs` |
| 6 | Kotlin | `pollNow()` wakes the poll loop. Every poll calls `nativeListTorrents`, which returns torrents and link downloads. | `EngineHost.pollLocked` |
| 7 | Kotlin | From the poll: start the foreground service when there is work, update its notification and the tile, count completions, schedule automatic retries. | `EngineHost.driveService`, `AutoRetryWorker.kt` |
| 8 | Kotlin → TS | `onTelemetry` carries the snapshots. In the background it fires at most every 5 s. | `MaglevNativeBridge.ts` `bind` |
| 9 | TS | `EngineContext` smooths the speeds, merges in pending taps (a pause shows at once) and hands the list to the Transfers screen. | `context/EngineContext.tsx`, `utils/optimistic.ts` |
| 10 | Rust | All bytes arrive. The machine goes `verifying` (checksum or joining video and audio), then `finished`. | `RS/http_dl/driver.rs`, `KT/MuxJobs.kt` |
| 11 | Kotlin | On the finished edge: copy into a picked (SAF) folder when downloads are staged, ask the media scanner, post "Downloaded". For torrents this keys off `finished` going false → true, never the state name. | `EngineHost.detectCompletions` |
| 12 | Kotlin | With nothing left running or held by a rule, the service stops itself. | `EngineHost.driveService` |

If a rule blocks a transfer partway (Wi-Fi lost with Wi-Fi only on), Kotlin calls `nativeSetTransfersAllowed(false, "wifi_only")`. Rust pauses what's running and tags it. When the rule clears, Rust resumes only the transfers carrying that tag; a transfer the user paused stays paused.

## Where state lives

| State | Layer | Stored in | Survives process death |
|---|---|---|---|
| User settings (`MaglevSettings`) | TS | expo-sqlite kv-store through `MaglevSettingsStore.ts`, read synchronously so the first frame has them. `SettingsContext` holds the live copy. | yes |
| Other preferences (search, browser, tabs, feeds, Watches, tips…) | TS | kv-store through `utils/prefs/kv.ts` | yes |
| Browser history and saved tabs | TS | expo-sqlite database, `utils/history/db.ts` | yes (private tabs never saved) |
| Assistant API keys | TS | expo-secure-store; never written to backups | yes |
| Transfer list for the first frame | TS | `utils/transferCache.ts`: names, sizes and states the engine last reported, never speeds | yes |
| Live telemetry, notices, the undo window, pending taps | TS | `EngineContext` | no; rebuilt from the next poll |
| What the user wants: Shut down, Pause all, "work wanted", schedule held, the last heartbeat | Kotlin | SharedPreferences `maglev_engine`, `maglev_schedule`, `maglev_governance` | yes. A restart reads these first. |
| Rule settings for headless starts | Kotlin | SharedPreferences, written by `setGovernance` | yes |
| Feed and retry queues | Kotlin | SharedPreferences `maglev_feeds`, `maglev_autoretry`, plus WorkManager | yes |
| Torrents, their state, `pausedBy`, add time, fast-resume data | Rust | librqbit JSON persistence in the session folder | yes |
| Link downloads, priorities, per-torrent limits, edited trackers | Rust | `maglev-downloads.json`, `maglev-priorities.json`, `maglev-limits.json`, `maglev-trackers.json` in the session folder | yes |
| Resume data for one link download | Rust | `<name>.maglev-dl.json` beside `<name>.part`. Never holds cookies, headers or the query, because the folder is public. | yes; a download that needed them goes to `needs_link` |
| Engine config | Rust | Saved with the session. `nativeInit("")` reuses it. | yes |

Settings flow one way: the settings screen writes the store, the store notifies `SettingsContext`, and `maglevEngine.applySettings` pushes the config to Rust and the rules to Kotlin. `getEffectiveConfig` reads back what Rust is actually using. See [engine-boundary.md](engine-boundary.md#settings-round-trip).

## The foreground service and process death

Android kills background apps. Maglev keeps transfers alive with a foreground service and brings them back when Android wins anyway.

**When the service runs.** `EngineHost` decides from each poll. The service runs while anything is downloading, seeding, resolving, checking, streaming or held by a rule (so it can resume by itself). It stops when none is left. JS never starts or stops it.

**Service type.** `specialUse` on API 34 and up, which has no 6-hour cap. `dataSync` below 34. The constant `USE_SPECIAL_USE_FGS` in `MaglevTorrentService.kt` switches a store build back to `dataSync`, where Android 15's time limit applies and `onTimeout` pauses everything with the `fgs_timeout` tag.

**The notification.** It always offers **Shut down** while it shows. **Pause all** appears only while something runs; **Resume all** only while something is paused by the user. On API 36 and up it is a promoted Live Update while downloading.

**After Android kills the process.** The service is `START_STICKY`, so Android restarts it without the app's JS. Then:

```
service restarts (no JS)
  └─ EngineHost.headlessStart, under the lifecycle lock
       ├─ read the saved intent: user_shutdown, user_paused_all, scheduleHeld
       ├─ RestartPolicy.decide → StayStopped  (any of those set, or no work)  → stop the service
       └─                       → Resume       → nativeInit("") with the saved config,
                                                 rules from SharedPreferences, transfers continue
```

What the user asked for always wins: a sticky restart never brings back transfers they shut down or paused. A shutdown counter stops a headless start that was queued before a Shut down tap from undoing it.

**Other ways back** (`RestartEntry.kt`, `BootReceiver.kt`):

| Entry | What happens |
|---|---|
| Phone reboot | With "Resume after restart" on and work left, a headless start. On a `dataSync` build Android 15 forbids starting from boot, so Maglev posts "Tap to continue your downloads" instead. |
| App updated | The same as a reboot. |
| App opened after a kill | If the heartbeat is more than 2 minutes old, the last state was running and the service isn't, the app says Android stopped it. Settings → Needs attention counts these kills and links to battery settings. |
| User stopped the app from Android's task manager | Seen on the next open through the process exit reasons (API 30+). Restarts once through the normal path. |

**What is lost.** Whatever lived only in memory: a multi-item share still waiting in the queue, the video-site link refresh, search source health, and the live speeds. Everything in the "Survives" column above comes back.

## Memory and battery

Only numbers the code enforces. `scripts/test-power-budget.js` checks the service and poll ones.

| Budget | Value | Where |
|---|---|---|
| Poll while busy | 1 s | `EngineHost.kt` `BUSY_POLL_MS` |
| Poll while idle (seeding only, or nothing) | 5 s | `IDLE_POLL_MS` |
| Telemetry to JS with the app in the background | at most every 5 s; once at once on return | `BACKGROUND_EMIT_MS` |
| Wake lock and Wi-Fi lock | Held only while something downloads, resolves, checks or streams, or upload ran above 32 KiB/s in the last 60 s. Idle seeding holds none. | `MaglevTorrentService.wantsLocks` |
| Wi-Fi lock | Only below API 34 | `MaglevTorrentService.kt` |
| Lock timeout | 15 min, refreshed every 10 min | `LOCK_TIMEOUT_MS`, `LOCK_REFRESH_MS` |
| Notification updates | at most every 2 s | `NOTIFY_MIN_INTERVAL_MS` |
| Rust runtime | one tokio runtime, 2 worker threads | `RS/engine.rs` |
| Live browser tabs | 3 live WebViews, 50 tabs; older ones sleep | `utils/browser/tabs.ts` `MAX_LIVE`, `MAX_TABS` |
| Free-space reserve | 200 MB kept free; "tight" within 1 GB | `utils/admission.ts`, `KT/storage/Admission.kt` |
| Link download retries | 10 attempts, 5 for stalls | `RS/http_dl/machine.rs` |
| Stream counts as active | 60 s after the last byte served | `RS/streaming.rs` |
| Native library | built for size (`opt-level = "s"`, LTO, stripped); CI rejects a `.so` under 3 MB or without 16 KB page alignment | `native/maglev-core/Cargo.toml`, `.github/workflows/_rust-android.yml` |
| Release JS bundle | the simulator engine can't be reached from release code, so Metro drops it | `scripts/test-bundle-slim.js` |

## Repo map

```
app/                       Screens (expo-router). (tabs)/ holds Transfers, Search, Feeds, Browse, Assistant, Settings.
  settings/                One file per settings page.
components/                UI pieces, grouped by screen (transfers/, detail/, browser/, search/, assistant/, ui/…).
context/                   EngineContext (transfers), SettingsContext, ThemeContext.
constants/                 Theme tokens, copy, font styles, generated icon and licence tables. The only place hex colours live.
utils/                     Logic without React: admission, copy builders, search, feeds, watch, subtitles,
                           assistant, update, lists, backup, stats, prefs. Pure functions where possible.
modules/maglev-engine/
  src/                     The TS side of the boundary: types, the bridge, settings store, toNativeConfig,
                           the dev-only simulator, the browser view component.
  android/                 Kotlin: the Expo modules, EngineHost, NativeCore, the service, storage, rules,
                           browser, updater, feeds, video sites, share. Unit tests in android/src/test/.
native/maglev-core/        Rust engine. src/ for the code, vendor/ for patched librqbit and the TLS shim.
plugins/                   Expo config plugins: ABI splits, signing, share intents, app icons, backup rules.
scripts/                   Checks (test-*.js), generators (gen-icons, gen-licenses), release tools.
.maestro/                  End-to-end flows run on an emulator in CI.
.github/workflows/         ci.yml (every push and PR), release-apk.yml (tags), e2e.yml, pages.yml, audit.yml.
release-notes/             One file per version.
lists/                     The signed list of search sources, trackers and ad lists the app fetches.
site/                      The project website, published by pages.yml.
distribution/, fastlane/   Store recipes and listing text.
specs/                     TLA+ models, one folder per feature. See state-machines.md.
handbook/                  This guide.
```

## See also

- [engine-boundary.md](engine-boundary.md): every call, event, shape and error code across the layers.
- [feature-map.md](feature-map.md): every feature, its states and whether it has a model.
- [state-machines.md](state-machines.md): how to write a model before you change how something moves between states.
- [maintaining.md](maintaining.md): branches, versions and releases.
