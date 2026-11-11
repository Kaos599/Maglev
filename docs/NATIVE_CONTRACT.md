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
