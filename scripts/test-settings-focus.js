#!/usr/bin/env node
// Settings search focus: tapping a result opens the page scrolled to that row, with a brief highlight.
// Needs Node 22.18+ (imports the TypeScript source via type stripping).
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
  const f = await import(path.join(root, 'components/settings/settingsFocusMatch.ts')).catch(() => null);
  const m = f && f.pickAnchor;
  check('settingsFocusMatch exports pickAnchor', typeof m === 'function');
  if (m) {
    const keys = [f.rowKey('Max active downloads'), f.sectionKey('Adding downloads'), f.rowKey('Other')];
    check('row title wins', m({ title: 'Max active downloads', section: 'Adding downloads' }, keys) === f.rowKey('Max active downloads'));
    check('match ignores case and spacing', m({ title: '  max ACTIVE  downloads ' }, keys) === keys[0]);
    check('falls back to section', m({ title: 'Missing', section: 'Adding downloads' }, keys) === f.sectionKey('Adding downloads'));
    check('none when nothing matches', m({ title: 'Missing', section: 'Nope' }, keys) === null);
    check('none when no section and no row', m({ title: 'Missing' }, keys) === null);
  }

  const search = read('components/settings/SettingsSearch.tsx');
  check('SettingsSearch passes the entry id as focus', /params:\s*\{\s*focus:\s*entry\.id\s*\}/.test(search));

  const parts = read('components/settings/SettingsParts.tsx');
  check('SettingsPage reads focus param', /useLocalSearchParams/.test(parts) && /focus/.test(parts));
  check('SettingsPage scrolls', /scrollTo\(/.test(parts) && /measureLayout/.test(read('components/settings/settingsFocus.tsx')));
  check('SettingsPage clears the param after use', /setParams\(\s*\{\s*focus:\s*undefined/.test(parts));
  check('SettingsPage looks the entry up in the index', /SETTINGS_INDEX/.test(parts));
  check('ChipGroup registers by label', /FocusAnchor[^>]*rowKey\(label\)|FocusAnchor[^>]*anchorKey=\{rowKey\(label\)\}/.test(parts));

  check('ListRow registers by title', /FocusAnchor/.test(read('components/ui/ListRow.tsx')) && /rowKey\(props\.title\)/.test(read('components/ui/ListRow.tsx')));
  check('SectionHeader registers by title', /FocusAnchor/.test(read('components/ui/SectionHeader.tsx')) && /sectionKey\(title\)/.test(read('components/ui/SectionHeader.tsx')));

  const ctx = read('components/settings/settingsFocus.tsx');
  check('anchor is a no-op outside a focus context', /if \(!ctx\) return <>\{children\}<\/>/.test(ctx));
  check('reduce-motion skips the fade and the animated scroll', /useReduceMotion/.test(ctx) && /go\(Math\.max\(0, y - 16\), !r\)/.test(ctx));
  check('highlight fades in about 1.2 s', /1200/.test(ctx));
  check('highlight uses theme colours only', /useTheme\(\)/.test(ctx) && !/#[0-9a-fA-F]{3,8}\b/.test(ctx));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nsettings focus: all checks passed');
})();
