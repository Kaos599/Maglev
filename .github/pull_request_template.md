## What this changes

<!-- One or two sentences. What does the user see differently? -->

Closes #

## Why

<!-- The problem this solves. Features and behaviour changes need an approved issue first (see [CONTRIBUTING.md](https://github.com/Kaos599/Maglev/blob/dev/CONTRIBUTING.md)). For a bug, the cause you found, not only the symptom. -->

## Rules this keeps

<!--
The things that must stay true after this change, one per line, in plain words. A reviewer checks the code against these.
  - A paused download never starts again on its own.
  - Sizes we can't read from the site show "—", never a guess.
If the change moves something between states, link its model instead and name the invariants: specs/<feature>/ (see handbook/state-machines.md).
-->

## How a reviewer can check it

<!--
1. Commands you ran, with the lines of output that matter (pass counts, the failing line before your fix).
2. Steps on a phone that someone else can repeat, each with what they should see.
3. The phone or emulator and Android version you used.
See handbook/contributing-well.md for an example.
-->

## Screens

<!-- Before and after screenshots, or a short recording, for anything on screen. Write "none" if nothing on screen changed. -->

## Checklist

- [ ] Opened against `dev`, not `main`, with Conventional Commit messages (`feat(browser): …`, `fix(search): …`)
- [ ] `npm run check`, `npx tsc --noEmit` and `npm run check:refs` pass, and `npm run models` if you touched a model or a feature's states
- [ ] Colours, fonts and icons come from the theme and Pixelarticons ([DESIGN.md](https://github.com/Kaos599/Maglev/blob/dev/DESIGN.md))
- [ ] Copy is plain English, and every new setting row has an entry in `utils/settingsIndex.ts`
- [ ] Touch targets are at least 44 × 44
- [ ] No tracking, analytics or new network calls the user didn't ask for
- [ ] If this changes how something moves between states, the model in `specs/` is added or updated
