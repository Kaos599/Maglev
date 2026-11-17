#!/usr/bin/env node
// Search > Sort and filter sheet: sections, captions, toggle, footer, and that picking a sort keeps the sheet open.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}

const comp = read('components/search/SortFilterSheet.tsx');
const search = read('app/(tabs)/search.tsx');

for (const [t, c] of [
  ['Most shared', 'Most people sharing first. Usually the fastest.'],
  ['Newest', 'Most recently added first.'],
  ['Largest', 'Biggest files first.'],
  ['Name', 'A to Z.'],
]) {
  check(`sort title "${t}"`, comp.includes(`'${t}'`));
  check(`sort caption "${c}"`, comp.includes(c));
}
for (const s of ['Sort by', 'Source', 'Size']) check(`section label "${s}"`, comp.includes(`title="${s}"`) || comp.includes(`'${s}'`));
check('source caption', comp.includes('Show results from one source.'));
check('size caption', comp.includes('Files of unknown size always show.'));
check('size section uses the range slider', /<RangeSlider\b/.test(comp) && comp.includes('rangeLabel('));
check('size chips are gone', !comp.includes('Over 100 MB') && !comp.includes('MIN_SIZES'));
check('dirty covers the size range', /sizeRange\.low !== 0 \|\| sizeRange\.high !== LAST_STOP/.test(comp));
check('toggle title', comp.includes('Hide torrents no one is sharing'));
check('toggle subtitle', comp.includes('They rarely finish.'));
check('Toggle used', /<Toggle\b/.test(comp));
check('footer count line', comp.includes('Showing ') && comp.includes(' results'));
check('Done button', comp.includes('label="Done"'));
check('Reset button', comp.includes('label="Reset"') && comp.includes('ghost'));
check('Reset only when not default', /showReset|isDirty|dirty/.test(comp));
check('search.tsx resets the size range to full', /setSizeRange\(\{ low: 0, high: SIZE_STOPS\.length - 1 \}\)/.test(search));
check('radiogroup roles', (comp.match(/accessibilityRole="radiogroup"/g) || []).length >= 2);
const sortBlock = (comp.match(/SORT_ORDER\.map[\s\S]*?\n\s+\)\)\}/) || [''])[0];
check('sort block found', sortBlock.length > 20);
check('selecting a sort does not close', !/onClose/.test(sortBlock));
check('sheet passes returnFocusRef', comp.includes('returnFocusRef'));
check('content scrolls', comp.includes('ScrollView'));
check('no hex colours', !/#[0-9a-fA-F]{6}\b/.test(comp));

check('search.tsx renders SortFilterSheet', /<SortFilterSheet\b/.test(search));
check('search.tsx no old inline hide chip', !search.includes('Hide no one sharing'));
check('search.tsx no inline "Sort and filter" Sheet', !/<Sheet[^>]*title="Sort and filter"/.test(search));
// The sheet's hide toggle and Settings > Search sources > Hide dead torrents are one saved setting.
check('sheet hide toggle reads the saved hideDead pref', /const hideNoShare = prefs\.hideDead;/.test(search));
check('sheet hide toggle writes the saved hideDead pref', /updatePrefs\(\{ hideDead \}\)/.test(search));
check('no separate session-only hide state', !/\[hideNoShare, setHideNoShare\] = useState/.test(search));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nall sort-filter checks passed');
