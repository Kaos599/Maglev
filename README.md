<p align="center">
  <img src="assets/brand/readme-header.svg" alt="Maglev, a small, fast torrent client for Android" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Kaos599/Maglev/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Kaos599/Maglev/ci.yml?style=flat-square&label=CI&labelColor=05070A"></a>
  <a href="https://github.com/Kaos599/Maglev/releases"><img alt="Release" src="https://img.shields.io/github/v/tag/Kaos599/Maglev?style=flat-square&label=release&labelColor=05070A&color=CCFF00"></a>
  <img alt="Android 7+" src="https://img.shields.io/badge/Android-7%2B-00E5FF?style=flat-square&labelColor=05070A">
  <img alt="Status: pre-release" src="https://img.shields.io/badge/status-pre--release-FFB020?style=flat-square&labelColor=05070A">
</p>

<p align="center">
  <b>Maglev</b> is a minimal torrent client for Android, built to replace LibreTorrent and Flood on your phone.<br>
  A Rust engine does the downloading. The interface stays out of your way.
</p>

---

> [!NOTE]
> **Pre-release.** The engine is real (librqbit) and CI builds every commit. The first release is waiting on the
> on-device test described in [What's next](#whats-next). Expect rough edges.

## Why Maglev

- **Small.** No ads, analytics or account. The arm64 APK is about 38 MB today; we expect about 19 MB once the compressed-library build is confirmed.
- **Keeps going in the background.** A foreground service keeps downloads running. If Android kills the app, it restarts on its own and picks up where it left off.
- **Files go where you can find them.** By default they land in `Download/Maglev`, which any file manager can open. You can also pick any folder.
- **Search built in.** It searches several public indexes at once, merges duplicate results, and lets you choose which sources to use for each category.

## What works today

| Area | Status | Notes |
|---|:---:|---|
| Magnet links and `.torrent` files | ✅ | Opens from the browser, other apps, or the clipboard. Duplicates are detected. |
| Downloading and seeding | ✅ | librqbit 9 with DHT, ratio and time seed limits, and a queue (max active). |
| Background service | ✅ | Notification with Pause all, Resume all and Shut down. Restarts after process death. |
| Storage | ✅ | `Download/Maglev` by default. A custom folder is supported through the system picker. |
| Network and power rules | ✅ | Wi-Fi only, battery cutoff, charging only. |
| Transfers screen | ✅ | Sort, filter, multi-select with bulk actions. |
| Torrent detail | ✅ | Files (include or exclude), peers, trackers, pieces, recheck. |
| Search | 🧪 | Knaben, Torrents-CSV, Internet Archive, Nyaa and YTS on by default. Optional: TPB, BitSearch, LinuxTracker, and your own Jackett or Prowlarr (Torznab). Needs a device test. |
| Themes | ✅ | OLED, Dim and Light, with Lime, Cyan, Pink or Orange accent. |
| Streaming while downloading | 🧪 | Local playback link for VLC and similar players. Needs a device test. |
| Encryption, PEX toggle, sequential download | ⏳ | These are saved, but librqbit does not apply them yet. See [`NATIVE_CONTRACT.md` §7](docs/NATIVE_CONTRACT.md). |
| RSS rules, scheduler, create torrent | ⏳ | Planned for Phase 3. |

✅ works and is covered by contracts · 🧪 built, waiting for a device test · ⏳ not done yet

## Install

Download an APK from [Releases](https://github.com/Kaos599/Maglev/releases). Each CI run also uploads an `apks` artifact.

| File | Pick it if |
|---|---|
| `Maglev-<version>-arm64-v8a.apk` | You have a phone made in the last 6 years. Most people want this one. |
| `Maglev-<version>-armeabi-v7a.apk` | You have an older 32-bit phone. |
| `Maglev-<version>-x86_64.apk` | You use an emulator or a Chromebook. |
| `Maglev-<version>-universal.apk` | You aren't sure. It runs everywhere but is larger. |

## What's next

**First release**
- Test on real phones: long downloads, the app being closed by Android, and search.
- Publish the first pre-release APKs.

**Coming after that**
- Speed limits for each torrent
- Moving downloads to another folder
- Sharing a torrent or making your own
- A scheduler that only downloads at times you pick (overnight, for example)
- RSS feeds that add new episodes automatically
- A blocklist for bad peers

**Later**
- An optional assistant that uses your own AI key
- Downloading normal files from any link, with pause and resume

The detailed task list is in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Contributing

<details>
<summary>Build from source, run the tests, and find the project docs</summary>

### Build from source

You need Node 22, the Android SDK and a device or emulator. You don't need Rust: CI compiles `libmaglev_core.so` on every push.

```bash
git clone https://github.com/Kaos599/Maglev.git && cd Maglev
npm install --legacy-peer-deps

# Debug builds use a mock engine when the native library is missing.
npx expo run:android
```

To run the real engine locally, download the `jniLibs-<abi>` artifact from a CI run and unpack it into `modules/maglev-engine/android/src/main/jniLibs/`.

Expo Go cannot load Maglev's native module, so use a development build (`expo run:android`).

#### Tests

```bash
npm test                 # ABI-split plugin + reality contracts
npm run test:contracts   # contract suite (exits 1 if any P0 fails)
npm run test:search      # search providers against offline fixtures
node scripts/test-plugins.js
```

CI also runs the Rust unit tests and rejects any engine library that is under 3 MB, lacks librqbit symbols, or isn't 16 KB page-aligned.

### Project docs

| Doc | What's in it |
|---|---|
| [`AGENTS.md`](AGENTS.md) | How to work in this repo: rules, design tokens, git workflow. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases, tasks and priorities. |
| [`docs/NATIVE_CONTRACT.md`](docs/NATIVE_CONTRACT.md) | The engine boundary: JNI calls, JSON shapes, error codes. |
| [`docs/SEARCH_CONTRACT.md`](docs/SEARCH_CONTRACT.md) | Search providers, categories and aggregation. |
| [`docs/STATE_MACHINES_AND_SCREENS.md`](docs/STATE_MACHINES_AND_SCREENS.md) | Every screen and state transition. |

The Rust ⇄ Kotlin ⇄ TypeScript boundary is defined in [`docs/NATIVE_CONTRACT.md`](docs/NATIVE_CONTRACT.md).

</details>

## Legal

Maglev does not host, index or curate any content. Search sends your query to public third-party indexes. You are responsible for what you download and for following the laws where you live.
