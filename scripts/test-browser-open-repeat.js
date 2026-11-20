#!/usr/bin/env node
// Opening the same address twice must work (the Browse tab stays mounted), and "Open in new tab" must really open a tab.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}`); }
}
function load(file, extra) {
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: (n) => extra[n], Date }, { filename: file });
  return mod.exports;
}
let tabShown = true;
const { openBrowser } = load('utils/browser/openBrowser.ts', {
  '../../components/tabs/tabPrefs.ts': { visibleTabs: () => (tabShown ? ['browse'] : []) },
  '../../components/tabs/tabPrefsStore.ts': { getTabPrefs: () => ({}) },
});
const calls = [];
const router = { push: (h) => calls.push(['push', h]), replace: (h) => calls.push(['replace', h]), navigate: (h) => calls.push(['navigate', h]), dismissTo: (h) => calls.push(['dismissTo', h]) };
const last = () => calls[calls.length - 1][1];

openBrowser(router, { url: 'https://a.com' }, 'dismissTo');
openBrowser(router, { url: 'https://a.com' }, 'dismissTo');
const [p1, p2] = [calls[0][1].params, calls[1][1].params];
check('url open carries an open nonce', typeof p1.open === 'string' && p1.open.length > 0);
check('the same url twice gets different nonces', p1.open !== p2.open);
check('url is kept', p1.url === 'https://a.com');
openBrowser(router, { prefill: 'x' });
check('prefill open carries a nonce', !!last().params.open);
openBrowser(router);
check('no params: plain path, no nonce', last() === '/browse');
openBrowser(router, { url: 'https://a.com', newTab: true });
check('newTab passes newTab=1', last().params.newTab === '1');
openBrowser(router, { url: 'https://a.com' });
check('no newTab param by default', last().params.newTab === undefined);
tabShown = false;
openBrowser(router, { url: 'https://b.com' }, 'dismissTo');
check('stack route also gets the nonce', calls[calls.length - 1][0] === 'dismissTo' && last().pathname === '/browser' && !!last().params.open);

const scr = read('app/browser.tsx');
check('browser.tsx reads open and newTab params', /open\?: string/.test(scr) && /newTab\?: string/.test(scr));
check('dedupe key includes the nonce', /params\.open/.test(scr.slice(scr.indexOf('const handled = useRef'), scr.indexOf('// ---- tabs ----'))));
check('newTab always opens a tab', /isBlank\(cur\) && params\.newTab !== '1'\) open\(t\.url\);\s*else openTabChecked\(\{ url: t\.url \}\)/.test(scr));

const bm = read('app/browser-bookmarks.tsx');
check('Open in new tab row passes newTab', /newTab: true/.test(bm));

check('the Bookmarked icon sits in a fixed 16x16 box centred in the address bar', /style=\{styles\.savedIcon\}/.test(read('app/browser.tsx')) && /savedIcon: \{ width: 16, height: 16, alignSelf: 'center'/.test(read('app/browser.tsx')));
if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nbrowser open repeat: all checks passed');
