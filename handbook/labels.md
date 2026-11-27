# Labels

Labels say where an issue stands and what part of the app it touches. The maintainer sets the status labels. Anyone can suggest an area label in a comment.

## Status

| Label | Colour | Meaning |
|---|---|---|
| `approved` | `#0E8A16` | The idea fits Maglev. A pull request is welcome, following any notes in the issue. Features need this before code. |
| `needs-model` | `#FBCA04` | To be created. The change moves something between states, so the pull request needs a model in `specs/` first. See [state machines](state-machines.md). |
| `good first issue` | `#7057FF` | Small, well described and in one place. A good way in if you're new to the code. |
| `help wanted` | `#008672` | The maintainer would like someone else to take this. Comment before you start, so two people don't do the same work. |
| `translation` | `#0E8A16` | Translating Maglev into another language. It has this colour on GitHub today, the same as `approved`; the owner may change it. |

`approved` and `needs-model` can both be on one issue. That means the idea is welcome and the model comes first: open a pull request with the spec, agree on it, then write the code.

## Area

None of the area labels exist yet; they are to be created. All of them will share one colour, `#BFD4F2`, so they read as a group.

| Label | Covers |
|---|---|
| `area:browser` | The built-in browser: tabs, pop-up and ad blocking, private browsing, finding files and videos on a page |
| `area:search` | Search and its sources, Feeds, Watches |
| `area:torrents` | Magnet links and torrent files, peers, trackers, seeding |
| `area:downloads` | Link and video-site downloads, the Transfers list, storage and folders |
| `area:settings` | Settings screens, settings search, backup and restore |
| `area:engine` | The Kotlin module and the Rust core under it: the background service, notifications, the bridge between the app and the engine |

## Kind

These already exist and stay as they are.

| Label | Colour | Meaning |
|---|---|---|
| `bug` | `#D73A4A` | Something doesn't work. Set by the bug report form. |
| `enhancement` | `#A2EEEF` | A new feature or a change. Set by the feature request form. |
| `accessibility` | `#F143AB` | A barrier for people with disabilities. |
| `documentation` | `#0075CA` | The README, the handbook or other docs. |
| `question` | `#D876E3` | Needs more information. |
| `duplicate` | `#CFD3D7` | Already reported. The comment links the original. |
| `invalid` | `#E4E669` | Not a bug in Maglev, or not enough to act on. |
| `wontfix` | `#FFFFFF` | Won't be done. The comment says why. |

Dependabot sets `dependencies`, `javascript`, `rust` and `github_actions` on its own pull requests.
