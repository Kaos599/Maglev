# MAGLEV — High Architecture & SLA Contract Sheet

---

## 1. System Vision & Purpose

**Maglev** is an uncompromising, zero-bloat, high-performance Android BitTorrent client. The name derives from *Magnetic Levitation* — frictionless, ultra-fast motion powered by magnetic link streams. 

Unlike mainstream commercial torrent apps that suffer from battery drain, ad trackers, crypto mining, and 150MB+ memory footprints, Maglev enforces strict systems-level SLAs:
- **Instant Cold Launch:** `< 500 ms` to interactive state.
- **Micro Memory Footprint:** Sub-30MB RAM at rest, capped at `< 45MB` during saturated downloads.
- **Battery Preservation:** Power locks engaged *only* during active network transfers.
- **Cyber-Retro OLED Identity:** High-contrast tactical UI (`#05070A`, `#CCFF00`, `#00E5FF`) with zero fluff.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                 React Native / Expo UI Layer                │
│   (Transfers Dashboard, Piece Map, Search, Feeds, Config)   │
└──────────────────────────────┬──────────────────────────────┘
                               │ JSI / Native Events (500ms Throttled)
┌──────────────────────────────▼──────────────────────────────┐
│           Maglev Native Module (Expo Module / Kotlin)       │
│  - Android ForegroundService (FOREGROUND_SERVICE_TYPE_DATA_SYNC)
│  - PartialWakeLock Manager (Acquire on leech / Release on idle)│
│  - Scoped Storage SAF Resolver (ParcelFileDescriptor)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ UniFFI / C JNI Bindings
┌──────────────────────────────▼──────────────────────────────┐
│           Native Rust BitTorrent Engine (librqbit)          │
│  - BEP 3 (Wire Protocol), BEP 5 (DHT), BEP 9/10 (Metadata)  │
│  - Asynchronous Tokio Runtime (4 Worker Threads)            │
│  - Direct POSIX Disk I/O (Clamped 16-32MB Disk Cache)       │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. High Architecture Contract Sheet & SLAs

### SLA-1: Memory Footprint Contract
* **Idle Target:** `≤ 28 MB` RSS RAM consumption.
* **Active Transfer Target:** `≤ 45 MB` RSS RAM consumption when saturating an 80+ peer swarm.
* **Disk Write Cache Limit:** Rust disk cache strictly clamped to `16 MB` (default) with a maximum configurable ceiling of `32 MB`. 
* **Violation Behavior:** If RSS exceeds 60MB, the disk cache flushes immediately, and excess inactive peer connections are pruned.

### SLA-2: UI Thread Fluidity & Bridge Telemetry Contract
* **Frame Rate:** Sustained `120 FPS / 60 FPS` without micro-stutters or dropped frames during active swarm telemetry streaming.
* **Bridge Event Throttling:** The native layer must **never** emit raw packet-level events to React Native. Telemetry payloads (speeds, ETA, swarm ratios, bitfields) are aggregated and broadcast at a strict cadence of **`500 ms`** (`2 Hz`).
* **Piece Map Density:** The piece visualizer renders an aggregated 16×16 (256-block) or 32×16 matrix rather than tens of thousands of individual pieces, ensuring instantaneous canvas/DOM rendering.

### SLA-3: Battery & Power Governance Contract
* **Android Service Type:** Implements `android.app.Service` declared with `android:foregroundServiceType="dataSync"` (Android 14+ compatible).
* **WakeLock Discipline:** `PARTIAL_WAKE_LOCK` is acquired **only** when at least one torrent is in an active `DOWNLOADING` or `SEEDING` state. Upon all transfers pausing or completing, the lock is released within `500 ms`.
* **Battery Whitelist:** Prompts user gracefully for `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` to prevent OEM aggressive background kills.
* **Wi-Fi Threshold:** Immediate suspension of TCP/UDP swarm sockets when network transitions from Wi-Fi to Cellular (if "Wi-Fi Only" toggle is enabled).

### SLA-4: Storage & Native I/O Contract
* **Android Scoped Storage (SAF):** Full compatibility with Android 11 through Android 15. The user selects a target directory via `ACTION_OPEN_DOCUMENT_TREE`.
* **Direct File Descriptors:** Kotlin passes open `ParcelFileDescriptor` handles down to the Rust engine via JNI, allowing native `pwrite64`/`pread64` POSIX file access without copying buffers through the JVM or React bridge.

### SLA-5: Code Quality & Anti-Slop Contract
* **Zero Jargon:** No hex dump identifiers, no confusing version codes like "050406", no meaningless text like "Swarm Idle".
* **Visual Clarity:** Every screen must be comprehensible within 2 seconds. Use pixel icons where icons communicate better than words.
* **Pixel Aesthetics:** Authentic 8-bit glyphs (`Silkscreen`), crisp monospaced telemetry (`JetBrains Mono`), and clean sans copy (`Inter`).
