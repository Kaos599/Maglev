#!/usr/bin/env node
// The Bookmarks screen: a full list with search, reached from the browser page menu and from "See all" on the start page.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const exists = (p) => fs.existsSync(path.join(__dirname, '..', p));
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
function load(file, extra = {}) {
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: (n) => extra[n] ?? require(n), Promise }, { filename: file });
  return mod.exports;
}

// 1. The filter, run for real.
const { filterBookmarks } = load('utils/browser/bookmarks.ts', {
  react: { useSyncExternalStore: () => [] },
  '../prefs/kv.ts': { kvGet: () => null, kvSet: () => {} },
});
check('filterBookmarks is exported', typeof filterBookmarks === 'function');
const mk = (id, title, url) => ({ id, title, url, host: new URL(url).host, addedAt: 0 });
const list = [
  mk('1', 'Ubuntu ISO', 'https://releases.ubuntu.com/24.04/'),
  mk('2', 'Blender', 'https://www.blender.org/download'),
  mk('3', 'Arch Wiki', 'https://wiki.archlinux.org/title/Installation_guide'),
];
const f = (q) => (typeof filterBookmarks === 'function' ? filterBookmarks(list, q).map((b) => b.id).join(',') : 'missing');
check('empty query keeps everything in stored order', f('') === '1,2,3');
check('whitespace-only query keeps everything', f('   ') === '1,2,3');
check('matches the title, ignoring case', f('BLEND') === '2');
check('matches the host', f('archlinux') === '3');
check('matches the address path', f('installation') === '3');
check('trims the query', f('  ubuntu ') === '1');
check('no match gives an empty list', f('zzz') === '');
check('keeps stored order for several matches', f('.org') === '2,3');

// 2. Route and screen.
check('screen file exists', exists('app/browser-bookmarks.tsx'));
const screen = exists('app/browser-bookmarks.tsx') ? read('app/browser-bookmarks.tsx') : '';
const layout = read('app/_layout.tsx');
check('route registered next to browser-history', /<Stack\.Screen name="browser-history" \/>\s*<Stack\.Screen name="browser-bookmarks" \/>/.test(layout));
check('uses useBookmarks and filterBookmarks', /useBookmarks\(/.test(screen) && /filterBookmarks\(/.test(screen));
check('has a search TextField', /<TextField/.test(screen) && /searchPlaceholder/.test(screen));
check('empty state uses bookmarkCopy.empty', /EmptyBlock/.test(screen) && /bookmarkCopy\.empty/.test(screen));
check('no-results state has its own copy', /bookmarkCopy\.noResults/.test(screen));
check('tap opens through openBrowser with dismissTo', /openBrowser\(router,[^)]*'dismissTo'\)/.test(screen));
check('long-press opens the menu', /onLongPress/.test(screen));
check('trailing menu IconButton has an accessibilityLabel', /<IconButton[\s\S]*?accessibilityLabel=\{bookmarkCopy\.moreLabel/.test(screen));
check('menu offers new tab, rename, remove from bookmarkCopy.menu', /M\.openNewTab/.test(screen) && /M\.rename/.test(screen) && /M\.remove/.test(screen));
check('remove goes through removeWithUndo', /removeWithUndo\(/.test(screen));
check('rename opens BookmarkSheet', /<BookmarkSheet/.test(screen));
const minHeights = [...screen.matchAll(/minHeight:\s*(\d+|touch\.min)/g)].map((m) => (m[1] === 'touch.min' ? 44 : Number(m[1])));
check('row is at least 44 px tall', minHeights.length > 0 && minHeights.every((n) => n >= 44));
check('no hex colours in the screen', !/#[0-9a-fA-F]{3,8}\b/.test(screen));

// 3. Page menu.
const browser = read('app/browser.tsx');
const bm = browser.indexOf("router.push('/browser-bookmarks')");
const hist = browser.indexOf("router.push('/browser-history')");
check('page menu pushes /browser-bookmarks', bm > 0);
check('Bookmarks row comes before the History row', bm > 0 && hist > bm);
check('Bookmarks row uses the bookmark icon and menuRow copy', /icon="bookmark"\s+title=\{bookmarkCopy\.menuRow\}/.test(browser));
check('Bookmarks row sits outside the page-only block', (() => {
  const row = browser.indexOf('bookmarkCopy.menuRow');
  const pageOnlyEnd = browser.indexOf(') : null}', browser.indexOf('<BookmarkToggle'));
  return row > pageOnlyEnd;
})());

// 4. Start page.
const start = read('components/browser/StartPage.tsx');
check('start page caps tiles at 8', /START_BOOKMARK_LIMIT\s*=\s*8/.test(start) && /bookmarks\.slice\(0,\s*START_BOOKMARK_LIMIT\)/.test(start));
check('See all link goes to /browser-bookmarks', /router\.push\('\/browser-bookmarks'\)/.test(start));
check('See all shows whenever there is a bookmark', /bookmarks\.length\s*>\s*0\s*\?\s*\(\s*<PressableScale[\s\S]{0,200}browser-bookmarks/.test(start) && !/bookmarks\.length\s*>\s*START_BOOKMARK_LIMIT/.test(start));
check('See all has its own label', /bookmarkCopy\.seeAllBookmarksLabel/.test(start));

// 5. Copy.
const copy = read('constants/bookmarkCopy.ts');
for (const k of ['screenTitle', 'menuRow', 'searchPlaceholder', 'noResults', 'seeAllBookmarksLabel', 'moreLabel']) check(`bookmarkCopy.${k}`, new RegExp(`\\b${k}\\b`).test(copy));

// 6. Move to top, Settings row, saved-state icon.
check('copy has Move to top', /moveToTop:\s*'Move to top'/.test(copy));
check('Bookmarks screen offers Move to top, hidden for the first', /M\.moveToTop/.test(screen) && /moveBookmark\(\w+\.id, 0\)/.test(screen) && /bookmarks\[0\]\?\.id !== /.test(screen));
check('Start page offers Move to top, hidden for the first', /M\.moveToTop/.test(start) && /moveBookmark\(target\.id, 0\)/.test(start) && /bookmarks\[0\]\?\.id !== /.test(start));
const sb = read('app/settings/browser.tsx');
check('Settings has a Bookmarks row to /browser-bookmarks', /title=\{bookmarkCopy\.screenTitle\}[\s\S]{0,120}router\.push\('\/browser-bookmarks'\)/.test(sb));
const idx = read('utils/settingsIndex.ts');
check('settings index has the Bookmarks row', /"browser-open-bookmarks",\s*"Bookmarks"/.test(idx));
check('address bar shows a Bookmarked indicator that opens the sheet', /findBookmark\(bookmarks, page\.url\)/.test(browser) && /accessibilityLabel=\{bookmarkCopy\.savedIndicator\}/.test(browser) && /<BookmarkSheet/.test(browser));
check('indicator copy', /savedIndicator:\s*'Bookmarked'/.test(copy));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nbookmarks screen: all checks passed');
