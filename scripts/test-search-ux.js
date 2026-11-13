#!/usr/bin/env node
// 0.15 Search UX: media kinds, long age, the fix line, needs-check prefs, and the wiring of the new Search tab
// and Settings > Search sources. Needs Node 22.18+ (runs TypeScript directly).
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  // Stub the native storage modules so prefs load in Node.
  Module.registerHooks({
    resolve(spec, ctx, next) {
      if (spec === 'expo-sqlite/kv-store' || spec === 'expo-secure-store') return { url: `stub:${spec}`, shortCircuit: true, format: 'commonjs' };
      return next(spec, ctx);
    },
    load(url, ctx, next) {
      if (url.startsWith('stub:')) {
        return { format: 'commonjs', shortCircuit: true, source: 'module.exports = { default: { getItemSync: () => null, setItemSync() {} }, getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} };' };
      }
      return next(url, ctx);
    },
  });

  console.log('[mediaKind]');
  const { mediaKind } = await import('../utils/search/mediaType.ts');
  const k = (name, category) => mediaKind({ name, category });
  check('category movies/tv/anime are video', k('x', 'movies') === 'video' && k('x', 'tv') === 'video' && k('x', 'anime') === 'video');
  check('category music is audio, books is book', k('x', 'music') === 'audio' && k('x', 'books') === 'book');
  check('category apps is app, games is game', k('x', 'apps') === 'app' && k('x', 'games') === 'game');
  check('category beats the name', k('Album.flac', 'movies') === 'video');
  check('category other falls through to the name', k('Some.Show.S01E02.720p', 'other') === 'video');
  check('video: 1080p', k('Movie.2020.1080p.BluRay.x264') === 'video');
  check('video: S01E02 and .mkv', k('Show S01E02') === 'video' && k('clip.mkv') === 'video');
  check('video: WEB-DL, HEVC, 4k', k('A WEB-DL') === 'video' && k('A HEVC') === 'video' && k('A 4k') === 'video');
  check('audio: flac, mp3, discography', k('Band - Album [FLAC]') === 'audio' && k('Song.mp3') === 'audio' && k('Band Discography') === 'audio');
  check('book: epub, pdf, audiobook', k('Book.epub') === 'book' && k('Manual PDF') === 'book' && k('Dune audiobook') === 'book');
  check('app: apk, exe, dmg', k('App.apk') === 'app' && k('setup.exe') === 'app' && k('Tool.dmg') === 'app');
  check('app: linux distro iso', k('ubuntu-24.04-desktop-amd64.iso') === 'app' && k('archlinux-2024.iso') === 'app');
  check('game: repack, fitgirl, gog', k('Game [FitGirl Repack]') === 'game' && k('Game GOG') === 'game' && k('Game-CODEX') === 'game');
  check('archive: zip, rar, 7z', k('stuff.zip') === 'archive' && k('stuff.rar') === 'archive' && k('stuff.7z') === 'archive');
  check('image: jpg, wallpaper', k('photo.jpg') === 'image' && k('4 Wallpaper pack') === 'image');
  check('unknown name is unknown', k('random thing') === 'unknown');

  console.log('\n[age]');
  const meta = await import('../utils/search/age.ts');
  const NOW = Date.UTC(2026, 10, 13);
  const DAY = 86400000;
  check('age long: just now', meta.formatAgeLong(NOW - 30000, NOW) === 'just now');
  check('age long: 2 days ago', meta.formatAgeLong(NOW - 2 * DAY, NOW) === '2 days ago');
  check('age long: 1 day ago (singular)', meta.formatAgeLong(NOW - DAY, NOW) === '1 day ago');
  check('age long: 3 months ago', meta.formatAgeLong(NOW - 95 * DAY, NOW) === '3 months ago');
  check('age long: 1 year ago', meta.formatAgeLong(NOW - 365 * DAY, NOW) === '1 year ago');
  check('age long: 3 hours ago', meta.formatAgeLong(NOW - 3 * 3600000, NOW) === '3 hours ago');
  check('age long: unknown is empty', meta.formatAgeLong(undefined, NOW) === '');

  console.log('\n[fix line]');
  const ans = await import('../utils/search/answered.ts');
  check('hint: nothing to fix hides it', ans.shouldShowFixHint(NOW, 0, 0) === false);
  check('hint: never closed shows it', ans.shouldShowFixHint(NOW, 0, 2) === true);
  check('hint: closed an hour ago hides it', ans.shouldShowFixHint(NOW, NOW - 3600000, 1) === false);
  check('hint: closed 25 hours ago shows it again', ans.shouldShowFixHint(NOW, NOW - 25 * 3600000, 1) === true);
  check('hint: closed exactly 24 hours ago shows it again', ans.shouldShowFixHint(NOW, NOW - DAY, 1) === true);
  const st = (providerId, state) => ({ providerId, state, count: 0, ms: 0 });
  const nn = ans.nextNeedsCheck(['a', 'b'], [st('a', 'done'), st('b', 'timeout'), st('c', 'challenge')]);
  check('needs-check: answered ids leave, challenged ids join, others stay', nn.join() === 'b,c', nn.join());

  console.log('\n[prefs]');
  const prefs = await import('../utils/prefs/search.ts');
  const d = prefs.normalizeSearchPrefs({}, []);
  check('prefs: needsCheck defaults to []', Array.isArray(d.needsCheck) && d.needsCheck.length === 0);
  check('prefs: fixHintDismissedAt defaults to 0', d.fixHintDismissedAt === 0);
  const n = prefs.normalizeSearchPrefs({ needsCheck: ['a', 3, 'a', 'b'], fixHintDismissedAt: 1234 }, []);
  check('prefs: needsCheck keeps unique strings', n.needsCheck.join() === 'a,b');
  check('prefs: fixHintDismissedAt kept', n.fixHintDismissedAt === 1234);
  check('prefs: bad fixHintDismissedAt becomes 0', prefs.normalizeSearchPrefs({ fixHintDismissedAt: 'x' }, []).fixHintDismissedAt === 0);
  prefs.updateSearchPrefs({ recents: ['One', 'two', 'Three'] });
  check('recents: removeRecentSearch drops one, case-insensitively', prefs.removeRecentSearch('TWO').join() === 'One,Three');

  console.log('\n[search tab wiring]');
  const search = read('app/(tabs)/search.tsx');
  const code = strip(search);
  check('search: no SourceScoreboard', !/SourceScoreboard/.test(code) && !exists('components/search/SourceScoreboard.tsx'));
  check('search: no SourcesCard', !/SourcesCard/.test(code) && !exists('components/search/SourcesCard.tsx'));
  check('search: Browser button, labelled, hidden when the Browser tab shows', />\s*Browser\s*</.test(code) && /Open the browser/.test(code) && /useTabPrefs/.test(code) && /'browse'/.test(code));
  check('search: header dot instead of a count badge', /dot=\{/.test(code) && !/badge=\{prefs\.enabled/.test(code));
  const copySrc = read('constants/copy.ts');
  check('search: idle title and body come from copy', /empty\.search\.idle\(enabledCount\)/.test(code) && /sources at once/.test(copySrc) && /Tap the box to see your recent searches\./.test(copySrc));
  check('search: recent dropdown on focus, with remove and Clear', /onFocus/.test(code) && /onBlur/.test(code) && /removeRecentSearch/.test(code) && /Clear/.test(code));
  check('search: one progress line while searching', /Searching… \$\{[^}]+\} of \$\{[^}]+\}/.test(code) && !/sources answered, results appear/.test(code));
  check('search: exactly one Stop button', (code.match(/label="Stop"/g) || []).length === 1);
  check('search: result count line', /'results'/.test(code));
  check('search: source filter lives in the sort sheet', /Source/.test(code) && /sourceFilter/.test(code) && /setSourceFilter/.test(code));
  check('search: fix line copy and actions', /need[s]? a quick check/.test(code) && /They'll add more results\./.test(code) && /Fix/.test(code) && /fixHintDismissedAt/.test(code) && /shouldShowFixHint/.test(code));
  check('search: remembers needsCheck after a search and on solve', /nextNeedsCheck/.test(code) && /needsCheck/.test(code));
  const ib = read('components/ui/IconButton.tsx');
  check('IconButton: dot prop, badge kept', /dot\?: boolean/.test(ib) && /badge\?: number/.test(ib));

  console.log('\n[result row]');
  const row = read('components/search/ResultRow.tsx');
  const rowCode = strip(row);
  const visible = rowCode.replace(/accessibilityLabel=\{[^}]*\}/g, '');
  check('row: media tile via mediaKind', /mediaKind/.test(rowCode) && /file-video/.test(rowCode));
  check('row: no seeding/downloading words on screen', !/>[^<{]*(seeding|downloading)[^<]*</.test(visible));
  check('row: accessibility label spells out seeding, downloading, uploaded and via', /seeding/.test(rowCode) && /downloading/.test(rowCode) && /uploaded \$\{/.test(rowCode) && /via \$\{via\}/.test(rowCode));
  check('row: title is one line', /numberOfLines=\{1\}/.test(rowCode));
  check('row: keeps follow, add, added, risky and dim', /onFollow/.test(rowCode) && /Add \$\{name\}/.test(rowCode) && /, added/.test(rowCode) && /Risky source/.test(rowCode) && /isLowShare/.test(rowCode));

  console.log('\n[settings: search sources]');
  const sp = read('app/settings/search-providers.tsx');
  check('sources: needs-a-check section on top', /Needs a quick check/.test(sp) && /Tap \? to open the site once/.test(sp) && sp.indexOf('Needs a quick check') < sp.indexOf('What sources to show'));
  check('sources: opens the solver and clears the flag on solve', /CloudflareSolverSheet/.test(sp) && /needsCheck/.test(sp));
  const pr = read('components/search-providers/ProviderRow.tsx');
  check('provider row: a ? button', /onCheck/.test(pr) && /\?/.test(pr));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

// The Browser button hides when the Browser tab is shown (it would be a duplicate).
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'app/(tabs)/search.tsx'), 'utf8');
  const ok = /\{!browserTabShown \? \(/.test(src) && /browserTabShown = !tabs\.hidden\.includes\('browse'\)/.test(src);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} header: Browser button hidden while the Browser tab is shown`);
  if (!ok) process.exitCode = 1;
}
