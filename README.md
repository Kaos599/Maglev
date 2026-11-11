<p align="center">
  <img src="assets/brand/readme-header.svg" alt="Maglev, a fast, minimal torrent client for Android" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Kaos599/Maglev/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Kaos599/Maglev/ci.yml?style=flat-square&label=CI&labelColor=05070A"></a>
  <a href="https://github.com/Kaos599/Maglev/releases"><img alt="Release" src="https://img.shields.io/github/v/release/Kaos599/Maglev?include_prereleases&style=flat-square&label=release&labelColor=05070A&color=CCFF00"></a>
  <img alt="Status: beta" src="https://img.shields.io/badge/status-beta-CCFF00?style=flat-square&labelColor=05070A">
  <img alt="Android 7+" src="https://img.shields.io/badge/Android-7%2B-00E5FF?style=flat-square&labelColor=05070A">
  <img alt="Engine: Rust + librqbit" src="https://img.shields.io/badge/engine-Rust%20%C2%B7%20librqbit-E8ECEF?style=flat-square&labelColor=05070A">
</p>

<p align="center">
  Maglev is a torrent client for Android, built to do on a phone what LibreTorrent and Flood do elsewhere.<br>
  Paste a magnet link, pick your files, and put the phone in your pocket.
</p>

<p align="center">
  <a href="https://github.com/Kaos599/Maglev/releases/latest"><b>Download the beta</b></a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#whats-next">What's next</a>
</p>

---

## Features

**Adding torrents**
- Open magnet links and `.torrent` files straight from your browser, a chat app, or the clipboard.
- See every file before you start. Choose which ones to download, and mark one to download first.
- Maglev checks the free space on your phone and tells you what will be left before you tap Start.

**Downloading**
- The engine is [librqbit](https://github.com/ikatson/rqbit), written in Rust, with DHT, trackers and local peer discovery.
- A queue decides how many torrents run at once. Seeding stops on its own at the ratio or time you set.
- Downloads keep running with the screen off. If Android closes the app, Maglev restarts and carries on from where it was.
- On Android 16 and later, progress shows as a live chip in the status bar.

**Your files**
- Everything lands in `Download/Maglev`, where any file manager can find it, or in any folder you choose.
- Open, share or stream a file from the torrent's detail screen. Video can start playing before the download finishes.

**Search**
- One search box queries Knaben, Torrents-CSV, Internet Archive, Nyaa and YTS together, and merges results that point to the same torrent.
- Filter by category, sort by seeders, size or date, and pick which sources answer each category.
- Add your own Jackett or Prowlarr indexer.

**Control**
- Wi-Fi only, pause on low battery, and download only while charging.
- Speed limits, Pause all and Resume all, and Shut down from the notification.
- OLED, Dim and Light themes with four accent colours.

## Install

Download an APK from [Releases](https://github.com/Kaos599/Maglev/releases/latest).

| File | Choose it if |
|---|---|
| `Maglev-<version>-arm64-v8a.apk` | your phone is from the last six years. Most people want this one. |
| `Maglev-<version>-armeabi-v7a.apk` | you have an older 32-bit phone. |
| `Maglev-<version>-x86_64.apk` | you use an emulator or a Chromebook. |
| `Maglev-<version>-universal.apk` | you aren't sure. It runs on every device. |

## What's next

**Now**
- Per-torrent speed limits, tracker editing and moving finished downloads to another folder.
- Sharing a torrent as a magnet link or a `.torrent` file, and creating your own.

**Soon**
- A scheduler that downloads only during the hours you choose.
- RSS feeds that add new episodes as they come out, filtered by name.
- Peer blocklists.

**Later**
- An optional assistant that runs on your own AI key.
- Downloading ordinary files from any link, with pause and resume.

The full plan lives in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Contributing

<details>
<summary>Build from source, run the tests, and find the project docs</summary>

### Build from source

You need Node 22, the Android SDK and a device or emulator. CI compiles the Rust engine (`libmaglev_core.so`) on every push, so there's no Rust toolchain to install.

```bash
git clone https://github.com/Kaos599/Maglev.git && cd Maglev
npm install --legacy-peer-deps
npx expo run:android
```

Debug builds use a mock engine until the native library is present. For the real engine, download the `jniLibs-<abi>` artifact from a CI run and unpack it into `modules/maglev-engine/android/src/main/jniLibs/`. Maglev ships its own native module, so it runs as a development build (`expo run:android`) rather than in Expo Go.

### Tests

```bash
npm test                 # ABI-split plugin + contract suite
npm run test:contracts   # contract suite on its own
npm run test:search      # search providers against offline fixtures
node scripts/test-plugins.js
```

CI also runs the Rust unit tests and checks every engine build for librqbit symbols and 16 KB page alignment.

### Project docs

| Doc | What's in it |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Working rules, design tokens and the git workflow. |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phases, tasks and priorities. |
| [`docs/NATIVE_CONTRACT.md`](docs/NATIVE_CONTRACT.md) | The Rust ⇄ Kotlin ⇄ TypeScript boundary: JNI calls, JSON shapes, error codes. |
| [`docs/SEARCH_CONTRACT.md`](docs/SEARCH_CONTRACT.md) | Search providers, categories and how results merge. |
| [`docs/STATE_MACHINES_AND_SCREENS.md`](docs/STATE_MACHINES_AND_SCREENS.md) | Every screen and state transition. |

Icons are [Pixelarticons](https://github.com/halfmage/pixelarticons) by Gerrit Halfmann (MIT).

</details>

## Legal

Maglev doesn't host or index any content. Search sends your query to public indexes run by third parties. What you download, and following the law where you live, is up to you.

## License

Maglev is free software under the [GNU General Public License v3.0](LICENSE). You can use, study, change and share it. If you distribute a changed version, its source must stay available under the same licence.

It includes a modified copy of [librqbit](https://github.com/ikatson/rqbit) by Igor Katson, under the [Apache License 2.0](native/maglev-core/vendor/librqbit/LICENSE). The changes are listed in [`MAGLEV_PATCH.md`](native/maglev-core/vendor/librqbit/MAGLEV_PATCH.md).
