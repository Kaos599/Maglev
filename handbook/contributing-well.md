# Contributing well

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the mechanics: open an issue, set up, branch, run the checks. This page is about the pull request itself: what makes one easy to merge, what gets one closed, and how to write it so that anyone can check it. The whole build-and-verify process, from spec sheet to device test, is in [verifying.md](verifying.md).

"Anyone" means the maintainer, another contributor, or an AI agent asked to review the change. None of them can see your phone or know what you tried. A pull request has to carry its own proof: the rules it keeps, the commands that show it works, and steps someone else can repeat. If a reviewer has to guess, the review stalls.

## A good contribution

- **It starts from an approved issue.** Features, new settings, new search sources, redesigns and refactors need an issue with the `approved` label before code. Bug fixes can go straight to a pull request. See [labels](labels.md).
- **It's small and does one thing.** A fix and a reformat of 30 files are two pull requests. So are a bug fix and the feature you noticed while making it. Small pull requests get reviewed fastest.
- **It fixes the cause.** "Lower qualities sometimes show bigger sizes, so I hide sizes that look out of order" treats a symptom. "The wrong size came from `tbr × duration`, and this site reports the encoder's peak bitrate, so I read `filesize` first and show — when it's missing" fixes the cause. It says which field was wrong and how you know.
- **Copy is plain English.** "Waiting for Wi-Fi", not "Network policy gate". No raw hashes on normal screens. [DESIGN.md](../DESIGN.md) has the voice rules.
- **Colours, fonts and icons come from the theme.** `useTheme()`, `type.heading`, `type.body`, `type.mono`, and Pixelarticons through `components/PixelIcon.tsx`. Touch targets are at least 44 × 44.
- **Every setting does something.** A new setting is saved, reaches the code it controls (Rust through `toNativeConfig`, Kotlin through `toGovernance`, or the screen itself), and has an entry in `utils/settingsIndex.ts` so search finds it. [The engine boundary](engine-boundary.md) shows the round trip.
- **State changes come with a model.** A new feature, or a fix that changes how something moves between states (a download pausing and resuming, a share handing off to the app, an update installing), updates its model in `specs/<feature>/`. A bug fix adds a `.cfg` that fails on the old design. [State machines](state-machines.md) explains why and walks you through a model in about 100 lines. Layout, copy and pure functions need no model.
- **A reviewer can check every claim.** See the next section.

## How to make a pull request verifiable

The full process, step by step, is in [verifying.md](verifying.md). This section is the short version, with examples.

The [pull request template](../.github/pull_request_template.md) has a section for each of these.

1. **Name the rules it keeps.** Write the things that must stay true after your change, one per line: "A paused download never starts again on its own." A reviewer checks the code against these, not against your intentions. For a state change, link the model and name its invariants instead. The invariants are the rules.
2. **Link the model**, if there is one, and say that `npm run models` passes.
3. **List the checks you ran, with their output.** Paste the lines that matter: the pass count, and the check that covers your change. "Tests pass" on its own can't be checked. [Testing](testing.md) says which checks to run for each part of the app. `npm run check` runs what CI runs, one line per check. Also run `npm run check:refs`, and `npm run models` when you touched a model or a feature's states.
4. **Give steps someone can repeat on a phone.** Numbered, each with what they should see. Name the phone or emulator and the Android version. If the steps need a particular link or file, give it, or say how to get one.
5. **Show anything on screen.** Before and after screenshots, or a short recording. For a bug, put the debug log (Settings → About → Export debug log) under "How a reviewer can check it".

Evidence here is the existing checks plus a run on real data or a device. Don't add new unit-test scripts; if a user flow is worth automating, add a Maestro flow in `.maestro/` ([verifying.md](verifying.md)). Whatever you feed a check or a device, make it something the real site, tracker or Android could produce. A case you made up proves very little.

### Example: the description

The same fix, written two ways. The example is made up, but it's shaped like real reviews here.

**Weak**

> Fixed the Wi-Fi only bug. Downloads now respect the setting properly. Also cleaned up some code in the scheduler.

The reviewer doesn't know which bug, what "properly" means, or why the scheduler changed. "Cleaned up" means unrelated changes are mixed in.

**Strong**

> Closes #123.
>
> **Cause.** With Wi-Fi only on, a link download added while the phone was on mobile data started at once. The network check ran when the engine's state changed, and adding a download doesn't change it, so the new download was never checked.
>
> **Fix.** The check also runs when a download is added. Nothing else in the scheduler changed.
>
> **Rules this keeps**
> - With Wi-Fi only on, no download sends or receives data on mobile data.
> - A download held for Wi-Fi shows "Waiting for Wi-Fi", and starts on its own when Wi-Fi comes back.
> - With Wi-Fi only off, nothing changes.

Each rule is something a reviewer can test, and the cause says which code to read.

### Example: "How a reviewer can check it"

**Weak**

> Tested on my phone, works fine. All tests pass.

**Strong**

> **Commands**
> ```
> $ npm run check
> ...
> PASS  0.4s  test-blocks  Why a transfer is held: one copy table, banner order, overrides, per-item lines.
> ...
> $ npm run check:refs
> No private references in lines added since origin/dev (9f495c5).
> ```
> The device steps below carry the proof for this fix: on `dev`, step 2 shows the download starting on mobile data.
>
> **On a phone** (Pixel 7, Android 15, the CI APK from this PR):
> 1. Settings → Network → turn on Wi-Fi only. Turn Wi-Fi off so the phone is on mobile data.
> 2. Share any direct file link to Maglev and add it. The card shows "Waiting for Wi-Fi", and the speed stays at 0. (On `dev`, the download starts here.)
> 3. Turn Wi-Fi on. Within a few seconds the download starts.
> 4. Turn Wi-Fi only off, turn Wi-Fi off, and add another link. It starts on mobile data.
>
> **Screens:** before and after screenshots of the card in step 2, and a 20-second recording of steps 2 and 3.

Someone with no context can run the commands, follow the steps and see the same thing you did.

## What gets a pull request closed

These come up often enough that they get closed, or sent back, without a full review.

- **A feature with no approved issue.** However good the code is. The issue is where we agree it belongs in the app, before you spend time on it.
- **Fake data.** Hardcoded files, peers, sizes or speeds, or a guess shown as a fact. If the engine doesn't know a value, the app shows "—".
- **A second icon set.** Pixelarticons only.
- **Hex colours outside `constants/`**, or font files named directly. Use the theme.
- **Jargon on screen.** Error codes, raw hashes, "pipeline", "gate", "orchestrator" and the like.
- **Unrelated reformatting.** Whitespace, import order or renames in files the change doesn't need. They hide the real change from the reviewer.
- **Bulk changes with nothing run.** Dozens of files changed by a tool or an AI, with no checks run and no description of what was checked.
- **A toggle that does nothing.** A setting that is saved but never reaches the code it claims to control.
- **New tracking or network calls.** No analytics, ads or tracking libraries, and no requests the user didn't ask for.

## Pull requests written with AI help

They're welcome, on the same terms as any other. You have read every line and can explain why each one is there. The description is yours and its claims are true: if it says a test passes, you ran it; if it says a phone was used, you used one. A change that looks plausible but that nobody checked is the kind that gets closed.

If an AI agent wrote most of the change, say so. That doesn't count against you. It tells the reviewer to read the edge cases more closely.

## When you're stuck

If you can't get real data, can't run something on a phone, or aren't sure the model is right, ask in the issue or the pull request. A half-finished pull request with an honest note about what's missing is easier to help with than a finished-looking one that guesses.
