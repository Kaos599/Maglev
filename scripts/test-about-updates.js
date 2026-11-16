#!/usr/bin/env node
// About is calm; every update and list control lives on the Updates page.
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
const about = read('app/settings/about.tsx');
const up = read('app/settings/updates.tsx');
const layout = read('app/_layout.tsx');

for (const w of ['useUpdatePrefs', 'RadioCard', 'checkListsNow', 'useListPrefs', 'Toggle']) {
  check(`about does not reference ${w}`, !about.includes(w));
}
check('about keeps StarTicket', about.includes('StarTicket'));
check('about keeps Report a bug via updateCopy.report', about.includes('updateCopy.report'));
check('about keeps REPO_URL', about.includes('REPO_URL'));
check('about keeps the crash log', about.includes('copyCrashReport') && about.includes('clearCrashLog'));
check('about links to /settings/updates', about.includes("'/settings/updates'"));
check('about has a version footer with a11y label', /Opens Updates/.test(about));

check('updates declares checkNow', up.includes('checkNow'));
check('updates declares useUpdatePrefs', up.includes('useUpdatePrefs'));
check('updates declares checkListsNow', up.includes('checkListsNow'));
check("updates has 'When an update is found'", up.includes('When an update is found'));
check("updates has SectionHeader 'App'", /<SectionHeader title="App"/.test(up));
check("updates has SectionHeader 'Lists'", /<SectionHeader title="Lists"/.test(up));
check('updates has UpdateCard', up.includes('function UpdateCard'));
check('updates title is Updates', up.includes('<SettingsPage title="Updates">'));

check('layout declares settings/updates', layout.includes('<Stack.Screen name="settings/updates" />'));
process.exit(failed ? 1 : 0);
