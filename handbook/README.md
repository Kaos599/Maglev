# Maglev handbook

How Maglev works and how to change it. Start with the page that matches what you're doing.

| You want to | Read |
|---|---|
| Send a first pull request | [CONTRIBUTING.md](../CONTRIBUTING.md), then [contributing-well.md](contributing-well.md) |
| Understand the app's layers and how a download flows | [architecture.md](architecture.md) |
| Change anything that crosses TS ⇄ Kotlin ⇄ Rust | [engine-boundary.md](engine-boundary.md) (change it first) |
| Add a feature, or change how one moves between states | [state-machines.md](state-machines.md) and [specs/](../specs/) |
| Find where a feature lives, its states, and whether it has a model | [feature-map.md](feature-map.md) |
| Run the checks, or understand one that failed | [testing.md](testing.md) |
| Build a screen | [DESIGN.md](../DESIGN.md) |
| Cut a release, bump a version, or understand signing | [maintaining.md](maintaining.md) |
| Know what a label on an issue means | [labels.md](labels.md) |

## The short version

1. Open an issue first for anything bigger than a bug fix, and wait for `approved`.
2. If the change moves a feature between states, write or update its model in `specs/` and run `npm run models`.
3. Keep the PR small, plain and checkable: name the rules it keeps, and give a reviewer the commands and phone steps to confirm them.
4. Run `npm run check` and `npx tsc --noEmit` before you push.
