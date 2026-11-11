# Phase 2 UI Spec (screen targets for Wave 2b)

The shared rules apply to every screen:
- Use `components/ui/*` primitives and `<PixelIcon>` only. No Ionicons.
- Use `useTheme()` and the `makeStyles(colors)` pattern. No hex values.
- Text styles: Inter for copy; Space Mono + `tabular-nums` for numbers and filenames; Silkscreen only for the brand and screen titles.
- Touch targets are at least 44 px.
- Android Back closes the topmost sheet or modal first.
- Every async view has loading, empty and error states. An error state always has an action.
- Copy is plain and short ("Waiting for Wi-Fi", not "Network governance clamp").
- Engine data comes from `useEngine()` (`context/EngineContext.tsx`). Never fabricate values. Show unknown as "—".
- Hide anything listed as "stored only" in `NATIVE_CONTRACT.md` §7.

## S1. Shell: tabs, header, boot (owner: Onboarding agent for `app/_layout.tsx`; Transfers agent for `app/(tabs)/_layout.tsx`)
- **Tabs:** Transfers · Search · Feeds · Settings, using the PixelIcons `transfers`/`search`/`feeds`/`settings`.
  - Bar height is 56 plus the safe area.
  - The active tab shows the accent-text label and icon with a 2 px accent bar above the icon. No glowing dot.
- **Boot gate** in `app/_layout.tsx`:
  - If `engineStatus.kind === 'unavailable'`, go to `/engine-error`.
  - Otherwise, if `!settings.onboarded`, go to `/onboarding`.
  - Otherwise, go to the tabs.

## S2. Onboarding `/onboarding` (SM-3/4/5)
Four steps with one idea per screen and a pixel progress indicator (4 squares):
1. **Welcome:** the brand mark (`assets/brand/maglev-mark.svg` via react-native-svg or the PNG), the word "Maglev", one line "Fast, simple torrents." Button: **Get started**.
2. **Notifications:** "Get notified when downloads finish and keep them running in the background." Buttons: **Allow** (`requestNotifications`) and **Not now**. On API < 33, auto-skip.
3. **Download folder:** shows the current folder, `Download/Maglev`.
   - Buttons: **Use this folder** and **Choose another…** (`pickDownloadFolder`).
   - When the picked folder is in staging mode, add a caption: "Files are copied there when they finish."
   - On API ≤ 28 the step first asks for storage access (`requestLegacyStorage`).
4. **Background:** "Android may stop downloads to save battery. Allow Maglev to keep running?" Buttons: **Allow** (`openBatterySettings`) and **Skip**.

Done sets `onboarded = true` and replaces the route with the tabs. Every step that was skipped later appears as a Banner or row in Settings.

## S3. Engine error `/engine-error`
EmptyBlock with the warning icon. Title "Maglev couldn't start its download engine". Body: the plain message. Buttons: **Copy details** (clipboard) and **Close app** (`BackHandler.exitApp`). No tabs.

## S4. Transfers (owner: Transfers agent)
- **Header:** brand tile and "MAGLEV" on the left. On the right, IconButtons for `sort` and `search` (in-list filter).
  - In selection mode the header becomes: close · "3 selected" · select-all.
- **Speed strip:** ↓ total, ↑ total, and a Pause all / Resume all toggle (whichever applies).
- **Clipboard chip:** shown above the list when the clipboard holds a magnet not already in the list. Text: "Magnet in clipboard · Add". Dismissible.
- **Filters** (Chips with counts): All · Downloading · Seeding · Paused · Done · Errors.
- **Sort sheet:** Name · Progress · Download speed · Upload speed · ETA · Size · Date added · Ratio, plus a direction toggle. Persist the choice in settings, or in memory if no field exists. Report missing fields.
- **Transfer card:**
  - Line 1: name (Space Mono 13, 1 line, middle-ellipsis), then a state badge on the right.
  - Line 2: telemetry, e.g. "↓ 4.2 MB/s · 1.2 / 3.4 GB · 12 min".
  - Line 3: ProgressBar.
  - Line 4: percentage, then "peers 12/40", then the action IconButton on the right.
  - State badge and action by state:

    | State | Badge | Action |
    |---|---|---|
    | INITIALIZING | "Getting info" | — |
    | QUEUED | "Queued" | — |
    | DOWNLOADING | — | pause |
    | SEEDING | "Seeding" | pause |
    | PAUSED | badge text from the `paused_by` table in STATE_MACHINES §2.1 | play |
    | CHECKING | "Checking" | — |
    | ERROR | `danger` badge with a plain reason | retry |
    | COMPLETED | "Done" | — |

  - Long-press enters multi-select. A bulk bar appears at the bottom with Pause · Resume · Delete…
- **Empty state:** EmptyBlock "No transfers yet" with **Add torrent** and **Search**.
- **FAB:** `plus`, opening the Add sheet.

## S5. Add torrent `/add-torrent` (owner: Detail agent)
SM-9 flow:
1. **Input:** a field to paste a magnet or URL, plus **Paste** and **Open .torrent file**.
2. **Resolving:** "Getting torrent info…"
3. **Preview:** shows name, size, a file list with checkboxes, ext chips and Select all / none, the destination folder row with **Change**, and the Start button.

States:
- **Invalid:** inline error "That isn't a magnet link or torrent file."
- **Duplicate:** "Already in your list", with **Open it**.
- **Timeout:** "Couldn't find this torrent's info" with **Retry** and **Add anyway** (magnets only; the add then continues in the background as INITIALIZING).

The `source` query param prefills the input and auto-resolves.

## S6. Torrent detail `/torrent/[id]` (owner: Detail agent)
- **Header:** back · name · `more` menu (Copy magnet, Recheck, Open folder, Delete…).
- **Summary block:**
  - State badge, a big percentage, and the ProgressBar.
  - A 2×3 stat grid: ↓, ↑, ETA, Ratio, Peers, Size.
  - The speed chart, kept only if it reads the real telemetry history; otherwise drop it.
- **Tabs** (SegmentedControl): Files · Peers · Trackers · Pieces.
  - **Files:** each row has a checkbox (`setIncludedFiles`), the path, size and a per-file progress bar. Tapping a completed file offers **Open** and **Share**.
  - **Peers:** address, client, ↓ and ↑. No per-peer progress.
  - **Trackers:** URLs only, no status badges (§7).
  - **Pieces:** the 16×16 grid from `getPieceBitfield`. Cells are missing, partial (accent at 50%) or have (accent). Add a legend.
- **Delete sheet:** offers **Remove from list** and **Delete with files** (danger), plus Cancel.

## S7. Search and Feeds (owner: Search/Feeds agent)
- **Search:**
  - Search field with clear, and a Recents row of chips with **Clear**.
  - Category chips: All · Video · Audio · Apps · Games · Books · Other.
  - Result rows: name, size, seeds/peers, an **Add** IconButton.
  - States: Idle (recents), Loading (skeleton rows), Empty ("No results for …"), and Error ("Search is unavailable right now" with **Retry**). No silent fallbacks.
- **Feeds:**
  - Header subtitle "3 feeds · 12 new", with a **New feed** button.
  - Feed chips. Item rows show title, size, "18 min ago" and the source, with **Add** or an `check` "Added" state.
  - Error per feed is shown inline. Never substitute hardcoded feeds.

## S8. Settings (owner: Settings agent)
- **Index** `app/(tabs)/settings.tsx`:
  - At the top, a "Needs attention" section, shown only when a permission is denied, the folder is lost, or storage has fallen back. Each issue is a Banner with its fix action.
  - Then ListRows with icon, title and current-value preview:

    | Row | Icon | Value preview |
    |---|---|---|
    | Storage | `storage` | "Download/Maglev" |
    | Bandwidth | `bandwidth` | "Unlimited" or "↓ 5 MB/s · ↑ 1 MB/s" |
    | Torrents & queue | `queue` | "3 at a time" |
    | Interface | `interface` | "OLED · Lime" |
    | Network | `network` | "Wi-Fi only" / "Any network" |
    | Power | `power` | "Pause below 20%" |
    | Scheduling | `schedule` | "Off" (Phase 3 placeholder screen with "Coming soon"; must not pretend to work) |
    | Feeds | `feeds` | "Refresh every 30 min" or similar |
    | About | `about` | version |

- **Sub-screens** `app/settings/<category>.tsx`. Each uses `Screen` with a back button. Changes apply instantly; there is no Save button.
  - **Storage:** folder row with **Change** (picker), a mode caption, "Move completed to" (only if supported), and the storage status banner.
  - **Bandwidth:** download and upload limit presets, plus Custom (a numeric sheet).
  - **Torrents & queue:** max active downloads and seeds, seed ratio limit, seed time limit.
  - **Interface:** Mode (SegmentedControl: OLED · Dim · Light · System), Accent (4 swatches), telemetry density. The preview applies instantly.
  - **Network:** Wi-Fi only, SSID allowlist (show "Needs location permission to work" if not enforceable), listen port, UPnP, DHT, local peer discovery, proxy (SOCKS5 fields with the note "Peer and web traffic only"), and the IP blocklist file. Rows needing a restart show a "Restart engine" chip when `restartRequired`. Encryption and the PEX toggle are hidden (§7).
  - **Power:** charging only, battery cutoff %, and auto-exit when done.
  - **About:** the brand wordmark, version (`version()` from the engine plus the app version), license and links. No slogans.

---

## S9. Wave 3: user feedback (2026-11-11)

The boundary is in `NATIVE_CONTRACT.md` §10. Every icon comes from **Pixelarticons** (MIT, 24×24 grid), generated into `components/icons.generated.ts` by `scripts/gen-icons.js`. To add an icon, map a name to a Pixelarticons file there and re-run the script. *(Amended 2026-11-11: the user picked Pixelarticons over hand-drawn 12×12 glyphs.)*

### S9.1 Bottom tab bar
- **Problem:** the four glyphs read as similar blobs. The focused tab is shown by colour only.
- **New glyphs**, each with a distinct silhouette that you can tell apart at 20px and in greyscale:
  - `tab-transfers`: two opposed arrows, ↓ on the left and ↑ on the right.
  - `tab-search`: a magnifier with a thick ring.
  - `tab-feeds`: an RSS quarter-arcs mark.
  - `tab-settings`: a 3-slider mixer, not a cog. Keep `settings` for other uses.
  - Tab icons render at 24px, a 1:1 match with the Pixelarticons grid.
- **Focused state:**
  - a 56×28 pill behind the icon with `accent` at 16% alpha and radius 8 (no new hex; derive it with an alpha helper in `constants/`);
  - the icon in `accentText` and the label in `text` at weight 600.
  - Unfocused tabs show the icon in `textMuted` and the label in `textMuted` at weight 400.
- The pill animates its opacity and scale (0.9→1, 160 ms) on focus. Respect reduced motion.
- Bar height is 64, plus the inset. Labels stay visible.

### S9.2 Add sheet: space
- A **space strip** under the file count:
  - a bar showing selected bytes against free space on the target. Selected is `accent`; free space left after the download is `surfaceRaised`.
  - Line 1: `Selected 3.2 GB of 4.7 GB`.
  - Line 2: `Free on device 21.4 GB` (in staging mode: `Free in Maglev storage …`, plus the target folder's free space when it's known).
  - It uses the `storage` glyph.
- **Not enough space** (`NATIVE_CONTRACT` §10.3):
  - a danger Banner reading "Not enough space. Free up 1.2 GB or deselect files.";
  - Start is disabled and its label is "Not enough space".
- **Low-space warning:** a warning Banner reading "Only 640 MB will be left on your device." Start stays enabled.
- Free space refreshes when the sheet opens and whenever the folder changes.

### S9.3 Detail: actions and file priority
- **Header actions:** an overflow (`more`) sheet with icon rows:
  - Pause or Resume
  - Recheck files (`recheck`), subtitle "Verify everything on disk"
  - Find more peers (`reannounce`), subtitle "Asks trackers and DHT again". It is disabled unless the torrent is downloading or seeding. If the engine sets `retryAfterSecs`, show "Try again in 40 s".
  - Copy magnet (`magnet`)
  - Open folder (`folder`)
  - Delete (`trash`, danger)
- **Files tab:** each row shows:
  - a file-type glyph;
  - the name in Space Mono on one line with middle-ellipsis;
  - size, % and a thin progress bar;
  - a priority chip: `First` (accent outline), `Skip` (muted, with the name struck through), and nothing for Normal.
- **Changing priority:** tapping a row opens a priority sheet with radio rows using ListRow `selected`:
  - **Download first**, subtitle "Fetched before other files"
  - **Normal**
  - **Skip**, subtitle "Not downloaded"
  - Multi-select (long-press) applies one priority to several files.
  - Skipping every file is blocked with the message "Keep at least one file".
- The add sheet's per-file checkbox stays as is. A long-press on a file there opens the same priority sheet, and its result is sent as `file_priorities`.

### S9.4 More icons (consistency pass)
- **File-type glyphs:** `file-video`, `file-audio`, `file-image`, `file-archive`, `file-doc`, `file-app` (apk), `file-disc` (iso, img), and the existing `file` for anything else. Map them by extension in `utils/fileKind.ts`.
- **Stat glyphs** (12px, beside the stat):
  - size: `storage`
  - seeds: `upload`
  - peers: `peers`
  - ratio: `ratio` (new)
  - ETA: `clock`
  - down and up speed: `download` and `upload`
- **Where they go:**
  - TransferCard telemetry row
  - Detail Overview stat grid
  - Search result rows (already partly done)
  - Add sheet file rows (file-type)
  - Detail section headers (Files, Peers, Trackers, Pieces), using the existing glyphs
- **New glyphs in this wave:** `tab-transfers`, `tab-search`, `tab-feeds`, `tab-settings`, `file-video`, `file-audio`, `file-image`, `file-archive`, `file-doc`, `file-app`, `file-disc`, `ratio`, `recheck`, `reannounce`, `priority-first`.
- **Rules:**
  - One glyph per meaning, never a decorative icon on every heading.
  - Icons sit beside text and never replace it, except in the tab bar, which has labels too.
  - Glyph colour follows the text colour of its row.

### S9.5 Settings: Live Updates
Settings → Interface (or Notifications) gets a "Live progress in status bar" row:
- On API 36 and later, the value is On or Off from `liveUpdates`, and tapping the row calls `openLiveUpdateSettings()`.
- Below API 36 the row is hidden.

## S10. Wave 4.5: feel and trust (user-approved 2026-11-11)

TS-only items are listed here. Native items (MediaStore indexing, resolve activity) are in `NATIVE_CONTRACT.md` §12.

### S10.1 Instant actions (SM-22)
- Tapping Pause, Resume, Pause all or Resume all updates the screen **immediately**. `EngineContext` keeps an optimistic override per torrent, `{state, since}`. It clears when telemetry reports the expected state, or after 5 s.
- On timeout or on an error result, the torrent reverts to the engine state and a notice says "Couldn't pause <name>. Try again."
- The card's action button is disabled while an override is pending, so double taps do nothing.

### S10.2 Steady speed and time left
- **Pure functions** in `utils/rates.ts`, tested in `scripts/test-rates.js`:
  - `smoothRate(prev, sample, dtMs)` is an exponential moving average with τ = 5 s. If the gap is more than 15 s (the app was backgrounded), it resets to the sample.
  - `etaSecs(remaining, smoothedBps)`: −1 when the rate is under 1 KB/s.
  - `formatEta(secs, prevLabel)` uses steps: "under a minute", whole minutes up to 59, "1 h 20 min" (5-minute steps), and "over a day". There is **hysteresis**: the label changes only when the new value is outside ±10% of the value the previous label stands for, or when it crosses a step boundary.
- **Applied in one place:** smoothing happens where telemetry enters `EngineContext`, per torrent, for `down_bps` and `up_bps`. Every screen shows the smoothed values. The raw values stay available as `rawDownBps` for the detail Peers tab.

### S10.3 Instant cold start
- `EngineContext` persists the last torrent list (id, name, state, progress, totals, `paused_by`) to the kv-store, throttled to once every 5 s and on app background.
- On boot it renders that list **at once**, before the engine answers. Speeds show "—" and the state comes from the cache. Live telemetry replaces it in place, with no list reset or re-mount, and keys stay stable.
- Never show a full-screen spinner when a cached list exists. Log `bootToFirstRowMs` with `console.log('[Maglev] boot', ms)` for device measurement.

### S10.4 Transfers list at a glance
- **A card shows three things:** the name (two lines max), one progress bar, and one status line.
- **Status line** by state:
  - Downloading: `12 min left · 4.1 MB/s`
  - Seeding: `Seeding · ↑ 1.2 MB/s`
  - Paused: its reason, for example `Paused: waiting for Wi-Fi`
  - Finished: `Done · 4.2 GB`
  - Moving: `Moving files… 42%`
- Peers, ratio and the upload amount move out of the card into Detail. Keep the stat icons only where they label the single status line, if at all.
- Keep the card height steady across states.

### S10.5 Undo for removing a torrent
- "Remove (keep files)" no longer asks for confirmation. The torrent leaves the list at once, and a notice shows "Removed <name> · Undo" for 5 s. The engine delete runs only after the notice expires.
- If the app goes to the background first, the pending removal runs at once.
- "Remove and delete files" still asks first, with the existing confirmation and its exact size.
- Bulk remove behaves the same way, with "Removed N torrents · Undo".

### S10.6 Empty state that teaches
- With no torrents, Transfers shows the title "Paste a magnet link or open a .torrent file" and the body "Links you tap in your browser open here too."
- Actions are **Paste link**, enabled only when the clipboard holds a magnet or `.torrent` URL (reuse the clipboard chip detection), and **Open file** (the document picker).
- The clipboard chip appears at the top of the empty state when it applies.

### S10.7 Mobile data during onboarding
- A new onboarding step after Background: "Download on mobile data?" The options are **Wi-Fi only (recommended)**, which is pre-selected, and **Wi-Fi and mobile data**.
- The step saves the existing Wi-Fi-only setting.
- **Defaults:** for a fresh install the default becomes Wi-Fi only. Users who have already finished onboarding keep their current value. Never change it silently.

## S11. Wave 4.6: device-test fixes and polish (user-approved 2026-11-11)

The reference design is https://claude.ai/artifact/15UyikwfrRKdpkcfQvVe8j (Files tab, priority sheet, light palette).

### S11.1 File row states (`components/detail/FileListRow.tsx`)
- **Downloading:** file icon in `download`, bar in `download`, label `42% · 1.2 GB`.
- **Paused** (torrent paused): icon and bar in `paused`, label `30% · Paused · 96 MB`.
- **Done:** a `check` icon in `success` replaces the file icon. No bar. The label reads `Done · 64 MB`, with "Done" in `success`.
- **Skipped:** transparent background, dashed border (`border`), opacity 0.6, faint icon, label `Skipped · 4.9 GB`. No strikethrough, no Skip chip and no ⋮ button.
- **First chip:** keeps the lime chip and uses the new `firstBg`, `firstFg` and `firstBorder` tokens.

### S11.2 Priority sheet (`components/detail/PrioritySheet.tsx`)
- Three option cards (a new `components/ui/RadioCard.tsx`): a 32 px icon box, a mono title, a body description and a square pixel radio (2 px border, with an 8 px filled square when selected).
- **Selected card:** border `selBorder`, background `selBg`. The Skip card is dashed and faded when not selected.
- **Copy:**
  - Download first: "Fetched before the other files. Same speed, earlier turn." with the First chip.
  - Normal: "In torrent order with the rest."
  - Skip: "Not downloaded. Saves <size>, leaves <free> free." For several files, use the sum. Free space comes from `getFreeSpace()`. If that is unknown, use "Not downloaded. Saves <size>."
  - Footer: "Changes apply at once. You can change it again any time."
- Accessibility: `radio` role, `checked` state and a 44 px minimum.

### S11.3 Light palette (`constants/theme.ts`, light mode only)
- **Colours:** `accent` = `#4D7C0F`, `accentText` = `#3F6212`, `download` = `#0369A1`, `upload` = `#3F6212`, `success` = `#15803D`.
- **New semantic tokens in every mode:** `firstBg`, `firstFg`, `firstBorder`, `selBg`, `selBorder`.
  - Dark modes: `alpha(accent, .10)`, `accentText`, `accent`, `alpha(accent, .08)`, `accent`.
  - Light: `#D9F99D`, `#1A2E05`, `#4D7C0F`, `#F4FCE3`, `#4D7C0F`.
- Update the contrast table in the header comment. Every text role must stay at 4.5:1 or above on `bg`.
- Accent fills with `onAccent` text (buttons) must still pass 4.5:1. Check white on `#4D7C0F` and use `#3F6212` for fills if it fails.

### S11.4 Bugs from the device test
1. **Unknown speed unit.** The Transfers header showed "↓ 4.1 undefined/s" while a magnet was still getting its info. Find the speed formatter that can return an undefined unit (NaN or an out-of-range index) and make every speed formatter total and safe. Add a test.
2. **Opening a `.torrent` via a `file://` VIEW intent** put the path in the paste box with "That isn't a magnet link or torrent file". `file://` and `content://` URIs that end in `.torrent`, or that arrive with the torrent MIME type, must go straight to resolving, the same as the document picker.
3. **Long-press, then Pause in the bulk bar, opened a search box** (reported by the user, not yet reproduced). The bulk bar replaces the hidden tab bar, and the tab bar is shown again in the same frame the tap is handled. Make the bulk bar not depend on hiding the tab bar: keep the tab bar mounted and hidden for the whole press (delay exiting selection until the press has ended, e.g. `requestAnimationFrame` after `onPress`), or place the bulk bar above it. Also check that no header control (search toggle) sits under the selection header's controls. Write down which cause you found.

### S11.5 About
Settings → About gets a "Built by Kaos" row with the GitHub icon (or `link`). It opens `https://github.com/Kaos599` with `Linking.openURL` and shows the handle `Kaos599` as its value.

### S11.6 Snappier screen changes
- The user finds Settings → Storage → Back slow.
- Measure before changing anything:
  - which navigator the root `Stack` uses (expo-router uses native-stack, where `animationDuration` is iOS-only),
  - how long the Android transition takes,
  - whether the pushed screen or the screen we return to does heavy work on mount or focus (a context re-render, a sync storage read, an effect that waits).
- Then:
  - Pick the fastest Android animation available in the installed react-native-screens version that still shows direction. Read its source for the supported `animation` values and any Android duration control, and cite them.
  - Remove the JS work in the path: memoise the Settings rows and defer non-visible work with `InteractionManager` or after the transition.
  - Make sure the back gesture and the hardware back button pop at once.
- Report before and after numbers if you can measure them. Otherwise report the transition values you used.
