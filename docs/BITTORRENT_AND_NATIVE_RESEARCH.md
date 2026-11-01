# MAGLEV — BitTorrent & Native Architecture Research (Audited & Locked)

---

## 1. BitTorrent Protocol Deep-Dive (BEP Standards)

BitTorrent is a distributed content delivery protocol operating over TCP and UDP. To achieve zero-drag efficiency in Maglev, our implementation conforms to core BitTorrent Enhancement Proposals (BEPs):

### 1.1 Core Wire Protocol & Peer Lifecycle (BEP 3)
* **Handshake:** 68-byte sequence: `<pstrlen><pstr: "BitTorrent protocol"><reserved: 8 bytes><info_hash: 20 bytes><peer_id: 20 bytes>`.
* **Bitfield Exchange:** Immediately following the handshake, peers exchange bitfields indicating which pieces they possess.
* **Choking & Unchoking (Tit-for-Tat):**
  * `choke`: Informs peer that no piece requests will be serviced.
  * `unchoke`: Permits peer to request data blocks.
  * `interested` / `not interested`: Expresses download intent.
  * *Optimistic Unchoke:* Periodically unchoking a random peer to discover higher throughput connections.
* **Piece & Block Requests:** Files are divided into *pieces* (typically 1–4 MB), each divided into 16 KB *blocks*. A peer sends `request <index><begin><length=16384>`.
* **SHA-1 Verification:** Completed pieces are verified against the 20-byte SHA-1 hash list in the metadata before marking as verified in the local bitfield.

### 1.2 Metadata Transfer & Magnet Links (BEP 9 & BEP 10)
* Magnet links (`magnet:?xt=urn:btih:<hex/base32>&dn=<name>&tr=<tracker>`) contain only the 20-byte `info_hash` without file layout metadata.
* **BEP 10 (Extension Protocol):** Adds message type `20` (extended) with an ID dictionary to negotiate capabilities.
* **BEP 9 (ut_metadata):** Downloads torrent metadata directly from swarm peers in 16 KB slices over BEP 10, resolving file layout within seconds without web servers.
* **Multi-Tracker Tiers & Fallbacks:** Maglev extracts all `tr=` parameters into an ordered tracker list and injects fallback public tiers if no valid trackers exist.

### 1.3 Distributed Hash Table / DHT (BEP 5) & Local Peer Discovery (BEP 14)
* **DHT (BEP 5):** Serverless peer discovery implementing Kademlia over UDP. Connects to bootstrap nodes (`router.bittorrent.com`, `dht.transmissionbt.com`).
* **LSD (BEP 14):** Local Peer Discovery over multicast UDP to discover peers on the same local Wi-Fi subnet and transfer at wire speeds (1 Gbps+).
* **Private Torrents (BEP 27):** When a torrent contains `private = 1`, DHT, PEX, and LSD are **strictly suppressed** to preserve private tracker integrity.

### 1.4 Port Forwarding & Encryption (BEP 55, PE/MSE)
* **UPnP / NAT-PMP (BEP 55):** Automatically opens an external listening port on home Wi-Fi routers, preventing passive/firewalled mode and doubling discoverable peers.
* **Protocol Encryption (PE/MSE):** Encrypts handshakes and payloads to prevent mobile ISP Deep Packet Inspection (DPI) throttling.

---

## 2. BitTorrent Engine: Rust (`librqbit`) Architecture

`librqbit` is selected as Maglev's engine core:
* **Memory Safety:** 100% Rust, zero memory corruption, zero segfaults.
* **Asynchronous Tokio Runtime:** Mobile-tuned with **2 worker threads** (`max_blocking_threads = 4`).
* **Binary Footprint:** Stripped `.so` size is only `~4 MB` per architecture (`arm64-v8a`, `armeabi-v7a`, `x86_64`).
* **Socket Buffer Clamping:** Default maximum of **40 active peer sockets** per torrent, preventing socket buffer memory explosion on mobile.

---

## 3. Android Native Architecture & Storage Mechanics

### 3.1 App-Specific External Storage (Primary Zero-Copy Target)
Android 11–15 enforces Scoped Storage. Standard POSIX paths to `/sdcard/Download` are blocked by SAF. However, Android provides:
```kotlin
val defaultDir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
// Path: /storage/emulated/0/Android/data/com.maglev/files/Download
```
* **Direct POSIX Path Access:** This directory retains **100% direct native POSIX filesystem access** (`open`, `pwrite64`, `pread64`) without runtime permissions, without Binder IPC overhead, and without FUSE permission prompts.
* **`posix_fallocate` Fallback:** Rust disk I/O catches `EOPNOTSUPP` from `posix_fallocate` on Android FUSE emulation layers and falls back to `ftruncate` / sparse chunk writes.

### 3.2 ForegroundService & Battery Governance
```xml
<service
    android:name=".service.MaglevTorrentService"
    android:foregroundServiceType="dataSync"
    android:exported="false" />
```
* **Zero-Idle Notification:** Call `stopForeground(STOP_FOREGROUND_REMOVE)` immediately when all transfers pause or complete.
* **WakeLock Management:** `PowerManager.PARTIAL_WAKE_LOCK` held strictly while transfers run; released in `< 500 ms` when paused or finished.
* **Doze Mode & Connectivity State:** When network is firewalled during Doze, `ConnectivityManager.NetworkCallback` signals the native engine to enter a low-power `DORMANT` state, halting DHT queries to conserve battery.

---

## 4. Expo & React Native Bridge Integration

### 4.1 JNI Dispatcher Thread (Thread-Safety Architecture)
Tokio worker threads must never touch JNI directly. Maglev implements an internal thread-safe pipeline:
1. Tokio async tasks push telemetry structs into a Rust `tokio::sync::mpsc::channel`.
2. A single dedicated native JNI dispatcher thread (attached to the JVM via `AttachCurrentThreadAsDaemon`) drains this channel at the **500 ms** cadence.
3. Fires a single batch `onTelemetryUpdate` event across JSI to React Native.

### 4.2 Zero-GC SIMD Piece Map Downsampling
* A 40GB torrent with 20,000 pieces is downsampled natively in Rust using SIMD bit-popcount (`u64::count_ones()`).
* Generates a fixed **256-byte binary payload** (`[u8; 256]`) mapping directly to the 16×16 visualizer matrix.
* Exposed to Kotlin and React Native via a JNI `DirectByteBuffer` without creating temporary heap allocations or triggering Garbage Collection stutters.

### 4.3 In-App Sequential Media Streaming
* `librqbit` features a built-in local loopback HTTP server.
* When sequential streaming is enabled, Maglev exposes an internal stream endpoint:  
  `http://127.0.0.1:<port>/stream/:torrent_id/:file_index`
* Once head pieces (first 2% and file metadata index) are verified, Maglev provides a `[▶ Stream Now]` action that launches an Android `Intent.ACTION_VIEW` (`video/*`) directed to external media players (VLC, Just Player, or system player).
