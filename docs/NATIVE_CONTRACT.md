# Native Contract: Rust ⇄ Kotlin ⇄ TypeScript (v1, locked 2026-11-11)

This is the single source of truth for the engine boundary. The Rust, Kotlin and TS layers are written in parallel against this file.
**Do not change a signature or JSON shape without updating this file first.**

## 1. Principles

- **JSON over JNI.** Every call passes and returns UTF-8 JSON strings. The one exception is the bitfield buffer. This keeps the JNI surface small and the shapes testable.
- **Every call returns a `Result` envelope.** A success is `{"ok":true,...payload}`. A failure is `{"ok":false,"code":"<ERROR_CODE>","message":"<plain English>"}`. Native code never throws across JNI. Rust wraps each export in `catch_unwind`; a panic becomes `{"ok":false,"code":"INTERNAL"}`.
- **Blocking calls are made only from Kotlin `Dispatchers.IO`**, never on the JS thread. Rust uses one long-lived multi-thread tokio runtime (2 workers) and runs `block_on` with explicit timeouts.
- **Units.** Bytes are `u64` and speeds are bytes per second. Times are seconds (`i64`), except where a name ends in `Ms`. Inside Rust JSON all keys are `snake_case`. The TS layer converts them to camelCase.

## 2. Kotlin JNI holder

All externs live in `object NativeCore` in `com.maglev.engine.NativeCore`. The Rust symbols are therefore `Java_com_maglev_engine_NativeCore_<name>`.

| Kotlin `external fun` | Returns | Rust behavior |
|---|---|---|
| `nativeInit(configJson: String, sessionDir: String, defaultDownloadDir: String): String` | Result | Creates the librqbit `Session` with JSON persistence + fastresume in `sessionDir`. Restores saved torrents. Starts the 1 s governance tick. Calling it twice returns `ok` (idempotent). |
| `nativeShutdown(): String` | Result | Flushes persistence and stops the session and runtime. No zombie threads may remain. |
| `nativeResolveMetadata(source: String, timeoutMs: Long): String` | Result + `Metadata` | `source` is a magnet URI, an `http(s)://…/.torrent` URL, or an absolute `.torrent` file path. Uses librqbit `list_only`. Does **not** add the torrent. Error codes: `INVALID_SOURCE`, `METADATA_TIMEOUT`, `NETWORK`. |
| `nativeAddTorrent(source: String, optionsJson: String): String` | Result + `{id, info_hash}` | Options: `{"only_files":[u32]|null,"paused":bool,"output_folder":string|null,"sequential":bool}`. If the info-hash already exists, returns `{"ok":false,"code":"DUPLICATE","id":…}` and changes nothing. |
| `nativeListTorrents(): String` | Result + `{"torrents":[Snapshot]}` | Cheap. Called once per second. |
| `nativeGetDetail(id: String): String` | Result + `Detail` | |
| `nativePause(id)`, `nativeResume(id)`, `nativeRecheck(id)` | Result | Pause and resume are user actions. They clear any `paused_by` governance flag. |
| `nativeDelete(id: String, deleteFiles: Boolean): String` | Result | |
| `nativeSetIncludedFiles(id: String, indicesJson: String): String` | Result | `[u32]`. Maps to librqbit `update_only_files`. |
| `nativeSetGlobalLimits(downBps: Long, upBps: Long): String` | Result | `0` means unlimited. Applies live. |
| `nativeApplyConfig(configJson: String): String` | Result + `{"restart_required":bool}` | Applies `NativeConfig`. Port, DHT, UPnP and proxy changes set `restart_required`. |
| `nativeGetEffectiveConfig(): String` | Result + `NativeConfig` | Used by contract C-SET-1 to prove settings reach Rust. |
| `nativeSetTransfersAllowed(allowed: Boolean, reason: String): String` | Result | Governance gate for Wi-Fi-only, battery and charging. `false` pauses every running torrent and tags it `paused_by: reason`. `true` resumes **only** the torrents carrying that governance tag. |
| `nativeGetPieceBitfield(id: String, out: ByteBuffer): Int` | count written | `out` is a direct 256-byte buffer. Fills the downsampled 16×16 grid with 0 = missing, 1 = have, 2 = partial. |
| `nativeStreamUrl(id: String, fileIndex: Int): String` | Result + `{url}` | Serves `http://127.0.0.1:<port>/stream/<id>/<file>` with HTTP Range, backed by the librqbit file stream. |
| `nativeVersion(): String` | `{"engine":"librqbit","version":"9.x.y"}` | The About screen shows this value, never a hardcoded string. |

## 3. JSON shapes (Rust `serde`, snake_case)

```jsonc
// NativeConfig
{
  "listen_port": 0,                 // 0 = random
  "enable_upnp": true,
  "enable_dht": true,
  "enable_lsd": true,               // applied only if librqbit supports it, otherwise stored
  "enable_pex": true,
  "encryption": "prefer",           // "prefer" | "require" | "disable"; stored if unsupported, reported by get_effective_config
  "max_active_downloads": 3,        // queue size; extra torrents get state QUEUED
  "max_active_seeds": 3,
  "max_connections_per_torrent": 50,
  "download_limit_bps": 0,
  "upload_limit_bps": 0,
  "seed_ratio_limit": 0.0,          // 0 = none
  "seed_time_limit_mins": 0,        // 0 = none
  "proxy_url": null,                // "socks5://user:pass@host:port" or null
  "ip_filter_path": null
}

// Metadata
{ "info_hash": "40-hex", "name": "…", "total_bytes": 0,
  "files": [{ "index": 0, "path": "dir/file.mkv", "length": 0 }] }

// Snapshot (one row per torrent)
{ "id": "40-hex info hash", "name": "…",
  "state": "INITIALIZING|QUEUED|DOWNLOADING|SEEDING|PAUSED|CHECKING|ERROR|COMPLETED",
  "paused_by": null,                // null | "user" | "wifi_only" | "battery" | "charging_only" | "seed_limit"
  "progress_bytes": 0, "total_bytes": 0, "uploaded_bytes": 0,
  "down_bps": 0, "up_bps": 0, "peers_live": 0, "peers_seen": 0,
  "eta_secs": -1,                   // -1 = unknown
  "ratio": 0.0, "seeding_secs": 0, "added_at": 0,
  "output_folder": "/abs/path",
  "error": null                     // null | { "code": "DISK_FULL|PERMISSION|FILES_MISSING|TRACKER|INTERNAL", "message": "…" }
}

// Detail
{ "snapshot": Snapshot,
  "files":   [{ "index": 0, "path": "…", "length": 0, "progress_bytes": 0, "included": true }],
  "peers":   [{ "addr": "1.2.3.4:5678", "client": "…", "down_bps": 0, "up_bps": 0, "progress": 0.0 }],
  "trackers":[{ "url": "…", "status": "working|updating|error|unknown", "message": null }],
  "piece_count": 0, "piece_length": 0 }
```

### Error codes (closed set)
`INVALID_SOURCE`, `DUPLICATE`, `METADATA_TIMEOUT`, `NETWORK`, `NOT_FOUND`, `DISK_FULL`, `PERMISSION`, `FILES_MISSING`, `NOT_INITIALIZED`, `ENGINE_UNAVAILABLE`, `UNSUPPORTED`, `INTERNAL`.

## 4. State rules (enforced in Rust)

- **Queue.** At most `max_active_downloads` torrents may be `DOWNLOADING`. Further unfinished, non-paused torrents become `QUEUED` and start in `added_at` order as slots free up. The same rule applies to seeds via `max_active_seeds`.
- **Seed limits.** When `ratio >= seed_ratio_limit > 0` or `seeding_secs >= seed_time_limit_mins*60 > 0`, the torrent pauses with `paused_by: "seed_limit"`.
- **Governance.** A pause from `nativeSetTransfersAllowed(false, r)` never overrides a user pause. Resume restores only torrents whose `paused_by == r`.
- **Errors.** ENOSPC → `DISK_FULL`. EACCES/EPERM → `PERMISSION`. A missing output file on resume → `FILES_MISSING`.
- **Persistence.** Torrents, their states, `paused_by`, `added_at`, and the `NativeConfig` all survive process death.

## 5. Storage policy (enforced in Kotlin)

1. **Default download dir:** `<primary external>/Download/Maglev`. It is visible in every file manager. On API 30+ the app may create files in its own folder there by direct path. Kotlin probes it at init by writing and deleting a file.
   - API 24–28: needs the runtime permission `WRITE_EXTERNAL_STORAGE`.
   - API 29: needs `requestLegacyExternalStorage`.
   - If the probe fails, fall back to `getExternalFilesDir(DOWNLOADS)` and report `storage.fallback = true` so the UI shows a banner.
2. **Custom folder:** the SAF `ACTION_OPEN_DOCUMENT_TREE` picker, then `takePersistableUriPermission`. If the tree resolves to a POSIX path that passes the write probe, Rust writes there directly. Otherwise use **staging plus copy-on-complete**: download into app-specific staging, and when the torrent reaches `COMPLETED` copy it into the tree with DocumentFile. Seeding continues from staging.
3. **Revoked SAF permission:** detected at startup. The UI shows "Folder access lost" and offers a repick.

## 6. Kotlin → JS module API (Expo module `MaglevEngine`)

Every method is async and resolves the decoded Result (camelCase). Events: `onTelemetry` (snapshots once per second), `onTorrentCompleted {id,name}`, `onNotificationAction {action:"pause_all"|"resume_all"|"shutdown"}`, `onStorageStatus {path,fallback,safLost}`.

| Kind | API |
|---|---|
| Engine | `init(config)`, `shutdown()`, `resolveMetadata(source, timeoutMs)`, `addTorrent(source, options)`, `listTorrents()`, `getDetail(id)`, `pause(id)`, `resume(id)`, `recheck(id)`, `pauseAll()`, `resumeAll()`, `delete(id, deleteFiles)`, `setIncludedFiles(id, indices)`, `setGlobalLimits(down, up)`, `applyConfig(config)`, `getEffectiveConfig()`, `getPieceBitfield(id)` (returns a 256-element number array), `streamUrl(id, fileIndex)`, `version()` |
| Storage | `pickDownloadFolder()` → `{uri, displayName, mode:"direct"|"staging"}` or `{cancelled:true}`; `getStorageStatus()`; `openFile(id, fileIndex)`; `shareFile(id, fileIndex)`; `openFolder(id)` |
| Permissions | `getPermissionStatus()` → `{notifications:"granted"|"denied"|"undetermined", batteryUnrestricted:bool, legacyStorage:"granted"|"denied"|"n/a"}`; `requestNotifications()`; `openBatterySettings()`; `requestLegacyStorage()` |
| Governance | `setGovernance({wifiOnly, ssidWhitelist, chargingOnly, batteryCutoffPct, autoExitOnComplete})`. Kotlin watches ConnectivityManager and BatteryManager and calls `nativeSetTransfersAllowed`. |
| Service | Started by Kotlin when any torrent is `DOWNLOADING` or `SEEDING`. Stopped when none is. JS never manages the service. |

## 7. Known engine gaps (librqbit 9.1, verified against v9.1.0 source)

UI rule: if a setting is "stored only", **hide it or show it as unavailable**. Never present it as working (AGENTS.md §4.6).

| Item | Status | Plan |
|---|---|---|
| Protocol encryption (MSE/PE) | Not in librqbit | Hide the setting (Phase 3: revisit upstream) |
| PEX toggle | Always on, no switch | Hide the toggle |
| Sequential download | No option; streaming reads prioritise pieces | Replace with **Stream** (uses the stream server) |
| Tracker status | Not exposed; always `unknown` | Show the tracker URL only, no status badge |
| Peer progress | Not exposed (`0.0`) | Hide per-peer progress |
| Recheck | Implemented as forget + re-add from bytes | OK, but show "Checking files…" |
| HTTPS (trackers, `.torrent` URLs) | **Fixed.** `[patch.crates-io]` swaps `rustls-platform-verifier` for a local shim (`native/maglev-core/vendor/`) that verifies against bundled Mozilla roots (`webpki-roots`). No JNI is needed. Certificates the user installed on the device are not trusted. | The shim must keep matching the API reqwest 0.13 calls (`Verifier::new`, `new_with_extra_roots`). |
| Proxy | SOCKS5 covers peer TCP + HTTP; DHT/UDP trackers bypass it | Settings copy must say so |
| Listener | TCP + IPv4 only | uTP is opt-in upstream (Phase 3) |
| Logs | No subscriber on Android | Phase 2: `android_logger` behind a debug flag |

Additions beyond §2–§6, agreed during Wave 1:
- `nativeInit` returns `{ok, stream_port, torrents}`. An empty or `"null"` config means "use the last persisted config".
- Magnet adds return immediately. The torrent shows `INITIALIZING` until metadata arrives, survives a restart, and goes to `ERROR` on failure. `.torrent` file/URL adds resolve synchronously (45 s).
- `paused_by` is an arbitrary string. `user` and `seed_limit` are reserved; everything else is a governance tag (for example `fgs_timeout`).
- `max_active_downloads` / `max_active_seeds` of `0` mean unlimited. A user resume of a `seed_limit` torrent waives the limits for that torrent.
- Multi-file torrents with a custom `output_folder` go into `<folder>/<torrent name>/`.
- Telemetry event payload: `{ok, torrents:[…], serviceBlocked}`. Storage status: `{path, fallback, safLost, mode, uri, displayName, copyError?}`.

## 8. Background survival (user requirement, 2026-11-11)

- **Auto-restart.** The service is `START_STICKY` while any torrent is active. When Android kills the process, the service restarts **headless** (no JS): `nativeInit("")` loads the last persisted config, the governance rules come from SharedPreferences, and transfers resume. If nothing is active, the service stops itself.
- **User intent wins.** Tapping Shut down or Pause all is persisted, so a sticky restart never resurrects transfers the user stopped.
- **No 6-hour cap.** On API 34+ the service type is `specialUse` (property: P2P transfer the user started). Below 34 it is `dataSync`. A future Google Play build flips `USE_SPECIAL_USE_FGS = false`, which brings back `dataSync` and its `onTimeout` handling.
- **Battery nudge.** `getPermissionStatus()` adds `backgroundKills: number` (headless restarts detected after a gap) and `oemHint` (the manufacturer, for dontkillmyapp.com guidance). Settings → Needs attention shows "Android stopped Maglev N times. Allow unrestricted battery" with **Allow** (`openBatterySettings`).
- **No boot auto-start.** Android 15 blocks starting these service types from `BOOT_COMPLETED`. Transfers resume on the next app open or the next sticky restart.

## 9. Amendments from the boundary review (2026-11-11)

- `Snapshot.finished: bool`: true once every included piece is present. **Completion and the staging copy key off the `finished` false→true edge**, never off the state string.
- A finished torrent that exceeds `max_active_seeds` becomes `COMPLETED` (not seeding), never `QUEUED`. `QUEUED` is reserved for unfinished torrents.
- `seeding_secs` is wall-clock time accumulated only while `SEEDING`, never a tick count.
- `nativeInit` with an invalid config **never** leaves the engine unavailable. It falls back to the last persisted config (or the defaults) and returns `{ok:true, config_warning:"…"}`.
- Proxy URLs are `socks5://` or `socks5h://` only. TS must not emit `http://`.
- Error code `UNSUPPORTED` is added to the closed set. It is used, for example, for `https://` sources while TLS verification isn't initialised: "Secure (https) torrent links aren't supported yet. Download the .torrent file and open it instead." Kotlin downloads `https://…/.torrent` itself (10 MB cap, 30 s timeout) and passes the file path, so users rarely see this error.
- Stream URLs carry a per-session random token, `/stream/<token>/<id>/<file>`. The server rejects a wrong token, and rejects a `Host` other than `127.0.0.1:<port>`.

## 10. Wave 3: user feedback (2026-11-11)

Grounded in librqbit v9.1.0 source (see the LEDGER entry for the research). Rust, Kotlin and TS workers implement against this section only.

### 10.1 File priority ("Download first")
librqbit has no per-file priority. It downloads in `file_priorities` order, a hardcoded list of file indices sorted by name, with a `// TODO: make it configurable` (`torrent_state/live/mod.rs`). The order is made configurable through a **minimal vendored patch**.

- **Patch:** vendor `librqbit` 9.1.0 into `native/maglev-core/vendor/librqbit` and wire it through `[patch.crates-io]`, the same mechanism as the TLS shim.
  - The patch adds one public method, `ManagedTorrent::set_file_priority_order(&self, order: Vec<usize>)`. It reorders the live `file_priorities` list, or stores the order for the next live state if the torrent is paused or initializing.
  - Keep the diff small and listed in `vendor/librqbit/MAGLEV_PATCH.md`, with the upstream file and line numbers, so it can be rebased.
- **Priorities:** `"first" | "normal" | "skip"`.
  - `skip` is the same as excluded, so `included = false` and it goes through `update_only_files`.
  - The order is `first` files (in index order), then `normal` files (in index order).
  - This **reorders** downloading. It does not weight bandwidth, and the UI must not claim that it does.
- **JNI:** `nativeSetFilePriorities(id: String, json: String): String`, where `json` is `[{"index":u32,"priority":"first|normal|skip"}]`. Files that are not listed count as `normal`.
  - It applies the include set and the order atomically.
  - It returns a Result. Errors are `NOT_FOUND`, or `INVALID_SOURCE` for an unknown index or an empty include set.
- **Persistence:** Rust persists priorities in its own sidecar, `<sessionDir>/maglev-priorities.json`, keyed by info-hash, and re-applies them on restore.
- **Detail shape:** `files[]` gains `"priority": "first|normal|skip"`. `included` stays and is derived from it.
- **Add:** `nativeAddTorrent` options gain an optional `"file_priorities":[{"index","priority"}]`. When it is present, it overrides `only_files`.

### 10.2 Reannounce
librqbit has no reannounce API. The workaround is `Session::pause` followed by `Session::unpause`, which rebuilds the peer source. That means a new tracker `started` announce, a DHT `get_peers` and an LSD announce.

- **JNI:** `nativeReannounce(id: String): String`. It is valid only while the torrent is `DOWNLOADING` or `SEEDING`; otherwise it returns `{"ok":false,"code":"UNSUPPORTED"}`.
- **Not a user pause.** It must not change `paused_by`, queue position, seeding clocks or the persisted state. The scheduler tick must not see the torrent as paused in between (hold the tick lock, as recheck does).
- **Rate limit:** once per 60 s per torrent. Earlier calls return `{"ok":false,"code":"UNSUPPORTED","retry_after_secs":n}`.
- **UI copy:** "Find more peers" (the subtitle is "Asks trackers and DHT again. Current peers reconnect."). The Detail overflow also shows "Reannounce" as the action label.

### 10.3 Free space
- **Kotlin:** `getFreeSpace(): {path, freeBytes, totalBytes, mode}`, using `StatFs` on the directory Rust actually writes to (the default dir, the direct SAF path, or the staging dir).
  - In staging mode it also returns `{targetFreeBytes}` for the SAF target, when the tree resolves to a volume. Otherwise that field is null.
- **Add-sheet rule:** if `selectedBytes > freeBytes - 200 MB`, show "Not enough space" and disable Start. If the free space after the download would be under 1 GB, show a warning, but Start stays enabled.

### 10.4 Notification and Live Updates
- **Dependencies:** `androidx.core:core-ktx` 1.17.0 or later, and the manifest permission `android.permission.POST_PROMOTED_NOTIFICATIONS`.
- **Content:** built from the latest telemetry. The *primary* torrent is the downloading torrent with the highest `down_bps`, falling back to the most recently added.

  | Situation | Title | Text | Progress / chip |
  |---|---|---|---|
  | 1 downloading | torrent name | `62% · ↓ 4.1 MB/s · 12 min left` | ProgressStyle 0–100; chip `62%` |
  | N > 1 downloading | `<primary name> +N−1 more` | `N downloading · ↓ total MB/s` | ProgressStyle of aggregate bytes; chip `62%` |
  | Seeding only | `Seeding N torrents` | `↑ total MB/s` | no ProgressStyle, **not promoted** |
  | All paused by governance | `Paused: waiting for Wi-Fi` (or battery, or charging) | — | not promoted |

- **Promotion:** only while something is downloading. Use `setRequestPromotedOngoing(true)` and `setShortCriticalText` with at most 4 characters, and set `ongoing`.
  - Not colorized and no RemoteViews. The channel importance must be above MIN.
  - Below API 36 the same builder falls back to a standard notification.
- **Throttle:** update at most once every 2 s, and only when the text changes.
- **Actions:** Pause all, Resume all and Shut down stay unchanged.
- **JS:** `getPermissionStatus()` gains `liveUpdates: "granted"|"denied"|"n/a"` (from `canPostPromotedNotifications()`). `openLiveUpdateSettings()` opens `Settings.ACTION_MANAGE_APP_PROMOTED_NOTIFICATIONS`.

### 10.5 Module API additions (§6)
`setFilePriorities(id, [{index, priority}])`, `reannounce(id)` (Result with `retryAfterSecs?`), `getFreeSpace()` and `openLiveUpdateSettings()`. The mock engine implements all four with the same validation.

### 10.6 Parked
**Wi-Fi and mobile data at once** is Phase 4 research. librqbit creates and connects its sockets internally and has no pre-connect hook (`ConnectOpts` only has `source_port` and `bind_device`), so it would need forks of librqbit, librqbit-dualstack-sockets and librqbit-utp. SO_BINDTODEVICE from an unprivileged Android app is also unverified.

## 11. Wave 4: parity features (2026-11-11)

User decisions (2026-11-11): magnet sharing sends the link only; the scheduler wakes through an inexact alarm; feed rules run in the background through WorkManager. Grounding: librqbit v9.1.0 source (`limits.rs`, `torrent_state/live/mod.rs`) and developer.android.com, "Restrictions on starting a foreground service from the background".

**Background-start rule (applies to 11.5 and 11.6).** On Android 12+ an alarm or a worker may call `startForegroundService` only when one of the exemptions in that page holds. The exemption Maglev relies on is the battery one: "The user turns off battery optimizations for your app", which onboarding already requests. Kotlin wraps every background start in `try/catch (ForegroundServiceStartNotAllowedException)`. If the start is refused, Kotlin posts a normal notification on a new channel, `maglev_reminders` (default importance). Tapping it starts the service, because a notification tap is an exempt user action. The texts are given below. Nothing ever fails silently.

### 11.1 Share magnet link
- The share payload is **only** the magnet URI. On Android, `Share.share({ message: magnet })` sets only `EXTRA_TEXT`. Pass no `title`, no `url` and no extra text.
- The magnet comes from the same source as "Copy magnet". The Detail overflow sheet gets a "Share magnet link" row (icon `share`), placed directly under "Copy magnet".
- Exporting a `.torrent` file is out of scope.

### 11.2 Per-torrent speed limits
librqbit 9.1 already has a per-torrent `Limits` (`TorrentStateLive.ratelimits`). Uploads acquire the torrent limiter and then the session limiter. The torrent limiter is built only from `AddTorrentOptions.ratelimits`, when the live state is created.
- **Patch:** add `ManagedTorrent::set_ratelimits(&self, cfg: LimitsConfig)` to the vendored crate. It sets `set_download_bps`/`set_upload_bps` on the live state's limiter. It also stores `cfg`, so the next live state (after a pause/unpause or recheck) is built with it. Before writing it, confirm that the download path acquires the torrent limiter as well (around `live/mod.rs` line 1741). If it doesn't, add that one call to the patch. Add the entry to `MAGLEV_PATCH.md`.
- **JNI:** `nativeSetTorrentLimits(id: String, json: String): String`. The JSON is `{"down_bps":u64,"up_bps":u64}`, where `0` means no limit. It returns a Result; the only error is `NOT_FOUND`. Values above `u32::MAX` are clamped.
- **Persistence:** stored in a sidecar, `<sessionDir>/maglev-limits.json`, keyed by info-hash. It is re-applied on restore, re-add and recheck.
- **Snapshot:** gains `down_limit_bps: u64` and `up_limit_bps: u64` (0 = none).
- **Global limits still apply.** The effective speed is the lower of the two. The UI says "This torrent: 2 MB/s. The overall limit still applies."
- **Add:** `nativeAddTorrent` options gain optional `"down_limit_bps"` and `"up_limit_bps"`.

### 11.3 Move finished or active downloads
- **New state `MOVING`** joins `TorrentState` (and SM-1). The snapshot gains `move_progress: f64 | null`, from 0 to 1 by bytes, and non-null only while `MOVING`.
- **JNI:** `nativeMoveStorage(id: String, destDir: String): String`. It returns a Result **immediately**, and the move runs on the engine runtime. `destDir` is an absolute POSIX directory, and Rust creates it. The torrent's own layout is kept: a multi-file torrent moves to `<destDir>/<name>/`, a single file to `<destDir>/<file>`.
- **Errors** (immediate): `NOT_FOUND`; `UNSUPPORTED` when the torrent is `INITIALIZING`, `CHECKING` or `MOVING`, or when the destination equals the current folder; `PERMISSION` when the destination isn't writable.
- **Algorithm** (holds the tick lock for the whole move, as recheck does):
  1. Remember the pre-move state and `paused_by`, then pause.
  2. For each existing file, try `rename`. If that fails with `EXDEV`, copy it in 1 MiB chunks, `fsync`, then remove the source. Update `move_progress` as it goes.
  3. Re-add the torrent at the new `output_folder` with the same include set, priorities (§10.1) and limits (§11.2), and run the same forget + re-add path as Recheck. The result is `CHECKING` and then the pre-move state. A user-paused torrent stays paused.
  4. On any I/O error, move the files already moved back, keep the old folder, set `ERROR` with `DISK_FULL` or `PERMISSION`, and leave the torrent recoverable with Retry.
  5. Remove the now-empty source folder of a multi-file torrent.
- **Persistence:** the new `output_folder` persists. A crash mid-move restores at the old folder, and files already moved show as missing until Recheck (`FILES_MISSING`). This edge is accepted for v1.
- **Kotlin:** `moveStorage(id, target)`. `target` is either `{kind:"default"}` or `{kind:"tree", uri}` from the folder picker.
  - Kotlin resolves it with the same rules as the storage setting (§5).
  - Only directories Maglev can write **directly** are allowed. A tree that would need staging returns `UNSUPPORTED` with the message "Maglev can't keep active torrents in this folder. Pick a folder inside Download, or use the default."
  - When the move is cross-volume, check free space first. If `StatFs` free space at the destination is below the bytes still to move plus 200 MB, return `DISK_FULL`.

### 11.4 Streaming
- **Rust:** `nativeStreamUrl(id, fileIndex)` works for any **included** file, finished or not. It returns `UNSUPPORTED` for a skipped file and adds `"mime"` to the result.
- **Detail `files[]`** gains `stream_ready_bytes: u64`: the contiguous downloaded bytes from the start of the file, computed from the bitfield. Also add `"tail_ready": bool`, true when the last piece of the file is present (players read the MP4 index there).
- **Kotlin:** `openStream(url, mime, title)` sends `ACTION_VIEW` with `setDataAndType(Uri.parse(url), mime)` and `EXTRA_TITLE`, through `Intent.createChooser` titled "Play with". It returns `{ok:false, code:"UNSUPPORTED", message:"No video player found. Install VLC or another player."}` when nothing resolves.
- **UI:** "Stream" is offered for video and audio files (from the `fileKind` helper) while downloading or finished. The sheet shows readiness:
  - "Ready to play" when it's finished, or when `stream_ready_bytes ≥ min(8 MB, 5% of the file)` and `tail_ready`.
  - Otherwise "Starting may pause to buffer (N% ready)".
  - In both cases Stream stays enabled. Streaming a file reorders its pieces through librqbit's stream reader. The UI never says "sequential download".
- **When you tap Stream,** if the torrent is paused by the user, resume it first and say "Resumed to stream".

### 11.5 Scheduler (SM-26)
Kotlin owns the scheduler. It is another governance input, next to network and power.
- **Config** (JS → Kotlin `setSchedule(json)`, persisted in SharedPreferences `maglev_schedule`):
  `{enabled: bool, rules: [{id: string, days: number[] /* 0=Mon … 6=Sun */, start: "HH:MM", end: "HH:MM", action: "pause" | "limit", downBps?: number, upBps?: number}]}`.
- **Evaluation:** pure Kotlin, `ScheduleEvaluator.evaluate(config, now: LocalDateTime): ScheduleState`, where `ScheduleState = {paused, downBps: Long?, upBps: Long?, activeRuleIds, nextBoundary: LocalDateTime?}`.
  - `end <= start` means the window runs past midnight. `days` refers to the day the window **starts**. `start == end` means all day.
  - **Overlaps:** `pause` wins. Among `limit` rules the lowest non-zero value wins, per direction.
  - `nextBoundary` is the soonest start or end of any rule within the next 8 days.
- **Apply:** a pause uses `nativeSetTransfersAllowed(false, "schedule")`. Limits apply as `min(global, schedule)` per direction through `nativeSetGlobalLimits`, with 0 meaning none. Settings never show the schedule-adjusted value as the user's global limit.
- **Paused reason:** `paused_by: "schedule"`. The UI label is "Scheduled pause · resumes 01:00", with the time taken from `nextBoundary`.
- **While paused, the service stops,** about 10 s after entering the pause. It persists `scheduleHeld = true` so a sticky restart doesn't resume anything.
- **Wake-up:** `AlarmManager.setAndAllowWhileIdle(RTC_WAKEUP, nextBoundary)` is inexact and needs no permission. The receiver re-evaluates.
  - If the schedule allows transfers again and `scheduleHeld` is set, it starts the service headless (§8 path), subject to the background-start rule.
  - Refused-start notification: title "Scheduled downloads are ready", text "Tap to start them."
  - Re-arm on `ACTION_TIME_CHANGED`, `ACTION_TIMEZONE_CHANGED`, app start and every `setSchedule`.
  - While the service runs, it also re-evaluates once a minute, because alarms can be late.
- **JS status:** `getScheduleStatus(): {enabled, paused, activeRuleIds, nextBoundary: epochMs | null}`.

### 11.6 Feed rules (SM-25)
The Feeds tab keeps its TS parsing for display. Automation runs in Kotlin so it works with the app closed.
- **Config** (JS → Kotlin `setFeedAutomation(json)`, persisted in SharedPreferences `maglev_feeds`):
  `{enabled: bool, intervalMins: 15 | 30 | 60, feeds: [{id, url, name}], rules: [Rule]}`.
  `Rule = {id, name, feedIds: string[] /* empty = all */, include: string, exclude: string, episodes: "all" | "new_only", startPaused: bool, enabled: bool}`.
- **Matching is case-insensitive, with one source of truth for the semantics:** `scripts/fixtures/feeds/rule-vectors.json` (`[{rule, title, seenEpisodes, expect}]`). Both `utils/feedRules.ts` (`scripts/test-feeds.js`) and Kotlin `FeedRuleMatcher` (JVM test) must pass every vector.
  - `include`: every whitespace-separated word must appear. If the string is wrapped in `/…/`, it's a regex instead, and an invalid regex never matches.
  - `exclude`: same syntax; any match rejects the item. Empty means nothing is excluded.
  - `episodes: "new_only"`: parse the episode key from the title (`S01E02`, `1x02`, `S01E01-E03`, and anime ` - 12 ` with an optional `v2`) as `"s1e2"`. Skip an item whose key is already in `seenEpisodes` for that rule. Titles with no key match normally.
- **Worker:** `FeedWorker`, a `CoroutineWorker` scheduled as unique periodic work `maglev-feeds` with `ExistingPeriodicWorkPolicy.UPDATE`. Constraints are `CONNECTED`, or `UNMETERED` when the Wi-Fi-only governance setting is on. It adds `androidx.work:work-runtime-ktx`.
  - Fetch each feed with `HttpURLConnection`: 15 s timeouts and a 2 MB cap. Parse RSS 2.0 and Atom with `XmlPullParser`. The source is a magnet from `link`, an `enclosure`, `torznab:attr magneturl`/`infohash`, or a `.torrent` URL.
  - Seen items are keyed `feedId + (guid || link)` and capped at 1000 per feed. The first fetch of a new feed marks everything as seen and adds nothing.
  - Matches are appended to a pending-add queue in SharedPreferences. The worker then starts the service with `ACTION_DRAIN_FEED_ADDS`, subject to the background-start rule. The service drains the queue through the normal add path (`.torrent` URLs go through `TorrentFetcher`). A duplicate counts as done.
  - Refused-start notification: title "N new from <rule name>", text "Tap to download."
- **JS status:** `getFeedAutomationStatus(): {lastRunAt: epochMs | null, lastError: string | null, addedTotal: number, pending: number}` and `runFeedCheckNow()`, which enqueues a one-time `maglev-feeds-now`.

### 11.7 Service restart check (C-SVC-3)
- Extract the restart decision into pure Kotlin: `RestartPolicy.decide(input): Decision`. The input is the persisted intent (`userShutdown`, `userPausedAll`, `scheduleHeld`) and the count of active torrents. The decision is `Resume | StayStopped`.
- **JVM unit tests** go in `modules/maglev-engine/android/src/test/` (JUnit 4, `testImplementation`), together with the `ScheduleEvaluator` and `FeedRuleMatcher` tests. CI runs them after prebuild.
- **Device check:** `scripts/device/test-service-restart.sh`. With a torrent downloading, it runs `adb shell am crash com.maglev`, waits up to 60 s, then asserts that the service is back (`dumpsys activity services com.maglev`) and that the download is moving again (logcat telemetry line or notification text). A user-paused run must stay stopped.

### 11.8 Module API additions (§6)
`setTorrentLimits(id, {downBps, upBps})`, `moveStorage(id, target)`, `openStream(url, mime, title)`, `setSchedule(cfg)`, `getScheduleStatus()`, `setFeedAutomation(cfg)`, `getFeedAutomationStatus()`, `runFeedCheckNow()`.
- The mock engine implements all of them with the same validation. `MOVING` is simulated over about 3 s in dev only.
- The TS snapshot maps `down_limit_bps`, `up_limit_bps` and `move_progress`. The file detail maps `stream_ready_bytes` and `tail_ready`.

## 12. Wave 4.5: native items (user-approved 2026-11-11)

The UI side is in `UI_SPEC_PHASE2.md` S10.

### 12.1 Activity while a magnet resolves
librqbit resolves a magnet inside `Session::add_torrent(.., list_only: true)` and exposes no progress for it. Maglev therefore reports only what it can observe itself, and the copy never claims more.
- **Rust:** when `resolve_metadata` starts on a magnet, it spawns a side task on the session runtime. The task reads `session.get_dht()` (if DHT is on) and the `get_peers(info_hash, None)` stream, and counts **unique peer addresses**. It stops when the resolve ends, either successfully or with an error or timeout.
  - Counts live in a map keyed by info-hash: `{peers_found: u32, dht: bool, elapsed_ms: u64}`.
  - Before writing this, verify the DHT accessor and stream API against the vendored source and cite file:line.
- **JNI:** `nativeResolveActivity(infoHash: String): String` returns `{"ok":true,"peers_found":n,"dht":bool,"elapsed_ms":n}` or `NOT_FOUND` when no resolve is running.
  - `nativeCancelResolve(infoHash: String): String` aborts a running resolve. The blocked `nativeResolveMetadata` call then returns `{"ok":false,"code":"CANCELLED"}`. `CANCELLED` is added to the closed error set, and the UI never shows it as an error.
- **UI** (Add screen while resolving), polled every 1 s:
  - With DHT on: "Looking for peers · 14 found". With DHT off: "Asking trackers…". The elapsed time shows as a quiet timer.
  - After 5 s it offers **Start now, choose files later**. That cancels the resolve and adds the magnet the normal way (`INITIALIZING`, all files), then goes back to Transfers with the notice "Added. You can choose files once its details arrive."

### 12.2 Finished files show up in gallery and music apps
- **Kotlin:** on the `finished` false→true edge (§9), and after a successful move (§11.3) or staging copy, call `MediaScannerConnection.scanFile(context, paths, null, null)` for every included file in public shared storage.
  - For SAF trees, call it on the resolved path when one exists. Otherwise skip: the document provider indexes those itself.
  - Run it at most once per torrent per completion, and never for private or staging directories.
- No UI. On a device, check that a finished video shows up in Google Photos (or the gallery app) within a few seconds.
