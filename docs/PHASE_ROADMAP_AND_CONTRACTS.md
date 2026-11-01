# MAGLEV — Phase Roadmap, Task Lists & Contract Sheets (Audited & Locked)

---

## 🚀 Phase 1: Core BitTorrent Engine & Transfers

### Objective
Deliver a fully functional, native-speed BitTorrent client capable of ingesting magnet links and raw `.torrent` files, downloading to Android storage with piece verification, seeding to the swarm, and displaying real-time HUD telemetry.

### Detailed Task List
- [x] **Task 1.1:** Setup Rust `librqbit` mobile cross-compilation pipeline with `cargo-ndk` targeting `arm64-v8a`, `armeabi-v7a`, `x86_64` (Tokio tuned to 2 worker threads).
- [x] **Task 1.2:** Implement Kotlin JNI bridge with internal MPSC channel and dedicated daemon dispatcher thread exposing lifecycle methods (`startTorrent`, `openTorrentFile`, `pauseTorrent`, `resumeTorrent`, `deleteTorrent`, `setFilePriority`, `getPieceBitfield`, `getTrackers`, `addTracker`, `reannounce`).
- [x] **Task 1.3:** Configure Android `intent-filter` in `AndroidManifest.xml` for `magnet:` URI scheme and `application/x-bittorrent` / `application/x-torrent` MIME types.
- [x] **Task 1.4:** Build Android `ForegroundService` (`dataSync`) with persistent speed notification; automatically call `stopForeground(STOP_FOREGROUND_REMOVE)` when active count is 0.
- [x] **Task 1.5:** Implement default storage destination in Android App-Specific External Storage (`/Android/data/com.maglev/files/Download`) for zero-copy direct POSIX writes with `EOPNOTSUPP` fallback.
- [x] **Task 1.6:** Implement Expo Native Module (`MaglevEngineModule`) with zero-GC native SIMD bitfield downsampling (`[u8; 256]` via `DirectByteBuffer`) at 500ms cadence.
- [x] **Task 1.7:** Build **Transfers Screen** (Active cards, speed badges, pause/resume, global `[Pause All]` / `[Resume All]`, horizontal swipeable filter pills: All, Down, Up, Paused).
- [x] **Task 1.8:** Build **Empty State Screen** with clean 8-bit download tray, automatic clipboard magnet detection pill, and direct `[+ Add Torrent]` and `[Search Torrents]` buttons.
- [x] **Task 1.9:** Build **Add Torrent Sheet** with default storage path pill + `[Change]` override, multi-file batch selection (`[Select All]`, `[Deselect All]`, `.ext` chips), and non-blocking background queueing.
- [x] **Task 1.10:** Build **Torrent Detail Screen** with live speed chart, dual-action delete dialog (`Remove from Maglev` vs `Delete Torrent + Files`), and 4 tab views: `[FILES]`, `[PIECES]`, `[PEERS]`, and `[TRACKERS]`.
- [x] **Task 1.11:** Implement built-in loopback HTTP streaming server (`http://127.0.0.1:<port>/stream/...`) with `[▶ Stream Now]` action button for sequential playback in external video players.
- [x] **Task 1.12:** End-to-End integration test validating real torrent download against a local swarm.

### Phase 1 Contract List
* **CONTRACT-1.1 (Engine Lifecycle):** Native engine must initialize in `< 200ms` and shut down cleanly without zombie Tokio worker threads.
* **CONTRACT-1.2 (Magnet & File Ingestion):** Ingesting a valid magnet link or `.torrent` file must resolve torrent name, total size, and file tree within `< 5.0s` over active swarm/DHT.
* **CONTRACT-1.3 (Bitfield Accuracy):** The 16×16 piece visualizer reads from a fixed 256-byte `DirectByteBuffer` populated by native Rust SIMD bit-popcount without Kotlin heap allocations.
* **CONTRACT-1.4 (State Transition):** Pausing a torrent must immediately drop network sockets, transition UI card to `PAUSED` (showing `▶ RESUME`), and release the Android WakeLock if no other active transfers exist.
* **CONTRACT-1.5 (Safe Deletion):** Deletion must require explicit user choice between removing the task session versus purging payload files from disk.

### Phase 1 Minimum SLA List
| Metric | Threshold | Verification Method |
|---|---|---|
| Cold Start to Interactive UI | `< 500 ms` | Android Trace / Macrobenchmark |
| RAM Footprint (Idle) | `≤ 38 MB` | Android Studio Profiler / `adb shell dumpsys meminfo` |
| RAM Footprint (100 Mbps Transfer) | `≤ 85 MB` | Profiler during saturated download (40 peers) |
| UI Frame Rate | `120 FPS` (or screen max) | Android GPU Profiling / zero dropped frames |
| WakeLock Release on Pause | `≤ 500 ms` | PowerManager WakeLock test |
| Touch Target Minimum | `≥ 44 × 44 px` | Automated UI accessibility linter |

---

## ⚙️ Phase 2: Configuration & System Governance

### Objective
Empower users with granular control over networking, bandwidth limits, storage targets, power preservation, and visual theming without introducing bloat.

### Detailed Task List
- [ ] **Task 2.1:** Implement persistent Settings State Store (MMKV / encrypted local storage).
- [ ] **Task 2.2:** Implement Network Listener in Kotlin (`ConnectivityManager.NetworkCallback`) for real-time Wi-Fi vs Cellular detection.
- [ ] **Task 2.3:** Implement UPnP and NAT-PMP port forwarding in native engine with toggle in Settings.
- [ ] **Task 2.4:** Implement Protocol Encryption toggle (PE / MSE: Preferred, Required, Disabled).
- [ ] **Task 2.5:** Implement Bandwidth Throttling in Rust engine with speed preset chips (`Unlimited`, `1 MB/s`, `5 MB/s`, `10 MB/s`, `Custom`).
- [ ] **Task 2.6:** Implement Seeding Governance limits (Stop seeding at ratio 1.0x, 1.5x, 2.0x or after set time limit).
- [ ] **Task 2.7:** Build **General Theming Section** (Tactical Dark `#05070A`, Pure Black OLED `#000000`, Light Theme toggle).
- [ ] **Task 2.8:** Build **Transfers & Network Section** (Storage directory picker via SAF, Download/Upload limits, Active torrent cap, Wi-Fi only toggle, "Download only while charging" toggle).
- [ ] **Task 2.9:** Build **Content & Privacy Section** (Enable adult search toggle, Blur adult images toggle, Save/Clear search history).
- [ ] **Task 2.10:** Build **About Section** (Version display, Engine build tag, License, Source repo link).

### Phase 2 Contract List
* **CONTRACT-2.1 (Wi-Fi Safety):** When "Download on Wi-Fi only" is enabled, transferring over mobile data is physically impossible at the native socket level.
* **CONTRACT-2.2 (Bandwidth Clamping):** Configured download/upload limits must cap transfer rates within `±5%` of configured ceiling.
* **CONTRACT-2.3 (Theme Persistence):** Switching theme to Pure Black OLED must apply instantly without activity recreation.

### Phase 2 Minimum SLA List
| Metric | Threshold | Verification Method |
|---|---|---|
| Settings Read/Write Latency | `< 10 ms` | MMKV benchmark |
| Network Switch Reaction Time | `< 300 ms` | Connectivity switch test |
| Bandwidth Enforcement Accuracy | `±5%` of target | Throughput telemetry benchmark |

---

## 🔍 Phase 3: Torrent Search & Discovery

### Objective
Integrate a clean, lightning-fast multi-source search and browse experience with categorized filtering, instant magnet queueing, search history, and privacy controls.

### Detailed Task List
- [ ] **Task 3.1:** Implement modular Search Provider Aggregator with enable/disable toggles in Settings.
- [ ] **Task 3.2:** Implement category filter pills: `All Categories`, `Anime`, `Apps`, `Books`, `Games`, `Movies`, `Music`, `18+ Series`, `Others` with smooth horizontal scroll and edge fade.
- [ ] **Task 3.3:** Build search result sorting pills (`Sort: Seeds ↓`, `Size`, `Date`).
- [ ] **Task 3.4:** Build search history cache with quick-tap pills and one-tap clear action.
- [ ] **Task 3.5:** Build Search Result Card UI (Title, Size, Seeds cyan `↓`, Peers lime `↑`, Category badge, one-touch `+ Add` button).
- [ ] **Task 3.6:** Wire one-touch `+ Add` button directly to Add Torrent Sheet.
- [ ] **Task 3.7:** Implement adult content filter & blur logic bound to Settings privacy toggles.

### Phase 3 Contract List
* **CONTRACT-3.1 (Search Latency):** Search queries must stream aggregated results to the UI within `< 2.0s`.
* **CONTRACT-3.2 (Adult Content Isolation):** When adult content mode is disabled, 18+ content must be completely purged from results; when blur is enabled, thumbnails/metadata must be masked.
* **CONTRACT-3.3 (Seamless Queueing):** Tapping `+ Add` on a search result must invoke the Add Torrent Sheet with pre-parsed magnet data within `< 200ms`.

---

## 📡 Phase 4: Automated Feeds (RSS)

### Objective
Enable background RSS/Atom feed subscriptions with automated regex-based torrent queuing for periodic releases and series.

### Detailed Task List
- [ ] **Task 4.1:** Implement lightweight XML/RSS/Atom feed parser.
- [ ] **Task 4.2:** Build Feed Channels UI (`All Feeds`, channel filter pills, `+ Add Feed` modal).
- [ ] **Task 4.3:** Build Feed Item Card UI (Release title, channel badge, time ago, file size, download button, auto-download badge).
- [ ] **Task 4.4:** Implement Auto-Download Rule Engine with inclusion regex, exclusion (blacklist) regex, and smart episode deduplication (`SxxExx`).
- [ ] **Task 4.5:** Schedule periodic background feed sync via Android `WorkManager` with configurable interval (`15m`, `30m`, `1h`, `6h`, `Manual`).

### Phase 4 Contract List
* **CONTRACT-4.1 (Parse Reliability):** Parse standard torrent RSS feeds with `< 100ms` processing time per 100 items.
* **CONTRACT-4.2 (Rule Precision):** Auto-download rules must only trigger on exact regex matches and never queue duplicate info-hashes or episodes.
* **CONTRACT-4.3 (Sync Efficiency):** Background feed sync must consume `< 1%` battery over a 24-hour cycle.
