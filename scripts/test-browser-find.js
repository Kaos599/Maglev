#!/usr/bin/env node
// Browser find in page and text size (NATIVE_CONTRACT section 28): static checks on the Kotlin view, module, TS wrapper and screens,
// plus the text size normalizer imported from the prefs.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}\b/;

const stubs = {
  'expo-sqlite/kv-store': `export default { getItemSync: () => null, setItemSync: () => {} };`,
  react: `export const useSyncExternalStore = () => 0;`,
};
require('node:module').registerHooks({
  resolve(spec, ctx, next) {
    if (stubs[spec]) return { url: 'data:text/javascript,' + encodeURIComponent(stubs[spec]), shortCircuit: true, format: 'module' };
    try { return next(spec, ctx); } catch (e) {
      if (spec.startsWith('.') && !/\.\w+(\?.*)?$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});

const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/MaglevBrowserView.kt');
const mod = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
const ts = read('modules/maglev-engine/src/MaglevBrowser.tsx');
const tab = read('components/browser/TabWebView.tsx');
const bar = read('components/browser/FindBar.tsx');
const sheet = read('components/browser/TextSizeSheet.tsx');
const scr = read('app/browser.tsx');
const set = read('app/settings/browser.tsx');
const copy = read('constants/copy.ts');
const pkg = read('package.json');

async function main() {
  console.log('native view');
  check('findInPage uses findAllAsync', /fun findInPage\(query: String, promise: Promise\)[\s\S]{0,400}findAllAsync\(query\)/.test(kt));
  check('findNext uses WebView.findNext(forward)', /fun findNext\(forward: Boolean, promise: Promise\)[\s\S]{0,300}webView\.findNext\(forward\)/.test(kt));
  check('clearFind uses clearMatches', /fun clearFind\(promise: Promise\)[\s\S]{0,300}webView\.clearMatches\(\)/.test(kt));
  check('the three commands reject with VIEW_GONE on a destroyed view', ['findInPage', 'findNext', 'clearFind'].every((n) => new RegExp(`fun ${n}\\([^)]*\\) \\{\\s*if \\(destroyed\\) \\{\\s*promise\\.reject\\("VIEW_GONE"`).test(kt)));
  check('setFindListener emits onFindResult with active, total and done', /setFindListener \{[^}]*onFindResult\(mapOf\("active" to \w+, "total" to \w+, "done" to \w+\)\)/.test(kt));
  check('the listener lives in createWebView, so a crash-recreated WebView gets it again', /private fun createWebView\(\)[\s\S]*?setFindListener[\s\S]*?return w/.test(kt));
  check('onFindResult is an EventDispatcher', /private val onFindResult by EventDispatcher<Map<String, Any\?>>\(\)/.test(kt));
  check('textZoom is clamped to 50..200', /fun setTextZoom\(value: Int\)[\s\S]{0,120}value\.coerceIn\(50, 200\)/.test(kt));
  check('textZoom reaches settings.textZoom, also in createWebView (crash recreate)', /webView\.settings\.textZoom = v/.test(kt) && /private fun createWebView\(\)[\s\S]*?s\.textZoom = textZoom[\s\S]*?return w/.test(kt));
  check('textZoom defaults to 100', /private var textZoom = 100/.test(kt));
  check('pinch zoom stays on', /s\.builtInZoomControls = true/.test(kt) && /s\.displayZoomControls = false/.test(kt) && /s\.setSupportZoom\(true\)/.test(kt));

  console.log('module registration');
  check('the view declares onFindResult', /Events\([^)]*"onFindResult"/.test(mod));
  check('Prop textZoom calls setTextZoom', /Prop\("textZoom"\) \{ view: MaglevBrowserView, value: Int -> view\.setTextZoom\(value\) \}/.test(mod));
  check('findInPage, findNext and clearFind are AsyncFunctions on the view', /AsyncFunction\("findInPage"\) \{ view: MaglevBrowserView, query: String, promise: Promise/.test(mod) && /AsyncFunction\("findNext"\) \{ view: MaglevBrowserView, forward: Boolean, promise: Promise/.test(mod) && /AsyncFunction\("clearFind"\) \{ view: MaglevBrowserView, promise: Promise/.test(mod));

  console.log('TS wrapper');
  check('the result event type', /BrowserFindResultEvent = \{ active: number; total: number; done: boolean \}/.test(ts));
  check('textZoom prop and onFindResult in the props and native props', (ts.match(/textZoom\?: number/g) || []).length === 2 && (ts.match(/onFindResult\?:/g) || []).length === 2);
  check('the ref has findInPage, findNext and clearFind', /findInPage\(query: string\): Promise<void>/.test(ts) && /findNext\(forward: boolean\): Promise<void>/.test(ts) && /clearFind\(\): Promise<void>/.test(ts));
  check('the commands reach the native ref', /findInPage: \(query: string\) => nativeRef\.current\?\.findInPage\(query\)/.test(ts) && /findNext: \(forward: boolean\) => nativeRef\.current\?\.findNext\(forward\)/.test(ts) && /clearFind: \(\) => nativeRef\.current\?\.clearFind\(\)/.test(ts));
  check('the event is unwrapped from nativeEvent', /onFindResult=\{onFindResult \? \(e\) => onFindResult\(e\.nativeEvent\)/.test(ts));
  check('every live tab view gets textZoom and a tab-id onFindResult', /textZoom=\{textZoom\}/.test(tab) && /onFindResult=\{\(e\) => h\.onFindResult\(id, e\)\}/.test(tab) && /textZoom=\{prefs\.browserTextZoom\}/.test(scr));

  console.log('find bar');
  check('the bar replaces the address row while find is open', /\{findOpen \? \(\s*<FindBar[\s\S]*?\) : \(\s*<View style=\{styles\.bar\}>/.test(scr));
  check('the input autofocuses', /autoFocus/.test(bar));
  check('typing is debounced 150 ms', /FIND_DEBOUNCE_MS = 150/.test(bar) && /setTimeout\([\s\S]{0,120}FIND_DEBOUNCE_MS\)/.test(bar));
  check('Enter means next', /onSubmitEditing/.test(bar) && /step\(true\)/.test(bar));
  check('shows {active+1}/{total} or No matches', /findCopy\.count\(result\.active \+ 1, result\.total\)/.test(bar) && /findCopy\.noMatches/.test(bar));
  check('up, down and close have labels from copy', /findCopy\.previous/.test(bar) && /findCopy\.next/.test(bar) && /findCopy\.close/.test(bar) && /findCopy\.matchLabel/.test(bar));
  check('buttons are 44 px', /step: \{ width: 44, height: 44/.test(bar) && /height: 44,/.test(bar));
  check('no hex colours and no inline copy in the bar and sheet', !HEX.test(bar) && !HEX.test(sheet));
  check('the screen runs the commands on the tab find was opened on', /findTab\.current/.test(scr) && /view\(id\)\?\.findInPage\(q\)/.test(scr) && /view\(id\)\?\.findNext\(forward\)/.test(scr) && /view\(id\)\?\.clearFind\(\)/.test(scr));
  check('Back closes find before the switcher', /if \(findOpen\) \{\s*closeFind\(\);\s*return true;\s*\}\s*if \(switcherOpen\)/.test(scr));
  check('switching tabs closes find', /findTab\.current !== activeId\) closeFind\(\)/.test(scr));
  check('a new document closes find', /newDocument && id === findTab\.current\) closeFind\(\)/.test(scr));
  check('the menu has Find in page and Text size rows', /findCopy\.menuRow/.test(scr) && /textSizeCopy\.menuRow/.test(scr));
  check('copy: find and text size strings', /export const findCopy/.test(copy) && /'Find in page'/.test(copy) && /'No matches'/.test(copy) && /`Match \$\{n\} of \$\{total\}`/.test(copy) && /'Previous match'/.test(copy) && /'Next match'/.test(copy) && /'Close find'/.test(copy) && /export const textSizeCopy/.test(copy));

  console.log('text size');
  const P = await import('../utils/prefs/browser.ts');
  check('default is 100', P.defaultBrowserPrefs().browserTextZoom === 100 && P.normalizeBrowserPrefs({}).browserTextZoom === 100);
  check('non-numbers fall back to 100', [undefined, null, 'big', NaN, Infinity, {}].every((v) => P.normalizeTextZoom(v) === 100));
  check('clamps to 50..200', P.normalizeTextZoom(10) === 50 && P.normalizeTextZoom(-5) === 50 && P.normalizeTextZoom(999) === 200 && P.normalizeTextZoom(201) === 200);
  check('rounds to the nearest 5', P.normalizeTextZoom(102) === 100 && P.normalizeTextZoom(103) === 105 && P.normalizeTextZoom(112.4) === 110);
  const chips = [80, 90, 100, 115, 130, 150, 175, 200];
  check('every Settings chip survives the normalizer', chips.every((v) => P.normalizeTextZoom(v) === v));
  check('the prefs parse keeps and normalizes browserTextZoom', P.normalizeBrowserPrefs({ browserTextZoom: 130 }).browserTextZoom === 130 && P.normalizeBrowserPrefs({ browserTextZoom: 4000 }).browserTextZoom === 200);
  check('Settings has the chip row 80 90 100 115 130 150 175 200', /\[80, 90, 100, 115, 130, 150, 175, 200\]/.test(set) && /<ChipGroup label=\{textSizeCopy\.settingsLabel\}/.test(set) && /browserTextZoom/.test(set));
  check('the sheet steps by 10 between 50 and 200 with Reset', /TEXT_ZOOM_STEP/.test(sheet) && P.TEXT_ZOOM_STEP === 10 && P.TEXT_ZOOM_MIN === 50 && P.TEXT_ZOOM_MAX === 200 && /textSizeCopy\.reset/.test(sheet) && /FloatingSheet/.test(sheet));
  check('the sheet changes the global pref', /updateBrowserPrefs\(\{ browserTextZoom \}\)/.test(scr));

  console.log('wiring');
  check('chained in npm test after test-browser-tabs-ui.js', /test-browser-tabs-ui\.js && node scripts\/test-browser-find\.js/.test(pkg));

  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll browser find and text size checks passed.');
}
main().catch((e) => { console.error(e); process.exit(1); });
