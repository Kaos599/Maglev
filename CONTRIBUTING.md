# Contributing to Maglev

Bug reports, fixes and ideas are welcome. This page covers what you need to send a pull request that can be merged.

## Reporting a bug

Use **About → Report a bug** in the app. It opens a GitHub issue with your Maglev version, Android version and phone filled in. You can also open one directly with the [bug report form](https://github.com/Kaos599/Maglev/issues/new?template=bug.yml).

Security problems go through [private reporting](https://github.com/Kaos599/Maglev/security/advisories/new), not public issues.

## Setting up

You need Node 22, the Android SDK and a phone or emulator. You don't need Rust: CI builds the engine (`libmaglev_core.so`) on every push.

```bash
git clone https://github.com/Kaos599/Maglev.git && cd Maglev
npm install --legacy-peer-deps
npx expo run:android
```

Debug builds use a mock engine until the native library is present. For the real engine, download the `jniLibs-<abi>` artifact from a CI run and unpack it into `modules/maglev-engine/android/src/main/jniLibs/`.

## Branches

- `dev` is where work lands. Branch from it as `feature/<area>-<task>` or `fix/<area>-<task>`, and open your pull request against `dev`.
- `main` holds releases only. Release tags (`v0.22`) are cut from it.
- Commit messages follow Conventional Commits: `feat(browser): …`, `fix(search): …`, `test: …`, `docs: …`.

## Before you open a pull request

```bash
npm test                 # unit and contract checks
npx tsc --noEmit         # types
npm run test:search      # search parsers against saved pages, if you touched search
```

CI runs these plus the Rust tests and an APK build. A pull request needs CI green before it can merge.

Some checks read design documents that aren't in this repository. Those checks skip themselves when the documents are missing, so a clean run on your machine is still meaningful.

## What gets merged

- **No fake data in release builds.** If the engine doesn't know a value, show it as unknown ("—"), never a guess.
- **Plain English in the app.** "Waiting for Wi-Fi", not "Network policy gate". No raw hashes on normal screens.
- **Colours and fonts come from the theme** (`useTheme()`, `type.heading`, `type.body`, `type.mono`). No hex values outside `constants/`.
- **One icon set:** Pixelarticons, through `components/PixelIcon.tsx`.
- **Touch targets of at least 44 × 44.**
- **No analytics, ads or tracking libraries,** and nothing that sends data anywhere except where the user asked.
- **Every setting has to do something.** A toggle that isn't wired to the engine won't be merged.

Small, focused pull requests get reviewed fastest. For anything large, open an issue first so we can agree on the approach.

## Licence

Maglev is GPL-3.0-only. By sending a pull request you agree that your contribution is released under the same licence.
