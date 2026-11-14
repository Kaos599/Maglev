#!/usr/bin/env node
// Found-list lifecycle (NATIVE_CONTRACT 24.6a), native side: resetFound, and same-document navigation resets the tracker.
// Static: reads Kotlin and TS source. The screen wiring (Scan again, dismiss, Undo) is checked in a later wave.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const view = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/MaglevBrowserView.kt');
const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
const wrapper = read('modules/maglev-engine/src/MaglevBrowser.tsx');

// Body of a Kotlin block starting at the first match of `re` (brace matching).
function block(src, re) {
  const m = re.exec(src);
  if (!m) return '';
  let i = src.indexOf('{', m.index), depth = 0;
  const start = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  return '';
}

console.log('doUpdateVisitedHistory');
const dh = block(view, /override fun doUpdateVisitedHistory\(view: WebView, url: String\?, isReload: Boolean\)/);
check('overridden in the browser client', dh.length > 0);
check('reloads are ignored', /isReload/.test(dh));
check('compares with the document comparison helper', /sameDocument\(/.test(dh));
check('a new document calls resetPageState', /resetPageState\(\)/.test(dh));
check('a new document emits onPage', /emitPage\(\)/.test(dh));
check('the scan is scheduled 600 ms later on the main thread', /mainHandler\.postDelayed\(\s*scanRunnable\s*,\s*600L?\s*\)/.test(dh));
check('a pending scan from an earlier navigation is cancelled', /mainHandler\.removeCallbacks\(\s*scanRunnable\s*\)/.test(dh));
const sd = block(view, /fun sameDocument\(/);
check('comparison covers scheme, host, path and query', /scheme/.test(sd) && /host/.test(sd) && /path/.test(sd) && /query/.test(sd));
check('comparison ignores the fragment', !/fragment/i.test(sd.replace(/\/\/.*$/gm, '')));
check('the document url is tracked from onPageStarted', /docUrl\s*=/.test(block(view, /override fun onPageStarted\(/)));
check('destroy cancels the scheduled scan', /mainHandler\.removeCallbacksAndMessages\(null\)/.test(block(view, /fun destroyBrowser\(/)));

console.log('resetFound (view)');
const rf = block(view, /fun resetFound\(/);
check('view has resetFound', rf.length > 0);
check('rejects a destroyed view with VIEW_GONE', /VIEW_GONE/.test(view) && /destroyed/.test(rf));
check('empties the tracker', /tracker\.clear\(\)/.test(rf));
check('runs the page scan', /scan\(\)|scanNow\(\)/.test(rf));
check('a loading page is scanned after the load ends', /scanAfterLoad/.test(rf) && /scanAfterLoad/.test(block(view, /override fun onPageFinished\(/)));

console.log('resetFound (module and wrapper)');
const reg = block(mod, /View\(MaglevBrowserView::class\)/);
check('module registers resetFound on the browser view', /AsyncFunction\("resetFound"\)/.test(reg));
check('registration takes a Promise', /AsyncFunction\("resetFound"\)\s*\{\s*view: MaglevBrowserView,\s*promise: Promise/.test(reg));
check('TS ref types resetFound as a Promise<void>', /resetFound\(\): Promise<void>/.test(wrapper));
check('TS handle forwards resetFound', /resetFound:\s*\(\)\s*=>/.test(wrapper) && /nativeRef\.current\?\.resetFound\(\)/.test(wrapper));

if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
console.log('\nall ok');
