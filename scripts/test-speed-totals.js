#!/usr/bin/env node
// Transfers speed totals strip (↓/↑ totals plus Pause all / Resume all) is off by default.
// Settings → Appearance → "Speed totals" turns it on; the choice persists through migrateSettings.
// Pause all / Resume all stay in the notification and the Quick Settings tile either way. Needs Node 22.18+.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
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
  console.log('[setting]');
  const types = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  check('default is off', types.DEFAULT_SETTINGS.appearance.showSpeedTotals === false);

  const store = read('modules/maglev-engine/src/MaglevSettingsStore.ts');
  check('migrate coerces a non-boolean to false', /showSpeedTotals\s*!==\s*true|typeof merged\.appearance\.showSpeedTotals/.test(store));

  console.log('[transfers screen]');
  const screen = read('app/(tabs)/index.tsx');
  check('strip is gated on the setting', /appearance\.showSpeedTotals\s*&&[\s\S]{0,80}<SpeedTelemetryHeader/.test(screen) || /showSpeedTotals[\s\S]{0,200}<SpeedTelemetryHeader/.test(screen));

  console.log('[settings screen]');
  const ui = read('app/settings/interface.tsx');
  check('Appearance has a "Speed totals" toggle', /Speed totals/.test(ui) && /showSpeedTotals/.test(ui) && /<Toggle/.test(ui));

  console.log('[notification keeps Pause all]');
  const notif = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/service/Notifications.kt');
  check('notification still offers Pause all', /Pause all/.test(notif));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
