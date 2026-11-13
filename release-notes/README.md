# Release notes

One file per version, named after `app.json` `expo.version` (for example `0.14.md`). The release workflow turns it into the GitHub release text, between a fixed intro and the install steps.

Use any of these sections, in this order, and leave out the ones a release doesn't have:

```
## What's new
## What's changed
## What's fixed
```

Each section is a list of `- ` lines written for people who use the app: what they can do now and where to find it, not how it was built. `node scripts/release-notes.js check` (part of `npm test`) fails if the file for the current version is missing or uses any other heading. `node scripts/release-notes.js draft` lists the commits since the last tag, sorted into the three sections, as a starting point.
