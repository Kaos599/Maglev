#!/usr/bin/env node
// Share -> "Find videos on this page" opens the Browser tab when it is shown, and a cold link keeps the tabs underneath.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

async function main() {
  const { shareBrowserRoute } = await import('../utils/browser/shareRoute.ts');
  const { browserIntentRoute } = await import('../utils/browserUrl.ts');
  const r = browserIntentRoute('maglev://browser?url=' + encodeURIComponent('https://example.com/a?b=1'));
  check('card route is the stack route', r.startsWith('/browser?prefill='));
  check('tab shown: /browse with same params', shareBrowserRoute(r, true) === r.replace('/browser', '/browse'));
  check('tab hidden: stack route kept', shareBrowserRoute(r, false) === r);
  check('bare /browser goes to /browse', shareBrowserRoute('/browser', true) === '/browse');
  check(
    'other routes untouched',
    shareBrowserRoute('/browser-history', true) === '/browser-history' && shareBrowserRoute('/add-torrent?source=x', true) === '/add-torrent?source=x',
  );

  const ni = read('app/+native-intent.tsx');
  check('native intent uses shareBrowserRoute with the tab prefs', /shareBrowserRoute\(browser,\s*visibleTabs\(getTabPrefs\(\)[^;]*includes\('browse'\)/.test(ni));
  const layout = read('app/_layout.tsx');
  check('root layout anchors on (tabs)', /unstable_settings\s*=\s*\{\s*anchor:\s*'\(tabs\)'\s*\}/.test(layout));
  const add = read('app/add-download.tsx');
  check('add-download never router.replace("/")', !/router\.replace\('\/'\)/.test(add));
  check('add-download goes home with dismissTo', (add.match(/router\.dismissTo\('\/'\)/g) || []).length >= 3);
  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/share/QuickShareActivity.kt');
  check('card still sends maglev://browser (routing is decided in JS)', kt.includes('maglev://browser?url='));
  process.exit(failed ? 1 : 0);
}
main();
