# Store listing images

Phone screenshots (1080x1920) and the feature graphic (1024x500) for the store listing, built from HTML mock screens.

## Render

```bash
node store/render.js                  # everything, into store/out/
node store/render.js --only search    # one screen and its frame
node store/render.js --out /tmp/x     # somewhere else

# The new set (screens.v2.json): captions on top in Inter ExtraBold, one lime phrase each
node store/render.js --config screens.v2.json   # CANON: new set with Inter screens -> store/out/v2-inter
```

A config can set `out`, `screenFonts` (a `store/fonts/<name>.css` applied to the phone screens only, never the captions), and for each screen its `screen` file and `template`. In a v2 headline, `*phrase*` marks the lime phrase. The v2 screens (`screens/<id>-v2.html`) have the same layout as the current ones with friendlier demo titles. `store/index.html` compares the current set, v2 and v2 with Inter screens.

Output (gitignored):

| File | Size | What |
|---|---|---|
| `store/out/<id>.png` | 1080x1920 | Framed screenshot for the listing |
| `store/out/screens/<id>.png` | 1080x2400 | The bare mock screen |
| `store/out/feature.png` | 1024x500 | Feature graphic |
| `store/out/contact-sheet.png` | | Every image on one page, for review |

The script uses Playwright's Chromium and adds nothing to `package.json`. It looks for `playwright-core` in `node_modules`, then in the npx cache, and otherwise runs `npx --yes playwright-core@1.58.2 --version` once to fetch it. Version 1.58.2 matches the `chromium-1208` build in `~/Library/Caches/ms-playwright`. If you have no browser cached, run `npx --yes playwright-core@1.58.2 install chromium` first. Set `PLAYWRIGHT_CORE=/path/to/playwright-core` to use another copy.

Fonts load from `node_modules/@expo-google-fonts`, so run `npm install` first. The render stops if a font or an icon fails to load.

## Files

- `screens/<id>.html`: one mock screen per listing image, 360x800 dp rendered at 3x. Each copies the layout, sizes and colours of the real screen (the source file is named in the CSS comments).
- `screens/app.css`: tokens and shared components, copied from `constants/theme.ts` and `components/ui`.
- `screens/app.js`: fills in icons, the status bar, the tab bar and the brand mark.
- `screens/icons.js`: generated on every render from `components/icons.generated.ts`. Don't edit it.
- `frames/top.html`, `bottom.html`, `detail.html`: the three layouts around a screen. `detail` shows part of the screen at full size; `focusX` and `focusY` (0 to 1) in `screens.json` pick the part.
- `frames/feature.html`: the feature graphic.
- `screens.json`: which screen goes in which frame, and the copy.

## Rules for the mock screens

The images must show the app as it is.

- Copy layouts and wording from the real screen files. When a screen changes, change its mock to match.
- Show only features that exist in the code. No invented buttons, numbers or badges.
- Keep numbers consistent with the app's formatting (`constants/format.ts`, `utils/rates.ts`): sizes in base 1024, "8 min left" on Transfers, "8m 12s" on the detail screen.
- Demo content is legal and public: Blender open movies (Sintel, Big Buck Bunny, Tears of Steel, Spring, Charge, Wing It!), Linux ISOs, public-domain films from the Internet Archive. No titles that look like piracy and no real people's names.
- Web pages in the browser screens use a made-up site (`openfilms.example`), never a real brand.
- The status bar shows 12:30, Wi-Fi and a full battery.

## Copy

A headline is at most 5 words and a supporting line at most 12. Every claim must match `README.md` and the code. Plain words, no exclamation marks, no "ultimate", "powerful" or "seamless".

| Image | Headline | Supporting line |
|---|---|---|
| transfers | Every download, one list | Torrents and web links side by side, with speed and time left. |
| search | Search 40+ sources at once | Results that point to the same torrent are shown once. |
| browser | Save what the page plays | Ads blocked before they load. Filter found files by type. |
| stream-sheet | Streams saved as one file | Pick the quality and audio language. Maglev joins the pieces. |
| assistant | An assistant that asks first | Optional. It shows every change and waits for you to confirm. |
| detail | Every file, peer and piece | Pick files to fetch first, skip the rest, watch the speed. |
| feeds | Follow feeds, get new releases | Add any RSS feed. New items that match your rules download. |
| feature | (wordmark) | Torrents, links and web video. One small app. |

## Canon

The canonical store set is `screens.v2.json` (six images, Inter captions and Inter on the phone screens, matching
the Clean font style). Committed copies live in `store/images/canon/`; the earlier set is kept in
`store/images/current/` for reference. After changing a screen, render the canon set and copy
`store/out/v2-inter/` over `store/images/canon/`. `store/index.html` compares the two.
