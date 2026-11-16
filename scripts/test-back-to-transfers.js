#!/usr/bin/env node
// Issue #77: Android Back on any other tab goes to Transfers instead of closing the app.
// Source contract: the tabs layout registers a hardwareBackPress handler while the tab bar is focused.
// It sends any tab other than "index" (Transfers) to Transfers by name and lets Transfers fall through.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
const layout = fs.readFileSync(path.join(root, 'app/(tabs)/_layout.tsx'), 'utf8');
const handler = layout.slice(layout.indexOf('useFocusEffect('), layout.indexOf('<Tabs\n', layout.indexOf('useFocusEffect(')));
check('Back handler is registered only while the tab bar is focused', /useFocusEffect\(\s*useCallback\(/.test(handler) && /addEventListener\('hardwareBackPress'/.test(handler) && /sub\.remove\(\)/.test(handler));
check('a tab other than Transfers goes to Transfers by name', /open\.name === 'index'\) return false/.test(handler) && /open\.go\('index'\);\s*return true/.test(handler));
check('Transfers falls through to its own handler and Android', /return false/.test(handler));
check('no exitApp and no initialRouteName prop on Tabs', !/exitApp/.test(layout) && !/initialRouteName=/.test(layout));
const transfers = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
check('Transfers still clears selection on Back first', /hardwareBackPress[\s\S]{0,80}setSelectedIds\(new Set\(\)\)/.test(transfers));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
