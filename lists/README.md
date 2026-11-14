# Source lists

`sources.json` is the file Maglev checks once a day for search source addresses, on/off switches and warnings, the default trackers and the default ad block list addresses. The format is in `docs/NATIVE_CONTRACT.md` section 31.1.

## Editing

1. Change `sources.json` in a pull request. A provider id that Maglev doesn't know is ignored, and so is a field that fails its check.
2. Raise `serial` (UTC `yyyymmddNN`, for example `2026111402`). An app only applies a file whose serial is higher than the one it already has, so a lower serial never takes effect.
3. Set `generatedAt` to the time of the change.

## Publishing

When the change reaches `main`, `pages.yml` signs the file with the `LISTS_SIGNING_KEY` secret and publishes `sources.json` and `sources.json.sig` under `/lists/` on the site. Without the secret nothing is published. An app drops a file whose signature doesn't verify.
