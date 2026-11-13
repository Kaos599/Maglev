#!/usr/bin/env node
// 0.16 additions: Search sources category filter, About first in Settings, Browser tab glyph.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let failed = 0;
const check = (name, ok) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed++;
};

(async () => {
  const { providerCovers } = await import('../utils/search/providerFilter.ts');
  check('filter all shows everything', providerCovers({ categories: ['anime'] }, 'all'));
  check('filter matches a listed category', providerCovers({ categories: ['movies', 'tv'] }, 'tv'));
  check('filter hides a source without the category', !providerCovers({ categories: ['anime'] }, 'books'));
  check('a general source shows under every filter', providerCovers({ categories: ['all'] }, 'games'));

  const sp = read('app/settings/search-providers.tsx');
  check('settings: category chips as a radio group', /accessibilityRole="radiogroup" accessibilityLabel="Show sources for"/.test(sp) && /role="radio"/.test(sp));
  check('settings: On and Off lists are filtered', /shownOn\.map/.test(sp) && /shownOff\.map/.test(sp));
  check('settings: needs-a-check list is not filtered', /checkList\.map/.test(sp) && !/checkList[^\n]*providerCovers/.test(sp));
  check('settings: adult chip only when adult sources are shown', /c !== 'adult' \|\| prefs\.adult/.test(sp));

  const st = read('app/(tabs)/settings.tsx');
  check('About is the first App row', /appRows[^=]*=\s*\[\s*\{[^}]*title: 'About'/.test(st));
  check('scrollbar stays visible', /persistentScrollbar/.test(st));
  check('pill is dismissed by reaching the end, not a nudge', /if \(end && m\.y > 0\) dismissHint\(\)/.test(st) && !/y > 4\) dismissHint/.test(st));

  const layout = read('app/(tabs)/_layout.tsx');
  check('Browser tab uses its animated glyph', /tab\('browse', 'Browser', 'tab-browse'/.test(layout));

  console.log(failed ? `\n${failed} failed` : '\n0.16 more: all passed');
  process.exit(failed ? 1 : 0);
})();
