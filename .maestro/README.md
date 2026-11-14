# Maestro flows

End-to-end flows for the Android app (package `com.maglev`). Docs: https://docs.maestro.dev

| Flow | What it checks |
|---|---|
| `onboarding.yaml` | First launch (state cleared), every onboarding step, empty Transfers |
| `add-and-resume.yaml` | Open a magnet, start it, wait for progress, Home, kill, relaunch, still listed and downloading |
| `pause-resume.yaml` | Pause and resume from the card |
| `search-add.yaml` | Search "Sintel", one-tap add, shows in Transfers |
| `transfers-link-download.yaml` | Add a direct https link (Blender's Sintel trailer, CC BY), progress above 0, pause, resume, remove and delete files |
| `transfers-detail.yaml` | Open a torrent's detail screen: Files, Peers, Trackers, Pieces; open a file's sheet; back |
| `transfers-remove.yaml` | Remove a transfer and keep its files, add it again, remove it with its files; "Nothing downloading" |
| `transfers-filters.yaml` | Filter pills (Downloading, Done, All), the name filter and the sort sheet change the list, then reset |
| `settings-roundtrip.yaml` | Change font style, Wi-Fi only and a download limit, kill and relaunch, check they persisted, restore defaults |
| `settings-screens.yaml` | Open every Settings sub-screen, check its title and a key control, screenshot each |
| `search-filters.yaml` | Search "Sintel", category chips, sort (Newest, Largest, back to Most shared), results stay and the count updates |
| `search-title-lines.yaml` | Search "debian", screenshots at Result name lines 2, 1 and Full name (NEW: needs the result-name-lines setting), restores 2 |
| `search-watch.yaml` | Watch "Sintel" from Search, check it in Settings, Watches, delete it |
| `feeds-add-remove.yaml` | Follow a public archive.org RSS feed, check items load, remove it |
| `feeds-rule.yaml` | Follow the same feed, create an auto-download rule, check it is listed, delete it, remove the feed |
| `browser-detect.yaml` | Browser on a public test page: Files list with sizes, download one, shows in Transfers, removed with files |
| `browser-clear.yaml` | Browser: remove one found file, Clear all, list empty; next page starts without the old files |
| `browser-blocking.yaml` | Browser: per-site ad switch in "This page" and the global "Ad blocking" setting toggle |

Each flow removes its transfer with "Remove and delete files". Transfer cards are matched by `id: "transfer-card"` (never by a "percent" regex: the status bar battery also says percent). `subflows/` holds shared steps and is not run by `maestro test .maestro/`.
The content is the public Sintel torrent (Blender Foundation, CC BY). Flows wait for progress above 0, never for completion.

## Run locally

Use an emulator, never a phone you care about: flows clear app data (`onboarding.yaml`) and delete downloads.

1. Install Maestro: `curl -fsSL "https://get.maestro.mobile.dev" | bash`
2. Start an x86_64 Android emulator (API 34 recommended) with network.
3. Install a build that has the x86_64 ABI: the `apks` artifact of a CI run on `main` (`app-x86_64-release.apk`), then `adb install -r app-x86_64-release.apk`.
4. From the repo root: `maestro test .maestro/` or one flow: `maestro test .maestro/pause-resume.yaml`.

The transfers list must be empty before a run (flows tap the only card on screen). The search flow needs at least one source enabled and reachable.

CI: `.github/workflows/e2e.yml` (manual or on `v*` tags, report-only).
