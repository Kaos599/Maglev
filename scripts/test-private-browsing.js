#!/usr/bin/env node
// Private browsing: one browser setting that stops history and saved tabs, hides history suggestions, bypasses the page
// cache and wipes the cookies of the sites visited when the browser is left (without touching Search's cookies).
// Pure logic runs against the TypeScript sources (Node 22.18+); wiring is checked by reading the source.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ---- pref ----
  const kvStub = new Map();
  globalThis.__kv = kvStub;
  const prefsSrc = read('utils/prefs/browser.ts');
  check('pref type declared', /privateBrowsing: boolean;/.test(prefsSrc));
  check('pref defaults to off', /privateBrowsing: false,/.test(prefsSrc));
  check('pref normalised strictly (only true turns it on)', /privateBrowsing: o\.privateBrowsing === true,/.test(prefsSrc));

  // ---- pure host logic ----
  const ph = require(path.join(root, 'utils/browser/privateHosts.ts'));
  check('hostOf strips scheme, port and path but keeps www', ph.hostOf('https://www.Example.com:8080/a?b#c') === 'www.example.com');
  check('hostOf ignores non-web addresses', ['about:blank', 'data:text/html,x', 'magnet:?xt=1', 'file:///a', ''].every((u) => ph.hostOf(u) === ''));
  check('hostsToWipe adds parent domains', same(ph.hostsToWipe(['https://a.b.example.com/x'], []).sort(), ['a.b.example.com', 'b.example.com', 'example.com']));
  check('hostsToWipe keeps the www host itself and its parent', same(ph.hostsToWipe(['https://www.site.com/'], []).sort(), ['site.com', 'www.site.com']));
  check('hostsToWipe never targets a bare public suffix', same(ph.hostsToWipe(['https://www.shop.co.uk/'], []).sort(), ['shop.co.uk', 'www.shop.co.uk']), ph.hostsToWipe(['https://www.shop.co.uk/'], []).join(','));
  check('hostsToWipe skips IPs and single labels', ph.hostsToWipe(['http://192.168.1.2/', 'http://localhost/'], []).length === 0);
  const kept = ph.hostsToWipe(['https://nyaa.si/', 'https://www.nyaa.si/x', 'https://cdn.nyaa.si/', 'https://www.other.org/'], ['nyaa.si']);
  check('search hosts and their subdomains are never wiped', same(kept.sort(), ['other.org', 'www.other.org']), kept.join(','));
  check('a parent of a search host is not wiped either', same(ph.hostsToWipe(['https://x.example.com/'], ['mirror.example.com']), ['x.example.com']));
  const keep = ph.searchKeepHosts({
    enabledProviders: [{ homepage: 'https://nyaa.si', mirrors: ['https://nyaa.land'] }],
    mirrorOverrides: ['https://my-mirror.net/'],
    torznabUrls: ['https://torz.example.org/api'],
    clearanceHosts: ['1337x.to'],
  });
  check('searchKeepHosts covers sources, mirrors, custom mirrors, Torznab and site checks',
    ['nyaa.si', 'nyaa.land', 'my-mirror.net', 'torz.example.org', '1337x.to'].every((h) => keep.includes(h)), keep.join(','));

  // ---- session: remember, persist, wipe at start ----
  const store = new Map();
  const cleared = [];
  let cacheCleared = 0;
  const mk = () =>
    ph.createPrivateSession({
      kvGet: (k) => (store.has(k) ? store.get(k) : null),
      kvSet: (k, v) => store.set(k, v),
      clearCookies: async (urls) => { cleared.push(urls); return urls.length; },
      clearCache: async () => { cacheCleared++; },
      keepHosts: () => ['nyaa.si'],
    });
  const s1 = mk();
  s1.note('https://www.site-a.com/page');
  s1.note('https://site-a.com/other');
  s1.note('https://nyaa.si/');
  s1.note('about:blank');
  check('hosts are remembered once each, web only', same(s1.pending().sort(), ['nyaa.si', 'site-a.com', 'www.site-a.com']));
  const persisted = JSON.parse(store.get(ph.PRIVATE_HOSTS_KEY));
  check('the list is persisted as host names only', same(persisted.sort(), ['nyaa.si', 'site-a.com', 'www.site-a.com']) && !JSON.stringify(persisted).includes('/page'));
  check('nothing is wiped before the browser is left', cleared.length === 0);

  // Simulated kill: a new session object (a fresh process) reads the persisted list and wipes it at start.
  const s2 = mk();
  check('a new process sees the leftover hosts', same(s2.pending().sort(), ['nyaa.si', 'site-a.com', 'www.site-a.com']));
  const removed = await s2.wipe();
  check('wipe expires cookies for the visited hosts only (search host skipped)', cleared.length === 1 && same(cleared[0].slice().sort(), ['https://site-a.com/', 'https://www.site-a.com/']), JSON.stringify(cleared));
  check('wipe returns the count and empties the page cache', removed === 2 && cacheCleared === 1);
  check('the persisted list is deleted after the wipe', same(JSON.parse(store.get(ph.PRIVATE_HOSTS_KEY)), []) && s2.pending().length === 0);
  await s2.wipe();
  check('an empty list wipes nothing (no needless cache clear)', cleared.length === 1 && cacheCleared === 1);
  const s3 = mk();
  check('the next start finds nothing', s3.pending().length === 0);

  let cacheRuns = 0;
  const fStore = new Map();
  const mkFail = (cookieOk) => ph.createPrivateSession({
    kvGet: (k) => (fStore.has(k) ? fStore.get(k) : null), kvSet: (k, v) => fStore.set(k, v),
    clearCookies: async () => { if (!cookieOk) throw new Error('x'); return 1; }, clearCache: async () => { cacheRuns++; }, keepHosts: () => [],
  });
  const sFail = mkFail(false);
  sFail.note('https://a.com/');
  let threw = false;
  try { await sFail.wipe(); } catch { threw = true; }
  check('a failing cookie clear does not throw and the cache is still emptied', !threw && cacheRuns === 1);
  check('a failing cookie clear keeps the host list so the next start retries', sFail.pending().includes('a.com') && JSON.parse(fStore.get(ph.PRIVATE_HOSTS_KEY)).includes('a.com'));
  const sRetry = mkFail(true);
  await sRetry.wipe();
  check('the retry succeeds and then drops the list', sRetry.pending().length === 0);
  const sCacheFail = ph.createPrivateSession({
    kvGet: () => null, kvSet: () => {}, clearCookies: async () => 1, clearCache: async () => { throw new Error('c'); }, keepHosts: () => [],
  });
  sCacheFail.note('https://b.com/');
  await sCacheFail.wipe();
  check('a failing cache clear does not keep the cookie list', sCacheFail.pending().length === 0);

  // ---- history gated ----
  const hs = read('utils/history/store.ts');
  check('HistoryPrefs carries privateBrowsing', /privateBrowsing\?: boolean/.test(hs));
  check('recordVisit skips while private', /if \(!prefs\(\)\.saveHistory \|\| prefs\(\)\.privateBrowsing\) return 'skipped'/.test(hs));
  check('suggestions are empty while private', /if \(!prefs\(\)\.suggestFromHistory \|\| prefs\(\)\.privateBrowsing\) return \[\]/.test(hs));
  check('saved tabs are not written while private', /if \(!prefs\(\)\.saveHistory \|\| prefs\(\)\.privateBrowsing\) return false/.test(hs));
  check('recent pages are hidden while private', /prefs\.saveHistory && !privateMode/.test(read('components/browser/StartPage.tsx')) && /privateMode=\{prefs\.privateBrowsing\}/.test(read('app/browser.tsx')));
  check('address suggestions are hidden while private', /prefs\.suggestFromHistory && !prefs\.privateBrowsing/.test(read('components/browser/HistorySuggestions.tsx')));

  // ---- tabs gated (store behaviour) ----
  const { createTabStore } = require(path.join(root, 'utils/browser/tabStore.ts'));
  let priv = false;
  let listener = () => {};
  const saves = [];
  let deleted = 0;
  let loaded = 0;
  const deps = {
    load: async () => { loaded++; return { tabs: [{ id: 'old', url: 'https://old.example/', title: 'Old', position: 0, opener: null, last_active: 1 }], activeId: 'old' }; },
    scheduleSave: (rows) => saves.push(rows),
    flush: async () => {},
    deleteSaved: async () => { deleted++; },
    saveHistory: () => true,
    isPrivate: () => priv,
    subscribePrefs: (fn) => { listener = fn; return () => {}; },
    wipeCount: async () => 0,
  };
  const ts = createTabStore();
  ts.bind(deps);
  priv = true;
  listener();
  check('turning private on deletes the saved tabs', deleted === 1);
  await ts.ensureRestored();
  check('nothing is restored while private', loaded === 0 && ts.getState());
  ts.open({ url: 'https://secret.example/', title: 'S' });
  check('tabs opened while private are not saved', saves.length === 0);
  priv = false;
  listener();
  check('turning private off drops the private tabs (no private URL is saved afterwards)',
    saves.every((rows) => !JSON.stringify(rows).includes('secret.example')) &&
    !JSON.stringify(ts.getState()).includes('secret.example'));
  const ts2 = createTabStore();
  ts2.bind({ ...deps, isPrivate: () => false });
  ts2.open({ url: 'https://normal.example/', title: 'N' });
  check('tabs are still saved when private is off', saves.some((rows) => JSON.stringify(rows).includes('normal.example')));
  check('the tab store reads the setting through useTabs', /isPrivate: \(\) => getBrowserPrefs\(\)\.privateBrowsing/.test(read('components/browser/useTabs.ts')));

  // ---- cache props ----
  const wvt = read('components/browser/TabWebView.tsx');
  check('TabWebView passes privateMode to the native view', /privateMode=\{privateMode\}/.test(wvt));
  check('the screen feeds the pref to every tab view', /privateMode=\{prefs\.privateBrowsing\}/.test(read('app/browser.tsx')));
  check('MaglevBrowser declares the privateMode prop', (read('modules/maglev-engine/src/MaglevBrowser.tsx').match(/privateMode\?: boolean/g) || []).length === 2);
  const kt = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/MaglevBrowserView.kt');
  check('Kotlin sets LOAD_NO_CACHE while private and LOAD_DEFAULT otherwise', (kt.match(/WebSettings\.LOAD_NO_CACHE else WebSettings\.LOAD_DEFAULT/g) || []).length === 2);
  check('Kotlin prop is registered', /Prop\("privateMode"\)/.test(read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt')));
  check('the WebView incognito prop is not used (it would wipe Search cookies)', !/incognito=/.test(read('components/search/CloudflareSolverSheet.tsx')) && !/incognito=/.test(read('app/browser.tsx')));

  // ---- screen wiring ----
  const br = read('app/browser.tsx');
  check('hosts are noted only while private (page, found files, downloads)', (br.match(/getBrowserPrefs\(\)\.privateBrowsing/g) || []).length === 3 && /privateSession\.note\(e\.url\)/.test(br) && /privateSession\.note\(it\.url\)/.test(br));
  check('leaving the browser (unmount) wipes, tab-bar blur does not', /useEffect\(\s*\(\) => \{[\s\S]{0,200}mountedScreens \+= 1[\s\S]{0,500}privateSession\.wipe\(\)/.test(br) && !/useFocusEffect\(\s*useCallback\(\s*\(\) => \(\) => \{\s*setTimeout/.test(br));
  check('app start wipes a killed session', /privateSession\.wipe\(\)/.test(read('app/_layout.tsx')));
  const sess = read('utils/browser/privateSession.ts');
  check('the wipe uses clearCookies, never the whole jar', /clearCookies/.test(sess) && !/cookies: true/.test(sess));
  check('the wipe keeps enabled search sources and site checks', /enabledProviders/.test(sess) && /clearances/.test(sess));
  check('a failed cookie clear is not swallowed (the list stays)', /if \(cookiesOk\)/.test(read('utils/browser/privateHosts.ts')));
  check('the cache clear leaves cookies alone', /cookies: false, cache: true/.test(sess));
  check('indicator shown while private', /prefs\.privateBrowsing \? \(\s*<PixelIcon name="shield"/.test(br));

  // ---- settings ----
  check('settings row is a toggle on the browser page', /historyCopy\.settings\.private\}[\s\S]{0,200}prefs\.privateBrowsing/.test(read('app/settings/browser.tsx')));
  const idx = read('utils/settingsIndex.ts');
  check('settings index entry exists with keywords', /"browser-private-browsing",\s*"Private browsing"/.test(idx) && /"incognito"/.test(idx) && /"don't save"/.test(idx));
  const copy = read('constants/copy.ts');
  check('copy says what it does and what it leaves', /Don't keep history or open tabs, and clear cookies and cached pages from sites you visit when you leave the browser\. Site storage and third-party cookies can stay\./.test(copy));
  check('SECURITY.md states the limit', /Private browsing[^\n]*(site storage|third-party)/i.test(read('SECURITY.md')));
  const kt2 = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/MaglevEngineModule.kt');
  check('native clearCookies expires host-only and Domain forms with Max-Age=0 and path variants', /Max-Age=0; Path=\$path; Secure/.test(kt2) && /Domain=\.\$host; Max-Age=0; Path=\$path/.test(kt2));

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nprivate browsing: all checks passed');
})();
