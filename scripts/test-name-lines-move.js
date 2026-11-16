#!/usr/bin/env node
// "Result name lines" moved from Settings > Appearance to Settings > Search sources (under "Results").
// Checks the old row is gone, the new section sits after "How search behaves", and the options and pref binding are the same.
// Reads source text only.

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

const iface = read('app/settings/interface.tsx');
const sp = read('app/settings/search-providers.tsx');

// ---- removed from Appearance
check('interface.tsx no longer contains resultNameLines', !iface.includes('resultNameLines'));
check('interface.tsx no longer contains name lines', !/name lines/i.test(iface));
check('interface.tsx no longer defines NAME_LINES', !iface.includes('NAME_LINES'));
check('interface.tsx no longer imports useSearchPrefs', !/useSearchPrefs/.test(iface));

// ---- added to Search sources
check('search-providers.tsx has SectionHeader title="Results"', sp.includes('<SectionHeader title="Results" />'));
check('search-providers.tsx has the Result name lines label', sp.includes('label="Result name lines"'));
check('search-providers.tsx binds resultNameLines', sp.includes('resultNameLines'));
check('search-providers.tsx sets resultNameLines through update', sp.includes('update({ resultNameLines })'));
check('search-providers.tsx has the caption', sp.includes('How many lines a long result name can use in Search.'));
check('search-providers.tsx keeps the page title', sp.includes('title="Search sources"'));

// ---- same options as before
check('options: 1 line', /value: 1, label: '1'/.test(sp));
check('options: 2 lines', /value: 2, label: '2'/.test(sp));
check('options: 3 lines', /value: 3, label: '3'/.test(sp));
check('options: full name is 0', /value: 0, label: 'Full name'/.test(sp));

// ---- placement: Results comes right after How search behaves, and before Show sources for
const howAt = sp.indexOf('<SectionHeader title="How search behaves" />');
const resultsAt = sp.indexOf('<SectionHeader title="Results" />');
const nextAt = sp.indexOf('<SectionHeader title="Show sources for" />');
check('Results follows How search behaves', howAt !== -1 && resultsAt > howAt);
check('Results comes before Show sources for', resultsAt !== -1 && nextAt > resultsAt);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll name lines move checks passed.');
