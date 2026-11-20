#!/usr/bin/env node
// Bookmarks: pure logic, persistence, frequent sites, and source checks on the start page and sheet. Needs Node 22.18+.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  const B = await import('../utils/browser/bookmarks.ts');
  const F = await import('../utils/browser/frequentSites.ts');
  const kv = await import('../utils/prefs/kv.ts');

  console.log('[normalise]');
  check('case, fragment and bare slash ignored', B.normalizeUrl('HTTPS://Example.com/#top') === B.normalizeUrl('https://example.com'));
  check('query and path kept', B.normalizeUrl('https://a.com/x?y=1') !== B.normalizeUrl('https://a.com/x'));
  check('non-web gives empty', B.normalizeUrl('magnet:?xt=1') === '' && B.normalizeUrl('javascript:1') === '' && B.normalizeUrl('') === '');

  console.log('[logic]');
  let l = [];
  const a = B.addTo(l, 'https://a.com/', 'Alpha', 1, 'a');
  check('add', a.reason === 'added' && a.list.length === 1 && a.added.host === 'a.com');
  l = a.list;
  check('dedupe by normalised address', B.addTo(l, 'https://A.com', 'x', 2, 'z').reason === 'exists');
  check('invalid refused', B.addTo(l, 'about:blank', 'x', 2, 'z').reason === 'invalid');
  check('blank title falls back to host', B.addTo(l, 'https://b.com/p', '  ', 2, 'b').added.title === 'b.com');
  l = B.addTo(l, 'https://b.com/p', 'Beta', 2, 'b').list;
  l = B.addTo(l, 'https://c.com/', 'Gamma', 3, 'c').list;
  check('isBookmarkedIn', B.isBookmarkedIn(l, 'https://b.com/p#x') && !B.isBookmarkedIn(l, 'https://b.com/q'));
  check('rename', B.renameIn(l, 'a', 'New')[0].title === 'New' && B.renameIn(l, 'a', ' ')[0].title === 'a.com');
  check('move to front and end', B.moveIn(l, 'c', 0).map((x) => x.id).join() === 'c,a,b' && B.moveIn(l, 'a', 99).map((x) => x.id).join() === 'b,c,a');
  check('move unknown id changes nothing', B.moveIn(l, 'nope', 0).map((x) => x.id).join() === 'a,b,c');
  const without = B.removeFrom(l, 'b');
  check('remove', without.map((x) => x.id).join() === 'a,c');
  check('restore puts it back in place', B.restoreIn(without, l[1], 1).map((x) => x.id).join() === 'a,b,c');
  check('restore skips a page saved again meanwhile', B.restoreIn(B.addTo(without, 'https://b.com/p', 'again', 9, 'b2').list, l[1], 1).length === 3);
  let big = [];
  for (let i = 0; i < B.BOOKMARK_CAP; i++) big = B.addTo(big, `https://s${i}.com/`, 't', i, `i${i}`).list;
  check('cap', big.length === B.BOOKMARK_CAP && B.addTo(big, 'https://over.com/', 't', 1, 'o').reason === 'full');

  console.log('[parse]');
  check('corrupt JSON gives []', B.parseBookmarks('{nope').length === 0 && B.parseBookmarks('{"a":1}').length === 0 && B.parseBookmarks(null).length === 0);
  const messy = JSON.stringify([{ id: 'x', url: 'https://x.com', title: 'X', addedAt: 1 }, { id: 'y', url: 'https://X.com/' }, { url: 'https://z.com' }, 5, { id: 'w', url: 'ftp://w.com' }]);
  const parsed = B.parseBookmarks(messy);
  check('keeps good rows, drops bad and duplicate ones', parsed.length === 1 && parsed[0].id === 'x');

  console.log('[store]');
  kv.kvSet(B.BOOKMARKS_KEY, '{garbage');
  B.resetBookmarksCache();
  check('store starts empty on corrupt kv', B.listBookmarks().length === 0);
  const r1 = B.addBookmark('https://one.com/', 'One', 10);
  B.addBookmark('https://two.com/', 'Two', 11);
  check('addBookmark persists to kv', JSON.parse(kv.kvGet(B.BOOKMARKS_KEY)).length === 2 && r1.reason === 'added');
  B.resetBookmarksCache();
  check('reload reads back', B.listBookmarks().length === 2 && B.isBookmarked('https://ONE.com'));
  const removed = B.removeBookmarkByUrl('https://one.com');
  check('removeBookmarkByUrl returns index for Undo', removed && removed.index === 0 && B.listBookmarks().length === 1);
  B.restoreBookmark(removed.bookmark, removed.index);
  check('restoreBookmark', B.listBookmarks()[0].url === 'https://one.com/');
  B.renameBookmark(B.listBookmarks()[0].id, 'Uno');
  check('renameBookmark persists', JSON.parse(kv.kvGet(B.BOOKMARKS_KEY))[0].title === 'Uno');
  B.moveBookmark(B.listBookmarks()[0].id, 1);
  check('moveBookmark persists', JSON.parse(kv.kvGet(B.BOOKMARKS_KEY))[1].title === 'Uno');

  console.log('[merge]');
  const bm = (id, url, title = 't', addedAt = 1) => ({ id, url, title, host: 'h', addedAt });
  const have = [bm('a', 'https://a.com/'), bm('b', 'https://b.com/p')];
  const m1 = B.mergeBookmarks(have, [bm('x', 'https://B.com/p#frag'), bm('c', 'https://c.com/'), bm('d', 'https://d.com/')]);
  check('merge keeps existing order, appends new ones, skips a duplicate address', m1.map((x) => x.id).join() === 'a,b,c,d');
  check('merge with nothing new returns the same rows', B.mergeBookmarks(have, have).length === 2 && B.mergeBookmarks(have, []).length === 2);
  check('merge into empty keeps incoming order', B.mergeBookmarks([], [bm('q', 'https://q.com'), bm('r', 'https://r.com')]).map((x) => x.id).join() === 'q,r');
  check('merge drops corrupt rows', B.mergeBookmarks(have, [5, null, { id: 'n', url: 'ftp://n.com' }, { url: 'https://nid.com' }, bm('ok', 'https://ok.com')]).map((x) => x.id).join() === 'a,b,ok');
  check('merge of a non-array changes nothing', B.mergeBookmarks(have, { a: 1 }).length === 2 && B.mergeBookmarks(have, 'x').length === 2);
  check('merge dedupes inside the incoming list', B.mergeBookmarks([], [bm('1', 'https://z.com'), bm('2', 'https://Z.com/')]).length === 1);
  check('merge gives a clashing id a new one', (() => { const r = B.mergeBookmarks(have, [bm('a', 'https://other.com')]); return r.length === 3 && new Set(r.map((x) => x.id)).size === 3; })());
  const nearFull = [];
  for (let i = 0; i < B.BOOKMARK_CAP - 1; i++) nearFull.push(bm(`e${i}`, `https://e${i}.com/`));
  const capped = B.mergeBookmarks(nearFull, [bm('n1', 'https://n1.com'), bm('n2', 'https://n2.com')]);
  check('merge respects the cap, existing first', capped.length === B.BOOKMARK_CAP && capped[B.BOOKMARK_CAP - 1].id === 'n1' && !capped.some((x) => x.id === 'n2'));
  check('merge does not change its inputs', have.length === 2 && nearFull.length === B.BOOKMARK_CAP - 1);
  kv.kvSet(B.BOOKMARKS_KEY, JSON.stringify([bm('k1', 'https://k1.com/')]));
  B.resetBookmarksCache();
  let notified = 0;
  const unsub = B.subscribeBookmarks(() => { notified++; });
  check('importBookmarks returns how many were added', B.importBookmarks([bm('k1', 'https://k1.com'), bm('k2', 'https://k2.com/')]) === 1);
  check('importBookmarks updates the cache, kv and listeners', B.listBookmarks().length === 2 && JSON.parse(kv.kvGet(B.BOOKMARKS_KEY)).length === 2 && notified === 1);
  check('importing the same list again adds nothing and stays quiet', B.importBookmarks(B.listBookmarks()) === 0 && notified === 1);
  unsub();

  console.log('[frequent]');
  const rows = [
    { url: 'https://www.a.com/x', host: 'www.a.com', visits: 3 },
    { url: 'https://a.com/', host: 'a.com', visits: 4 },
    { url: 'http://b.com/p', host: 'b.com', visits: 9 },
    { url: 'https://c.com/', host: 'c.com', visits: 1 },
    { url: 'magnet:?x', host: 'm', visits: 50 },
  ];
  const f = F.frequentSites(rows, 8, 2);
  check('www merged, sorted by visits, singletons and non-web dropped', f.map((s) => `${s.host}:${s.visits}`).join() === 'b.com:9,a.com:7');
  check('tile goes to the front page on the top page scheme', f[0].url === 'http://b.com/' && f[1].url === 'https://a.com/');
  check('limit', F.frequentSites(rows, 1, 1).length === 1);

  console.log('[source]');
  const start = read('components/browser/StartPage.tsx');
  const sheet = read('components/browser/BookmarkSheet.tsx');
  const toggle = read('components/browser/BookmarkToggle.tsx');
  const actions = read('components/browser/bookmarkActions.ts');
  const all = { start, sheet, toggle, actions, store: read('utils/browser/bookmarks.ts') };
  check('no hex or rgb colours', !Object.values(all).some((s) => /['"`]#[0-9a-fA-F]{3,8}['"`]|['"`]\s*rgba?\(/.test(s)));
  check('no raw TextInput, no raw fontSize numbers', !/<TextInput|from 'react-native'[^;]*TextInput/.test(sheet) && !Object.values(all).some((s) => /fontSize:\s*\d/.test(s)));
  check('sheet uses TextField and Sheet', /<TextField/.test(sheet) && /<Sheet\b/.test(sheet));
  check('tiles and rows are 44px or more', /touch\.min/.test(start) && /minHeight:\s*56/.test(start));
  check('remove offers Undo through the notice', /actionLabel/.test(actions) && /restoreBookmark/.test(actions) && /removeWithUndo/.test(start) && /removeWithUndo/.test(toggle));
  check('privateMode hides frequent sites and recent pages', /privateMode \? \[\]/.test(start) && /prefs\.saveHistory && !privateMode/.test(start));
  check('start page has no network or favicon fetch', !/fetch\(|Image\b|uri:/.test(start));
  check('long-press menu: new tab, rename, remove', /openNewTab/.test(start) && /M\.rename/.test(start) && /M\.remove/.test(start) && /onLongPress/.test(start));
  check('toggle swaps its label', /saved \? c\.remove : c\.add/.test(toggle));
  const icons = read('components/icons.generated.ts');
  check('bookmark icon exists', /"?bookmark"?:\s*"/.test(icons));
  const fmt = read('utils/backup/format.ts');
  check('bookmarks travel in the backup (the user\'s own choices), history does not', /bookmarks: 'maglev\.browser\.bookmarks\.v1'/.test(fmt) && !/history/i.test(fmt.replace(/Browsing history[^\n]*/g, '')));
  check('backup restore merges bookmarks through the store', /importBookmarks/.test(read('utils/backup/io.ts')));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
