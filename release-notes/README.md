# Release notes

One file per version, named after `app.json` `expo.version` (for example `0.14.md`, or `1.0.1.md` for a fix release). The release workflow turns it into the GitHub release text, between a fixed intro and the install steps.

A fix release (`1.1.1`) reaches only apps from 1.1 on, because 1.0 and older can't read a tag with a patch number. Those apps read only GitHub's latest release, so a fix release is published without the latest mark and the last `<major>.<minor>` release stays the latest. Apps from 1.1 on read the 20 most recent releases and pick the highest one they can install, so they still get the fix.

The release workflow checks this before it builds. `scripts/check-updater-reach.js` asks the previous release's updater whether it would offer the new tag. For a `<major>.<minor>` release, which becomes the latest, it also asks every older updater that reads only the latest release. If any of them says no, the release stops.

Use any of these sections, in this order, and leave out the ones a release doesn't have:

```
## What's new
## What's changed
## What's fixed
```

Each section is a list of `- ` lines written for people who use the app: what they can do now and where to find it, not how it was built. `node scripts/release-notes.js check` (part of `npm test`) fails if the file for the current version is missing or uses any other heading. `node scripts/release-notes.js draft` lists the commits since the last tag, sorted into the three sections, as a starting point.
