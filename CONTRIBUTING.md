# Contributing to Maglev

Bug reports, fixes and ideas are welcome. This page covers what you need to send a pull request that can be merged.

## Open an issue first

For anything other than a small bug fix or a typo, **open an issue before you write code**: a new feature, a change to how something works, a new search source, a new setting, a redesign or a refactor.

1. [Open a feature request](https://github.com/Kaos599/Maglev/issues/new?template=feature.yml) that says what you want to change and why. Screenshots or a rough sketch help.
2. Wait for the maintainer to reply. If the idea fits, the issue gets the `approved` label, sometimes with notes on how it should work.
3. Then open your pull request against `dev`, and link the issue in it (`Closes #123`).

Pull requests for features or changes that don't have an approved issue may be closed without review, however good the code is. This saves you from building something that can't be merged.

Bug fixes don't need approval first, but please link the bug report if there is one.

## Reporting a bug

Use **About → Report a bug** in the app. It opens a GitHub issue with your Maglev version, Android version and phone filled in. You can also open one directly with the [bug report form](https://github.com/Kaos599/Maglev/issues/new?template=bug.yml).

Security problems go through [private reporting](https://github.com/Kaos599/Maglev/security/advisories/new), not public issues. [SECURITY.md](SECURITY.md) says what to include.

Everyone in issues and pull requests follows the [code of conduct](CODE_OF_CONDUCT.md).

## Setting up

You need Node 22, the Android SDK and a phone or emulator. You don't need Rust: CI builds the engine (`libmaglev_core.so`) on every push.

```bash
git clone -b dev https://github.com/Kaos599/Maglev.git && cd Maglev
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
- **Follow [DESIGN.md](DESIGN.md)** for new screens: tokens, components, patterns and a checklist.
- **Colours and fonts come from the theme** (`useTheme()`, `type.heading`, `type.body`, `type.mono`). No hex values outside `constants/`.
- **One icon set:** Pixelarticons, through `components/PixelIcon.tsx`.
- **Touch targets of at least 44 × 44.**
- **No analytics, ads or tracking libraries,** and nothing that sends data anywhere except where the user asked.
- **Every setting has to do something.** A toggle that isn't wired to the engine won't be merged.

Small, focused pull requests get reviewed fastest. Anything beyond a bug fix needs an approved issue first (see [Open an issue first](#open-an-issue-first)).

## Licence

Maglev is GPL-3.0-only. By sending a pull request you agree that your contribution is released under the same licence.
