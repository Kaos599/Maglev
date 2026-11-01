# MAGLEV — Screen Catalog & Comprehensive State Machines (Audited & Locked)

---

## 1. Master Screen Catalog

| Screen ID | Screen Name | Route / Modal | Key Responsibilities |
|---|---|---|---|
| **SCR-01** | **Active Transfers (Main Screen)** | `/transfers` | Aggregate speed header (`[Pause All]` / `[Resume All]`), filter pills (All, Down, Up, Paused), modular transfer cards, floating `[+]` FAB. |
| **SCR-02** | **Transfers Empty State** | `/transfers/empty` | Minimal 8-bit download tray icon, "No active transfers" header, direct `[+ Add Torrent]` and `[Search Torrents]` buttons. |
| **SCR-03** | **Add Torrent Sheet** | Modal `/add-torrent` | BEP-9 metadata preview, default storage path with `[Change]` override, file checklist with batch `[Select All]` and `.ext` chips, sequential stream toggle, Start action. |
| **SCR-04** | **Torrent Detail Screen** | `/torrent/:id` | Header metadata pill, live speed chart, and 4 tab views: `[FILES]`, `[PIECES]`, `[PEERS]`, and `[TRACKERS]`. Dual-action trash button. |
| **SCR-05** | **Search & Browse Screen** | `/search` | Search box with clear action, horizontal category pills (9 categories), recent searches chips, bookmark icon, search result cards with instant `+ Add` trigger. |
| **SCR-06** | **Automated Feeds Screen** | `/feeds` | Feed channel pills (`All Feeds`, `Linux Distros`, `EZTV`, etc.), `+ Add Feed` button, feed release items with 1-touch download and auto-download badges. |
| **SCR-07** | **System Settings** | `/settings` | 6 grouped sections: Appearance (OLED Black/Dark), Downloads & Storage (POSIX/SAF/Pre-allocation), Bandwidth & Limits (Speed presets, active caps), Network & Proxy (Wi-Fi only, SSID whitelist, SOCKS5, UPnP, Encryption), Power & Battery (Charge only, battery % cutoff, auto-exit), About. |

---

## 2. Macro State Machines

### 2.1 Torrent Lifecycle State Machine
Governs the core download, verification, and seeding pipeline.

```mermaid
stateDiagram-v2
    [*] --> Ingesting: Magnet Link / .torrent file input
    
    Ingesting --> ResolvingMetadata: BEP-9 Swarm Query
    ResolvingMetadata --> MetadataFailed: 15s Swarm Timeout
    MetadataFailed --> ResolvingMetadata: Retry / Re-announce
    MetadataFailed --> [*]: Discard
    
    ResolvingMetadata --> ReadyForDownload: Metadata Resolved
    ReadyForDownload --> AllocatingDisk: User confirms files
    
    AllocatingDisk --> CheckingPieces: Existing files detected
    AllocatingDisk --> Downloading: Pre-allocation complete
    CheckingPieces --> Downloading: Hash verified
    
    Downloading --> Downloading: Piece SHA-1 Verified
    Downloading --> Paused: User Pause / Wi-Fi lost
    Paused --> Downloading: User Resume / Wi-Fi restored
    
    Downloading --> Seeding: 100% Verified
    Seeding --> Paused: User Pause / Ratio limit reached
    Paused --> Seeding: User Resume
    
    Downloading --> Error: Disk Full / Permission Denied
    Error --> Downloading: Retry After Fix
    
    Downloading --> DeletionPrompt: User taps Trash / Long-press
    Paused --> DeletionPrompt: User taps Trash / Long-press
    Seeding --> DeletionPrompt: User taps Trash / Long-press
    Error --> DeletionPrompt: User taps Trash / Long-press

    state DeletionPrompt {
        [*] --> AwaitingChoice
        AwaitingChoice --> RemoveSessionOnly: Tap "Remove from Maglev"
        AwaitingChoice --> RemoveWithFiles: Tap "Delete Torrent + Files"
    }

    RemoveSessionOnly --> [*]: Task removed, files kept
    RemoveWithFiles --> [*]: Task removed, files wiped
```

### 2.2 Android Background Power & Service State Machine
Controls Foreground Service, notification lifecycle, and `PARTIAL_WAKE_LOCK`.

```mermaid
stateDiagram-v2
    [*] --> ServiceDestroyed
    
    ServiceDestroyed --> ForegroundActive: Torrent starts downloading/seeding
    
    state ForegroundActive {
        [*] --> WakeLockHeld: Acquire PARTIAL_WAKE_LOCK
        WakeLockHeld --> UpdatingNotification: Speed notification update (1000ms)
        UpdatingNotification --> WakeLockHeld
        
        WakeLockHeld --> ThrottledCellular: Mobile Data detected (Wi-Fi Only = ON)
        ThrottledCellular --> WakeLockHeld: Wi-Fi Reconnected
    }
    
    ForegroundActive --> ServiceStopped: All transfers Paused / Finished
    
    state ServiceStopped {
        [*] --> WakeLockReleased: Release PARTIAL_WAKE_LOCK (<500ms)
        WakeLockReleased --> NotificationRemoved: stopForeground(STOP_FOREGROUND_REMOVE)
        NotificationRemoved --> CompletionNotification: Fire dismissible download complete notification
    }
    
    ServiceStopped --> ForegroundActive: Transfer resumed
    ServiceStopped --> ServiceDestroyed: User exits app / OS stops service
```

### 2.3 Network & Connectivity Governance State Machine
Controls network interfaces, Wi-Fi constraints, SOCKS5 proxy routing, and Android Doze dormancy.

```mermaid
stateDiagram-v2
    [*] --> EvaluatingNetwork
    
    EvaluatingNetwork --> WifiConnected: Wi-Fi interface detected
    EvaluatingNetwork --> CellularConnected: Cellular interface active
    EvaluatingNetwork --> Disconnected: No network route
    
    state WifiConnected {
        [*] --> CheckSSID
        CheckSSID --> AllowedSSID: SSID matches whitelist (or whitelist disabled)
        CheckSSID --> BlockedSSID: SSID not in whitelist
        
        AllowedSSID --> DirectSwarm: Proxy disabled
        AllowedSSID --> SOCKS5Tunnel: SOCKS5 proxy enabled
        
        BlockedSSID --> SocketsClamped: Pause transfers & drop sockets
    }
    
    state CellularConnected {
        [*] --> CheckWifiOnlyRule
        CheckWifiOnlyRule --> SocketsClamped: "Wi-Fi Only" = ON
        CheckWifiOnlyRule --> MeteredTransfer: "Wi-Fi Only" = OFF
    }
    
    state Disconnected {
        [*] --> EngineDormant: Halt DHT, freeze timers, sleep worker threads
    }
    
    SocketsClamped --> AllowedSSID: Reconnected to authorized Wi-Fi (<300ms)
    EngineDormant --> EvaluatingNetwork: Network connectivity restored
```

### 2.4 Power & Battery Protection State Machine
Controls battery-level cutoff, charging-only rules, and auto-shutdown on transfer completion.

```mermaid
stateDiagram-v2
    [*] --> MonitorPowerState
    
    state MonitorPowerState {
        [*] --> CheckCharger
        CheckCharger --> PowerConnected: Charger attached (AC/Wireless)
        CheckCharger --> OnBatteryPower: Device running on battery
        
        state OnBatteryPower {
            [*] --> CheckBatteryLevel
            CheckBatteryLevel --> BatteryNormal: Level >= Threshold (e.g. 20%)
            CheckBatteryLevel --> BatteryCutoff: Level < Threshold
            
            BatteryNormal --> TransfersPermitted: "Charging Only" = OFF
            BatteryNormal --> TransfersHalted: "Charging Only" = ON
            BatteryCutoff --> TransfersHalted: Auto-pause & release WakeLock (<500ms)
        }
        
        PowerConnected --> TransfersPermitted: WakeLock held, active throughput
    }
    
    TransfersPermitted --> AllTransfersDone: Downloaded 100% & Seeding limits met
    AllTransfersDone --> AutoExitSequence: "Auto-Exit on Complete" = ON
    AllTransfersDone --> ServiceIdle: "Auto-Exit on Complete" = OFF
    
    AutoExitSequence --> ServiceDestroyed: stopForeground(STOP_FOREGROUND_REMOVE) & kill process
```

### 2.5 Seeding & Share Ratio Governance State Machine
Controls upload limits, seed time expiration, and swarm etiquette.

```mermaid
stateDiagram-v2
    [*] --> VerificationComplete: Torrent reaches 100% verified pieces
    
    VerificationComplete --> SeedingActive: Enter Seeding state
    
    state SeedingActive {
        [*] --> TrackingTelemetry: Track uploaded bytes and active time
        TrackingTelemetry --> TrackingTelemetry: Update ratio = uploaded / downloaded
        
        TrackingTelemetry --> RatioLimitMet: ratio >= configured limit (e.g. 1.5x)
        TrackingTelemetry --> TimeLimitMet: seed_duration >= configured duration (e.g. 6h)
    }
    
    RatioLimitMet --> SeedingHalted: Transition to PAUSED, drop peer uploads
    TimeLimitMet --> SeedingHalted: Transition to PAUSED, drop peer uploads
    SeedingHalted --> [*]: Notify user with completion pill
```

---

## 3. Micro Component-Level State Machines

### 3.1 Torrent Card Action Button (`PLAY` / `PAUSE` / `STOP`)
* **Purpose:** One-tap state changer on the right of each transfer card.
* **Touch Target:** Minimum 44×44px hit bounds (`min-w-[44px] min-h-[44px]`).
* **States:**
  * `STATE_DOWNLOADING`: Displays Pause icon `||` in dark square container. Tapping dispatches `engine.pauseTorrent(hash)` and transitions to `STATE_PAUSED`.
  * `STATE_SEEDING`: Displays Stop square icon `■` with micro-label `STOP`. Tapping halts seeding and transitions to `STATE_PAUSED`.
  * `STATE_PAUSED`: Displays Resume arrow icon `▶` with micro-label `RESUME` in lime outline. Tapping dispatches `engine.resumeTorrent(hash)` and transitions to `STATE_DOWNLOADING`.
  * `STATE_ERROR`: Displays Retry icon `↻` with high-contrast plain-language error label (e.g. `Storage Full` or `Permission Denied`).
  * `STATE_BUSY`: Displays a subtle 1-tick spinner when state transition is in flight across the JSI bridge. Button is disabled to prevent rapid multi-clicks.

### 3.2 Floating Action Button (FAB) `[+]`
* **Purpose:** Quick addition trigger on the main transfer screen.
* **States:**
  * `DEFAULT`: Docked bottom-right (`bottom: 80px`, `right: 16px`), neon lime background (`#CCFF00`), black bold 8-bit `+` icon, 48×48px.
  * `PRESSED`: Scale `0.95`, background `#D4FF00`.
  * `OPENED`: Add Torrent Sheet `/add-torrent` opens; FAB gracefully transforms into close trigger.

### 3.3 Category Filter Pills (Horizontal Bar)
* **States per Pill:**
  * `ACTIVE`: Acid Lime background (`#CCFF00`), black bold typography (`10px`), min-height 44px. Tapping active pill keeps it active.
  * `INACTIVE`: Dark card background (`#0D1117`), border `1px solid #1F2937`, white/gray text. Tapping transitions this pill to `ACTIVE` and deactivates prior pill.
  * `SWIPE_GESTURE`: Horizontal swipe across the viewport cycles between filter pills one-handed.

### 3.4 Pieces 16×16 Block Matrix (256 Blocks)
* **Block State Rules:**
  * `BLOCK_UNAVAILABLE` (`#161D26`): Swarm has not completed verification of these blocks.
  * `BLOCK_IN_FLIGHT` (`#CCFF00` solid lime): Actively being downloaded from peers across open TCP/UDP streams (steady, no pulse).
  * `BLOCK_VERIFIED` (`#00E5FF` steady cyan): Downloaded, hashed with SHA-1, verified match with metadata bitfield.
  * `BLOCK_CORRUPT` (`#FF3366` flash): SHA-1 hash mismatch; automatically discarded and re-queued.

### 3.5 File Multi-Select Checkboxes in Add Torrent Sheet
* **Batch Controls:** Top sticky header provides `[Select All]`, `[Deselect All]`, and extension-filter chips (e.g. `[.mkv only]`).
* **States per File:**
  * `CHECKED`: Acid Lime border & fill with black pixel cross `[X]`. File will be allocated and downloaded.
  * `UNCHECKED`: Dark charcoal box `[ ]`. File will be set to download priority `0` (skipped).
  * `DOWNLOAD_PRIORITY`: Long-press opens priority popup: `High`, `Normal`, `Low`.

### 3.6 Settings Toggle & Speed Preset Chips
* **Purpose:** Quick-tap rate limiting and configuration controls in System Settings.
* **Touch Target:** Minimum 44×44px hit bounds (`min-h-[44px]`).
* **States per Preset Chip:**
  * `ACTIVE_PRESET`: Solid Acid Lime (`#CCFF00`) background, black text. Speed ceiling applied immediately in Rust token bucket.
  * `INACTIVE_PRESET`: Card surface `#0D1117`, 1px border `#1F2937`, muted text. Tapping switches active preset within `< 10ms`.
  * `CUSTOM_INPUT`: Tapping `Custom` opens numeric keypad bottom sheet for arbitrary KB/s or MB/s entry.

### 3.7 Storage Directory Selector (POSIX vs SAF)
* **Purpose:** Configure where torrent payloads are written.
* **States:**
  * `STATE_APP_SPECIFIC_POSIX` (Default): Points to `/Android/data/com.maglev/files/Download`. Zero-copy, no runtime permissions, highest I/O throughput.
  * `STATE_SAF_PENDING`: User taps `[Browse Directory]`. Fires `ACTION_OPEN_DOCUMENT_TREE` intent to Android file picker.
  * `STATE_SAF_GRANTED`: Detached file descriptor (`pfd.detachFd()`) passed to Rust JNI bridge with persistable URI permission (`takePersistableUriPermission`).
  * `STATE_AUTO_MOVE_ENABLED`: Completed torrent payloads are automatically relocated to secondary storage without blocking active transfers.
