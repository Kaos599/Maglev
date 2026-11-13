#!/usr/bin/env node
// 0.14 UX: Search rows and preview, Feeds focus refresh and "new" markers, plain settings wording.
// Static checks on the sources plus pure helpers. Needs Node 22.18+ (runs TypeScript directly).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

// --- Search: row, badge, preview -----------------------------------------------------------
const row = read('components/search/ResultRow.tsx');
const search = read('app/(tabs)/search.tsx');
check('sharing helper exists', exists('components/search/sharing.ts'));
if (exists('components/search/sharing.ts')) {
  const s = require('../components/search/sharing.ts');
  check('0 seeders reads "No one sharing"', s.sharingBadge(0) === 'No one sharing');
  check('1 seeder is flagged low', typeof s.sharingBadge(1) === 'string' && s.isLowShare(1));
  check('12 seeders has no badge', s.sharingBadge(12) === null && !s.isLowShare(12));
  check('unknown counts are not flagged', s.sharingBadge(undefined) === null && !s.isLowShare(undefined));
  check('plain words: "12 sharing"', s.sharingWords(12, 3) === '12 sharing, 3 downloading');
  check('plain words, no one', /^No one sharing/.test(s.sharingWords(0, 0)));
  check('plain words, unknown', /unknown/i.test(s.sharingWords(undefined, undefined)));
  check('hide-no-one filter drops 0 only', s.passesResultFilter({ seeders: 0 }, { hideDead: true, minBytes: 0 }) === false && s.passesResultFilter({ seeders: 5 }, { hideDead: true, minBytes: 0 }) === true);
  check('hide-no-one keeps unknown counts', s.passesResultFilter({ seeders: undefined }, { hideDead: true, minBytes: 0 }) === true);
  check('min size filter', s.passesResultFilter({ seeders: 5, sizeBytes: 10 }, { hideDead: false, minBytes: 100 }) === false);
}
check('row shows the zero-seeder badge', /sharingBadge/.test(row));
check('row is dimmed for low sharing', /isLowShare/.test(row) && /opacity/.test(row));
check('whole row opens the preview (onOpen)', /onOpen/.test(row) && /Pressable/.test(row));
check('row keeps the quick add', /Add \$\{name\}/.test(row) && /onAdd/.test(row));
check('row label says sharing, not seeds', !/seeds/.test(row.replace(/\/\*[\s\S]*?\*\//g, '')));
check('preview sheet exists', exists('components/search/ResultPreviewSheet.tsx'));
if (exists('components/search/ResultPreviewSheet.tsx')) {
  const p = read('components/search/ResultPreviewSheet.tsx');
  check('preview has Add and Open in browser', /Add/.test(p) && /Open in browser/.test(p));
}
check('search wires the preview', /ResultPreviewSheet/.test(search));
check('added feedback names Transfers with a View action', /Added to Transfers/.test(search) && /actionLabel: 'View'/.test(search));
check('sort labels have no "seeders"', !/Most seeders|Seeders'/.test(search) && /Most shared/.test(search));
check('header filter is labelled Sources', /accessibilityLabel=\{`Sources,/.test(search));
check('sort sheet has a result filter', /Hide no one sharing/.test(search) || /Hide results no one shares/.test(search));
check('search uses oneTapAddNote', /oneTapAddNote/.test(search) && /MobileDataSheet/.test(search));
check('mobile data sheet exists', exists('components/search/MobileDataSheet.tsx'));

// --- Feeds ---------------------------------------------------------------------------------
const feeds = read('app/(tabs)/feeds.tsx');
check('feeds refreshes on focus (throttled)', /useFocusEffect/.test(feeds) && /REFRESH_MIN_MS/.test(feeds) && /2 \* 60/.test(feeds));
check('feeds has no Alert.alert', !/Alert\.alert/.test(feeds) && !/\bAlert\b/.test(feeds));
check('remove feed asks in a sheet', /Sheet/.test(feeds) && /Remove feed\?|Remove \$\{/.test(feeds));
check('leaving the tab no longer marks everything seen', !/Leaving the tab marks everything shown as seen/.test(feeds));
check('Mark all seen exists', /Mark all seen/.test(feeds));
check('opening an item marks it seen', /markSeen/.test(feeds));
check('feeds uses oneTapAddNote', /oneTapAddNote/.test(feeds) && /MobileDataSheet/.test(feeds));

// --- Wording -------------------------------------------------------------------------------
const screen = read('components/ui/Screen.tsx');
check('Screen title is not upper-cased', !/textTransform/.test(screen) && !/toUpperCase/.test(screen));
const settingsDir = path.join(root, 'app/settings');
const caps = [];
for (const f of fs.readdirSync(settingsDir)) {
  const src = fs.readFileSync(path.join(settingsDir, f), 'utf8');
  for (const m of src.matchAll(/SettingsPage title="([^"]+)"/g)) if (m[1] === m[1].toUpperCase() && /[A-Z]{2}/.test(m[1])) caps.push(`${f}: ${m[1]}`);
}
check('settings page titles are sentence case', caps.length === 0, caps.join('; '));
const queue = read('app/settings/queue.tsx');
check('queue: no "Active seeds" / "Seed ratio limit"', !/Active seeds|Seed ratio limit/.test(queue) && /Sharing at once/.test(queue) && /Upload until shared/.test(queue));
const copy = read('constants/copy.ts');
check('copy: empty transfers title', /none: \{ title: 'No transfers yet'/.test(copy));
check('copy: Wi-Fi wait title', /waitingForNetwork: \{ title: 'Waiting for Wi-Fi' \}/.test(copy));

console.log(failed ? `\nux-014 search/feeds: ${failed} failed` : '\nux-014 search/feeds: all passed');
process.exit(failed ? 1 : 0);
