# MAGLEV — LEDGER & WORKSTREAM LOG

> **Branch:** `dev`  
> **Status:** Active (Phase 0 Initialization & Architecture Contracts Complete)  
> **Repository:** `Kaos599/Maglev` (Private)

---

## 📌 Executive Goal

Build **Maglev** — a frictionless, zero-drag, zero-bloat, native-speed Android BitTorrent client with a sleek, cyber-retro OLED aesthetic (`#05070A`, `#CCFF00`, `#00E5FF`). Powered by **React Native**, **Expo**, and **Rust (`librqbit`)**.

---

## 📜 Ledger Entries

### [2026-11-01] — Turn 1: Repository Setup, Visual Identity & Architectural Foundations
- **GitHub Repository Established:**
  - Remote initialized: `https://github.com/Kaos599/Maglev` (Private).
  - Main branch created and pushed with base identity README.
  - Dev branch branched off and tracking `origin/dev`.
  - Repository topics configured: `bittorrent`, `android`, `react-native`, `expo`, `rust`, `torrent-client`, `cyberpunk`.
- **Logo & Design Token Extraction:**
  - Analyzed user reference logo: Chunky 8-bit black 'M' inside rounded Electric Acid Lime (`#CCFF00`) squircle.
  - Palette tokens locked: OLED Void (`#05070A`), Card Surface (`#0D1117`), Hairline Border (`#1F2937`), Acid Lime (`#CCFF00`), Cyber Cyan (`#00E5FF`), Muted Slate (`#8B949E`).
  - Typography locked: `Silkscreen` / `Space Mono` (retro/pixel headers & badges), `JetBrains Mono` (telemetry & stats), `Inter` / `Space Grotesk` (clean readable copy).
- **Stitch MCP Screens Refined & Generated:**
  - Refined Empty State screen (`9962744ce8234c6dbdc2be517dcf8898`): Eliminated swarm jargon and debug headers; established clean 8-bit download tray with direct `[+ Add Torrent]` and `[Search Torrents]` buttons.
  - Refined Search screen (`9da9d383d8504fb9955ec1cd38d8fe32`): Added 9 categories (All, Anime, Apps, Books, Games, Movies, Music, 18+ Series, Others), recent searches, and instant download triggers.
  - Refined Feeds screen (`7fef5a66b6bd4e3287f06bf0fbbcfd57`): Minimal feed channels and release items with one-tap ingestion.
  - Refined Config screen (`072d522061864cf69b111c975d4c7d43`): Organized into 5 distinct cards: Torrent Engine, General Theming (Pure Black/Dark/Light), Content & Privacy (NSFW toggle/blur), Search/Feeds, About.
  - Generated Magnet Ingestion Sheet (`69cbd02414174fcea42d47563ead907e`): Bottom sheet with BEP-9 metadata preview, selective file checkboxes, sequential stream toggle.
  - Generated Torrent Detail Screen (`5669efd79f5c46e29d1ab3069a697dbb`): Live telemetry, speed header, 16x16 piece bitfield map, and Files/Piece Map/Peers tab views.
- **Architectural Specification & Contracts Authored:**
  - `docs/ARCHITECTURE_AND_GOAL.md`: SLA contracts, memory budgets, battery governance, and subsystem contracts.
  - `docs/BITTORRENT_AND_NATIVE_RESEARCH.md`: Deep research on BitTorrent BEPs, Rust `librqbit`, JNI/UniFFI, Expo modules, Scoped Storage SAF, and E2E testing harness.
  - `docs/PHASE_ROADMAP_AND_CONTRACTS.md`: Phases 1–4 with task lists, contract lists, acceptance criteria, and SLAs.
  - `docs/STATE_MACHINES_AND_SCREENS.md`: Comprehensive macro and micro state machines with Mermaid diagrams.
  - `docs/DESIGN_SYSTEM_TOKENS.md`: Exact tokens, spacing, typography, and anti-slop rules.

---

## 📋 Master Workstream Checklist

| Phase | Milestone | Scope | Status |
|:---:|:---|:---|:---:|
| **0** | **Repo & Design Foundation** | Git init, branches, design tokens, Stitch screens, specs & state machines | ✅ **COMPLETED** |
| **1** | **Core BitTorrent Engine & Transfers** | Rust librqbit Expo module, magnet ingestion, foreground service, transfer dashboard | 🟡 Up Next |
| **2** | **Configuration & System Settings** | Bandwidth throttling, Wi-Fi only, SAF storage picker, OLED pure black theme | ⚪ Pending |
| **3** | **Search & Aggregation** | Multi-provider search, category filters, recent searches, bookmarks, NSFW filters | ⚪ Pending |
| **4** | **Automated Feeds (RSS)** | RSS feed parser, auto-download regex filters, background sync | ⚪ Pending |

---

## 🤖 Subagent Task Execution Protocol

When deploying worker subagents to implement features:
1. **Isolated Contract Scope:** Each subagent is assigned **strictly one contract unit** from `docs/PHASE_ROADMAP_AND_CONTRACTS.md`.
2. **State Machine Conformance:** Implementation must conform 1:1 with the state diagrams defined in `docs/STATE_MACHINES_AND_SCREENS.md`.
3. **End-to-End Validation:** Work is evaluated against the phase SLA sheet using E2E integration test scripts, never simulated or mocked unit assertions alone.
