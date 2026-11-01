# MAGLEV — Design System & Mobile Tokens (Strict Anti-Slop Specification)

> **Platform:** Android Mobile (React Native / Expo)  
> **Source of Truth:** Canonical Maglev Mobile Screenshot (`media_1793540767117_c9a359bf.png`)  
> **Rule 0:** Absolute ban on developer jargon, pseudocode comments (`//`), header version tags, and status dots (`CORE OK`). Pure utility only.

---

## 1. Visual Token Architecture

### 1.1 Color Palette
| Token | Hex | Usage & Semantics |
|---|---|---|
| `color-bg-oled` | `#05070A` / `#080A0E` | Root mobile canvas, system navigation bar background. Full OLED power saving. |
| `color-surface-card` | `#0D1117` / `#12161F` | Torrent transfer cards, settings groupings, input containers. |
| `color-surface-border` | `#1F2937` / `#161D28` | Hairline 1px structural card border. No drop shadows. |
| `color-surface-pill` | `#161B22` / `#1A2230` | Inactive filter pill background, badge pill background. |
| `color-accent-lime` | `#CCFF00` | Primary interactive color. Maglev logo tile, active filter pill, progress bars (seeding/done), primary FAB. |
| `color-accent-cyan` | `#00E5FF` | Inbound network speed (`↓`), active download progress bars, active peers. |
| `color-status-paused` | `#6B7280` / `#4B5563` | Paused transfer progress bar, muted badges. |
| `color-text-primary` | `#F3F4F6` | High-contrast readable filenames, primary headings, input text. |
| `color-text-muted` | `#8B949E` / `#9CA3AF` | Transfer sizes, ratios, timestamps, subtitles. |

---

## 2. Typography Hierarchy

| Style | Font Family | Size | Weight | Tracking | Usage |
|---|---|---|---|---|---|
| **App Title** | `Silkscreen` / `Space Mono` | `14px` | Bold (`700`) | `-0.02em` | Top header `MAGLEV` brand text. |
| **Pill & Button Label** | `Silkscreen` / `Inter` | `10px`–`11px` | Bold (`700`) | `0em` | Filter pills, CTA buttons (`+ Add Torrent`). |
| **Card Filename** | `Space Mono` / `Inter` | `13px` | SemiBold (`600`) | `-0.01em` | Clean filename truncation in transfer cards. |
| **Telemetry & Metrics** | `JetBrains Mono` | `11px`–`12px` | Medium (`500`) | Tabular (`tnum`) | `↓ 14.8 MB/s · 3.1 / 4.2 GB`, ETA `2m 16s`, `74.2%`. |
| **Navigation Label** | `Silkscreen` / `Inter` | `8px`–`9px` | Bold (`700`) | `0.05em` | Bottom navigation bar labels (`TRANSFERS`, `SEARCH`, `FEEDS`, `CONFIG`). |

---

## 3. Strict Anti-Slop & Anti-Jargon Guidelines

Every engineer, agent, and component in the Maglev codebase must adhere to these prohibitions:

### ❌ STRICTLY FORBIDDEN (Slop & Jargon)
1. **NO Header Comment Slashes:** Never write `// TORRENT ENGINE`, `// Payload Files`, `// CONFIG`, or `// Search`. Section headers are clean title case: `Torrent Engine`, `Files`, `Settings`.
2. **NO Header Version Tags:** Never show `v0.1.0` or build hashes in the main header bar. Version information belongs solely in the bottom of the `About` section.
3. **NO Fake Hardware Status Indicators:** Never display `● CORE OK`, `DHT:248`, or pulsating status dots in headers.
4. **NO Cryptic Number Codes:** Never display meaningless debug strings like `050406`.
5. **NO Jargon State Names:** Never write "Swarm Idle", "Payload Ingestion", or "Engine Daemon". Use simple, direct language: `No active transfers`, `Paused`, `Downloading`, `Done`.
6. **NO Desktop/PC Layouts:** Maglev is strictly an Android mobile client (360dp–412dp viewport standard). All components, sheets, and touch targets must be mobile-optimized (minimum 44x44px touch targets).

---

## 4. Canonical Mobile Component Specifications

### 4.1 Header Bar
- **Height:** 52px (excluding Android system status bar safe-area insets).
- **Left Element:** 28×28px rounded square (`rounded-md`), Electric Lime (`#CCFF00`) fill, containing centered bold black pixel letter **`M`**.
- **Title:** `MAGLEV` in 14px bold retro font.
- **Right Element:** 32×32px dark icon button (`#11161F`, border `#222B38`) with search magnifying glass.

### 4.2 Filter Pills (Horizontal Grid / Scroll)
- 4 touch pills: `[All]`, `[Down]`, `[Up]`, `[Paused]`.
- **Active Pill:** Solid Acid Lime (`#CCFF00`) background, black text, count badge (e.g. `2`).
- **Inactive Pill:** Dark card surface (`#0D1117`), 1px border (`#1F2937`), muted gray icon and count badge.

### 4.3 Transfer Card (`#0D1117`, border 1px `#1F2937`, `rounded-xl`)
- **Row 1 (Header):** Torrent filename on left (truncated). Badge pill on right:
  - Downloading: Cyan badge `2m 16s` (ETA).
  - Done: Lime badge `✓ DONE`.
  - Paused: Slate badge `PAUSED`.
- **Row 2 (Metrics):** Monospaced telemetry: `↓ 14.8 MB/s · 3.1 / 4.2 GB` or `↑ 3.4 MB/s · Uploaded 5.4 GB`.
- **Row 3 (Progress Bar):** 6px height, rounded ends. Cyan for downloading, Lime for completed/seeding, Slate for paused.
- **Row 4 (Footer & Action):**
  - Left: Progress percentage (`74.2%`) and swarm health (`↓ 28  ↑ 6`).
  - Right: Floating action button:
    - Downloading card: Pause button `||`.
    - Done card: Stop button `STOP` or square.
    - Paused card: Start button `▶ START`.

### 4.4 Floating Action Button (FAB)
- 48×48px squircle (`rounded-xl`), docked bottom-right (`right: 16px`, `bottom: 80px`).
- Background: Solid Acid Lime (`#CCFF00`).
- Glyph: Chunky black pixel `+` icon.

### 4.5 Bottom Navigation Bar
- 4 tabs: `TRANSFERS`, `SEARCH`, `FEEDS`, `CONFIG`.
- Fixed height: 56px + bottom safe-area insets.
- Background: `#070A0E` with top 1px border `#161C26`.
- Active Tab: Acid Lime text and icon with subtle active indicator.
- Inactive Tabs: Muted slate (`#8B949E`) at 60% opacity.
