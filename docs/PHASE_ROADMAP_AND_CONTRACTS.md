# MAGLEV — Phase Roadmap, Task Lists & Contract Sheets

---

## 🚀 Phase 1: Core BitTorrent Engine & Transfers

### Objective
Deliver a fully functional, native-speed BitTorrent client capable of ingesting magnet links, downloading payloads to Android storage with piece verification, seeding to the swarm, and displaying real-time HUD telemetry.

### Detailed Task List
- [ ] **Task 1.1:** Setup Rust `librqbit` mobile cross-compilation pipeline with `cargo-ndk` targeting `arm64-v8a`, `armeabi-v7a`, `x86_64`.
- [ ] **Task 1.2:** Implement Kotlin JNI / UniFFI bridge exposing torrent lifecycle methods (`start`, `pause`, `resume`, `delete`, `getPieceBitfield`, `getPeers`).
- [ ] **Task 1.3:** Build Android `ForegroundService` (`dataSync`) with persistent speed notification and `PARTIAL_WAKE_LOCK` lifecycle manager.
- [ ] **Task 1.4:** Integrate Scoped Storage SAF to extract `ParcelFileDescriptor` for zero-copy native disk writing.
- [ ] **Task 1.5:** Implement Expo Native Module (`MaglevEngineModule`) with throttled 500ms `onTelemetryUpdate` events.
- [ ] **Task 1.6:** Implement React Native **Transfers Screen** (Active cards, speed badges, pause/resume, filter pills: All, Down, Up, Paused).
- [ ] **Task 1.7:** Implement **Empty State** screen with direct `[+ Add Torrent]` and `[Search Torrents]` actions.
- [ ] **Task 1.8:** Implement **Magnet Ingestion Bottom Sheet** with BEP-9 metadata preview, multi-select file checkboxes, and sequential streaming toggle.
- [ ] **Task 1.9:** Implement **Torrent Detail Screen** with live speed chart, 16×16 Piece Map block matrix, and Peers table.
- [ ] **Task 1.10:** End-to-End integration test validating real torrent download against a local swarm.

### Phase 1 Contract List
* **CONTRACT-1.1 (Engine Lifecycle):** Native engine must initialize in `< 200ms` and shut down cleanly without zombie Tokio worker threads.
* **CONTRACT-1.2 (Magnet Ingestion):** Ingesting a valid BEP-9 magnet link must resolve torrent name, total size, and file tree within `< 5.0s` over active DHT/swarm.
* **CONTRACT-1.3 (Bitfield Accuracy):** The 16×16 piece visualizer must accurately reflect verified piece bitfields within 1 tick (500ms) of SHA-1 verification.
* **CONTRACT-1.4 (State Transition):** Pausing a torrent must immediately drop network sockets, transition UI card to `PAUSED`, and release the Android WakeLock if no other active transfers exist.

### Phase 1 Minimum SLA List
| Metric | Threshold | Verification Method |
|---|---|---|
| Cold Start to Interactive UI | `< 500 ms` | Android Trace / Macrobenchmark |
| RAM Footprint (Idle) | `≤ 28 MB` | Android Studio Profiler / `adb shell dumpsys meminfo` |
| RAM Footprint (100 Mbps Transfer) | `≤ 45 MB` | Profiler during saturated download |
| UI Frame Rate | `120 FPS` (or screen max) | Android GPU Profiling / zero dropped frames |
| WakeLock Release on Pause | `≤ 500 ms` | PowerManager WakeLock test |

---

## ⚙️ Phase 2: Configuration & System Governance

### Objective
Empower users with granular control over networking, bandwidth limits, storage targets, power preservation, and visual theming without introducing bloat.

### Detailed Task List
- [ ] **Task 2.1:** Implement persistent Config State Store (MMKV / encrypted local storage).
- [ ] **Task 2.2:** Implement Network Listener in Kotlin (`ConnectivityManager.NetworkCallback`) for real-time Wi-Fi vs Cellular detection.
- [ ] **Task 2.3:** Implement Bandwidth Throttling in Rust engine (Token Bucket algorithm for global/per-torrent Down/Up limits).
- [ ] **Task 2.4:** Build **General Theming Section** (Pure Black OLED `#05070A`, Dark `#12161F`, Light Theme toggle).
- [ ] **Task 2.5:** Build **Torrent Engine Section** (Storage directory picker via SAF, Download/Upload limits, Active torrent cap, Wi-Fi only toggle).
- [ ] **Task 2.6:** Build **Content & Privacy Section** (Enable NSFW mode toggle, Blur NSFW images toggle, Save/Clear search history).
- [ ] **Task 2.7:** Build **About Section** (Version display, Engine build tag, License, Source repo link).
- [ ] **Task 2.8:** End-to-End test for Wi-Fi toggle (simulate network change, verify immediate pause of cellular socket).

### Phase 2 Contract List
* **CONTRACT-2.1 (Wi-Fi Safety):** When "Download on Wi-Fi only" is enabled, transferring over mobile data is physically impossible at the native socket level.
* **CONTRACT-2.2 (Bandwidth Clamping):** Set download/upload limits must cap transfer rates within `±5%` of configured ceiling.
* **CONTRACT-2.3 (Theme Persistence):** Switching theme to Pure Black OLED must apply instantly without activity recreation.

### Phase 2 Minimum SLA List
| Metric | Threshold | Verification Method |
|---|---|---|
| Config Read/Write Latency | `< 10 ms` | MMKV benchmark |
| Network Switch Reaction Time | `< 300 ms` | Connectivity switch test |
| Bandwidth Enforcement Accuracy | `±5%` of target | Throughput telemetry benchmark |

---

## 🔍 Phase 3: Torrent Search & Discovery

### Objective
Integrate a clean, lightning-fast multi-source search and browse experience with categorized filtering, instant magnet queueing, search history, and privacy controls.

### Detailed Task List
- [ ] **Task 3.1:** Implement modular Search Provider Aggregator (Scrapers/APIs for public legal repositories, Linux ISOs, Internet Archive, and extensible indexing).
- [ ] **Task 3.2:** Implement category filter pills: `All Categories`, `Anime`, `Apps`, `Books`, `Games`, `Movies`, `Music`, `18+ Series`, `Others`.
- [ ] **Task 3.3:** Build search history cache with quick-tap pills and one-tap clear action.
- [ ] **Task 3.4:** Build Bookmarking / Saved torrents state.
- [ ] **Task 3.5:** Build Search Result Card UI (Title, Size, Seeds cyan `↓`, Leechers lime `↑`, Category badge, one-touch `+ Add` button).
- [ ] **Task 3.6:** Wire one-touch `+ Add` button directly to Magnet Ingestion Sheet.
- [ ] **Task 3.7:** Implement NSFW content filter & blur logic bound to Phase 2 privacy settings.
- [ ] **Task 3.8:** End-to-End search journey test (query -> filter category -> select item -> queue transfer).

### Phase 3 Contract List
* **CONTRACT-3.1 (Search Latency):** Search queries must stream aggregated results to the UI within `< 2.0s`.
* **CONTRACT-3.2 (NSFW Isolation):** When NSFW mode is disabled, 18+ content must be completely purged from results; when blur is enabled, thumbnails/metadata must be masked.
* **CONTRACT-3.3 (Seamless Queueing):** Tapping `+ Add` on a search result must invoke the Ingestion Sheet with pre-parsed magnet data within `< 200ms`.

### Phase 3 Minimum SLA List
| Metric | Threshold | Verification Method |
|---|---|---|
| Search Query Response Time | `< 2000 ms` | Network E2E test |
| Result List Scroll Fluidity | `120 FPS` | List scroll profiling |
| Privacy Filter Enforcement | `100%` filtered | Regression test suite |

---

## 📡 Phase 4: Automated Feeds (RSS)

### Objective
Enable background RSS/Atom feed subscriptions with automated regex-based torrent queuing for periodic releases and series.

### Detailed Task List
- [ ] **Task 4.1:** Implement lightweight XML/RSS/Atom feed parser.
- [ ] **Task 4.2:** Build Feed Channels UI (`All Feeds`, channel filter pills, `+ Add Feed` modal).
- [ ] **Task 4.3:** Build Feed Item Card UI (Release title, channel badge, time ago, file size, download button, auto-download badge).
- [ ] **Task 4.4:** Implement Auto-Download Rule Engine (Regex matching for release titles, size bounds, seed thresholds).
- [ ] **Task 4.5:** Schedule periodic background feed sync via Android `WorkManager` (respecting battery & Wi-Fi constraints).
- [ ] **Task 4.6:** End-to-End feed test (add RSS URL -> parse items -> trigger auto-download matching rule).

### Phase 4 Contract List
* **CONTRACT-4.1 (Parse Reliability):** Parse standard torrent RSS feeds with `< 100ms` processing time per 100 items.
* **CONTRACT-4.2 (Rule Precision):** Auto-download rules must only trigger on exact regex matches and never queue duplicate info-hashes.
* **CONTRACT-4.3 (Sync Efficiency):** Background feed sync must consume `< 1%` battery over a 24-hour cycle.

### Phase 4 Minimum SLA List
| Metric | Threshold | Verification Method |
|---|---|---|
| Feed Parse Time | `< 100 ms` / 100 items | Parser benchmark |
| Background Battery Impact | `< 1%` / 24h | Battery Historian analysis |
