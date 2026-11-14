#!/usr/bin/env node
// Found-list lifecycle (NATIVE_CONTRACT 24.6a), native side: resetFound, and same-document navigation resets the tracker.
// Static: reads Kotlin and TS source, plus the pure dismiss helpers and the screen wiring (Scan again, dismiss, Undo).
process.removeAllListeners('warning');
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

async function screen() {
  const d = await import('../components/browser/foundDismiss.ts');
  const mk = (id, over = {}) => ({ id, url: `https://cdn.test/${id}.mp4`, kind: 'video', mime: 'video/mp4', ext: 'mp4', name: `${id}.mp4`, size: null, width: null, height: null, source: 'network', stream: null, pageUrl: 'https://site.test/a', pageTitle: 'A', ...over });
  const items = [mk('a'), mk('b'), mk('c')];

  console.log('dismiss helpers');
  check('nothing dismissed shows everything', d.visibleFound(items, new Set()).length === 3);
  const one = d.dismissIds(new Set(), d.visibleFound(items, new Set()), ['b']);
  check('dismissing one hides it', d.visibleFound(items, one.next).map((i) => i.id).join() === 'a,c');
  check('dismiss does not touch the source list', items.length === 3);
  check('dismiss reports what it added', one.added.join() === 'b');
  const again = d.dismissIds(one.next, d.visibleFound(items, one.next), ['b']);
  check('dismissing a hidden id adds nothing to undo', again.added.length === 0);
  const all = d.dismissAllVisible(one.next, d.visibleFound(items, one.next));
  check('clear hides every visible row', d.visibleFound(items, all.next).length === 0);
  check('clear undoes only what it hid', all.added.join() === 'a,c');
  check('undo restores the ids', d.visibleFound(items, d.restoreIds(all.next, all.added)).map((i) => i.id).join() === 'a,c');
  check('undo of a clear keeps an earlier remove hidden', d.visibleFound(items, d.restoreIds(all.next, all.added)).every((i) => i.id !== 'b'));
  check('helpers return new sets', one.next !== all.next && d.restoreIds(all.next, []) !== all.next);
  const hlsA = mk('m', { stream: 'hls', url: 'https://cdn.test/v/master.m3u8' });
  const hlsB = mk('v', { stream: 'hls', url: 'https://cdn.test/v/720/index.m3u8' });
  check('a hidden variant stays hidden after its master is dismissed', d.visibleFound([hlsA, hlsB], d.dismissIds(new Set(), [hlsA], ['m']).next).length === 0);

  console.log('screen wiring (app/browser.tsx, FoundTray)');
  const scr = read('app/browser.tsx');
  const tray = read('components/browser/FoundTray.tsx');
  check('screen keeps a dismissed set', /useState<ReadonlySet<string>>|useState<Set<string>>|dismissed: ReadonlySet<string>/.test(scr) && /dismissed/.test(scr));
  check('the tray list hides dismissed ids', /visibleFound\(/.test(scr));
  check('Remove dismisses instead of deleting from the list', !/removeFound\(/.test(scr) && /dismissIds\(/.test(scr));
  check('Clear dismisses instead of emptying the list', !/clearFound\(/.test(scr) && /dismissAllVisible\(/.test(scr));
  check('the dismissed set resets on a new document', /d\.dismissed = new Set\(\)/.test(block(scr, /onPage: \(id, e\) =>/)));
  check('Undo lasts 5 seconds', /UNDO_MS\s*=\s*5000/.test(scr) && /UNDO_MS/.test(scr.replace(/UNDO_MS\s*=\s*5000/, '')));
  check('Undo restores the ids', /restoreIds\(/.test(scr));
  check('Scan again empties dismissed and the list, then calls resetFound', /scanAgain/.test(scr) && /d\.dismissed = new Set\(\)/.test(block(scr, /const scanAgain = useCallback/)) && /d\.found = \[\]/.test(block(scr, /const scanAgain = useCallback/)) && /resetFound\(\)/.test(block(scr, /const scanAgain = useCallback/)));
  check('a VIEW_GONE rejection is ignored', /resetFound\(\)[\s\S]{0,80}\.catch\(/.test(scr));
  check('the tray has a Scan again row', /onScanAgain/.test(tray) && /foundTray\.scanAgain/.test(tray));
  check('the empty tray offers Scan again too', /EmptyBlock[\s\S]{0,400}onScanAgain/.test(tray));
  check('the tray shows the Undo row', /onUndo/.test(tray) && /foundTray\.undo/.test(tray));
  check('the screen passes the new props', /onScanAgain=/.test(scr) && /onUndo=/.test(scr));
  const copy = await import('../constants/copy.ts');
  check('copy: scanAgain and undo exist', typeof copy.foundTray.scanAgain === 'string' && typeof copy.foundTray.undo === 'string' && typeof copy.foundTray.removed === 'function' && typeof copy.foundTray.cleared === 'function');
}

screen().then(() => {
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall ok');
}, (e) => { console.error(e); process.exit(1); });
