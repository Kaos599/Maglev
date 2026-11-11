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
