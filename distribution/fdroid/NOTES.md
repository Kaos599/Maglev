# F-Droid submission notes

Recipe: `distribution/fdroid/com.maglev.yml` (copy to `fdroiddata/metadata/com.maglev.yml`).
`fdroid lint` and `fdroid rewritemeta` (fdroidserver 2.4.5) pass on it against stub `config/categories.yml` and
`config/antiFeatures.yml`. Nothing was built: the recipe is untested on a buildserver. Run
`fdroid build -v -l com.maglev` in an fdroiddata checkout (needs the Android SDK) before opening the merge request.

## What must change in the repo, ranked

### Blockers (the build cannot be accepted or cannot be reproduced without these)

1. **`native/maglev-core/Cargo.lock` is gitignored** (`.gitignore` line 21, absent at tag `v0.19-beta`).
   F-Droid builds would resolve the newest semver-compatible crates on the day of the build, so two builds differ
   and a malicious or broken crate release goes straight into the APK. Fix: delete the `Cargo.lock` line from
   `.gitignore`, commit `native/maglev-core/Cargo.lock`, and add `--locked` to `cargo ndk ... build --release` in both
   `_rust-android.yml` and the recipe. Affects v0.19-beta; the recipe can only add `--locked` for a tag that has the file.
2. **No pinned Rust toolchain.** `_rust-android.yml` uses `dtolnay/rust-toolchain@stable`. Add
   `native/maglev-core/rust-toolchain.toml` (`[toolchain] channel = "1.91.1"`, targets for the three Android triples) and
   change the recipe to read it, as cfait does: `export RUST_VERSION=$(sed -n 's/channel = "\(.*\)"/\1/p' rust-toolchain.toml)`.
   The recipe hardcodes `1.91.1` as a stand-in; set it to the version the release CI actually used.
3. **Version code is generated, so the F-Droid bot cannot update it.** `plugins/withAbiSplits.js` makes
   `versionCode = app.json versionCode * 10 + ABI digit` (arm64-v8a 4, armeabi-v7a 1, x86_64 3, universal 0). The recipe therefore
   has one `Builds` entry per ABI with `versionCode` 194 and 191. `checkupdates` finds the tag and version
   but cannot compute 194. Either add the new entries by hand per release (acceptable for a beta) or give the
   updater a plain file: commit `distribution/fdroid/versions.txt` and use `UpdateCheckData`. Do not drop the ABI digit
   without a plan: Android refuses an upgrade to a lower versionCode (see comment in `withAbiSplits.js`).
4. **Non-free network services need `AntiFeatures: NonFreeNet`.** The assistant calls `openrouter.ai`, `console.groq.com`
   and `platform.claude.com` (grep of `utils/`, `context/`, `app/`, `modules/maglev-engine/src`). The recipe already
   declares it. If the assistant is off by default and needs a user key, say so in the store description so reviewers
   do not read it as tracking. The search tab queries third-party torrent index sites (1337x, nyaa.si, thepiratebay.org and
   others). Reviewers may ask about the app's description of content; it is not an anti-feature by itself.
5. **Release signing must stay out of the recipe path.** `plugins/withReleaseSigning.js` is already safe: it does nothing
   without `MAGLEV_KEYSTORE_PATH`. But Expo's template signs `release` with the debug key, so the recipe deletes every
   `signingConfig ` line from `android/app/build.gradle` (same as the F-Droid React Native template). Keep the
   plugin's block free of `signingConfig ` lines outside the `if (...)` guard or the recipe's `sed` will break it.

### Likely scanner / policy findings (fix when the first `fdroid build` reports them)

6. **Prebuilt binaries in `node_modules`.** The scanner rejects them. The recipe uses `scandelete: node_modules`, which
   deletes anything flagged, and `scanignore` for the files that must stay:
   `node_modules/react-native/sdks/hermesc/linux64-bin/hermesc` (Hermes compiler, MIT, prebuilt by Meta),
   `ExpoModulesCorePlugin.gradle`, `autolinking_implementation.gradle`, and the `build.gradle` of reanimated, worklets,
   screens, safe-area-context, gesture-handler, svg, webview. Unused `scanignore` paths are errors, so trim the
   list to what the scanner reports. Known upstream issue: Hermes is a binary; `react-native` Maven AARs (`react-android`,
   `hermes-android`) come from Maven Central, which F-Droid allows.
7. **Expo prebuilt AARs.** Expo ships `local-maven-repo` AARs inside each module. The recipe applies the template's
   `sed` that adds `"expo":{"autolinking":{"android":{"buildFromSource":[".*"]}}}` to `package.json` so they build from
   source. Check that SDK 58 still honours this key (template: `templates/build-react-native.yml` in fdroiddata).
8. **`expo prebuild` downloads a template from npm** (`expo-template-bare-minimum`, tag from the SDK). That network
   fetch is what `android/` is generated from, so a republished template changes the APK. Options: commit `android/`
   (violates AGENTS.md "prebuild regenerates"), or pin by installing the template package at an exact version
   with `npx expo prebuild --template <tarball>` after `npm pack expo-template-bare-minimum@<ver>`.
9. **`npm ci --legacy-peer-deps`.** `--legacy-peer-deps` hides conflicting peer ranges. The recipe adds
   `--ignore-scripts` so no postinstall can download binaries. If a dependency needs its script, run it in
   `prebuild`. `package-lock.json` is committed, good.
10. **Google components.** None found. `package.json` has no `expo-notifications`, `expo-location`, `expo-camera`,
    `react-native-device-info`, firebase, or Play Services. `modules/maglev-engine/android/build.gradle` uses AndroidX
    only (`work-runtime-ktx` is Apache-2.0 and from `google()` maven, which F-Droid accepts). If one is added later, use
    the `firebase-stub` srclib and `sed` lines in the F-Droid template. `expo-web-browser` and `react-native-webview`
    use the system WebView; no GMS.
11. **Gradle repositories.** The Expo template adds `maven { url 'https://www.jitpack.io' }` to `android/build.gradle`.
    F-Droid flags unrecognised repositories. `android/build.gradle` is in `scanignore`; if reviewers reject that,
    `sed -i '/jitpack/d' android/build.gradle` in `prebuild`.
12. **Non-code assets.** Fonts come from `@expo-google-fonts/*` (OFL) and icons from `pixelarticons` (MIT,
    `assets/licenses/pixelarticons-LICENSE`). Fine. `native/maglev-core/vendor/librqbit/resources/test/*.bin` are test
    fixtures; add them to `scanignore` or `rm:` if the scanner flags them.

### Packaging and metadata

13. **No fastlane text at tag `v0.19-beta`** (an untracked `fastlane/` appeared in the working tree during this task, from another worker; not reviewed). Needed: `fastlane/metadata/android/en-US/{title.txt,short_description.txt,
    full_description.txt,images/phoneScreenshots/*.png,changelogs/<versionCode>.txt}` or the listing will be empty.
    Screenshots exist in `store/images/canon/`. Changelog source: `release-notes/<version>.md`.
14. **License.** `LICENSE` is the GPLv3 text and `package.json` says `GPL-3.0-only`. The recipe uses `GPL-3.0-only`. The
    module `modules/maglev-engine/package.json` says `MIT`; MIT code inside a GPLv3 app is fine. The vendored
    `librqbit` / `librqbit-core` are Apache-2.0 / MIT per their own `LICENSE` files.
15. **Tag naming.** `release-apk.yml` triggers on `v*`. Beta tags `v<maj>.<min>-beta` match the recipe's
    `UpdateCheckMode: Tags ^v[0-9]+\.[0-9]+-beta$`. F-Droid users get betas as stable unless you tag stable releases `v<maj>.<min>`
    and widen the regex.
16. **Build time and memory.** Rust LTO + Gradle + Hermes on one buildserver VM per ABI. Add
    `timeout: 7200` to a build entry if the first run is killed.

## Reproducible builds

Short answer: not out of the box; feasible for arm64-v8a after items 1 and 2, with unsure results for the Rust library.

- F-Droid's reproducible flow copies the upstream v2/v3 signature onto its own unsigned APK, so the two APKs must be
  byte-identical apart from the signature
  ([Reproducible Builds](https://f-droid.org/docs/Reproducible_Builds/)). The recipe sets `binary:` per ABI to the GitHub
  release asset `Maglev-v<ver>-<abi>.apk` and `AllowedAPKSigningKeys` (placeholder; fill with the release cert SHA-256).
  `withReleaseSigning.js` already signs with v2+v3 only (`enableV1Signing = false`), which is what copying needs.
- The docs say NDK output is the most fragile part: "Anything built using the NDK will be much more sensitive."
  Differences to remove: CI builds Rust on `ubuntu-latest` with an unpinned toolchain and NDK r27c while Gradle uses
  27.1.12297006; the recipe uses 27.1.12297006 for both. Pin the same NDK and Rust in CI. Add the recipe's
  `--remap-path-prefix` and `--build-id=none` flags to `_rust-android.yml` so absolute paths and build IDs match.
- The release APK is currently assembled from CI-built `.so` files that the `reuse` job in `release-apk.yml` downloads from
  `ci.yml`. For F-Droid verification, the published APK must come from the same recipe inputs, so build the
  release APK from the tag with the pinned toolchain.
- `expo prebuild` template drift (item 8), the committed `Cargo.lock` (item 1) and the Hermes bytecode (built from the JS bundle,
  deterministic given the same Node and `package-lock.json`) are the remaining variables.
- Per-ABI split APKs are fine: the recipe builds with `MAGLEV_ABIS=<abi>` so each split only has one native set.
  The universal APK is built too but not published.
- If the Rust library stays unreproducible, drop `binary:` and `AllowedAPKSigningKeys` and let F-Droid sign. Users who installed
  from GitHub then cannot upgrade in place (different signing key); that is the cost of skipping verification.

## Sources

- Build metadata reference: https://f-droid.org/docs/Build_Metadata_Reference/
- React Native on F-Droid: https://f-droid.org/2020/10/14/adding-react-native-app-to-f-droid.html
- React Native template (Expo `buildFromSource`, `scanignore`, `scandelete`): https://gitlab.com/fdroid/fdroiddata/-/blob/master/templates/build-react-native.yml
- Expo app recipe (`npx expo prebuild`, hermesc `scanignore`): https://gitlab.com/fdroid/fdroiddata/-/blob/master/metadata/org.therapiefinder.yml
- cargo-ndk with `rustup` srclib, pinned NDK: https://gitlab.com/fdroid/fdroiddata/-/blob/master/metadata/com.trougnouf.cfait.yml , https://gitlab.com/fdroid/fdroiddata/-/blob/master/metadata/rs.ruffle.yml , https://gitlab.com/fdroid/fdroiddata/-/blob/master/metadata/com.logseq.app.yml
- Reproducible builds and `Binaries` / `AllowedAPKSigningKeys`: https://f-droid.org/docs/Reproducible_Builds/
