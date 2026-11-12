#!/usr/bin/env node
// Browser UI logic: address bar parsing, prefs, found-files tray, and the wiring the screens need.
// Needs Node 22.18+ (runs TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

async function main() {
  const u = await import('../utils/browserUrl.ts');
  const prefs = await import('../utils/prefs/browser.ts');
  const f = await import('../components/browser/foundFilter.ts');

  console.log('toBrowserUrl');
  const t = (s, e) => u.toBrowserUrl(s, e);
  check('empty', t('  ').kind === 'empty');
  check('https as is', t('https://example.com/a?b=1').url === 'https://example.com/a?b=1');
  check('http as is', t('http://example.com').url === 'http://example.com');
  check('magnet is a marker', t('magnet:?xt=urn:btih:abc').kind === 'magnet' && t('magnet:?xt=urn:btih:abc').uri === 'magnet:?xt=urn:btih:abc');
  check('bare host gets https', t('example.com/x').url === 'https://example.com/x');
  check('bare host with port', t('example.com:8080/x').url === 'https://example.com:8080/x');
  check('localhost and IPs get http', t('localhost:3000').url === 'http://localhost:3000' && t('192.168.1.5/a').url === 'http://192.168.1.5/a');
  check('words search DuckDuckGo by default', t('big buck bunny').url === 'https://html.duckduckgo.com/html/?q=big%20buck%20bunny');
  check('single word searches', t('ubuntu').url.startsWith('https://html.duckduckgo.com/html/?q=ubuntu'));
  check('engines', t('a b', 'google').url === 'https://www.google.com/search?q=a%20b' && t('a b', 'bing').url.startsWith('https://www.bing.com/search?q=') && t('a b', 'brave').url.startsWith('https://search.brave.com/search?q='));
  check('other schemes become a search', t('javascript:alert(1)').url.startsWith('https://html.duckduckgo.com/') && t('file:///etc/passwd').url.startsWith('https://html.duckduckgo.com/') && t('intent://x#Intent;end').url.startsWith('https://html.duckduckgo.com/'));
  check('a file name with a dot and spaces searches', t('my file.txt').url.startsWith('https://html.duckduckgo.com/'));
  check('query characters are escaped', t('a&b=c').url.endsWith('a%26b%3Dc'));

  console.log('hosts');
  check('hostOf', u.hostOf('https://User:pw@Sub.Example.com:8443/a?b') === 'sub.example.com' && u.hostOf('about:blank') === '');
  check('isHttpsUrl', u.isHttpsUrl('https://x.test/hosts') && !u.isHttpsUrl('http://x.test/hosts') && !u.isHttpsUrl('https://') && !u.isHttpsUrl('x.test'));
  check('toggle adds without www', u.toggleAllowedHost([], 'www.Example.com').join() === 'example.com');
  check('toggle removes a site and its subdomain form', u.toggleAllowedHost(['example.com'], 'm.example.com').length === 0);
  check('allowed covers subdomains', u.isAllowedHost(['example.com'], 'a.b.example.com') && !u.isAllowedHost(['example.com'], 'notexample.com'));
  check('notice rate limit', u.noticeAllowed(0, 100) && !u.noticeAllowed(1000, 5999) && u.noticeAllowed(1000, 6000));

  console.log('maglev://browser');
  const r = u.browserIntentRoute;
  check('url is prefilled, never loaded', r('/browser?url=' + encodeURIComponent('https://x.test/a')) === '/browser?prefill=' + encodeURIComponent('https://x.test/a'));
  check('other params are dropped', r('browser?go=1&url=https%3A%2F%2Fx.test&prefill=https%3A%2F%2Fevil.test') === '/browser?prefill=https%3A%2F%2Fx.test');
  check('non-web url is dropped', r('/browser?url=javascript%3Aalert(1)') === '/browser' && r('/browser?url=file%3A%2F%2F%2Fa') === '/browser');
  check('other routes are left alone', r('/add-download?url=x') === null && r('/settings/browser') === null);

  console.log('prefs');
  const d = prefs.defaultBrowserPrefs();
  check('defaults', d.adBlock === true && d.desktopMode === false && d.searchEngine === 'duckduckgo' && d.allowAdsHosts.length === 0 && d.blocklistUrls[0] === 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts');
  check('default list address matches the bundled list header', read('modules/maglev-engine/android/src/main/assets/blocklist.txt').includes(d.blocklistUrls[0]));
  const n = prefs.normalizeBrowserPrefs({ adBlock: false, allowAdsHosts: ['A.com', 'a.com', 3], blocklistUrls: ['http://x/y', 'https://x/y'], searchEngine: 'nope', desktopMode: true });
  check('normalize', n.adBlock === false && n.allowAdsHosts.join() === 'a.com' && n.blocklistUrls.join() === 'https://x/y' && n.searchEngine === 'duckduckgo' && n.desktopMode === true);
  check('no usable list falls back to the default', prefs.normalizeBrowserPrefs({ blocklistUrls: ['http://x'] }).blocklistUrls[0] === d.blocklistUrls[0]);
  check('garbage gives defaults', JSON.stringify(prefs.normalizeBrowserPrefs(null)) === JSON.stringify(d));
  prefs.updateBrowserPrefs({ desktopMode: true });
  check('update persists in the cache', prefs.getBrowserPrefs().desktopMode === true);

  console.log('found tray');
  const mk = (id, kind, over = {}) => ({ id, url: `https://x.test/${id}`, kind, mime: null, ext: null, name: id, size: null, width: null, height: null, source: 'network', stream: null, pageUrl: 'https://x.test', pageTitle: 't', ...over });
  const items = [mk('a', 'video', { size: 100 }), mk('b', 'image'), mk('c', 'video', { size: 900 }), mk('d', 'video'), mk('e', 'document'), mk('f', 'video', { size: 900 })];
  const counts = f.countByKind(items);
  check('counts', counts.all === 6 && counts.video === 4 && counts.image === 1 && counts.audio === 0);
  check('zero segments hidden, All kept', f.visibleFilters(counts).join() === 'all,video,image,document' && f.visibleFilters(f.countByKind([])).join() === 'all');
  check('video: size desc, then newest', f.sortFound(items, 'video').map((i) => i.id).join() === 'f,c,a,d');
  check('others: newest first', f.sortFound(items, 'all').map((i) => i.id).join() === 'f,e,d,c,b,a');
  check('filter keeps one kind', f.sortFound(items, 'image').length === 1);
  check('empty filter falls back to All', f.effectiveFilter('audio', counts) === 'all' && f.effectiveFilter('video', counts) === 'video');
  const merged = f.mergeFound(items, [mk('a', 'video'), mk('z', 'audio')]);
  check('merge skips known ids', merged.length === 7 && merged[6].id === 'z');
  const many = f.mergeFound([], Array.from({ length: 520 }, (_, i) => mk('i' + i, 'image')));
  check('merge caps at 500, newest kept', many.length === 500 && many[499].id === 'i519' && many[0].id === 'i20');
  check('installers', ['apk', 'exe', 'msi', 'dmg', 'bat', 'cmd', 'scr'].every((e) => f.isInstaller({ ext: e, name: 'x' })) && f.isInstaller({ ext: null, name: 'Setup.EXE' }) && !f.isInstaller({ ext: 'zip', name: 'a.zip' }));
  check('stream tags', f.streamTag({ stream: 'hls' }) === 'HLS' && f.streamTag({ stream: 'dash' }) === 'DASH' && f.streamTag({ stream: null }) === null);

  console.log('wiring');
  const exists = (p) => fs.existsSync(path.join(root, p));
  check('screens exist', exists('app/browser.tsx') && exists('app/settings/browser.tsx') && exists('components/browser/FoundTray.tsx'));
  if (exists('app/browser.tsx')) {
    const b = read('app/browser.tsx');
    check('browser never feeds onPage.url back into the url prop', !/setUrl\(\s*e\.url|setUrl\(\s*page\.url|url=\{page\.url/.test(b));
    check('browser handles back while the page can go back', /canGoBack/.test(b) && /goBack\(\)/.test(b) && /BackHandler/.test(b));
    check('downloads send the page user agent', /User-Agent/.test(read('components/browser/FoundDownload.tsx')));
    check('streams do not say "later"', !/later version/i.test(b + read('components/browser/FoundTray.tsx') + read('constants/copy.ts')));
  }
  check('native intent routes maglev://browser', /browserIntentRoute/.test(read('app/+native-intent.tsx')));
  check('search tab has Browse the web', /Browse the web/.test(read('app/(tabs)/search.tsx')));
  check('settings list has Browser row', /route: 'browser'/.test(read('app/(tabs)/settings.tsx')));
  check('add-download offers Open in browser', /Open in browser/.test(read('app/add-download.tsx')));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll browser UI checks passed.');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
