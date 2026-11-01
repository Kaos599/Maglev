# MAGLEV — Design System & Mobile Tokens (Audited & Locked Specification)

> **Platform:** Android Mobile (React Native / Expo)  
> **Source of Truth:** Canonical Maglev Mobile Screenshot (`media_1793540767117_c9a359bf.png`)  
> **Rule 0:** Absolute ban on developer jargon, pseudocode comments (`//`), header version tags, and status dots (`CORE OK`). Pure utility only.

---

## 1. Visual Token Architecture

### 1.1 Color Palette
| Token | Hex | Contrast Ratio vs #05070A | Usage & Semantics |
|---|---|---|---|
| `color-bg-oled` | `#05070A` | 1:1 | Root mobile canvas, system navigation bar background. Full OLED power saving. |
| `color-surface-card` | `#0D1117` | 1.06:1 (Req. 1px border) | Torrent transfer cards, settings groupings, input containers. |
| `color-surface-border` | `#1F2937` | 2.15:1 | Mandatory 1px structural card border. No drop shadows. |
| `color-surface-pill` | `#161B22` | 1.25:1 | Inactive filter pill background, badge pill background. |
| `color-accent-lime` | `#CCFF00` | **17.15:1** (WCAG AAA) | Primary interactive color. Maglev logo tile, active filter pill, progress bars (seeding/done), primary FAB. |
| `color-accent-cyan` | `#00E5FF` | **13.12:1** (WCAG AAA) | Inbound network speed (`↓`), active download progress bars, active peers. |
| `color-status-paused` | `#8B949E` | **6.22:1** (WCAG AA) | Paused transfer progress bar, muted badges, paused card outlines. |
| `color-status-danger` | `#FF3366` | **4.85:1** (WCAG AA) | Destructive actions, delete torrent + files button, critical errors. |
| `color-text-primary` | `#F3F4F6` | **18.20:1** (WCAG AAA) | High-contrast readable filenames, primary headings, input text. |
| `color-text-muted` | `#8B949E` / `#9CA3AF` | **6.22:1 – 6.98:1** (WCAG AA) | Transfer sizes, ratios, timestamps, subtitles. Full outdoor legibility. |

---

## 2. Typography Hierarchy

| Style | Font Family | Size | Weight | Tracking | Usage |
|---|---|---|---|---|---|
| **App Title** | `Silkscreen` | `14px` | Bold (`700`) | `-0.02em` | Top header `MAGLEV` brand text. |
| **Card Filenames** | `Space Mono` | `13px` | SemiBold (`600`) | `-0.01em` | Clean filename truncation in transfer cards. |
| **Pill & Button Label** | `Space Mono` / `Inter` | `10px`–`11px` | Bold (`700`) | `0em` | Filter pills, CTA buttons (`+ Add Torrent`). |
| **Telemetry & Metrics** | `JetBrains Mono` | `11px`–`12px` | Medium (`500`) | Tabular (`tnum`) | `↓ 14.8 MB/s · 3.1 / 4.2 GB`, ETA `2m 16s`, `74.2%`. Mandates `fontVariant: ['tabular-nums']`. |
| **UI Copy & Settings** | `Inter` | `13px`–`14px` | Regular (`400`) / Medium (`500`) | `0em` | Settings descriptions, list options, file tree paths. |
| **Navigation Label** | `Space Mono` / `Inter` | `10px` | Bold (`700`) | `0.04em` | Bottom navigation bar labels (`TRANSFERS`, `SEARCH`, `FEEDS`, `SETTINGS`). |

---

## 3. Strict Anti-Slop & Anti-Jargon Guidelines

Every component and screen in Maglev must adhere to these prohibitions:

### ❌ STRICTLY FORBIDDEN (Slop & Jargon)
1. **NO Header Comment Slashes:** Never write `// Appearance`, `// Downloads & Storage`, or `// Files`. Section headers are clean title case: `Appearance`, `Downloads & Storage`, `Files`.
2. **NO Header Version Tags:** Never show `v0.1.0` or `v2.4` in the top bar. App version belongs solely at the bottom of the `About` card.
3. **NO Fake Hardware Status Displays:** Never display `● CONFIG OK`, `● CORE OK`, `BEP-0003 OK`, or pulsating status dots in headers.
4. **NO Cryptic Number Codes:** Never display meaningless debug strings like `050406`.
5. **NO Jargon State Names:** Never write "Swarm Idle", "Payload Ingestion", or "Engine Daemon". Use simple, direct language: `No active transfers`, `Paused`, `Downloading`, `Done`.
6. **NO Desktop/PC Layouts:** Maglev is strictly an Android mobile client (360dp–412dp viewport standard). All components, sheets, and touch targets must be mobile-optimized.
7. **NO Sub-44px Touch Targets:** Every interactive element must satisfy minimum $44 \times 44\text{px}$ touch targets (or use `hitSlop` padding).
8. **NO Pulsating Animations in Piece Grid:** Verified pieces are steady glowing cyan; active in-flight pieces are steady solid acid lime. No GPU-draining arcade pulse animations.

---

## 4. Canonical Mobile Component Specifications

### 4.1 Header Bar
- **Height:** 52px (excluding Android system status bar safe-area insets).
- **Left Element:** 28×28px rounded square (`rounded-md`), Electric Lime (`#CCFF00`) fill, containing centered bold black pixel letter **`M`**.
- **Title:** `MAGLEV` in 14px bold retro font.
- **Right Element:** 44×44px touch container with 32×32px dark icon button (`#11161F`, border `#222B38`) with search magnifying glass.

### 4.2 Filter Pills (Horizontal Grid / Scroll)
- 4 touch pills: `[All]`, `[Down]`, `[Up]`, `[Paused]`.
- **Touch Target:** Minimum 44px height (`min-h-[44px]`).
- **Active Pill:** Solid Acid Lime (`#CCFF00`) background, black text, count badge (e.g. `2`).
- **Inactive Pill:** Dark card surface (`#0D1117`), 1px border (`#1F2937`), muted gray icon and count badge.

### 4.3 Transfer Card (`#0D1117`, border 1px `#1F2937`, `rounded-xl`)
- **Row 1 (Header):** Torrent filename on left (truncated). Badge pill on right:
  - Downloading: Cyan badge `2m 16s` (ETA).
  - Done: Lime badge `✓ DONE`.
  - Paused: Slate badge `PAUSED`.
- **Row 2 (Metrics):** Monospaced tabular telemetry (`JetBrains Mono`): `↓ 14.8 MB/s · 3.1 / 4.2 GB` or `↑ 3.4 MB/s · Uploaded 5.4 GB`.
- **Row 3 (Progress Bar):** Continuous 6px height, rounded ends. Cyan for downloading, Lime for completed/seeding, Slate for paused.
- **Row 4 (Footer & Action):**
  - Left: Progress percentage (`74.2%`) and peer health (`↓ 28  ↑ 6`).
  - Right: Floating action button (minimum 44×44px hit bounds):
    - Downloading card: Pause button `||`.
    - Done card: Stop button `STOP` or square.
    - Paused card: Resume button `▶ RESUME`.

### 4.4 Floating Action Button (FAB)
- 48×48px squircle (`rounded-xl`), docked bottom-right (`right: 16px`, `bottom: 80px`).
- Background: Solid Acid Lime (`#CCFF00`).
- Glyph: Chunky black pixel `+` icon.

### 4.5 Bottom Navigation Bar
- 4 tabs: `TRANSFERS`, `SEARCH`, `FEEDS`, `SETTINGS`.
- Fixed height: 56px + bottom safe-area insets.
- Background: `#070A0E` with top 1px border `#161C26`.
- Active Tab: Acid Lime text (`10px` bold) and icon with subtle active indicator.
- Inactive Tabs: Muted slate (`#8B949E`) at 60% opacity.
