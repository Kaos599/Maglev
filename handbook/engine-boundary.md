# Engine boundary

The exact line between the three layers: what TypeScript can call, what Kotlin passes to Rust, what comes back, and what the app tells the user when something fails.

**Change this page first when the boundary changes.** A new bridge method, a new field in a snapshot, a new error code or a new state goes here in the same PR as the code, before or with the code, never after. Reviewers check the PR against this page.

## The path of one call

```
TypeScript                      Kotlin                                    Rust
──────────                      ──────                                    ────
maglevEngine.pause(id)
  MaglevNativeBridge.ts  ─────▶ MaglevEngineModule.kt  AsyncFunction("pause")
                                  EngineHost.call { NativeCore.nativePause(id) }, then EngineHost.pollNow()
                                    NativeCore.nativePause(id)  ─JNI─▶  jni.rs  Java_com_maglev_engine_NativeCore_nativePause
                                                                          MaglevEngine::pause (engine.rs)
                                                                       ◀─ '{"ok":true}'
                                  Json.parseObject → Json.camelize
  Promise resolves ◀──────────── promise.resolve(map)
```

| File | Role |
|---|---|
| `modules/maglev-engine/src/MaglevEngine.types.ts` | Every type that crosses the boundary, and the `MaglevEngineApi` interface. |
| `modules/maglev-engine/src/MaglevNativeBridge.ts` | The `maglevEngine` singleton. Picks native or the dev simulator, starts the engine, fans events out to listeners. |
| `modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt` | The Expo module `MaglevEngine`: one `AsyncFunction` per bridge method, plus the events and the browser view. |
| `modules/maglev-engine/android/src/main/java/com/maglev/engine/EngineHost.kt` | Engine lifecycle, the poll loop, governance, the service, completions. Everything Kotlin does between JS and JNI. |
| `modules/maglev-engine/android/src/main/java/com/maglev/engine/NativeCore.kt` | The `external fun` declarations. Loads `libmaglev_core.so`. |
| `native/maglev-core/src/jni.rs` | The JNI exports. Each one reads its arguments, runs the engine call inside `catch_unwind` and returns a JSON string. |
| `native/maglev-core/src/engine.rs` | `MaglevEngine`: the librqbit session, link downloads, the stream server. |

## Rules

| Rule | Where it holds |
|---|---|
| **JSON over JNI.** Every export takes and returns UTF-8 JSON strings. The one exception is `nativeGetPieceBitfield`, which fills a direct 256-byte buffer. | `jni.rs` |
| **Every call returns a result envelope.** Success is `{"ok":true, …payload}`. Failure is `{"ok":false,"code":"…","message":"…"}`. | `error.rs` (`EngineError::to_json`), `Json.failure` in Kotlin |
| **Nothing throws across the boundary.** Rust wraps each export in `catch_unwind`; a panic becomes an `INTERNAL` envelope. Kotlin catches every `Throwable` and resolves an `INTERNAL` envelope. JS promises resolve; they don't reject for engine errors. The four wrappers `engine`, `io`, `native` and `blocklist` all resolve `INTERNAL`. Subtitle calls are the exception: they reject (see Subtitles below). | `jni.rs` `guarded`, `MaglevEngineModule.kt` `engine` / `io` / `native` / `blocklist` |
| **snake_case in Rust, camelCase in TS.** Kotlin converts on the way out (`Json.camelize`) and on the way in (`Json.snakeify`). `toNativeConfig` emits snake_case on purpose, because Rust reads it as-is. | `util/Json.kt`, `snapshotMapping.ts` |
| **Units.** Bytes are integers, speeds are bytes per second, times are seconds unless the name ends in `Ms`. `-1` means unknown (`etaSecs`, `eta`); the UI shows it as "—". | everywhere |
| **Calls never run on the JS thread.** Short calls run one at a time on the `maglev-control` thread. Calls that can block for a long time (resolve, add, probe, move, export) run on `Dispatchers.IO`. The poll loop has its own `maglev-poll` thread. | `EngineHost.kt` |
| **No simulator in release.** If the module or the library is missing, a release build shows `engineStatus.kind = 'unavailable'`. Only `__DEV__` and web fall back to `MaglevMockEngine.ts`, and Metro strips it from release bundles. | `MaglevNativeBridge.ts` `simulatorIfAllowed` |
| **No made-up values.** The bridge never fills in files, peers, sizes or speeds. Unknown stays unknown. | review rule |

## Bridge API

`maglevEngine` (from `maglev-engine`) implements `MaglevEngineApi`. Every method resolves an `EngineResult<T>` unless the table says otherwise. The JNI column names the Rust export a call reaches; "Kotlin" means Kotlin answers it without Rust.

These methods resolve plain values, not an `EngineResult`: `getStorageStatus`, `pickFolder` and `pickDownloadFolder`, `getAppIcon`, `openBatterySettings`, `openNotificationSettings` and `openLiveUpdateSettings`, `getPlaybackSupport`, `getScheduleStatus`, `getFeedAutomationStatus`, `getInstallSource`, `getPermissionStatus`, `verifyListSignature`, `videoSitesVersion`, `videoSitesStatus` and `videoSitesConfigure`, and `getActiveBlocks`. `getPieceBitfield` and `version` are plain too (see their rows).

### Engine and torrents

| Method | JNI export | Notes |
|---|---|---|
| `init(config)` | `nativeInit` | Idempotent. Result carries `streamPort`, `torrents` (how many torrents were loaded, a count) and, when the config was bad or the port was busy, `configWarning`. |
| `shutdown()` | `nativeShutdown` | Flushes persistence, stops the session. |
| `restartEngine()` | `nativeShutdown` + `nativeInit` | `INVALID_STATE` while a restart is already running. |
| `resolveMetadata(source, timeoutMs)` | `nativeResolveMetadata` | Magnet, `.torrent` URL or path. Doesn't add. `INVALID_SOURCE`, `METADATA_TIMEOUT`, `NETWORK`, `CANCELLED`. |
| `getResolveActivity(infoHash)` | `nativeResolveActivity` | `{peersFound, dht, elapsedMs}` while a magnet resolves; `NOT_FOUND` otherwise. |
| `cancelResolve(infoHash)` | `nativeCancelResolve` | The pending resolve returns `CANCELLED`. |
| `addTorrent(source, options)` | `nativeAddTorrent` | `{id, infoHash}`. `DUPLICATE` carries the existing `id` and changes nothing. |
| `listTorrents()` | `nativeListTorrents` | `{torrents: Snapshot[], downloads?: DownloadSnapshot[]}`. Cheap; the poll loop calls it. |
| `getDetail(id)` | `nativeGetDetail` | `Detail`. |
| `pause(id)`, `resume(id)`, `recheck(id)` | `nativePause`, `nativeResume`, `nativeRecheck` | User actions. Resume clears a rule's `pausedBy`. |
| `resumeAnyway(id)` | `nativeResumeAnyway` | Resumes and exempts this torrent from the rules a user may override until it finishes, is removed or is paused. |
| `pauseAll()`, `resumeAll()` | Kotlin, looping `nativePause` / `nativeResume` | Pause all is saved, so a restart after process death doesn't undo it. Resume all skips torrents held by a file-health tag. |
| `delete(id, deleteFiles)` | `nativeDelete` | |
| `setIncludedFiles(id, indices)` | `nativeSetIncludedFiles` | |
| `setFilePriorities(id, entries)` | `nativeSetFilePriorities` | `FilePriority` is `first`, `normal` or `skip`. |
| `removeFiles(id, indices)` | `nativeRemoveFiles` | `{freedBytes}`. |
| `setHealth(id, tag)` | `nativeSetHealth` | `''` clears the tag. |
| `scanFileHealth()`, `fileHealth(id)` | `nativeScanFileHealth`, `nativeFileHealth` | File states `ok`, `missing`, `changed`. |
| `resolveFiles(id, action, indices, dir)` | `nativeResolveFiles` | `action` is `stop`, `again`, `folder` or `recheck`. |
| `reannounce(id)` | `nativeReannounce` | May fail with `retryAfterSecs`. |
| `addTrackers(id, urls)`, `removeTracker(id, url)` | `nativeAddTrackers`, `nativeRemoveTracker` | |
| `exportTorrent(id)` | `nativeExportTorrent` | Kotlin picks the destination path. `shareExportedTorrent(path)` is Kotlin. |
| `setTorrentLimits(id, {downBps, upBps})` | `nativeSetTorrentLimits` | 0 means no limit. |
| `moveStorage(id, target)` | `nativeMoveStorage` | `target` is `{kind:'default'}` or `{kind:'tree', uri}`. The state is `MOVING` while it runs. |
| `setGlobalLimits(down, up)` | `nativeSetGlobalLimits` | Applies live. |
| `applyConfig(config)` | `nativeApplyConfig` | `{restartRequired}`. |
| `getEffectiveConfig()` | `nativeGetEffectiveConfig` | `EffectiveConfig`: the saved config plus `restartPending` and `blocklist`. |
| `getPieceBitfield(id)` | `nativeGetPieceBitfield` | Resolves a plain 256-number array (16×16 grid; 0 missing, 1 have, 2 partial). Not an envelope. |
| `streamUrl(id, fileIndex)` | `nativeStreamUrl` | `{url, mime}`, a loopback URL with a per-session token. |
| `version()` | `nativeVersion` | `{engine, version}`. Not an envelope. About shows it. |

### Link downloads

| Method | JNI export | Notes |
|---|---|---|
| `probeUrl(url, options, timeoutMs)` | `nativeProbeUrl` | `{name, size, resumable, urlDisplay}`. Size is `null` when the server doesn't say. |
| `probeStream(url, options, timeoutMs)` | `nativeProbeStream` | HLS or DASH. Adds `STREAM_PROTECTED`, `STREAM_LIVE`, `STREAM_UNSUPPORTED`. |
| `addDownload(url, options)` | `nativeAddDownload` | `{id}`. Kotlin fills `folder` with the active download folder when the caller didn't. |
| `pauseDownload`, `resumeDownload`, `resumeDownloadAnyway`, `retryDownload`, `removeDownload(id, deleteFiles)` | same names with `native` prefix | `retryDownload` after `FILE_CHANGED` starts over from zero. |
| `refreshDownloadUrl(id, url, options)` | `nativeRefreshDownloadUrl` | Only for `needs_link`. `FILE_CHANGED` when the new link is another file. |
| `setDownloadLimits(id, {downLimitBps})` | `nativeSetDownloadLimits` | |
| `allowLanHost(id)` | `nativeAllowLanHost` | Allows a host on the user's own network. Call `retryDownload` next. |
| `openDownload`, `shareDownload` | Kotlin | `NO_APP` when nothing can open the file. |
| `getNetworkState()` | Kotlin | `{connected, metered}`. |
| `videoSitesResolve(url)` | Kotlin (yt-dlp) | `{json}`: the page's formats as trimmed yt-dlp JSON. Maglev's own downloader fetches the files. |
| `videoSitesUpdate`, `videoSitesVersion`, `videoSitesStatus`, `videoSitesConfigure` | Kotlin | yt-dlp self-update. `videoSitesUpdate` answers `updated`, `current` or `failed`; `failed` is a normal answer. |

### Storage, files, permissions

All Kotlin, no JNI: `pickDownloadFolder`, `pickFolder`, `getStorageStatus`, `getFreeSpace`, `openFile`, `shareFile`, `openFolder`, `openDownloadFolder`, `getPermissionStatus`, `requestNotifications`, `requestLegacyStorage`, `openBatterySettings`, `openNotificationSettings`, `openLiveUpdateSettings`, `getAppIcon`, `setAppIcon`, `exportDebugLog`, `shareDebugLog`, `getPlaybackSupport`, `openStream`.

### Rules, schedule, feeds

| Method | Notes |
|---|---|
| `setGovernance(config)` | Wi-Fi only, allowed Wi-Fi names, charging only, battery cut-off, VPN only, seeding on mobile data, resume after restart. Kotlin watches the network and battery and tells Rust through `nativeSetTransfersAllowed`. |
| `getActiveBlocks()`, `addBlocksListener(fn)` | Every rule holding transfers right now (`ActiveBlock[]`). Never throws. |
| `setSchedule`, `getScheduleStatus` | Kotlin alarms. |
| `setFeedAutomation`, `getFeedAutomationStatus`, `runFeedCheckNow` | Kotlin WorkManager job. |

### Updates and lists

Kotlin only: `getInstallSource`, `downloadUpdate(url, sha256, size, requireVpn)`, `getUpdateNetwork`, `cancelUpdateDownload`, `installUpdate(path, silent, sha256)`, `openInstallPermissionSettings`, `cleanupUpdates`, `postUpdateNotice`, `clearUpdateNotice`, `verifyListSignature(body, sigB64)`.

### Subtitles

Kotlin only: `subtitleHash(pathOrUri)`, `saveSubtitle(video, fileName, base64, replace)`, `unzipSubtitles(base64)`. These throw a `SubtitleError` with a `SubtitleErrorCode` instead of resolving an envelope.

### Other native modules

| Module | Functions | Used by |
|---|---|---|
| `MaglevWatch` | `getNetwork`, `notify`, `cancel` | Watches (`utils/watch/`) |
| `MaglevQuickShare` | `open` | Quick share card |
| `MaglevBrowserView` (view inside `MaglevEngine`) | Commands `goBack`, `goForward`, `reload`, `stop`, `loadUrl`, `scan`, `findInPage`, … Events `onPage`, `onFound`, `onDownloadRequest`, `onMagnet`, `onPopupRequest`, `onPopupBlocked`, `onMediaHit`, … | `modules/maglev-engine/src/MaglevBrowser.tsx` |

## Events

| Event | Payload | When |
|---|---|---|
| `onTelemetry` | `{torrents: Snapshot[], downloads: DownloadSnapshot[], serviceBlocked}` | Every poll while the app is in front. At most every 5 s in the background, and once right away on return. |
| `onTorrentCompleted` | `{id, name}` | On a torrent's `finished` false → true edge. |
| `onNotificationAction` | `{action}`: `pause_all`, `resume_all`, `shutdown`, or `stopped_by_android` with a `message` | A notification or tile button, or the app opening after Android killed it mid-transfer. |
| `onStorageStatus` | `{path, fallback, safLost, mode, uri, displayName, copyError?}` | The download folder changed or became unreachable. |
| `onBlocksChanged` | `{blocks: ActiveBlock[]}` | The set of rules holding transfers changed. |
| `onUpdateProgress` | `{bytes, total}` | While an update downloads. `total` is 0 when the server didn't say. |
| `onUpdateResult` | `{ok:true, status:'needs_user'|'installed'}` or `{ok:false, code, message}` | The install session ended. |
| `onNetworkChanged` | `{connected, metered}` | The default network changed. Sent only while JS listens. Lands with PR #229. |

Kotlin sends a few fields the TS types don't include yet: `serviceBlocked` on `onTelemetry` (telemetry), and `mode`, `uri`, `displayName` and `copyError` on `onStorageStatus` (storage status). `MaglevEngine.types.ts` is the reference, so read the Kotlin when you need these.

## JNI exports

All live in `native/maglev-core/src/jni.rs` and are declared in `NativeCore.kt` as `@JvmStatic external fun`. Symbols are `Java_com_maglev_engine_NativeCore_<name>`. Every one returns a JSON string except `nativeGetPieceBitfield` (`Int`, the count written).

| Export | Arguments |
|---|---|
| `nativeInit` | `configJson`, `sessionDir`, `defaultDownloadDir`. An empty config means "use the last saved one" (headless restarts rely on this). |
| `nativeShutdown`, `nativeListTorrents`, `nativeGetEffectiveConfig`, `nativeScanFileHealth`, `nativeNetworkChanged`, `nativeVersion` | none |
| `nativeResolveMetadata` | `source`, `timeoutMs` |
| `nativeResolveActivity`, `nativeCancelResolve` | `infoHash` |
| `nativeAddTorrent` | `source`, `optionsJson` |
| `nativeGetDetail`, `nativePause`, `nativeResume`, `nativeResumeAnyway`, `nativeRecheck`, `nativeReannounce`, `nativeFileHealth` | `id` |
| `nativeDelete` | `id`, `deleteFiles` |
| `nativeSetIncludedFiles`, `nativeRemoveFiles` | `id`, `indicesJson` |
| `nativeSetFilePriorities`, `nativeSetTorrentLimits` | `id`, `json` |
| `nativeAddTrackers` | `id`, `urlsJson` |
| `nativeRemoveTracker` | `id`, `url` |
| `nativeExportTorrent` | `id`, `destPath` |
| `nativeSetGlobalLimits` | `downBps`, `upBps` |
| `nativeApplyConfig` | `configJson` |
| `nativeSetTransfersAllowed` | `allowed`, `reason` (a rule tag). Kotlin governance only. |
| `nativeSetNetworkMetered`, `nativeSetNetworkOff` | `metered` / `off`. Kotlin governance only. |
| `nativeGetPieceBitfield` | `id`, a direct 256-byte `ByteBuffer` |
| `nativeMoveStorage` | `id`, `destDir` |
| `nativeSetHealth` | `id`, `tag` |
| `nativeResolveFiles` | `id`, `action`, `indicesJson`, `dir` |
| `nativeStreamUrl` | `id`, `fileIndex` |
| `nativeProbeUrl`, `nativeProbeStream` | `url`, `optionsJson`, `timeoutMs` |
| `nativeAddDownload` | `url`, `optionsJson` |
| `nativePauseDownload`, `nativeResumeDownload`, `nativeResumeDownloadAnyway`, `nativeRetryDownload`, `nativeAllowLanHost` | `id` |
| `nativeRemoveDownload` | `id`, `deleteFiles` |
| `nativeRefreshDownloadUrl` | `id`, `url`, `optionsJson` |
| `nativeSetDownloadLimits` | `id`, `json` |
| `nativeFinishMux` | `id`, `ok`, `errorMessage`. Kotlin reports the result of joining a video and an audio file. |

48 exports in all. A new one needs a matching `external fun` in `NativeCore.kt`; nothing checks the pair automatically, and a missing export throws `UnsatisfiedLinkError` on the first call.

## JSON shapes

Rust sends snake_case; TS sees the camelCase names below. The TS types in `MaglevEngine.types.ts` are the reference.

### Result envelope

```jsonc
{ "ok": true, ...payload }
{ "ok": false, "code": "DISK_FULL", "message": "plain English",
  "id": "…",              // DUPLICATE: the torrent that already exists
  "retryAfterSecs": 30,   // reannounce too soon
  "httpStatus": 404 }     // HTTP_STATUS, AUTH_REQUIRED, LINK_REFUSED
```

### NativeConfig (TS → Rust, snake_case on purpose)

```jsonc
{ "listen_port": 0, "enable_upnp": true, "enable_dht": true, "enable_lsd": true, "enable_pex": true,
  "encryption": "prefer",                 // prefer | require | disable
  "max_active_downloads": 3, "max_active_seeds": 3, "max_connections_per_torrent": 50,
  "download_limit_bps": 0, "upload_limit_bps": 0,      // 0 = no limit
  "seed_ratio_limit": 0, "seed_time_limit_mins": 0,     // 0 = none
  "peer_timeout_secs": 600,                             // seconds to wait for peers before no_peers; 0 = never give up
  "proxy_url": null,                                    // socks5h://user:pass@host:port or null
  "ip_filter_path": null }
```

### Snapshot (one torrent)

| Field | Meaning |
|---|---|
| `id` | Lower-case 40-hex info hash. Only Detail → "Copy magnet" shows it to the user. |
| `name` | The torrent's name, or "Unnamed torrent" until metadata arrives. |
| `state` | `TorrentState` (below). |
| `pausedBy` | `null`, `user`, `seed_limit`, a rule tag, or a health tag. |
| `finished` | Every included piece is present. Completion keys off this flag's false → true edge, never off `state`. |
| `progressBytes`, `totalBytes`, `includedBytes`, `heldBytes`, `uploadedBytes` | Bytes. |
| `downBps`, `upBps`, `peersLive`, `peersSeen`, `webSeeds` | Live numbers. |
| `etaSecs` | `-1` when unknown. |
| `ratio`, `seedingSecs`, `addedAt`, `outputFolder` | |
| `error` | `null` or `{code, message}` with `code` one of `DISK_FULL`, `PERMISSION`, `FILES_MISSING`, `TRACKER`, `INTERNAL` (a failed move can leave its own code: `DISK_FULL`, `PERMISSION` or `INTERNAL`). |
| `downLimitBps`, `upLimitBps` | Per-torrent limits, 0 = none. |
| `moveProgress` | 0 to 1 while `MOVING`, else `null`. |
| `health` | `null` or a `HealthTag`. |
| `mainFile` | Largest included file, `null` until metadata. |
| `resolvingSecs`, `stalledSecs` | How long a magnet has looked for metadata; how long a torrent has waited with no peer. |
| `allowedAnyway` | "Resume anyway" is active. |
| `activeSecs`, `finishedAt`, `sessionBytes`, `bytesWifi`, `bytesMobile` | Timing and byte counts for Stats. `0` on items from before these existed. |

### DownloadSnapshot (one link download)

`id`, `urlDisplay` (scheme, host and path; never a user name, password or query), `name`, `state` (`DownloadState`), `pausedBy`, `size` (`null` until the server says), `downloaded`, `downBps`, `eta` (`-1` unknown), `segmentsActive`, `downLimitBps`, `resumable`, `folder`, `addedAt`, `error` (`{code, message, httpStatus?}` or `null`), `notice`, `stalled`, `stream` (HLS/DASH progress), `muxNeeded`, `pageUrl`, `allowedAnyway`, and the same timing fields as a torrent.

### Detail

`{snapshot, files, peers, trackers, pieceCount, pieceLength}`. Each file has `index`, `path`, `length`, `progressBytes`, `onDiskBytes`, `included`, `priority`, `streamReadyBytes`, `tailReady`. Tracker `status` is always `unknown` because librqbit doesn't report it; the UI shows the URL only. Peer `progress` is always 0 for the same reason and isn't shown.

### ActiveBlock

`{tag, cause?, thresholdPct?, levelPct?, resumesAtMs?, sinceMs}`. `tag` is one of `wifi_only`, `battery`, `charging_only`, `network_unvalidated`, `vpn_required`, `offline`, `schedule`, `storage_full`, `seed_metered`.

## States

| Type | Values | Decided by |
|---|---|---|
| `TorrentState` | `INITIALIZING`, `QUEUED`, `DOWNLOADING`, `SEEDING`, `PAUSED`, `CHECKING`, `ERROR`, `COMPLETED`, `MOVING` | Rust. `scheduler.rs` plans queue, seed limits and rule pauses; `engine.rs` sets `MOVING`. |
| `PausedBy` | `user`, `seed_limit` (set when the ratio or time limit is reached); rule tags `wifi_only`, `battery`, `charging_only`, `schedule`, `network_unvalidated`, `vpn_required`, `seed_metered`, `fgs_timeout`; health tags | Rust stores it. Kotlin decides the rule tags. |
| `HealthTag` | `files_missing`, `files_changed`, `storage_full`, `storage_unavailable`, `no_peers` | Rust (`file_health.rs`, `storage_guard.rs`), Kotlin storage health. |
| `DownloadState` | `resolving`, `queued`, `downloading`, `paused`, `verifying`, `finished`, `needs_link`, `error` | Rust, `http_dl/machine.rs`: a pure `step(state, event)` with a unit test per transition. |
| `EngineStatus.kind` | `starting`, `ready`, `unavailable` | TS bridge. |

State rules Rust enforces:

- At most `max_active_downloads` torrents are `DOWNLOADING`; the rest wait as `QUEUED` and start in `addedAt` order. `0` means no limit. The same holds for seeds.
- A finished torrent with no free seed slot becomes `COMPLETED`, never `QUEUED`. `QUEUED` is only for unfinished torrents.
- Reaching the ratio or time limit pauses with `pausedBy: seed_limit`, and the state shows `COMPLETED`. A user resume waives the limit for that torrent.
- A rule pause never overrides a user pause. Lifting a rule resumes only the torrents that carry that rule's tag.
- `storage_full` never stops a finished torrent (seeding writes nothing). `seed_metered` only touches finished torrents.
- "Resume anyway" can override `wifi_only`, `battery`, `charging_only`, `schedule` and `seed_metered`. It never overrides storage, VPN, offline or unvalidated-network blocks.
- Torrents, their states, `pausedBy`, `addedAt` and the config survive process death.

## Error codes

Rust picks the code and writes a plain-English `message`. The app shows that message unless the tables below give it its own words and buttons. A code the app doesn't know falls back to "Something went wrong." with Retry.

### Codes and who sends them

| Code | Sent by | Meaning |
|---|---|---|
| `INVALID_SOURCE` | Rust | Not a magnet, `.torrent` or readable file. |
| `DUPLICATE` | Rust | Already in the list; `id` names it. |
| `METADATA_TIMEOUT` | Rust | No one shared the torrent's info in time. |
| `CANCELLED` | Rust | The user stopped a resolve. |
| `NETWORK` | Rust | Can't reach the server or peers. |
| `NOT_FOUND` | Rust, Kotlin | No such torrent, download or resolve. |
| `DISK_FULL`, `PERMISSION`, `FILES_MISSING` | Rust | Storage full; can't write the folder; files gone on resume. |
| `TRACKER` | Rust | Only in `Snapshot.error`. |
| `NOT_INITIALIZED` | Rust | The engine isn't running. |
| `ENGINE_UNAVAILABLE` | Rust, Kotlin | The native library didn't load or the module isn't attached. |
| `UNSUPPORTED`, `INVALID_ARGUMENT`, `INVALID_STATE`, `NOT_READY`, `INTERNAL` | Rust, Kotlin | Programming or timing errors. `INTERNAL` also covers a Rust panic. |
| `HTTP_STATUS`, `AUTH_REQUIRED`, `LINK_REFUSED`, `LINK_EXPIRED`, `FILE_CHANGED`, `NOT_A_FILE`, `CHECKSUM_MISMATCH`, `STALLED`, `LAN_ADDRESS`, `LOCAL_REDIRECT`, `BLOCKED` | Rust (`http_dl`); Kotlin sends `BLOCKED` too, for updates and block lists | Link download failures. |
| `STORAGE_UNAVAILABLE`, `FILE_TOO_LARGE` | Rust (`http_dl`) | Folder gone (SD card out); file over the 4 GB FAT32 limit. |
| `STREAM_PROTECTED`, `STREAM_LIVE`, `STREAM_UNSUPPORTED`, `MUX_FAILED` | Rust | HLS/DASH: DRM or unknown encryption; a live stream; an unreadable stream; joining video and audio failed. |
| `NO_APP` | Kotlin | No app on the phone opens the file. |
| `SITE_NOT_SUPPORTED`, `SITE_NEEDS_LOGIN`, `SITE_NO_VIDEO`, `SITE_FAILED`, `VIDEO_SITES_UNAVAILABLE` | Kotlin (yt-dlp) | Video-site reads. TS adds `SITE_NO_FORMAT` itself when a page has video but none Maglev can save. |

`TRACKER`, `LOCAL_REDIRECT`, `BLOCKED`, `STORAGE_UNAVAILABLE` and `FILE_TOO_LARGE` reach TS but are missing from the `EngineErrorCode` union; the copy code matches them as strings. `TRACKER` is typed on `SnapshotError.code`, and `DownloadError.code` lists `LOCAL_REDIRECT` and `BLOCKED` in an `Extract` over the union, which drops them. `STORAGE_UNAVAILABLE` and `FILE_TOO_LARGE` are typed nowhere. Add them to the union when you next touch it.

### Torrent detail banner (`components/detail/errorActions.ts`)

| Code or pause | Message | Buttons |
|---|---|---|
| `DISK_FULL`, or `pausedBy: storage_full` | Storage full. | Free up space, Move |
| `PERMISSION` | Maglev can't write to this folder. | Pick folder again |
| `FILES_MISSING` | Some files are missing. | Recheck |
| `pausedBy: storage_unavailable` | The SD card isn't there. | Move |
| `NETWORK`, any code containing `TRACKER` | Can't reach anyone right now. | Retry |
| `INTERNAL` and anything else (the fallback) | Something went wrong. | Retry, Recheck |

### Adding a torrent (`app/add-torrent.tsx`, `constants/copy.ts`)

| Code | What the user sees |
|---|---|
| `DUPLICATE` | "Already in Transfers" and "This torrent is already added.", with **Open it** and Back. |
| `INVALID_SOURCE`, or a source the screen rejects before calling the engine | "That isn't a link, magnet link or torrent file." |
| `METADATA_TIMEOUT` | "Couldn't find torrent info" with **Retry** and, for a magnet link, **Add anyway**. For a file, Back replaces Add anyway. |
| `CANCELLED` | Nothing. The user already moved on. |
| `NOT_INITIALIZED`, or a failed automatic restart | The engine's own reason, with **Start the downloader**. |
| anything else | "Couldn't read this torrent" with **Retry** and Back. |

### Adding from Search and Feeds (`utils/addErrorNotice.ts`)

Search and Feeds use a short notice instead of a screen.

| Code | What the user sees |
|---|---|
| `DUPLICATE` | "Already in your list". |
| `INVALID_SOURCE` | "That link is not a valid torrent". |
| `NOT_INITIALIZED`, or a failed automatic restart | The engine's own reason, with **Start the downloader**. |
| anything else | "Could not add the torrent" and the engine's message. |

### Link downloads (`utils/downloadCopy.ts`)

| Code | Card line | Buttons |
|---|---|---|
| `FILE_CHANGED` | The file changed on the server · Restart | Restart |
| `NOT_A_FILE` | This link opens a web page, not a file | Remove |
| `CHECKSUM_MISMATCH` | File doesn't match the checksum | Remove |
| `HTTP_STATUS` (final 4xx) | the server's message | Remove |
| `HTTP_STATUS` (other), `NETWORK` | the server's message | Retry |
| `PERMISSION` | Maglev can't write to that folder. | Pick folder again, Retry |
| `STORAGE_UNAVAILABLE` | Folder not available (the card line; the sheet and screen readers get "The folder isn't available. Is the SD card in?") | Pick folder again |
| `FILE_TOO_LARGE` | This file is bigger than the card's format allows (4 GB). Use phone storage. | Pick folder again |
| `LOCAL_REDIRECT` | A redirect tried to send Maglev to a device on your network, so it stopped. | Remove |
| `LAN_ADDRESS` | This address points to a device on your network. | Allow this device, Remove |
| `BLOCKED` | Blocked by your Wi-Fi-only or VPN setting. | Open settings, Retry |
| `AUTH_REQUIRED` | This link needs you to sign in again. Paste the link again. | Paste new link |
| `LINK_REFUSED` (state `error`) | The site refused this link. Open its page again, then retry. | Paste new link |
| `STALLED` | The server stopped sending data. | Retry |
| state `needs_link` | One of: "Needs sign-in · Paste new link" (`AUTH_REQUIRED`), "Site refused · Paste new link" (`LINK_REFUSED`), "Link expired · Paste new link", and for a video site that can fetch a fresh link, "Video sites need an update" (`LINK_REFUSED`) or "Link expired · Update" | **Update** then **Paste new link** for a video site with a known page; **Paste new link** alone otherwise |
| `NO_APP` (on Open) | No app on this phone can open this file. | none |

### Engine start failure (`app/engine-error.tsx`)

`PERMISSION`, `DISK_FULL` and `STORAGE_UNAVAILABLE` offer **Pick folder again**. Everything else offers **Start the downloader**. The screen shows the engine's message; a release build never falls back to fake data.

## Settings round trip

Every user-facing setting is saved, reaches the layer that uses it, and can be read back.

```
Settings screen
  └─ settingsStore.updateSettings(…)          MaglevSettingsStore.ts, saved to expo-sqlite kv-store
       └─ subscribers → maglevEngine.applySettings(settings)     SettingsContext.tsx
            ├─ toNativeConfig(settings) → applyConfig → nativeApplyConfig        Rust settings
            ├─ toGovernance(settings)   → setGovernance                          Kotlin rules
            └─ setGlobalLimits(down, up) → nativeSetGlobalLimits
getEffectiveConfig() → nativeGetEffectiveConfig → {…NativeConfig, restartPending, blocklist}
```

- `toNativeConfig` (`modules/maglev-engine/src/toNativeConfig.ts`) is pure. It maps UI names to Rust names: speed presets to bytes per second, minutes to the units Rust wants, the proxy to a `socks5h://` URL (other proxy types aren't sent).
- `toGovernance` carries the settings only Kotlin uses: Wi-Fi only, allowed Wi-Fi names, charging only, battery cut-off, VPN only, seeding on mobile data, resume after restart, exit when done (`autoExitOnComplete`), quick add, appearance mode (`appearanceMode`), hide from gallery, automatic retry, retry delay (`autoRetryDelayMin`) and retry always (`autoRetryAlways`).
- Listening port, DHT, UPnP, local peer discovery, proxy, blocklist and connections per torrent need an engine restart. `applyConfig` answers `restartRequired`, and `getEffectiveConfig().restartPending` stays true until the running session matches the saved config. Settings → Network shows a restart banner while it's true.
- `nativeInit` with a bad config never leaves the engine down. It falls back to the last saved config or the defaults and returns `configWarning`. A busy port gets one retry with a random port and a warning; the saved port doesn't change.
- A toggle that changes nothing must not ship. Every settings row also needs an entry in `utils/settingsIndex.ts` so Settings search finds it.

## Checks that guard this page

| Check | What it proves |
|---|---|
| `npm run test:contracts` | The reality rules: no simulator in release, the settings keys reach the bridge, the service and notification wiring exist. |
| `node scripts/test-error-actions.js` | The torrent banner table above. |
| `node scripts/test-download-native.js`, `node scripts/test-url-download.js` | Link-download states and copy. |
| `node scripts/test-engine-restart-apply.js`, `node scripts/test-peer-timeout.js` | Restart-required settings and `peer_timeout_secs`. |
| `cargo test` in `native/maglev-core` (CI job "Rust tests (no JNI feature)") | `http_dl/machine.rs`, `scheduler.rs`, `error.rs` and the other pure modules. |
| CI job "Rust Android" | The `.so` is over 3 MB, carries librqbit symbols and has 16 KB page alignment. |
| `.maestro/settings-roundtrip.yaml` | Three settings survive a kill and relaunch on a real device. |

See [testing.md](testing.md) for every check and [architecture.md](architecture.md) for what each layer owns.
