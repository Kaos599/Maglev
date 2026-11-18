#!/usr/bin/env node
// Browser hardening (NATIVE_CONTRACT 24.11): downloads without a tap, Back-button hijacking, HTTPS-first, the found-files
// hint and the mining block list. Pure TS rules run directly (Node 22.18+); the Kotlin side is checked as source, because
// Kotlin is only compiled in CI. The Kotlin mirrors have JVM tests in BrowserHardeningTest.kt with the same vectors.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

require('node:module').registerHooks({
  resolve(spec, ctx, next) {
    try { return next(spec, ctx); } catch (e) {
      if (spec.startsWith('.') && !/\.\w+(\?.*)?$/.test(spec)) return next(spec + '.ts', ctx);
      throw e;
    }
  },
});
const h = require('../utils/browser/hardening.ts');

// ---- 1. downloads ----
check('no tap, no user load: not asked for', h.downloadTapped(null, 0, false) === false);
check('typed or tapped navigation: asked for', h.downloadTapped(null, 0, true) === true);
check('tap inside the window: asked for', h.downloadTapped(500, 0, false) && h.downloadTapped(3000, 0, false));
check('old tap does not count', h.downloadTapped(3001, 0, false) === false);
check('a tap vouches for one download only', h.downloadTapped(100, 1, false) === false && h.downloadTapped(100, 1, true));
check('save sheet: only untapped is held back (a missing flag counts as tapped)', h.opensSaveSheet(true) && h.opensSaveSheet(undefined) && !h.opensSaveSheet(false));

// ---- 2. back ----
check('back: nearest user entry', h.backSteps([true, true, false, false], 3) === 2 && h.backSteps([true, true, true], 2) === 1 && h.backSteps([true, true, false, true], 3) === 2);
check('back: all earlier no-tap goes to the first', h.backSteps([false, false, false, false], 3) === 3 && h.backSteps([true, false, false], 2) === 2);
check('back: nothing behind is 0', h.backSteps([true], 0) === 0 && h.backSteps([], 0) === 0);
check('back: unknown flags count as made', h.backSteps([], 4) === 1 && h.backSteps([true], 3) === 1 && h.backSteps([], 1) === 1);
{
  const f = h.newHistoryFlags();
  h.historyVisited(f, 'https://a.test/', 0, true);
  h.historyVisited(f, 'https://a.test/b', 1, true);
  h.historyVisited(f, 'https://a.test/b#x', 2, false);
  h.historyVisited(f, 'https://a.test/b#y', 3, false);
  check('history: new entries take the flag', eq(f.made, [true, true, false, false]));
  h.historyVisited(f, 'https://a.test/b', 1, false);
  h.historyVisited(f, 'https://a.test/b#x', 2, true);
  check('history: Back and Forward keep stored flags', eq(f.made, [true, true, false, false]));
}
{
  const f = h.newHistoryFlags();
  h.historyVisited(f, 'https://a.test/', 0, true);
  h.historyVisited(f, 'https://a.test/1', 1, true);
  h.historyVisited(f, 'https://a.test/2', 2, false);
  h.historyVisited(f, 'https://a.test/1', 1, false);
  h.historyVisited(f, 'https://a.test/3', 2, true);
  check('history: a new entry after Back drops the forward ones', eq(f.made, [true, true, true]) && f.urls.length === 3);
}
{
  const f = h.newHistoryFlags();
  h.historyVisited(f, 'https://a.test/', 0, true);
  h.historyVisited(f, 'https://a.test/1', 1, false);
  h.historyVisited(f, 'https://a.test/1b', 1, false);
  const kept = eq(f.made, [true, false]);
  h.historyVisited(f, 'https://a.test/1c', 1, true);
  check('history: a replace keeps the flag and a tap wins', kept && eq(f.made, [true, true]));
}
{
  const f = h.newHistoryFlags();
  h.historyVisited(f, 'http://a.test/', 0, true);
  h.historyVisited(f, 'https://b.test/', 1, true);
  h.historySkipIfUrl(f, 'https://other.test/');
  const untouched = eq(f.made, [true, true]);
  h.historySkipIfUrl(f, 'https://b.test/');
  check('history: a failed https try becomes a Back skip, only when it is the current entry', untouched && eq(f.made, [true, false]));
}
{
  // The hijack: A typed, B tapped, then the page pushes C, D, E without a tap. Back from E goes to B in one press.
  const f = h.newHistoryFlags();
  [['https://s.test/', true], ['https://s.test/post', true], ['https://s.test/post#1', false], ['https://s.test/post#2', false], ['https://s.test/post#3', false]]
    .forEach(([u, m], i) => h.historyVisited(f, u, i, m));
  check('hijack: one Back press leaves the spam', h.backSteps(f.made, 4) === 3);
  // Fragment change from a tap is user-made.
  h.historyVisited(f, 'https://s.test/post#faq', 5, true);
  h.historyVisited(f, 'https://s.test/post#faq2', 6, false);
  check('tapped fragment change is a stop', h.backSteps(f.made, 6) === 1 && h.backSteps(f.made, 5) === 4);
}

// ---- 5. https first ----
const none = new Set();
check('https: plain http is upgraded, path and query kept', h.upgradeToHttps('http://example.com/a?b=1#c', none) === 'https://example.com/a?b=1#c' && h.upgradeToHttps('HTTP://example.com', none) === 'https://example.com');
check('https: port 80 is dropped, other ports stay http', h.upgradeToHttps('http://example.com:80/x', none) === 'https://example.com/x' && h.upgradeToHttps('http://example.com:8080/x', none) === null);
check('https: exemptions', [
  'https://example.com/', 'http://localhost/', 'http://192.168.1.5/', 'http://8.8.8.8/', 'http://[2001:db8::1]/', 'http://nas/', 'http://router.local/', 'http://user@example.com/', 'http://2130706433/', 'http://0x7f.1/',
].every((u) => h.upgradeToHttps(u, none) === null));
check('https: a host the user fell back on is not upgraded again', h.upgradeToHttps('http://example.com/', new Set(['example.com'])) === null);
check('https: host parsing', h.httpsHostOf('http://u:p@Example.com:8080/x') === 'example.com' && h.httpsHostOf('http://[2001:db8::1]:80/') === '2001:db8::1' && h.httpsHostOf('not a url') === null);
check('https: failure and loop', h.isUpgradeFailure('example.com', 'https://example.com/a') && h.isUpgradeFailure('example.com', 'https://www.example.com/') && !h.isUpgradeFailure('example.com', 'https://other.test/') && !h.isUpgradeFailure(null, 'https://example.com/')
  && h.isUpgradeLoop('example.com', 'http://example.com/') && h.isUpgradeLoop('example.com', 'http://www.example.com/x') && !h.isUpgradeLoop('example.com', 'https://example.com/') && !h.isUpgradeLoop('example.com', 'http://other.test/'));

// ---- 3. found-files hint ----
check('hint: due once, with files, tray closed', h.foundHintDue(2, 'idle', false) && !h.foundHintDue(0, 'idle', false) && !h.foundHintDue(2, 'shown', false) && !h.foundHintDue(2, 'done', false) && !h.foundHintDue(2, 'idle', true));
check('hint: copy is plain', h.foundHintText(1) === 'Maglev found 1 file on this page' && h.foundHintText(4) === 'Maglev found 4 files on this page' && h.FOUND_HINT_MS <= 8000);

// ---- Kotlin and screen wiring (source checks) ----
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const view = strip(read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/MaglevBrowserView.kt'));
const store = strip(read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/BlocklistStore.kt'));
const screen = read('app/browser.tsx');
check('kotlin: download event carries tapped, from the rule', /"tapped" to tapped/.test(view) && /DownloadRules\.tapped\(tapAge\(\), dlTapUses, pendingUserNav, /.test(view));
check('kotlin: Back uses BackRules over a history list and goBackOrForward', /BackRules\.steps\(history\.flags\(\), webView\.copyBackForwardList\(\)\.currentIndex\)/.test(view) && /goBackOrForward\(-steps\)/.test(view));
check('kotlin: history is recorded from doUpdateVisitedHistory, not for reloads', /if \(url != null && !isReload\) recordHistory\(url\)/.test(view));
check('kotlin: canGoBack still comes from the WebView', /"canGoBack" to \(customView != null \|\| w\.canGoBack\(\)\)/.test(view));
check('kotlin: https-first on typed loads and link or redirect navigations', /HttpsFirst\.upgrade\(url, httpsFallbackHosts\)/.test(view) && /HttpsFirst\.upgrade\(uri\.toString\(\), httpsFallbackHosts, /.test(view));
check('kotlin: the fallback runs before the SSL refusal and only for the upgrade', (() => {
  const i = view.indexOf('override fun onReceivedSslError');
  const body = view.slice(i, i + 700);
  return body.indexOf('fallBackToHttp()') > 0 && body.indexOf('fallBackToHttp()') < body.indexOf('refuse(error.url');
})());
check('kotlin: main-frame errors fall back only for the pending upgrade', /override fun onReceivedError\(view: WebView, request: WebResourceRequest, error: WebResourceError\)/.test(view) && /request\.isForMainFrame && HttpsFirst\.isUpgradeFailure/.test(view));
check('kotlin: fallback hosts live for the app session (companion set)', /private val httpsFallbackHosts[\s\S]{0,120}newSetFromMap/.test(view));
check('kotlin: the crash rebuild resets history and the upgrade', /history\.clear\(\)[\s\S]{0,80}upgrade = null/.test(view));
check('screen: an untapped download does not open the save sheet', /if \(!opensSaveSheet\(e\.tapped\)\) \{[\s\S]{0,400}DOWNLOAD_HELD_NOTICE[\s\S]{0,200}return;/.test(screen));
check('screen: the hint shows once per page and ends with the tray or a timer', /foundHintDue\(found\.length, data\.hint, trayOpen\)/.test(screen) && /FOUND_HINT_MS/.test(screen) && /d\.hint = 'idle'/.test(screen));
check('event type has tapped', /tapped: boolean;/.test(read('modules/maglev-engine/src/MaglevBrowser.tsx')));
check('no mock browser engine emits download requests', !/onDownloadRequest|BrowserDownloadRequest/.test(read('modules/maglev-engine/src/MaglevMockEngine.ts')));

// ---- 4. mining list ----
const miners = read('modules/maglev-engine/android/src/main/assets/miners.txt');
const lines = miners.split('\n');
const head = lines.filter((l) => l.startsWith('#')).join('\n');
const domains = lines.filter((l) => l && !l.startsWith('#'));
check('miners asset: header names source and MIT licence', /Source: https:\/\/raw\.githubusercontent\.com\/hoshsadiq\/adblock-nocoin-list\//.test(head) && /License: MIT/.test(head));
check('miners asset: declared count matches, valid unique domains', Number(/Domains: (\d+)/.exec(head)[1]) === domains.length && new Set(domains).size === domains.length && domains.length >= 100
  && domains.every((d) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(d)));
check('miners asset: well-known CoinHive hosts are listed', domains.includes('coinhiveproxy.com') && domains.includes('authedmine.com'));
check('store: mining domains join every list, bundled or downloaded, with no new setting', /loadMiners\(context\)/.test(store) && (store.match(/withMiners\(/g) || []).length >= 4 && !/DomainSet\(all\)|DomainSet\(domains\)/.test(store.replace(/private fun withMiners[^\n]*/, '')));
check('build script exists', fs.existsSync(path.join(ROOT, 'scripts/build-miners.js')));
check('Kotlin JVM test exists', fs.existsSync(path.join(ROOT, 'modules/maglev-engine/android/src/test/java/com/maglev/engine/browser/BrowserHardeningTest.kt')));

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\ntest-browser-hardening: all checks passed');
