# Maintaining Maglev

How code moves from a branch to a release, how versions are numbered, and where builds go. Contributors only need the first section. The rest is for whoever cuts a release.

## Branches

```
feature/<area>-<task>  ─PR─▶  dev  ─PR─▶  main  ─tag─▶  release
fix/<area>-<task>
```

| Branch | What lands there | Who merges |
|---|---|---|
| `feature/…`, `fix/…` | One change. Branch from `dev`. | You open a PR against `dev`. |
| `dev` | Every accepted change. CI builds one ABI (arm64-v8a) here to keep runs short. | The maintainer, once CI is green. |
| `main` | Releases only. Reached by a PR from `dev`, never a direct push. | The maintainer, once every CI check on the PR is green. |

On a PR into `main` and on `main` itself, CI builds the three ABIs (arm64-v8a, armeabi-v7a, x86_64) plus the universal APK, refuses debug-signed APKs and, when the signing secrets exist, builds the Accrescent APK set. A push to `main` reuses the APKs the PR already built when nothing changed after the merge (job `reuse` in `.github/workflows/ci.yml`).

Commit messages follow Conventional Commits: `feat(browser): …`, `fix(search): …`, `docs: …`. Keep commits atomic: one concern each.

## Required checks

After the checks workflow (`.github/workflows/checks.yml`) merges, add its jobs **Models** and **No private references** as required status checks for `dev` in branch protection. **PR evidence** stays optional because it only warns. **No private references** runs only on pull requests into `dev`, so don't require it on `main`.

## Versions

Patch versions land with PR #231.

A version is `<major>.<minor>` or `<major>.<minor>.<patch>`. `app.json` holds the truth; `package.json` mirrors it as `x.y.z` because npm needs three parts.

| Command | Example | When |
|---|---|---|
| `npm run version:patch` | 1.0 → 1.0.1 | Fixes only. |
| `npm run version:minor` | 1.0.1 → 1.1 | New features. Resets the patch. |
| `npm run version:major` | 1.9 → 2.0 | Big changes. Resets minor and patch. |

All three run `scripts/bump-version.js`, which writes `expo.version` and `expo.android.versionCode` in `app.json` and the mirror in `package.json`.

### versionCode

```
versionCode = major × 10000 + minor × 100 + patch      1.0 → 10000, 1.0.1 → 10001, 1.1 → 10100
APK code    = versionCode × 10 + ABI digit              universal 0, armeabi-v7a 1, x86_64 3, arm64-v8a 4
```

The ABI digit comes from `plugins/withAbiSplits.js`. The universal APK and the app bundle (and so the Accrescent APK set) use digit 0. Android refuses to install a lower versionCode over a higher one, so never change this scheme without a migration plan. A phone that installed an arm64 APK (…4) can't move to the universal APK (…0) of the same version without reinstalling.

The in-app update check compares versions part by part: 1.0 < 1.0.1 < 1.1 = 1.1.0 < 1.10. A fix release shows no What's new card; the highlights ignore the patch on purpose.

## Releasing

1. Merge `dev` into `main` through a PR. Wait for every check, including the APK build. Don't cancel the run.
2. Write `release-notes/<version>.md` (see below). The release fails without it.
3. Tag the merge commit on `main`: `v1.1` or `v1.0.1`. Tags from 0.x were `v0.x-beta`; the updater ignores `-beta` tags.
4. Push the tag. `.github/workflows/release-apk.yml` takes over.

What the release workflow does:

| Step | Detail |
|---|---|
| Check the tag | `node scripts/bump-version.js check <tag>` refuses a tag that doesn't match `app.json`. |
| Check the notes | `node scripts/release-notes.js build <tag>` fails when `release-notes/<version>.md` is missing or malformed. |
| Get the APKs | Reuses the APKs CI built for the same commit on `main`. If that run is missing, failed or expired, it builds them itself. |
| Publish | Names the APKs `Maglev-<tag>-<abi>.apk`, writes `SHA256SUMS`, attaches `Maglev-<tag>.apks` when the signed APK set exists, and creates the GitHub release with the notes. |

When the release workflow finishes, `.github/workflows/pages.yml` rebuilds the website and the self-hosted F-Droid repo from the release APKs.

## Release notes

One file per version in `release-notes/`, named after `expo.version` (`1.1.md`, `1.0.1.md`). Use these headings in this order and leave out the ones a release doesn't have:

```
## What's new
## What's changed
## What's fixed
```

Each section is a list of `- ` lines for people who use the app: what they can do now and where to find it, not how it was built. Don't claim anything the code doesn't do.

- `npm test` checks the notes through `scripts/test-release-notes.js`, which fails when the file for the current version is missing or uses another heading. `node scripts/release-notes.js check [version]` runs the same version check alone.
- `node scripts/release-notes.js draft` lists the commits since the last tag, sorted into the three sections, as a starting point.

The same files feed the in-app What's new screen through `constants/releaseNotes.generated.ts`. Regenerate it with `node scripts/gen-licenses.js` after you add or edit a notes file.

## Signing

`plugins/withReleaseSigning.js` signs release builds (v2 and v3 signatures) when these repository secrets exist:

| Secret | Holds |
|---|---|
| `MAGLEV_KEYSTORE_B64` | The release keystore, base64-encoded |
| `MAGLEV_KEYSTORE_PASSWORD` | The keystore password |
| `MAGLEV_KEY_ALIAS` | The key alias |
| `MAGLEV_KEY_PASSWORD` | The key password |

Without them the build falls back to the Android debug key, so forks and PRs from forks still build. The "Verify APK signing" step fails on `main`, on PRs into `main` and on tags when any APK carries the debug certificate. Elsewhere it only warns.

Android only installs an update signed with the same key as the installed app. Losing the keystore means every existing install has to be uninstalled before it can take a new version. The certificate fingerprint users can check is in the README under "Check the APK is genuine".

## Where builds go

| Channel | How it gets builds | Notes |
|---|---|---|
| GitHub Releases | The release workflow attaches four APKs, the APK set and `SHA256SUMS`. | The source for every other channel. |
| Obtainium | Reads GitHub Releases directly. | No work per release. |
| Self-hosted F-Droid repo | `pages.yml` runs `scripts/build-fdroid-repo.sh` and publishes it under `/fdroid/repo` on the project site. | Refreshes after each release and once a day. |
| F-Droid main repo | Not listed yet. A draft recipe is in `distribution/fdroid/com.maglev.yml`, and `distribution/fdroid/NOTES.md` lists what still blocks it. | F-Droid builds from source, so a reproducible Rust build matters here. |
| Accrescent | Takes the signed APK set (`Maglev-<tag>.apks`), built only when the signing secrets exist. | The set uses the base versionCode (digit 0). |

When Maglev was installed by F-Droid, Obtainium, Accrescent or another store, the in-app updater sees it (`update/InstallSource.kt`; it also knows Google Play and other stores such as Aurora Store, Galaxy Store, Amazon Appstore, Xiaomi, Huawei and Oppo) and leaves updates to that app. It never downloads or installs an update over a store-managed install.

## After a release

- Check that the release page has four APKs and `SHA256SUMS`.
- Check the Maestro run (`.github/workflows/e2e.yml`). It runs on the tag push (`v*`) and by manual dispatch, not on a push to `main`, and it never blocks a release, so a failure there is easy to miss.
- Open the in-app updater on an older build and confirm it finds the new version.

## See also

- [Contributing well](contributing-well.md): what a mergeable PR looks like.
- [Testing](testing.md): every check, what it proves and when CI runs it.
- [Architecture](architecture.md): how the app, the Kotlin module and the Rust engine fit together.
