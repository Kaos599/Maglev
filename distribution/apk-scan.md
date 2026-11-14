# Release APK scan: v0.19-beta

Scanned file: `Maglev-v0.19-beta-arm64-v8a.apk` (22.3 MB), downloaded from
https://github.com/Kaos599/Maglev/releases/tag/v0.19-beta. Tools: `aapt2 dump badging`, `aapt2 dump xmltree`,
`apksigner verify --print-certs`, `unzip -l`, `dexdump` and `strings` on `classes.dex` (build-tools 36.0.0).

## Result

| Check | Result |
|---|---|
| Package, version | `com.maglev`, versionName 0.19, versionCode 194 (base 19 * 10 + ABI digit 4). Universal is 190, armeabi-v7a 191, x86_64 193. |
| SDK | minSdk 24, targetSdk 36 |
| Signing | APK Signature Scheme v2 and v3 only (no v1). One signer, `CN=Maglev, O=Maglev`, RSA 4096. Not the Android debug certificate. Certificate SHA-256 `c8e15bd47fb39fb2248d8b501a677e61be564d52ba535e31a1608564e35df3c4`. |
| `debuggable` / `testOnly` | Not set |
| Google Play Services, Firebase, Crashlytics, Sentry, AppsFlyer, Mixpanel, OneSignal, Play Core, Datadog, PostHog, Adjust | None found in the manifest or in the dex strings |
| Other trackers or ad SDKs | None found. The `com.facebook.*` classes are React Native, Fresco and fbjni (MIT), not Facebook SDKs. One hit for the word "amplitude" is an ordinary string, not an SDK. |
| Native libraries | `libmaglev_core.so` (Rust, librqbit), React Native, Hermes, Expo modules, reanimated, gesture-handler, screens, svg, expo-sqlite, libc++_shared, fbjni, Fresco image libraries, zstd. All open source. No proprietary `.so`. |
| Bundled data | `assets/blocklist.txt` (StevenBlack hosts, MIT), `assets/index.android.bundle` (Hermes bytecode of the app's JS) |
| Code loading | No self-updater and no `REQUEST_INSTALL_PACKAGES`. Two `DexClassLoader` strings in the dex come from framework code (not found in app source: `grep` of `modules/`, `app/`, `utils/` is clean). The app does not download or run code. Its blocklist update downloads a text list of domains. |
| Size | arm64 22.3 MB, armeabi-v7a 20.8 MB, x86_64 23.0 MB, universal 52 MB, `.apks` set 147 MB |

## Permissions (from the manifest)

Declared by Maglev: `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `WAKE_LOCK`, `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_DATA_SYNC`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`,
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

Added by libraries or the build, worth a second look: `SYSTEM_ALERT_WINDOW` (React Native, normally dev-menu only),
`USE_BIOMETRIC` and `USE_FINGERPRINT` (an Expo module, not used by any Maglev screen),
`RECEIVE_BOOT_COMPLETED` (restart after reboot), `VIBRATE`, `READ_/WRITE_EXTERNAL_STORAGE` (max SDK 32),
`POST_PROMOTED_NOTIFICATIONS` (Android 16 live chip).
Removing `SYSTEM_ALERT_WINDOW`, `USE_BIOMETRIC` and `USE_FINGERPRINT` with `tools:node="remove"` would shrink the list
and avoid questions from any store reviewer. Not done here (outside this task's files).

## Network behaviour

Everything below happens on the phone. There is no Maglev server, no account and no analytics.

- Search: queries go to the public sources the user keeps enabled (Knaben, Torrents-CSV, Internet Archive, Nyaa,
  YTS, EZTV, 1337x and others, plus IMDb's suggestion endpoint) and to any Jackett or Prowlarr the user adds.
- Browser: talks to the sites the user opens, and to the block-list URL in Settings
  (default `https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts`).
- Torrents: the Rust engine talks to peers, trackers and the DHT.
- Assistant (optional, off until the user adds a key): sends the chat to the provider the user picks, with the user's
  own key. Provider hosts found in `utils/assistant*`: `openrouter.ai` (default), `api.openai.com`,
  `api.anthropic.com`, `generativelanguage.googleapis.com` (Google), `api.groq.com`, and a user-entered
  OpenAI-compatible or Ollama address. Keys are stored in secure storage and left out of backups.

### Cleartext traffic

`plugins/withCleartextLan.js` sets a network security config with `cleartextTrafficPermitted="true"` for every host
(system trust anchors only). The reason in the file: the assistant's Ollama option is reached at
`http://192.168.x.x:11434`, and Android's config cannot match IP ranges. App code then allows plain http only for
private hosts (`utils/prefs/assistant.ts`). The Rust engine uses its own sockets and ignores the Android policy.
Store reviewers can flag a blanket allow. Possible fix: keep cleartext off in the base config and add a
`<domain-config>` only where Android can match, or ship Ollama support behind https only.

## Store policy fit

- **IzzyOnDroid: not eligible.** Its AI policy rejects apps that integrate LLM services and apps whose code was written
  with LLMs, and Maglev is both. See https://izzyondroid.org/docs/general/AppInclusionPolicy (section "AI policy").
  The 30 MB per-APK limit is met only by the split APKs, not the universal one.
- **F-Droid main repo:** it builds from source, so it needs the Expo and Rust build to work on its servers (the
  project builds the Rust `.so` in CI and gitignores binaries, so a recipe would need a Rust and NDK build step). The
  assistant would need the `NonFreeNet` anti-feature, and the search sources may count as `NonFreeNet` too. Not
  assessed further here.
- **Obtainium:** needs only the GitHub release with APKs attached. Works today with the link in the README.
- **Accrescent:** uses the `.apks` set already attached to each release. Reads the same fastlane metadata.

## Sources

- https://izzyondroid.org/docs/general/AppInclusionPolicy
- https://izzyondroid.org/about/security/ApkScans
- https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/
- https://wiki.obtainium.imranr.dev/deep_links/
