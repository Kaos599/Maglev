#!/usr/bin/env node
// Search result names: two lines by default, a "Result name lines" setting (1, 2, 3, Full name) that persists
// and applies live, and the full name still reachable from the result preview. Needs Node 22.18+.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const Module = require('module');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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

  console.log('[setting]');
  const prefs = await import('../utils/prefs/search.ts');
  const norm = (raw) => prefs.normalizeSearchPrefs(raw, []).resultNameLines;
  check('default is 2 lines', norm({}) === 2 && norm(null) === 2);
  check('1, 2 and 3 are kept', norm({ resultNameLines: 1 }) === 1 && norm({ resultNameLines: 2 }) === 2 && norm({ resultNameLines: 3 }) === 3);
  check('0 (full name) is kept', norm({ resultNameLines: 0 }) === 0);
  check('junk falls back to 2', norm({ resultNameLines: 7 }) === 2 && norm({ resultNameLines: 'x' }) === 2 && norm({ resultNameLines: -1 }) === 2);
  check('round-trips through update', prefs.updateSearchPrefs({ resultNameLines: 3 }).resultNameLines === 3 && prefs.getSearchPrefs().resultNameLines === 3);

  console.log('\n[result row]');
  const row = read('components/search/ResultRow.tsx');
  check('row reads the pref', /useSearchPrefs/.test(row) && /resultNameLines/.test(row));
  check('name uses it for numberOfLines', /styles\.name[^>]*numberOfLines=\{(?!1\})/.test(row) && !/styles\.name[^>]*numberOfLines=\{1\}/.test(row));
  check('full name means no limit', /resultNameLines\s*(===|!==)\s*0|resultNameLines\s*\|\|\s*undefined/.test(row));
  check('download button stays centred', /alignItems: 'center'/.test(row.slice(row.indexOf('row: {'), row.indexOf('row: {') + 120)));

  console.log('\n[settings screen]');
  const sp = read('app/settings/search-providers.tsx');
  check('settings offers "Result name lines"', /Result name lines/.test(sp) && /resultNameLines/.test(sp));
  check('options 1, 2, 3 and Full name', /value: 1, label: '1'/.test(sp) && /value: 2, label: '2'/.test(sp) && /value: 3, label: '3'/.test(sp) && /value: 0, label: 'Full name'/.test(sp));

  console.log('\n[full name]');
  const sheet = read('components/search/ResultPreviewSheet.tsx');
  const ui = read('components/ui/Sheet.tsx');
  check('preview sheet title is the full name', /title=\{result\?\.name/.test(sheet) && !/numberOfLines/.test(ui.slice(ui.indexOf('styles.title'), ui.indexOf('styles.title') + 200)));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
