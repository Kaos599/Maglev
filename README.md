# MAGLEV ⚡

> **Frictionless, zero-drag, native-speed BitTorrent client for Android.**  
> Powered by **React Native**, **Expo**, and high-performance **Rust**.

---

## ⚡ Identity & Philosophy

**Maglev** is named after *Magnetic Levitation* — frictionless, ultra-fast, and driven by magnet links. Built specifically to eliminate the bloat, battery drain, tracking, and intrusive ads plaguing modern mobile torrent clients.

- 🪶 **Sub-30MB RAM Footprint:** Native engine memory management with strictly clamped disk caches (16–32 MB).
- 🔋 **Battery-First Architecture:** Native Android `ForegroundService` (`DATA_SYNC`) coupled with smart power locks (`PARTIAL_WAKE_LOCK`) only while active transfers occur.
- 👾 **Sleek Cyber-Retro Aesthetic:** Deep OLED foundations (`#05070A`), high-contrast modular cards, electric acid lime (`#CCFF00`), and cyber cyan (`#00E5FF`) accents.
- 🚫 **Zero Bloat, Zero Ads, Zero Jargon:** Pure utility. No unnecessary telemetry, no cluttered headers, no crypto tokens, no fluff.

---

## 🛠️ Tech Stack & Architecture

| Layer | Technology | Purpose |
|---|---|---|
| **UI Framework** | **React Native** + **Expo** | 120Hz fluid declarative interface with custom Native Modules |
| **BitTorrent Engine** | **Rust (`librqbit`)** via **UniFFI / JNI** | High-throughput, memory-safe peer-to-peer protocol implementation |
| **Android Backgrounding**| Native **ForegroundService** + **WakeLock** | Uninterrupted background downloads without OS termination |
| **Storage & I/O** | **Scoped Storage (SAF)** + `ParcelFileDescriptor` | Zero-copy direct disk streaming compatible with Android 11–15 |
| **Design System** | **Maglev Cyber-Retro HUD** | OLED `#05070A`, Acid Lime `#CCFF00`, Cyber Cyan `#00E5FF` |

---

## 🗺️ Roadmap & Phases

- **Phase 1: BitTorrent Engine & Transfers (Core)**
  - Magnet URI parsing & metadata resolution (BEP 9 / BEP 10).
  - Swarm connectivity: DHT (BEP 5), PEX (BEP 11), Tracker announce (HTTP/UDP).
  - Piece verification (SHA-1 bitfield) & disk streaming.
  - Active transfer dashboard: dynamic cards, live Down/Up speeds, progress, peer counts, pause/resume.
  - Magnet Ingestion Sheet with file selection tree and priority selection.
- **Phase 2: Configuration & System Settings**
  - Bandwidth throttling (download/upload limits).
  - Wi-Fi only mode & battery preservation thresholds.
  - Storage directory selection via Android SAF.
  - Pure Black OLED / Dark mode toggle.
  - Content & privacy controls (NSFW blur/toggle, search history management).
- **Phase 3: Torrent Search & Discovery**
  - Multi-provider search aggregation with category filters (Linux, Media, Software, Games, etc.).
  - Search history, trending filters, and instant one-tap magnet queueing.
- **Phase 4: Automated Feeds (RSS)**
  - Smart RSS / Atom feed subscription and parsing.
  - Auto-download filters with regex matching and quality criteria.

---

## 📱 Design System & Visual Tokens

Maglev fuses clean mobile UX with tactical cyber-terminal details:

- **Void Background:** `#05070A` (True OLED black)
- **Surface / Cards:** `#0D1117` with 1px border `#1F2937`
- **Primary Accent:** `#CCFF00` (Electric Acid Lime) — Active seeds, confirmations, primary actions
- **Secondary Accent:** `#00E5FF` (Cyber Cyan) — Inbound transfers, download progression, active peers
- **Typography:** `Space Mono` / `JetBrains Mono` for telemetry and tabular values; `Inter` / `Space Grotesk` for UI copy; `Silkscreen` for 8-bit badges and accents.

---

## 📄 License

MIT © Harsh (Kaos599)
