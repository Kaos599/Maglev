# MAGLEV — High Architecture & SLA Contract Sheet (Audited & Locked)

---

## 1. System Vision & Purpose

**Maglev** is an uncompromising, zero-bloat, high-performance Android BitTorrent client. The name derives from *Magnetic Levitation* — frictionless, ultra-fast motion powered by magnetic link streams. 

Unlike mainstream commercial torrent apps that suffer from battery drain, ad trackers, crypto mining, and 150MB+ memory footprints, Maglev enforces strict systems-level SLAs:
- **Instant Cold Launch:** `< 500 ms` to interactive state.
- **Micro Memory Footprint:** `≤ 38 MB` idle RSS; capped at `≤ 85 MB` during saturated 100 Mbps transfers with 40-peer socket clamp.
- **Battery Preservation:** Power locks engaged *only* during active network transfers. No persistent "idle" notifications.
- **Cyber-Retro OLED Identity:** High-contrast tactical UI (`#05070A`, `#CCFF00`, `#00E5FF`) with zero fluff.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                 React Native / Expo UI Layer                │
│  (Transfers Dashboard, Pieces Matrix, Search, Feeds, Settings)
└──────────────────────────────┬──────────────────────────────┘
                               │ JSI / Native Events (500ms Throttled)
┌──────────────────────────────▼──────────────────────────────┐
│           Maglev Native Module (Expo Module / Kotlin)       │
│  - Android ForegroundService (FOREGROUND_SERVICE_TYPE_DATA_SYNC)
│  - App-Specific Storage Resolver (/Android/data/com.maglev) │
│  - JNI Dispatcher Thread (draining Rust MPSC telemetry queue)│
│  - PartialWakeLock Manager (Acquire on leech / Release on idle)│
└──────────────────────────────┬──────────────────────────────┘
                               │ JNI DirectByteBuffer / C ABI
┌──────────────────────────────▼──────────────────────────────┐
│           Native Rust BitTorrent Engine (librqbit)          │
│  - BEP 3 (Wire), BEP 5 (DHT), BEP 9/10 (Metadata), BEP 55   │
│  - Asynchronous Tokio Runtime (2 Worker Threads)            │
│  - Direct POSIX Disk I/O (16-32MB Clamped Disk Cache)       │
│  - SIMD Piece Bitfield Downsampling ([u8; 256])             │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. High Architecture Contract Sheet & SLAs

### SLA-1: Memory Footprint Contract (Calibrated to ART & Hermes)
* **Idle Target:** `≤ 38 MB` RSS RAM consumption (including Android ART, Hermes VM, and native libraries).
* **Active Transfer Target:** `≤ 85 MB` RSS RAM consumption when saturating a 32–40 peer swarm at 100 Mbps.
* **Disk Write Cache Limit:** Rust disk cache strictly clamped to `16 MB` (default) with a maximum configurable ceiling of `32 MB`. 
* **Peer Connection Clamp:** Maximum active peer sockets clamped to **40 peers** per torrent by default, preventing socket buffer memory explosion.

### SLA-2: UI Thread Fluidity & Bridge Telemetry Contract
* **Frame Rate:** Sustained `120 FPS / 60 FPS` without micro-stutters or dropped frames during active swarm telemetry streaming.
* **Bridge Event Throttling:** Telemetry payloads (speeds, ETA, swarm ratios, bitfields) are aggregated in Rust and broadcast at a strict cadence of **`500 ms`** (`2 Hz`).
* **Zero-GC Piece Map Downsampling:** Rust performs piece bit-popcount (`u64::count_ones()`) natively and exposes a fixed **256-byte binary payload** (`[u8; 256]`) via JNI `DirectByteBuffer`. Kotlin and React Native read this buffer directly without JSON serialization or GC churn.

### SLA-3: Battery & Power Governance Contract
* **Android Service Type:** Implements `android.app.Service` declared with `android:foregroundServiceType="dataSync"` (Android 14+ compatible).
* **WakeLock Discipline:** `PARTIAL_WAKE_LOCK` is acquired **only** when at least one torrent is in an active `DOWNLOADING` or `SEEDING` state. Upon all transfers pausing or completing, the lock is released within `500 ms`.
* **Zero-Idle Notification:** When active transfers reach 0, call `stopForeground(STOP_FOREGROUND_REMOVE)` immediately. No persistent "Idle" notifications clutter the status shade.
* **Network Doze & Connectivity State:** When network connectivity is lost or firewalled during Doze (detected via `ConnectivityManager.NetworkCallback`), Maglev transitions the Rust engine to a low-power `DORMANT` state—halting DHT queries, freezing timers, and avoiding futile battery-draining retries.

### SLA-4: Storage & Native I/O Contract
* **Primary Target (App-Specific Storage):** Default download directory is set to `/storage/emulated/0/Android/data/com.maglev/files/Download`. Retains **100% direct POSIX file path access** (`open`, `pwrite64`, `pread64`) without SAF permissions, without Binder IPC overhead, and without FUSE permission dialogs on Android 11–15.
* **Secondary Target (SAF Custom Directory):** If the user selects a custom external directory via `ACTION_OPEN_DOCUMENT_TREE`, an async JNI storage adapter requests file descriptors on-demand only after BEP-9 metadata resolves, strictly detaching descriptors (`pfd.detachFd()`) before handing integer handles to Rust.
* **Filesystem Allocation Fallback:** Rust disk I/O catches `EOPNOTSUPP` from `posix_fallocate` on Android FUSE emulation and falls back to `ftruncate` / sparse chunk writes.

### SLA-5: Code Quality & Anti-Slop Contract
* **Zero Jargon:** No hex dump identifiers, no confusing version codes like "050406", no meaningless text like "Swarm Idle".
* **Visual Clarity:** Every screen must be comprehensible within 2 seconds. Use pixel icons where icons communicate better than words.
* **Pixel Aesthetics:** Authentic 8-bit glyphs (`Silkscreen`), crisp monospaced telemetry (`JetBrains Mono`), and clean sans copy (`Inter`).
