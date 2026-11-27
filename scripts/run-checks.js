#!/usr/bin/env node
// One command for the checks CI runs on every push: tsc, `npm test` and `npm run test:assistant`.
//
//   node scripts/run-checks.js                  everything CI runs (about two minutes)
//   node scripts/run-checks.js --area search    only the checks for one area (comma list allowed)
//   node scripts/run-checks.js --list           print the areas and what each one runs
//   node scripts/run-checks.js --all            also the checks `npm test` leaves out (search providers, updater, unlisted files)
//   node scripts/run-checks.js --quiet          print only checks that did not pass, plus the summary
//   node scripts/run-checks.js --jobs 8         checks to run at once (default 4)
//
// The list of checks is read from package.json, so a script added to `npm test` is picked up here. A check
// with no row in DESCRIPTIONS below still runs; it shows a placeholder sentence and a warning.
//
// Why this is more than `npm test`: a check can print FAIL and still exit 0 (the reality contracts only
// exit 1 for P0 failures), and a check can skip part of itself when the private design documents are not
// checked out. This runner reads the output as well as the exit code, so both show up.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// name | areas | what it covers. Areas are comma separated; `build` covers config, versions and release plumbing.
const DESCRIPTIONS = `
tsc|all|The whole project type-checks.
test-abi-splits|build|APK splits and the versionCode scheme agree for every ABI.
test-p3-reality-contracts|engine,build|Reality contracts: no simulator in release, permissions, storage, service and persistence rules.
test-feeds|feeds|Feed rules give the same answers as the shared vectors the Kotlin side uses.
test-rates|transfers|Speed smoothing and ETA labels.
test-version|build|bump-version.js writes a version and versionCode that always grow.
test-format|ui|Byte and speed formatters never print undefined or NaN.
test-trackers|torrents|Tracker address rules match the Rust tests.
test-error-actions|engine|Each error code maps to its plain message and its action.
test-admission|downloads|Admission vectors (start, queue or hold a download) match the Kotlin port.
test-remove-files|torrents|Remove files flow, one assertion per transition.
test-tracker-edit|torrents|Tracker edit flow: parsing and each transition.
test-plugins|build|Expo config plugins write the right manifest, backup rules and share intents.
test-share-bulk|downloads|Shared links are parsed into a queue and the bulk summary line reads right.
test-file-health-ui|torrents|File health banner states, their copy, magnet trackers and the one-tap decision.
test-wave2-edge|engine,torrents|A duplicate add merges trackers; the VPN-only rule reaches the engine.
test-mark-motion|ui|The Maglev mark's frames and motion helpers.
test-url-download|downloads|Link parsing, card copy and actions, and the dev simulator's transitions for link downloads.
test-transfer-filters|transfers|Link downloads sit under the right Transfers filter and are counted the same way.
test-transfers-render|transfers|Transfers re-render helpers and the low-space banner.
test-done-actions|transfers|Which file the Open action on a finished download opens.
test-motion|ui|Motion tokens, press scale, sheet drag-to-dismiss limits.
test-search-skeleton|search|Skeleton rows, stable order while sources answer, one background file-list read.
test-follow|feeds|Follow this: result to rule, feed choice, and saving through the real stores.
test-optimistic|transfers|Pause, resume and remove show at once, then settle.
test-tab-glyphs|ui|Each tab icon draws the original icon at rest and every animated track ends at rest.
test-haptics|ui|Every buzz uses a named haptic verb, and none fires without a user action.
test-copy-voice|ui|Every string in constants/copy.ts follows the copy voice, and call sites read from it.
test-font-style|settings,ui|Clean, Retro and Mono map every font slot to a loaded font; the setting persists.
test-browser-contract|browser,engine|Browser Kotlin view, module registration, TS binding and the bundled block list agree.
test-browser-ui|browser|Address bar parsing, browser prefs, found-files tray and screen wiring.
test-browser-found-files|browser|Found-files list: sizes, Clear, remove, reset on navigation, size probe limits.
test-stream-contract|engine,downloads|HLS and DASH saving: JNI names, error codes and the join-before-copy order agree across layers.
test-route-guards|ui|Every route is inside a Stack.Protected block, so a fresh install opens onboarding.
test-onboarding-layout|ui|Onboarding step columns keep their width, so no step renders blank.
test-service-downloads|engine,downloads|The foreground service stays up for link-only downloads after a restart.
test-transfers-ui|transfers|Card status lines, link speed in the header total, clipboard links, mixed selection.
test-add-flow|downloads,ui|Search and Browser are always-shown tiles on the add screens.
test-download-native|downloads,engine|Link download native actions: open folder, completion Open, notification routing.
test-download-gaps|downloads|Open folder everywhere, Saved to row, Clear finished, undo for link removal.
test-add-menu|downloads,ui|Add menu sheet and the add-download rename.
test-ux-014-adds|downloads,ui|One notice host, mobile-data note and folder row in the browser sheets.
test-ux-014-search-feeds|search,feeds|Search rows and preview, Feeds refresh and new markers, plain settings wording.
test-ux-014-transfers|transfers|Resume anyway, Done while seeding, Open on finished cards, one merged list.
test-rules-override|engine,transfers|Resume anyway per item, and seeding on mobile data.
test-feeds-badge|feeds|The Feeds tab badge counts new items and survives a restart.
test-tab-prefs|settings,ui|Which tabs show and in what order.
test-back-to-transfers|ui|Back on any tab goes to Transfers before it closes the app.
test-settings-groups|settings|Settings pages sit in their titled groups, in order.
test-app-icons|settings,build|The 20 launcher icon ids agree across constants, assets and previews.
test-release-notes|build|Release notes sections are ordered, the current version has notes, the release uses them.
test-share-mobile|downloads|Share for finished downloads, and the mobile-data note on add screens.
test-onboarding-motion|ui|Onboarding durations come from motion tokens.
test-ux-015|transfers,ui|Empty Transfers, the star ticket in About, the More-below hint, tab drag.
test-search-ux|search|Media kinds, result age, fix line, needs-check prefs, Search tab wiring.
test-search-title-lines|search,settings|Result name lines setting (1, 2, 3, Full) persists and applies live.
test-a11y-015|ui|TalkBack focus, announcements, roles, tokens and motion in the source.
test-016-more|search,settings|Source category filter, About first in Settings, Browser tab glyph.
test-crash-safety|engine|Local crash log, redaction, report, global handler and route error boundaries.
test-018-bugs|engine|A call made during engine start waits for it; before any start it fails fast; no mock fallback in release.
test-play-storage|downloads|Play while downloading and the low-storage protection rules.
test-backup|settings|Backup and restore modules round-trip the data they own.
test-quick-share|downloads|Quick share card: manifest output, setting round trip, link classification.
test-watch|watch|Watch for a title: matching, new vs seen, schedule, store, notification text, background cycle.
test-manifest-permissions|build|The release manifest declares only permissions Maglev uses on purpose.
test-browser-tray-video-first|browser|Found-files tray shows videos first, with the page title and size sort.
test-browser-found-lifecycle|browser|Found list resets on navigation, native and TypeScript sides.
test-browser-transfers|browser,downloads|Downloads chip and In Transfers tag in the browser.
test-browser-batch|browser,downloads|Batch download from the tray: select, one admission check, cap of 25.
test-browser-saveto|browser,downloads|Save to for one download reaches addDownload and never changes the engine target.
test-browser-history|browser|History store, prefs, wiring and the Kotlin side.
test-browser-tabs|browser|Tab and pop-up state machines, tab persistence, prefs.
test-browser-tabs-ui|browser|Tabs, link menu, pop-up card and settings on the screens.
test-browser-find|browser|Find in page and text size, Kotlin to screens.
test-tab-swipe|browser|Address bar swipe between tabs and its pref.
test-browser-history-ui|browser|History screens are wired to the store.
test-browser-overlay|browser|Browser controls float over the page; download sheets are floating cards.
test-speed-totals|transfers,settings|The speed totals strip is off by default and the setting persists.
test-fdroid-repo|build|The F-Droid repo build is secret-gated, split APKs only, no keys published.
test-update|updates|Updater: tag parsing, asset choice per ABI, the state machine, gates, skipped versions.
test-update-native|updates,engine|Updater Kotlin, manifest and plugin keep their safety rules.
test-lists|engine|Self-updating lists: schema, serial rule, mirrors, gates, trackers, ad list.
test-subtitles|subtitles|File name reading, grouping, zip choice, decoding, naming, settings.
test-lists-native|engine|Signed lists: Kotlin signature check, conditional ad-list requests, TS binding.
test-star-prompt|ui|Star prompt gates, outcomes, prefs and copy.
test-settings-search|settings|Every settings page has index entries, ids are unique, search finds rows.
test-router-hook|ui|The global router is not used before the first render.
test-about-updates|updates,ui|About stays calm; update controls live on the Updates page.
test-sort-filter|search|Sort and filter sheet sections, toggle and footer.
test-size-range|search|Size range stops, labels, max filter and slider accessibility.
test-name-lines-move|search,settings|Result name lines sit under Search sources.
test-download-limit|downloads|Speed limit for one link download: wrapper, sheet mode, row, handler.
test-download-limit-snapshot|downloads|A link download reports its own limit, so the sheet never invents No limit.
test-clipboard-prompt|downloads|Copied-link prompt: copy, Not now persists, toggle gates the read, routing.
test-info-hash|torrents|A bare info hash is accepted as a magnet; hashes inside other text are not.
test-download-parts|downloads|Parts per link download: pref, Settings row, segments sent with every add.
test-auto-retry|downloads|Retry failed downloads automatically: setting, scheduler, codes, rounds.
test-hide-gallery|settings,downloads|Hide downloads from gallery: setting, governance payload, .nomedia.
test-about-extras|ui|Website link, licence page and What's new for the installed version.
test-logo-light|ui|The logo is near-black on light themes and unchanged on dark.
test-settings-regroup|settings|Settings groups, the Downloads page, Power rows, search index in step.
test-whats-new-layout|ui|What's new renders titled sections with one row per change.
test-default-sources|search|Default search sources, and a turned-off source stays off.
test-settings-focus|settings|Tapping a settings search result scrolls to and highlights the row.
test-accents|ui,settings|Eight accent colours reach WCAG contrast in every mode.
test-site-download|build|The website's smart Download button and generated page.
test-peer-timeout|settings,torrents|Stop waiting for peers: setting round trip, row, search entry, Rust wiring.
test-stats|stats|Stats schema, store, recorder, insights, prefs, backup section.
test-stats-screen|stats|Ranges, buckets, streaks and card kit behind the Stats screen.
test-stats-delight|stats|Live active time, daily cap, midnight rollover, old-table migration.
test-download-timing|downloads,engine|Timing and data-use fields pass through types, bridge and dev simulator.
test-private-docs|build|The private-docs helper skips without docs/ and fails loudly on a partial checkout.
test-blocks|transfers,engine|Why a transfer is held: one copy table, banner order, overrides, per-item lines.
test-add-collision|downloads,engine|Wiring for moving old files from a previous install to a numbered folder.
test-swipe|transfers|Swipe actions per row state, the setting and the wiring.
test-resume-held|transfers,torrents|Finished never reads 99%; Resume is not offered for a file-health hold.
test-subtitles-native|subtitles,engine|Subtitle hash, save and unzip across JS, Kotlin and Rust.
test-subtitles-settings|subtitles,settings|Subtitles page wiring, language order, Sources screen.
test-highlights|ui|New-feature highlight: decision, setting, sheet and where it mounts.
test-dialog|ui|The centred Dialog component keeps its source contract.
test-subtitles-flow|subtitles|Subtitle flow in the app: entry rules, hash gate, errors, sheet states.
test-subtitles-batch3|subtitles|Anime subtitle sources parse saved real responses.
test-subtitles-batch5|subtitles|Six subtitle sources parse saved real pages.
test-subtitles-batch1|subtitles|Five subtitle sources parse recorded responses.
test-subtitles-batch2|subtitles|Five more subtitle sources parse saved responses.
test-subtitles-batch4|subtitles|Four subtitle sources parse recorded pages.
test-card-icon|transfers,ui|File-type icon on Transfers cards and its UI-only setting.
test-subtitle-requests|subtitles|Subtitle request outcomes, phase roll-up, retry limit, cap, dedupe.
test-subtitles-row|subtitles,downloads|The Subtitles row on the download page: phases, buttons, when it shows.
test-browser-hardening|browser|No downloads without a tap, Back-hijack guard, HTTPS-first, mining block list.
test-engine-restart|engine|Notification and tile actions start the engine first if Android killed it.
test-settings-coverage|settings|Every settings row has a search entry and every entry has a row.
test-ui-edges|ui|Undo window, search leaving, highlight dialog height, plain launches, light mode edges.
test-added-tray|downloads,browser|The Added message: merge, counts, words, timer, action choice.
test-off-sources|search|No-results hint points to sources that are off, with the right count and words.
test-subtitle-season|subtitles|Subtitles for a season: rows per file, best match rule, bulk save.
test-engine-context|engine,ui|A telemetry tick does not re-render the app; fonts are embedded at build time.
test-power-budget|engine|Lock policy while seeding, background poll rate, key renaming.
test-bundle-slim|build|The mock engine is folded out of release bundles.
test-transfers-hooks|transfers|Transfers screens read only the engine slices they show.
test-stream-headers|engine|Stream downloads send Referer, Origin, user agent and cookies, and Rust applies them to every request.
test-network-change|engine|A default-network change reaches Rust.
test-design-system|ui|Code follows DESIGN.md and DESIGN.md follows code.
test-textfield|ui|The TextField component keeps its source contract.
test-link-refused|downloads,engine|A 403 with no sign-in is "site refused this link", with its copy and action.
test-private-browsing|browser|Private browsing stops history and saved tabs and wipes site cookies on exit.
test-share-tabs|browser,downloads|Share to Find videos opens the Browser tab; a cold link keeps the tabs.
test-bookmarks|browser|Bookmark logic, persistence, frequent sites, start page and sheet.
test-bookmarks-screen|browser|The Bookmarks screen: filter, entry points.
test-bookmark-suggestions|browser|Address bar suggestions: bookmarks first, then history, private mode hides history.
test-browser-open-repeat|browser|Opening the same address twice works; Open in new tab opens a tab.
test-media-hit|browser|Long press on an image or video: payload, URL, menu rows, injected script.
test-window-background|build,ui|The cold-start window colour is Void.
test-page-url|browser,engine|pageUrl types, redirect handling and Kotlin wiring.
test-browser-integration|browser|Start page, bookmark toggle, media long-press, pull to reload, dark pages.
test-032-ui|ui,settings|Per-download folder, downloader wording, torrent internals page, restart banner.
test-engine-restart-apply|engine|restartEngine, blocklist status and VPN rule at start.
test-process-text|downloads|Download with Maglev in the text-selection menu and the Home clipboard chip.
test-debug-log|engine,settings|exportDebugLog across types, bridge, Kotlin, Rust, About row and settings index.
test-page-url-sent|browser,downloads|The page URL is sent with every browser download.
test-search-header-height|search,ui|The N of M sources button stays one line tall.
test-selection-contrast|ui|Selected text reaches 4.5:1 in every theme and accent.
test-video-sites|downloads|Video site detection, quality list, error copy and the parts options shape.
test-assistant-card|assistant|Proposal card state machine, one assertion per transition.
test-assistant-plan|assistant|Plan card state machine, one assertion per transition.
test-assistant-sanitize|assistant|Tool results are sanitised and session handles registered.
test-assistant-sse|assistant|Streamed model replies assemble correctly from recorded fixtures.
test-assistant-prefs|assistant|Provider presets, LAN-only http, migration, key never persisted.
test-assistant-provider|assistant|Provider setup states, copy, and no-ops for unlisted events.
test-assistant-safety|assistant|File-list safety check.
test-assistant-providersave|assistant|A probe that ends after Remove key must not save the key again.
test-assistant-context|assistant|Context builder: caps, token budget, tool pairing, summarise before drop.
test-assistant-release|assistant|Release-name parsing vectors and property tests.
test-assistant-tools|assistant|Tool schemas and argument validation.
test-assistant-prompt|assistant|System prompt structure, order, date, tool list. 2400-token budget.
test-assistant-glossary|assistant|The glossary contract.
test-assistant-playback|assistant|Playback verdicts on recorded probe output.
test-assistant-scoring|assistant|Scoring, size bands and shortlist.
test-assistant-turn|assistant|The chat turn machine: transitions, caps, retry once, card lifecycle, abort.
test-assistant-disk|assistant|Disk-space advice rules and their boundaries.
test-assistant-runner|assistant|Tool runner against fake dependencies.
test-assistant-browse|assistant,search|browse_torrents rules and source fan-out on recorded shapes.
test-assistant-chat|assistant|Chat controller: prompt, provider client, streaming, tool loop.
test-assistant-jargon|assistant|Assistant copy contains no jargon.
test-assistant-chatview|assistant|Chat view helpers.
test-assistant-probe|assistant|The Test model probe and Sign in with OpenRouter helpers.
test-assistant-models|assistant|OpenRouter model list: parse, filter, sort, cache, offline fallback.
test-assistant-capabilities|assistant|What the Assistant can do copy helpers.
test-assistant-017|assistant|Working phase, instant Stop, live step detail, unseen reply.
test-assistant-chat-save|assistant|The chat is saved and restored; an interrupted turn offers Retry.
test-search|search|Search core: parsing, ranking and merging on mocked fetch.
test-search-general|search|General torrent providers parse recorded pages.
test-search-dht|search|DHT and meta providers parse recorded pages.
test-search-anime|search|Anime providers parse recorded captures.
test-search-niche|search|Games, books and regional providers parse recorded pages.
test-search-direct|search|Direct-file results (not torrents).
test-search-outage|search|A 503 is an outage, not a bot check; failed sources are counted and listed.
test-sources-books|search|Gutenberg and LibriVox providers.
test-sources-feeds|search,feeds|ShowRSS, DistroWatch and the trusted-uploader filter.
test-sources-anime-adult-games|search|acgrip and u3c3 providers.
test-ux-027|updates,ui|Add torrent hands a plain web link to Add a link, which runs Get info once.
test-browser-tabs-native|browser,engine|Browser tabs, link menu, pop-ups and redirects in the Kotlin source (not in any npm script).
`.trim().split('\n').reduce((m, l) => {
  const [name, areas, desc] = l.split('|');
  m[name] = { areas: areas.split(','), desc };
  return m;
}, {});

// Output lines that mean a check failed even if the exit code says otherwise. Anchored to the start of the
// line so a passing test that merely mentions the word FAIL does not trip it.
const FAIL_LINE = /^\s*(?:[✗✘❌x]\s*)?(?:FAIL|FAILED|Error:)\b|^\s*❌/;
// Output lines that mean part of a check did not run.
const SKIP_LINE = /^\s*(?:⏭️?\s*)?skip(?:ped)?\b/i;

function chain(script) {
  return (pkg.scripts[script] || '')
    .split('&&')
    .map((s) => s.trim())
    .map((s) => /^node scripts\/(test-[\w-]+)\.js$/.exec(s))
    .filter(Boolean)
    .map((m) => m[1]);
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const inTest = new Set([...chain('test'), ...chain('test:assistant')]);
// Checks outside `npm test`: the search and updater chains, plus any test-*.js that no npm script lists at all.
const listed = new Set(Object.keys(pkg.scripts).flatMap(chain));
const orphans = fs
  .readdirSync(__dirname)
  .map((f) => /^(test-[\w-]+)\.js$/.exec(f))
  .filter(Boolean)
  .map((m) => m[1])
  .filter((n) => !listed.has(n));
const extras = [...new Set([...chain('test:search'), ...chain('test:update'), ...orphans])].filter((n) => !inTest.has(n));
const all = [
  { name: 'tsc', cmd: [process.execPath, path.join(root, 'node_modules/typescript/bin/tsc'), '--noEmit'] },
  ...[...inTest].map((n) => ({ name: n, cmd: [process.execPath, `scripts/${n}.js`] })),
  ...extras.map((n) => ({ name: n, cmd: [process.execPath, `scripts/${n}.js`], extra: true, unlisted: !chain('test:search').includes(n) })),
];
const info = (n) => DESCRIPTIONS[n] || { areas: ['other'], desc: '(no description yet; add one to run-checks.js)' };

const areaSet = new Set(all.flatMap((c) => info(c.name).areas).filter((a) => a !== 'all'));

if (flag('--list')) {
  for (const a of [...areaSet].sort()) {
    const n = all.filter((c) => info(c.name).areas.includes(a)).length;
    console.log(`${a.padEnd(11)} ${n} checks`);
  }
  console.log('\nUse --area <name>[,<name>] to run one. tsc runs in every area run.');
  process.exit(0);
}

const wanted = (value('--area', '') || '').split(',').filter(Boolean);
const unknown = wanted.filter((a) => !areaSet.has(a));
if (unknown.length) {
  console.error(`Unknown area: ${unknown.join(', ')}. Run with --list to see the areas.`);
  process.exit(2);
}
if (flag('--area') && !wanted.length) {
  console.error('--area needs a name. Run with --list to see the areas.');
  process.exit(2);
}

const selected = all.filter((c) => {
  // Outside `npm test`, only the search provider checks join an area run. The rest need --all: they are not run
  // by CI, so a failure there is not caused by the change being tested.
  if (c.unlisted && !flag('--all')) return false;
  if (wanted.length) return c.name === 'tsc' || info(c.name).areas.some((a) => wanted.includes(a));
  return !c.extra || flag('--all');
});

function run(check) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(check.cmd[0], check.cmd.slice(1), { cwd: root, env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => resolve({ check, code: 1, out: String(e), secs: 0 }));
    p.on('close', (code) => resolve({ check, code, out, secs: (Date.now() - t0) / 1000 }));
  });
}

function judge(r) {
  const lines = r.out.split('\n');
  const failLines = lines.filter((l) => FAIL_LINE.test(l));
  const skipLines = lines.filter((l) => SKIP_LINE.test(l));
  if (r.code !== 0) return { status: 'FAIL', note: `exit ${r.code}`, evidence: failLines.length ? failLines : lines.filter(Boolean).slice(-6) };
  // tsc prints errors as "file(1,2): error TS..." and exits non-zero, so exit 0 is enough for it.
  if (failLines.length) return { status: 'FAIL', note: 'exit 0 but printed FAIL', evidence: failLines };
  if (skipLines.length) {
    const first = skipLines[0].trim();
    const note = /docs\//.test(first) ? 'private docs not checked out' : first.replace(/^\S*\s*skip(ped)?:?\s*/i, '').slice(0, 60);
    return { status: 'SKIP', note, evidence: [] };
  }
  return { status: 'PASS', note: '', evidence: [] };
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const jobs = Math.max(1, Number(value('--jobs', Math.min(4, os.cpus().length))) || 4);
  const quiet = flag('--quiet');
  const results = [];

  // test-private-docs makes and removes a docs/ folder. Other checks read that folder, so it runs alone first.
  const alone = selected.filter((c) => c.name === 'test-private-docs');
  const rest = selected.filter((c) => c.name !== 'test-private-docs');
  const width = Math.max(...selected.map((c) => c.name.length));

  const report = (r) => {
    const j = judge(r);
    const row = { ...r, ...j };
    results.push(row);
    if (quiet && j.status === 'PASS') return;
    const note = j.status === 'PASS' ? '' : `  [${j.note}]`;
    console.log(`${pad(j.status, 4)} ${pad(r.secs.toFixed(1) + 's', 6)} ${pad(r.check.name, width)}  ${info(r.check.name).desc}${note}`);
  };

  console.log(`Running ${selected.length} checks${wanted.length ? ` for ${wanted.join(', ')}` : ''}, ${jobs} at a time.\n`);
  const t0 = Date.now();
  for (const c of alone) report(await run(c));
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < rest.length) report(await run(rest[next++]));
    })
  );

  const by = (s) => results.filter((r) => r.status === s);
  const failed = by('FAIL');
  const skipped = by('SKIP');
  const undescribed = selected.filter((c) => !DESCRIPTIONS[c.name]).map((c) => c.name);

  if (failed.length) {
    console.log('\nFailures');
    for (const r of failed) {
      console.log(`\n${r.check.name} (${r.note}), reproduce with: ${r.check.cmd[0] === process.execPath ? 'node ' + r.check.cmd.slice(1).map((a) => path.relative(root, a)).join(' ') : ''}`);
      for (const l of r.evidence.slice(0, 8)) console.log(`  ${l.trim()}`);
    }
  }
  if (skipped.length) {
    console.log(`\n${skipped.length} check(s) skipped part of themselves; their code checks still ran:`);
    for (const r of skipped) console.log(`  ${r.check.name}: ${r.note}`);
  }
  if (undescribed.length) console.log(`\nNo description in run-checks.js for: ${undescribed.join(', ')}`);

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${by('PASS').length} passed, ${skipped.length} skipped, ${failed.length} failed in ${secs}s`);
  process.exit(failed.length ? 1 : 0);
}

main();
