#!/usr/bin/env node
// Address-bar suggestions: matching bookmarks first (max 3, bookmark icon), history after with duplicates removed,
// bookmarks still shown in private mode (history stays hidden).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
function load(file, extra = {}) {
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: (n) => extra[n] ?? require(n) }, { filename: file });
  return mod.exports;
}

const file = 'components/browser/suggestionMerge.ts';
const exists = fs.existsSync(path.join(__dirname, '..', file));
check('suggestionMerge.ts exists', exists);
if (exists) {
  // Real normalisation from the bookmark store, with its own imports stubbed.
  const normalizeUrl = (url) => {
    const t = (url ?? '').trim();
    const m = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?/i.exec(t);
    if (!m) return '';
    const p = m[3] === '/' ? '' : m[3];
    return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${p}${m[4] ?? ''}`;
  };
  const { mergeSuggestions, MAX_BOOKMARK_SUGGESTIONS } = load(file, { '../../utils/browser/bookmarks': { normalizeUrl } });
  const b = (n, url) => ({ id: `b${n}`, url, title: `B${n}`, host: 'x.test', addedAt: n });
  const h = (url) => ({ url, title: 'H', host: 'x.test' });
  const bm = [b(1, 'https://x.test/a'), b(2, 'https://x.test/b'), b(3, 'https://x.test/c'), b(4, 'https://x.test/d')];
  const out = mergeSuggestions(bm, [h('https://x.test/z')]);
  check('cap is 3', MAX_BOOKMARK_SUGGESTIONS === 3);
  check('at most 3 bookmarks, first, then history', out.length === 4 && out.slice(0, 3).every((r) => r.kind === 'bookmark') && out[3].kind === 'history');
  const dup = mergeSuggestions([b(1, 'https://X.test/a#frag')], [h('https://x.test/a'), h('https://x.test/other')]);
  check('history entry already shown as a bookmark is dropped', dup.length === 2 && dup[1].url === 'https://x.test/other');
  check('bare host with and without slash dedupes', mergeSuggestions([b(1, 'https://x.test/')], [h('https://x.test')]).length === 1);
  check('empty bookmarks passes history through', mergeSuggestions([], [h('https://x.test/q')]).length === 1);
  check('no history keeps bookmarks', mergeSuggestions(bm.slice(0, 1), []).length === 1);
  const six = mergeSuggestions(bm, Array.from({ length: 6 }, (_, i) => h(`https://y.test/${i}`)));
  check('history is not trimmed', six.length === 9);
  check('a bookmark beyond the cap does not hide its history twin', mergeSuggestions(bm, [h('https://x.test/d')]).length === 4);
}

const sugg = read('components/browser/HistorySuggestions.tsx');
check('component uses filterBookmarks and mergeSuggestions', /filterBookmarks\(/.test(sugg) && /mergeSuggestions\(/.test(sugg));
check('bookmark rows use the bookmark PixelIcon', /<PixelIcon name=\{[^}]*'bookmark'/.test(sugg));
check('history is still hidden while private', /prefs\.suggestFromHistory && !prefs\.privateBrowsing/.test(sugg));
check('history is only queried when history is on', /historyOn/.test(sugg) && /suggestHistory\(query, 6\)/.test(sugg));
check('bookmark and history rows share one onPick call', (sugg.match(/onPick\(/g) || []).length === 1);
check('no hex colours', !/#[0-9a-fA-F]{6}\b/.test(sugg));
process.exit(failed ? 1 : 0);
