#!/usr/bin/env node
// Issue #77: Android Back on any other tab goes to Transfers instead of closing the app.
// Source contract: the tab navigator uses backBehavior "initialRoute" with initialRouteName "index"
// (the router looks the route up by name, so a reordered or partly hidden bar does not matter).
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
const tabs = layout.slice(layout.indexOf('<Tabs'), layout.indexOf('screenListeners'));
check('Tabs sets backBehavior="initialRoute"', /backBehavior=["']initialRoute["']/.test(tabs));
check('Tabs sets initialRouteName="index" (Transfers)', /initialRouteName=["']index["']/.test(tabs));
check('no BackHandler.exitApp in the tabs layout', !/exitApp/.test(layout));
const transfers = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
check('Transfers still clears selection on Back first', /hardwareBackPress[\s\S]{0,80}setSelectedIds\(new Set\(\)\)/.test(transfers));
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
