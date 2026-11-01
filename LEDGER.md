# MAGLEV — LEDGER & WORKSTREAM LOG

> **Branch:** `dev`  
> **Status:** Phase 1 Complete & Verified (100% Contract & SLA Pass)  
> **Repository:** `Kaos599/Maglev` (Private)

---

## 📌 Executive Goal

Build **Maglev** — a frictionless, zero-drag, zero-bloat, native-speed Android BitTorrent client with a sleek, cyber-retro OLED aesthetic (`#05070A`, `#CCFF00`, `#00E5FF`). Powered by **React Native**, **Expo**, and **Rust (`librqbit`)**.

---

## 📜 Ledger Entries

### [2026-11-01] — Turn 4: Field Architecture Research (Flud, LibreTorrent, TorrentSearch) & Phase 2 Refinement
- **Deep-Dive into Popular Open-Source & Android Clients:**
  - `LibreTorrent` (libtorrent4j FOSS standard): Analyzed SOCKS5/HTTP proxy tunneling, IP filter blocklists (`.dat`), alternative network interface binding, auto-move completed files, disk pre-allocation, and background battery optimization.
  - `Flud` (Class-leading Android client): Studied battery percentage threshold limits (<20% cutoff), Wi-Fi SSID whitelisting, connection caps (overall and per-torrent), speed scheduling, and automatic shutdown on completion.
  - `TorrentSearch` (prajwalch/TorrentSearch): Researched provider aggregation, Torznab/Jackett integration, category partitioning, and 1-tap pre-parsed magnet queuing.
- **Documentation & State Machines Updated on `dev`:**
  - `docs/PHASE_ROADMAP_AND_CONTRACTS.md`: Expanded Phase 2 task list (Tasks 2.1–2.14) with SOCKS5 proxy tunneling, battery % cutoff thresholds, SSID whitelisting, IP filtering, and auto-move.
  - `docs/STATE_MACHINES_AND_SCREENS.md`: Added State Machine 2.3 (Network & Connectivity Governance), State Machine 2.4 (Power & Battery Protection), State Machine 2.5 (Seeding & Share Ratio Governance), and micro-state components 3.6 (Preset Speed Chips) and 3.7 (Storage Directory POSIX vs SAF).
  - `docs/ARCHITECTURE_AND_GOAL.md`: Added SLA-6 (Network & Proxy Governance) and updated subsystem block diagram.
  - `docs/BITTORRENT_AND_NATIVE_RESEARCH.md`: Added SOCKS5 RFC 1928 remote DNS routing, token-bucket bandwidth shaping, and BatteryManager cutoff mechanics.

### [2026-11-01] — Turn 3: Phase 1 Core BitTorrent Engine & Transfers Delivery
- **Task 1.1:** Authored Rust `native/maglev-core` crate (librqbit, 2 Tokio worker threads, SIMD bit-popcount, Android FUSE `EOPNOTSUPP` fallback) and configured GitHub Actions cloud compilation CI `.github/workflows/build-engine.yml`.
- **Task 1.2 & 1.6:** Built custom Expo Native Module `modules/maglev-engine` with dual-mode bridge (high-fidelity TypeScript simulation engine + Kotlin JNI daemon dispatcher thread with MPSC channel).
- **Task 1.3:** Configured Android `intent-filter` for `magnet:` links and raw `.torrent` files with MIME types `application/x-bittorrent` and `application/x-torrent`.
- **Task 1.4:** Implemented Android `ForegroundService` (`dataSync`) with real-time speed notification, `PARTIAL_WAKE_LOCK` lifecycle, and zero-idle removal (`stopForeground(STOP_FOREGROUND_REMOVE)`).
- **Task 1.5:** Configured default App-Specific External Storage (`/Android/data/com.maglev/files/Download`) for zero-copy direct POSIX writes.
- **Task 1.7:** Built Transfers Screen (`app/(tabs)/index.tsx`, `TransferCard`, `SpeedTelemetryHeader`, `FilterPills` with min-44px touch targets).
- **Task 1.8:** Built Empty State Screen (`EmptyState.tsx`) with 8-bit download tray, auto-detect clipboard magnet link pill, and direct Add/Search triggers.
- **Task 1.9:** Built Add Torrent Sheet (`app/add-torrent.tsx`) with storage override, multi-file checklist batch controls, and sequential toggle.
- **Task 1.10:** Built Torrent Detail Screen (`app/torrent/[id].tsx`) with live speed chart, 4 tabs (Files, Pieces 16x16 matrix, Peers, Trackers), and dual-action delete dialog.
- **Task 1.11:** Built loopback HTTP streaming endpoint (`http://127.0.0.1:<port>/stream/:id/:file_index`) with `[▶ Stream Now]` action button.
- **Task 1.12:** Implemented and executed automated E2E integration test suite (`scripts/test-e2e.js`) validating 31/31 assertions (100% pass) against all Phase 1 contracts and SLAs.

### [2026-11-01] — Turn 2: Multi-Stakeholder Nemesis Audit Synthesis & Contract Remediation
- **5-Agent Parallel Audit Completed:**
  - `Design & Visual Hierarchy Auditor`: Enforced 44px touch targets, continuous 6px progress bars, and locked out desktop artifacts.
  - `Mobile Usability & UX Flow Auditor`: Designed safe dual-choice deletion flow, eradicated persistent idle notifications, and added multi-file batch selection.
  - `Anti-Slop & Jargon Nemesis`: Eliminated 24 exact slop violations (`//` comments, `v2.4`, `CONFIG OK`, `BEP-0003 OK`, `CONFIG` navigation tab).
  - `Feature Richness Auditor`: Specified raw `.torrent` intent filters, UPnP port forwarding, sequential loopback HTTP streaming, and seeding limits.
  - `Systems & Rust Engine Nemesis`: Resolved `librqbit` path requirement by establishing App-Specific External Storage as default, eliminated JNI Tokio thread panics with a dedicated MPSC dispatcher, calibrated RAM SLAs to ART/Hermes baselines (`≤ 38MB` idle, `≤ 85MB` active), and introduced zero-GC SIMD piece downsampling.
- **Specification Documentation Updated & Locked on `dev`:**
  - `docs/ARCHITECTURE_AND_GOAL.md`
  - `docs/DESIGN_SYSTEM_TOKENS.md`
  - `docs/STATE_MACHINES_AND_SCREENS.md`
  - `docs/PHASE_ROADMAP_AND_CONTRACTS.md`
  - `docs/BITTORRENT_AND_NATIVE_RESEARCH.md`

### [2026-11-01] — Turn 1: Repository Setup, Visual Identity & Architectural Foundations
- **GitHub Repository Established:** Remote `https://github.com/Kaos599/Maglev` (Private) on `main` and `dev`.
- **Identity & Tokens Locked:** OLED Void (`#05070A`), Cards (`#0D1117`), Hairline Border (`#1F2937`), Acid Lime (`#CCFF00`), Cyber Cyan (`#00E5FF`).
- **Initial Spec Sheets & State Machines Authored.**

---

## 📋 Master Workstream Checklist

| Phase | Milestone | Scope | Status |
|:---:|:---|:---|:---:|
| **0** | **Repo, Specs & Nemesis Audit** | Git init, branches, design tokens, multi-agent audit, locked contracts | ✅ **COMPLETED** |
| **1** | **Core BitTorrent Engine & Transfers** | Rust librqbit Expo module, intent filters, safe deletion, transfer dashboard | ✅ **COMPLETED** |
| **2** | **Settings & System Governance** | Bandwidth limits, UPnP port forwarding, encryption PE/MSE, OLED pure black | 🟡 **UP NEXT** |
| **3** | **Search & Aggregation** | Multi-provider search, category filters, recent searches, bookmarks, NSFW filters | ⚪ Pending |
| **4** | **Automated Feeds (RSS)** | RSS feed parser, auto-download regex filters, background sync | ⚪ Pending |

---

## 🤖 Subagent Task Execution Protocol

When deploying worker subagents to implement features:
1. **Isolated Contract Scope:** Each subagent is assigned **strictly one contract unit** from `docs/PHASE_ROADMAP_AND_CONTRACTS.md`.
2. **State Machine Conformance:** Implementation must conform 1:1 with the state diagrams defined in `docs/STATE_MACHINES_AND_SCREENS.md`.
3. **End-to-End Validation:** Work is evaluated against the phase SLA sheet using E2E integration test scripts, never simulated or mocked unit assertions alone.
