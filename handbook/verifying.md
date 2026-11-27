# How we build and verify a change

This is the process every change follows, whether a person or an AI agent writes it. The aim: by the time you ask for a review, you have already shown that the change works. A reviewer then repeats your steps instead of guessing.

Small fixes (a typo, a colour, a one-line bug) can skip the steps marked *features only*. Everything else follows all of them.

| # | Step | You end with |
|---|---|---|
| 0 | Agree on the change | An issue with the `approved` label |
| 1 | Read what exists | The conventions and code you will follow |
| 2 | Write the spec sheet | Rules a reviewer can check, before any code |
| 3 | Model it *(features only)* | A TLA+ spec in `specs/<feature>/` |
| 4 | Validate the model *(features only)* | `npm run models` passes; bad paths turned into device steps |
| 5 | Write the code | Code that follows the model, action by action |
| 6 | Run every check | `npm run check`, tsc and the reference guard green, plus the models if you touched states |
| 7 | Read your own diff | Nothing extra, nothing missing |
| 8 | Open a draft PR and let CI run | A green CI run |
| 9 | Get the APK | The CI-built APK for your phone |
| 10 | Test it on a real device | The device steps from step 4, plus the standard set |
| 11 | Post the evidence | Screens, recordings and check output in the PR |
| 12 | Ask for review | A PR up to date with `dev`, marked ready, which a reviewer can replay |

## 0. Agree on the change

Open an issue first for anything bigger than a bug fix, and wait for the `approved` label ([CONTRIBUTING.md](../CONTRIBUTING.md)). If the maintainer adds `needs-model`, the change moves a feature between states and steps 3 and 4 are required.

## 1. Read what exists

Before you write anything, read:
- the feature's row in [feature-map.md](feature-map.md): its screens, code, states and model;
- its model in `specs/`, if there is one;
- [DESIGN.md](../DESIGN.md) for anything on screen;
- [engine-boundary.md](engine-boundary.md) if the change crosses TS ⇄ Kotlin ⇄ Rust;
- the code around the change, so you follow its names and patterns instead of inventing new ones.

## 2. Write the spec sheet

Write down what you will build before you build it. For a feature, this is the `README.md` in `specs/<feature>/` (copy [specs/_template/](../specs/_template/)). For a smaller change, put it in the issue or the PR description.

A spec sheet has:
- **Goal:** one or two sentences on what the user sees differently.
- **Rules:** the things that must always hold, in plain words. Example: "the What's New card never opens over a link you just shared". These become your acceptance rules, and they are what a reviewer checks.
- **Out of scope:** what this change deliberately does not do.
- **Files:** the files you expect to touch. If the list grows a lot while you code, stop and ask whether the change is still the same change.
- **How it will be checked:** the commands, and the steps on a device.

For a feature, the README also has a table mapping each action to the code. Leave it empty for now; you fill it in at step 5, when the code exists.

## 3. Model it *(features only)*

Write the feature as a lean TLA+ spec: the states, one action per thing a person or Android does, and each rule as an invariant. [state-machines.md](state-machines.md) walks through the template. Most specs are about 100 lines.

When you fix a bug, add a second `.cfg` for the old design with `\* expect: fail <Rule> in <N> steps`. If the model can't reproduce the bug, it can't prove the fix.

## 4. Validate the model *(features only)*

```bash
npm run models specs/<feature>
```

- Every passing design must pass, and every rejected design must break the rule you expect.
- When TLC breaks a rule, read the path it prints and change the design. Never weaken a rule to make TLC pass. A rule changes only when the maintainer agrees it was wrong. Then change it in the `.tla` and the README, and give the reason in the pull request.
- **Turn each path TLC found into device steps for step 10.** A path like "share, Android closes Maglev, tap the icon" is exactly what to try on a phone. This is how the model and the real app stay connected.

TLC checks every state the model can reach. It doesn't check that your code matches the model. The action-to-code table in the README (step 5) and the device steps (step 10) cover that gap.

## 5. Write the code

- Follow the model one to one: each action becomes a code path, and each state becomes a value the code can hold. Don't invent states the model doesn't have.
- Fill in the action-to-code table in `specs/<feature>/README.md`.
- If the code needs a state the model lacks, go back to step 3 and add it there first.
- When you change a feature, update its row in [feature-map.md](feature-map.md) and its model's README (rules, designs tried, action table).
- If a Maestro flow in `.maestro/` covers what you changed, update it in the same PR. If you changed how a user flow works and no flow covers it, consider adding one.
- If people who use the app will notice the change, add a `- ` line for it to the release notes for the next version, `release-notes/<version>.md`, under `## What's new`, `## What's changed` or `## What's fixed`. Write it for people who use the app. Ask on the PR if you don't know the next version. `npm test` checks that the file for the version in `app.json` exists and uses only those headings, in that order. It doesn't check that your change has a line, so the reviewer does.
- Comments say why, in their own words. They never point at notes a contributor can't open.

## 6. Run every check

```bash
npm run check                  # every check, one line each (or: npm run check -- --area browser)
npx tsc --noEmit               # types
npm run check:refs             # no new references to private notes
npm run models                 # when you touched a model or a feature's states (needs Java 11+)
```

All of them must be green. CI runs the models on every pull request either way. A `SKIP` line says why it skipped, and [testing.md](testing.md) explains each one. Don't add new unit-test scripts. If a user flow is worth automating, add a Maestro flow in `.maestro/`.

## 7. Read your own diff

Run `git fetch origin`, then `git diff origin/dev...`, and read every line as if someone else wrote it. Check for:
- changes the spec sheet doesn't explain: reformatting, renames, drive-by fixes (send those separately);
- debug logs, commented-out code, TODOs without an issue;
- new dependencies (check licence and size), new permissions, new network calls;
- hex colours, font file names or a second icon set (use the theme and Pixelarticons);
- a setting without an entry in `utils/settingsIndex.ts`, or one that doesn't reach the code it controls (Rust through `toNativeConfig`, Kotlin through `toGovernance`, or the screen for a display-only setting);
- copy that isn't plain English;
- a change people will notice with no release-notes line;
- anything the spec sheet promised but the diff doesn't contain.

## 8. Open a draft PR and let CI run

Commit messages follow Conventional Commits: `feat(browser): …`, `fix(search): …`, `docs: …`. Push your branch and open a **draft** pull request against `dev`. CI builds the Rust engine and the APKs, and runs the checks. On your first PR, a maintainer may need to approve the workflow run before it starts; that's GitHub's rule for new contributors. Fix anything red before going further.

## 9. Get the APK

Open the CI run from the PR's checks, scroll to **Artifacts**, and download `apks` (kept for 7 days). A pull request into `dev` builds for arm64-v8a only, so it holds two files:
- `app-arm64-v8a-release.apk`;
- `app-universal-release.apk`, which here also holds arm64-v8a code only.

Either one installs on a 64-bit ARM phone or an arm64 emulator. Builds for armeabi-v7a and x86_64 are made only for pull requests into `main` and for releases.

**Before you install:** a pull request from a fork can't read the repository's signing secrets, so its APKs carry a debug key. Release builds carry Maglev's key. Android won't install one over the other, so remove an installed release build first. Its downloads and settings go with it unless you back them up (Settings → Backup and restore). An emulator, or a second user on the phone, avoids this.

## 10. Test it on a real device

Install with `adb install -r <file>.apk`, or open the file on the phone. Then:

1. **Run the device steps from step 4**, one per path TLC found. Each rule should hold.
2. **Run the standard set**, the parts that apply to your change:
   - Android closes Maglev in the background: press Home, run `adb shell am kill com.maglev`, then reopen.
   - No network, or a metered network.
   - Android's largest font size (Android Settings → Display → Font size).
   - A permission denied, then granted from the recovery path.
   - The screen in each of Maglev's font styles (Clean, Retro, Mono, in Maglev's Settings → Interface), if you changed one.
3. Note the phone model and Android version.

## 11. Post the evidence

In the PR description (the template has the sections):
- **Rules this keeps**, with the link to the model;
- **How a reviewer can check it:** the commands with their output, and the device steps, numbered, so anyone can repeat them;
- **Screens:** before and after screenshots, or a short recording for anything that moves. A screenshot: `adb exec-out screencap -p > shot.png`. A recording: `adb shell screenrecord /sdcard/clip.mp4`, stopped with Ctrl+C or after its 3-minute limit, then `adb pull /sdcard/clip.mp4`.

The **PR evidence** check reads these sections on every pull request and warns when one is empty (details in [testing.md](testing.md#the-pr-evidence-check)). It never blocks the merge; it saves the reviewer from asking.

## 12. Ask for review

Bring the branch up to date with `dev` first (merge or rebase onto `origin/dev`) and let CI run green again. Then mark the PR ready for review. The reviewer replays your steps, reads the model and the diff, and may try to break it. When you change something after review, repeat steps 6 to 11 for the part you changed. The maintainer merges into `dev`, and releases go out from `main`.

## Who checks what

| Check | Who | When |
|---|---|---|
| The rules hold in every state the model reaches | TLC (`npm run models`), you and CI | Steps 4, 6, 8 |
| The code matches the model | You (action-to-code table), then the reviewer | Steps 5, 12 |
| The code compiles and every existing check passes | You, then CI | Steps 6, 8 |
| The change works on a real phone | You, then the reviewer by replaying your steps | Steps 10, 12 |
| The change belongs in Maglev | The maintainer | Steps 0, 12 |
