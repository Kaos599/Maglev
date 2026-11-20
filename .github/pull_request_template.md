## What this changes

<!-- One or two sentences. What does the user see differently? -->

Closes #

## Why

<!-- The problem this solves. Features and behaviour changes need an approved issue first (see [CONTRIBUTING.md](https://github.com/Kaos599/Maglev/blob/dev/CONTRIBUTING.md)). -->

## How you tested it

<!-- Phone or emulator, Android version, and what you tried. Screenshots or a short recording for anything on screen. -->

## Checklist

- [ ] Opened against `dev`, not `main`, with Conventional Commit messages (`feat(browser): …`, `fix(search): …`)
- [ ] `npm test` and `npx tsc --noEmit` pass (and `npm run test:search` if you touched search)
- [ ] Colours, fonts and icons come from the theme and Pixelarticons ([DESIGN.md](https://github.com/Kaos599/Maglev/blob/dev/DESIGN.md))
- [ ] Copy is plain English, and every new setting row has an entry in `utils/settingsIndex.ts`
- [ ] Touch targets are at least 44 × 44
- [ ] No tracking, analytics or new network calls the user didn't ask for
