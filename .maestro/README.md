# Maestro flows

End-to-end flows for the Android app (package `com.maglev`). Docs: https://docs.maestro.dev

| Flow | What it checks |
|---|---|
| `onboarding.yaml` | First launch (state cleared), every onboarding step, empty Transfers |
| `add-and-resume.yaml` | Open a magnet, start it, wait for progress, Home, kill, relaunch, still listed and downloading |
| `pause-resume.yaml` | Pause and resume from the card |
| `search-add.yaml` | Search "Sintel", one-tap add, shows in Transfers |

Each flow removes its transfer with "Remove and delete files". `subflows/` holds shared steps and is not run by `maestro test .maestro/`.
The content is the public Sintel torrent (Blender Foundation, CC BY). Flows wait for progress above 0, never for completion.

## Run locally

Use an emulator, never a phone you care about: flows clear app data (`onboarding.yaml`) and delete downloads.

1. Install Maestro: `curl -fsSL "https://get.maestro.mobile.dev" | bash`
2. Start an x86_64 Android emulator (API 34 recommended) with network.
3. Install a build that has the x86_64 ABI: the `apks` artifact of a CI run on `main` (`app-x86_64-release.apk`), then `adb install -r app-x86_64-release.apk`.
4. From the repo root: `maestro test .maestro/` or one flow: `maestro test .maestro/pause-resume.yaml`.

The transfers list must be empty before a run (flows tap the only card on screen). The search flow needs at least one source enabled and reachable.

CI: `.github/workflows/e2e.yml` (manual or on `v*` tags, report-only).
