# Maglev: Gap Audit and Task List (2026-11-11)

This audit read the code itself. It did not rely on the ledger.
Contract IDs (`C-*`) match `scripts/test-p3-reality-contracts.js`. Run that script with `npm run test:contracts`.

## 0. What is actually true today

| Claim in LEDGER / README | Reality | Evidence |
|---|---|---|
| "Rust librqbit engine" | **Simulator.** `librqbit` is in `Cargo.toml`, but `engine.rs` never imports it. Progress is `downloaded += 12.5 MB/s / 2` per tick. Nothing reaches the network. Nothing is written to disk. | `native/maglev-core/src/engine.rs:208-219, 306-358` |
| `.so` is the engine | The release `.so` is 0.8 MB. The linker dead-stripped librqbit. The `.so` was last rebuilt in `9d2c44c`, because CI only commits binaries from `dev`. | `jniLibs/*/libmaglev_core.so`; `.github/workflows/build-engine.yml` |
| Foreground service with notification | `MaglevTorrentService.kt` is structurally broken. `startForeground` and `return START_NOT_STICKY` sit inside a companion `fun`. There is no `onStartCommand`. Nothing calls `startForegroundService`. | `service/MaglevTorrentService.kt:32-55` |
| Settings persist | They use `localStorage`, which does not exist on Hermes. Every setting resets on cold start. | `MaglevSettingsStore.ts:107-126` |
| Magnet / .torrent intent | The intent filters are declared, but the app never reads the incoming URL. | no `getInitialURL` / `useURL` in `app/` |
| Governance settings | The TS side sends nested camelCase JSON. Rust expects flat snake_case, and serde silently drops unknown keys. Of all the settings, only the speed presets reach Rust. | `MaglevNativeBridge.ts:259`, `governance.rs:188` |
| Session restore | Nothing is persisted. The torrent list is empty after the app is killed. | `engine.rs:93-101` |
| Tests pass | The tests only `require()` the **TS mock engine**. | `scripts/test-*.js` |

**Order of work:** real engine first, then service and persistence, then permissions and storage, then parity, then UI polish. Building UI parity on top of a simulator is wasted effort.

---

## Phase R: Reality (P0, blocks everything)

| # | Task | Contract |
|---|---|---|
| R1 | Wire `librqbit::Session` (v9.x) into `engine.rs`: add, pause, resume, delete, stats, file list, peers, and the piece bitfield from real chunk state. Delete all simulator constants. | C-ENG-1 |
| R2 | Make CI build the `.so` on every branch and **fail if any `.so` is < 3 MB** or is missing librqbit symbols. Enforce 16 KB page alignment (`-Wl,-z,max-page-size=16384`). | C-ENG-2 |
| R3 | Release builds must **never** fall back to the mock engine silently. If the `.so` fails to load, show a blocking "Engine failed to start" screen. Keep the mock for `__DEV__` and the web only. About must report the true engine. | C-ENG-3 |
| R4 | Enable librqbit session persistence with fast resume. Torrents must survive process death. | C-PERSIST-2 |
| R5 | Persist settings with `react-native-mmkv` (synchronous, about 300 KB) instead of `localStorage`. | C-PERSIST-1 |
| R6 | Rewrite `MaglevTorrentService`. It needs `onCreate`, `onStartCommand`, a notification channel, and a progress notification with **Pause all** and **Shut down** actions. It must implement `onTimeout()` (Android 15 6-hour dataSync cap). Start it with `ContextCompat.startForegroundService`. | C-SVC-1, C-SVC-2 |
| R7 | Add a typed `toNativeConfig(settings)` mapping layer (TS camelCase to the Rust snake_case struct). Add a JNI `getEffectiveConfig()` so tests can assert that the config round-trips. Wire DHT, PEX, LSD, UPnP, port, encryption, proxy, queue caps, and seed limits to the matching librqbit `SessionOptions`. | C-SET-1 |
| R8 | Handle `magnet:` and `.torrent` intents with expo-router `+native-intent.tsx`, then open the Add sheet with the link prefilled. | C-INTENT-1 |

## Phase S: First run, permissions, storage (P0)

| # | Task | Contract |
|---|---|---|
| S1 | **Onboarding route**, three steps: (1) notifications (`POST_NOTIFICATIONS` on API 33+), (2) **download folder picker**, (3) the optional "Keep running in background" battery exemption, which links to system settings. Gate `_layout` on an `onboarded` flag. | C-PERM-1, C-PERM-2 |
| S2 | Fix the `requestMaglevPermissions` result check. It currently tests whether an object is truthy, so a denial is ignored. | C-PERM-1 |
| S3 | **SAF folder picker**: `ACTION_OPEN_DOCUMENT_TREE`, then `takePersistableUriPermission`. Download into app-specific staging, then move completed files into the SAF tree. This avoids slow random writes over SAF. Show the picked folder name in Settings → Storage. | C-SAF-1 |
| S4 | If a persisted URI permission is revoked, show a "Folder access lost: pick again" banner. Do not fail silently. | C-SAF-1 |
| S5 | Add **Open file**, **Share file**, and **Open folder** actions on completed torrents. | (P1) |
| S6 | Sideload/F-Droid flavor only: optional `MANAGE_EXTERNAL_STORAGE` for "Download directly to /Download". Never ship this in the Play build, because Play policy rejects it for torrent clients. | (P2) |

## Phase E: Error and implicit states (P1)

| State | Required behavior | Contract |
|---|---|---|
| Invalid magnet / URL | Reject before the add, with a reason | C-MAG-1 |
| Duplicate torrent | Show "Already in your list" and keep the existing progress | C-DUP-1 |
| Magnet metadata timeout (60 s) | `Fetching info…`, then "Couldn't find this torrent" with **Retry** | C-META-1 (todo) |
| Disk full (ENOSPC) | Torrent goes to `ERROR` with reason "Storage full", and a notification is posted | C-DISK-1 (todo) |
| No network / Wi-Fi-only on cellular | Card shows "Waiting for Wi-Fi" or "Offline", and transfers resume automatically | C-NET-1 (todo) |
| Files deleted externally | Show "Files missing" with **Recheck** and **Locate** | C-MISS-1 (todo) |
| Tracker errors | Show the real per-tracker status | (todo) |
| Engine start failure | Show a blocking error screen, never mock data | C-ENG-3 |
| Back button with a modal open | Close the modal only | C-BACK-1 |
| Clipboard magnet copied while backgrounded | Re-check on `AppState` → active | (todo) |

## Phase P: Parity with LibreTorrent / Flood / qBittorrent (P1)

The "librqbit" column shows whether the library supports the feature today. "Custom" means we have to write it.

| Feature | Status | librqbit |
|---|---|---|
| Sort by name, progress, speed, ETA, size, added, ratio (with asc/desc) | missing | n/a |
| Multi-select with bulk pause, resume, delete, recheck | missing | n/a |
| Pause all / Resume all | UI only | yes |
| Queue (max active, move up/down) | mock only | custom |
| Global speed limits | simulated | yes |
| Per-torrent speed limits | missing | **custom** |
| Scheduler (time windows for limits and pause) | missing | custom (app side) |
| File select | fake (3 files hardcoded) | yes |
| File priority (high, normal, skip) | fake | **no**: map to select/deselect for now |
| Sequential download / streaming | fake stream server | yes (librqbit HTTP streaming) |
| Peers list | count only | yes |
| Trackers add, remove, reannounce | fake | partial / custom |
| Force recheck, move storage | missing | partial |
| Share magnet / export .torrent | missing | yes |
| Create torrent | missing | yes |
| Seed ratio / time limits | not delivered | custom (app side) |
| IP filter | parsed, never applied | partial (blocklists in v8.1+) |
| Encryption (MSE/PE) | dead toggle | **unverified**: spike needed |
| RSS auto-download rules (regex, episode filter) | missing (feeds list only) | custom (app side) |
| Completion notification | missing | n/a |
| Shut down app (stop engine, remove notification) | missing | n/a |

## Phase U: UI and design (P1/P2)

| # | Task | Contract |
|---|---|---|
| U1 | **Theme system**: `useTheme()` palette with `bg`, `card`, `border`, `accent`, `accent2`, `text`, `muted`. Presets: OLED black (default), Dim, Light, and accent swaps (Lime, Cyan, Pink). Replace about 60 hardcoded hex values. | C-UI-THEME |
| U2 | **Settings index**: a list of icon-labelled rows that open sub-screens. Storage · Bandwidth · Torrents & Queue · Interface · Network · Power · Scheduling · Feeds · AI · About. Each row shows its current value (e.g. "Wi-Fi only · 5 MB/s"). | C-UI-SET |
| U3 | Transfers: sort sheet, long-press multi-select with a bulk bar, and a clipboard-magnet chip above the list (not only on the empty state). | C-UI-SORT |
| U4 | **One icon family**: pixel glyphs on an 8×8 grid. Draw about 20 missing glyphs (settings categories, close, back, trash, folder, share, play) and remove all 24 Ionicons uses. Fixed size scale of 16 / 20 / 24. | C-ICON-1 |
| U5 | Fix every touch target under 44 px (`HeaderBar` 28/32, `[id].tsx` 38/40, `search`/`feeds` close 32, add-torrent checkbox 20). | C-A11Y-1 |
| U6 | Add `BackHandler` / `onRequestClose` to all modals, and `KeyboardAvoidingView` to the add sheet and tracker modal. | C-BACK-1 |
| U7 | Search: add a recents row and real error/retry states. Feeds: copy should match the mockup ("+ New feed", "+ Add" / "Added"), and stop silently showing hardcoded fallback feeds. | |
| U8 | Remove copy slop: "(Phase 2 Governance)", "Zero Bloat, Zero Jargon" in About, "Slot pending". | |
| U9 | Logo: rounded-tile angular **M** as the app icon, pixel **MAGLEV** wordmark for the splash and About. | |

## Phase B: Build and size (P1)

| # | Task | Contract |
|---|---|---|
| B1 | Ship 4 release APKs from one build: universal + arm64-v8a + armeabi-v7a + x86_64. Drop x86. Uses the config plugin `plugins/withAbiSplits.js`. | C-APK-1 |
| B2 | Fonts. Of the 27 `.ttf` files in the APK, about 19 are `@expo/vector-icons` icon fonts: the app uses 24 Ionicons glyphs but ships every icon family. Removing them under U4 saves about 4 MB. Text fonts: load ≤ 4 faces and drop JetBrains Mono, which is unused. **Also replace the 107 `fontFamily: 'monospace'` rules**, which currently render the Android system font instead of Space Mono. This is a major source of the off-brand, janky look. | C-APK-1 |
| B3 | Remove `react-native-web` from native builds. Audit Fresco GIF/WebP codecs. | |
| B4 | Fix the release workflow so release notes are honest (no "full protocol parity" while the engine is simulated). | |

Expected sizes after B1–B2: arm64 APK about 16–19 MB, rising to 22–27 MB once real librqbit is linked. The universal APK will be about 45–55 MB.

## Phase X: Exploration (only after R and S)

### X1: AI assistant (bring your own key)
- **One OpenAI-compatible client** (`POST {base}/chat/completions`, Bearer auth, SSE streaming) covers OpenAI, Gemini, Anthropic, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Cerebras, Azure OpenAI, Ollama, LM Studio, HF, NVIDIA NIM, Qwen, and Moonshot. That is 19 of 20 providers checked. Perplexity is partial: it has no tool calls.
- Settings → AI: a provider preset that fills in the base URL, an API key (stored in `expo-secure-store`), a model field with a "Fetch models" button (`GET {base}/models`), and Test connection.
- Send only `model`, `messages`, `stream`, and `tools`. Anthropic and Cerebras reject `n`, the penalty parameters, and `response_format: json_object`.
- OpenRouter: use "Connect OpenRouter" via OAuth PKCE so users bring their own key. **Never embed a key in the APK**, because anyone can extract it. Free models allow 20 requests/min and 50 requests/day (1,000/day once the account has bought $10 of credits). Send the `HTTP-Referer` and `X-Title` headers.
- Useful tools for the agent: `search_torrents`, `add_magnet`, `pause/resume`, `set_limits`, `explain_error`, and "create RSS rule from description".

### X2: Download from any URL
- Implement in the Rust core with `reqwest` on the existing tokio runtime. It shares the rate limiter, queue, persistence, and foreground service with torrents. Use Range/ETag resume, 4-way segmented download, and persisted offsets.
- On API 34+, wrap user-started downloads in a User-Initiated Data Transfer job.
- Effort: about 3–5 days after Phase R. Doing it before R would duplicate the service and persistence work.
