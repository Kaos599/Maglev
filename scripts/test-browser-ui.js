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
  const enc = encodeURIComponent('https://x.test/a');
  check('full maglev://browser?url= only prefills', r('maglev://browser?url=' + enc) === '/browser?prefill=' + enc);
  check('maglev:///browser?url= only prefills', r('maglev:///browser?url=' + enc) === '/browser?prefill=' + enc);
  check('full url, no param, is the bare route', r('maglev://browser') === '/browser' && r('MAGLEV://browser/') === '/browser');
  check('full url, evil scheme dropped', r('maglev://browser?url=javascript%3Aalert(1)') === '/browser');
  check('appPath leaves other schemes', u.appPath('magnet:?xt=1') === 'magnet:?xt=1' && u.appPath('https://a.test/x') === 'https://a.test/x');
  {
    const src = read('app/+native-intent.tsx');
    check('native intent normalises the full url for dl_ too', /appPath\(raw\)/.test(src));
  }
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
  {
    const h = (id, path, over = {}) => mk(id, 'video', { url: 'https://s.test' + path, stream: 'hls', pageUrl: 'https://p.test', ...over });
    const m = h('m', '/x36/x36.m3u8');
    const hid = f.hideVariantPlaylists([m, h('v0', '/x36/url_0/a.m3u8'), h('v1', '/x36/url_2/b.m3u8'), h('v2', '/x36/c.m3u8'), mk('mp4', 'video')]);
    check('variants of a master are hidden', hid.map((i) => i.id).join() === 'm,mp4');
    check('a lone stream is kept', f.hideVariantPlaylists([h('v0', '/x36/url_0/a.m3u8')]).length === 1);
    check('a different page or origin is kept', f.hideVariantPlaylists([m, h('o', '/x36/o.m3u8', { pageUrl: 'https://q.test' }), h('p', '/x36/p.m3u8', { url: 'https://other.test/x36/p.m3u8' })]).length === 3);
    check('a playlist in a sibling folder above is kept', f.hideVariantPlaylists([h('a', '/x/a/m.m3u8'), h('b', '/x/b.m3u8')]).length === 2);
    check('a playlist at the server root hides nothing', f.hideVariantPlaylists([h('r', '/master.m3u8'), h('s', '/films/b/master.m3u8')]).length === 2);
    check('browser wires hideVariantPlaylists', /hideVariantPlaylists\(foundAll\)/.test(read('app/browser.tsx')));
  }
  check('empty filter falls back to All', f.effectiveFilter('audio', counts) === 'all' && f.effectiveFilter('video', counts) === 'video');
  const merged = f.mergeFound(items, [mk('a', 'video'), mk('z', 'audio')]);
  check('merge skips known ids', merged.length === 7 && merged[6].id === 'z');
  const many = f.mergeFound([], Array.from({ length: 520 }, (_, i) => mk('i' + i, 'image')));
  check('merge caps at 500, newest kept', many.length === 500 && many[499].id === 'i519' && many[0].id === 'i20');
  check('installers', ['apk', 'exe', 'msi', 'dmg', 'bat', 'cmd', 'scr'].every((e) => f.isInstaller({ ext: e, name: 'x' })) && f.isInstaller({ ext: null, name: 'Setup.EXE' }) && !f.isInstaller({ ext: 'zip', name: 'a.zip' }));
  check('stream tags', f.streamTag({ stream: 'hls' }) === 'HLS' && f.streamTag({ stream: 'dash' }) === 'DASH' && f.streamTag({ stream: null }) === null);

  console.log('stream choices');
  const sc = await import('../components/browser/streamChoice.ts');
  const V = (id, height, bandwidth, estBytes, audio = 'muxed') => ({ id, height, width: null, bandwidth, codecs: null, estBytes, audio });
  const vs = [V('a', 720, 2e6, 1.5e9), V('b', 1080, 4e6, 1.2 * 1024 ** 3), V('c', 480, 1e6, null)];
  check('default is the tallest', sc.defaultVariant(vs).id === 'b' && sc.defaultVariant([]) === null);
  check('default without heights is the biggest bandwidth', sc.defaultVariant([V('x', null, 1e6, null), V('y', null, 3e6, null)]).id === 'y');
  check('label has height and size', sc.qualityLabel(vs[1], vs) === '1080p · about 1.2 GB');
  check('label omits unknown size', sc.qualityLabel(vs[2], vs) === '480p');
  const blind = [V('x', null, 1e6, null), V('y', null, 2e6, null), V('z', null, 3e6, null)];
  {
    const au = { id: 'v9', height: null, width: null, bandwidth: 128000, codecs: 'mp4a.40.2', estBytes: 1015808, audio: 'muxed' };
    const vid = { id: 'v1', height: 720, width: 1280, bandwidth: 2000000, codecs: 'avc1.4d401f,mp4a.40.2', estBytes: null, audio: 'muxed' };
    check('audio-only variant is labelled Audio only', sc.qualityName(au, [au, vid]) === 'Audio only' && /^Audio only · about /.test(sc.qualityLabel(au, [au, vid])));
    check('blind variant with a video codec is still tiered', sc.qualityName({ ...vid, height: null }, [{ ...vid, height: null }]) === 'Medium quality');
    check('no codecs info is not called audio only', sc.isAudioOnly({ ...au, codecs: null }) === false);
    const b1 = { ...vid, id: 'b1', height: null, bandwidth: 1 }, b2 = { ...vid, id: 'b2', height: null, bandwidth: 2 };
    check('audio-only does not shift the quality tiers', sc.qualityName(b1, [b1, b2, au]) === 'Low quality' && sc.qualityName(b2, [b1, b2, au]) === 'High quality');
  }
  check('stream links are told by path', sc.streamKindOfLink('https://a.test/x/v.m3u8?t=1') === 'hls' && sc.streamKindOfLink('https://a.test/v.MPD#x') === 'dash' && sc.streamKindOfLink('https://a.test/v.mp4') === null && sc.streamKindOfLink('https://a.test/m3u8/file.zip') === null);
  check('add download probes streams and opens the stream sheet', /streamKindOfLink\(input\)/.test(read('app/add-download.tsx')) && /<StreamSheet item=\{streamItem\}/.test(read('app/add-download.tsx')));
  check('no height falls back to bandwidth tiers', sc.qualityName(blind[0], blind) === 'Low quality' && sc.qualityName(blind[1], blind) === 'Medium quality' && sc.qualityName(blind[2], blind) === 'High quality' && sc.qualityName(blind[0], [blind[0]]) === 'Medium quality');
  const tr = [{ id: 't1', lang: 'en', name: 'English', bandwidth: null }, { id: 't2', lang: 'fr', name: null, bandwidth: null }, { id: 't3', lang: null, name: null, bandwidth: null }];
  check('audio label: name, lang, Track N', sc.audioLabel(tr[0], 0) === 'English' && sc.audioLabel(tr[1], 1) === 'fr' && sc.audioLabel(tr[2], 2) === 'Track 3');
  check('audio picker only for separate audio with 2+ tracks', sc.needsAudioPicker(V('s', 1, 1, 1, 'separate'), tr) && !sc.needsAudioPicker(V('m', 1, 1, 1, 'muxed'), tr) && !sc.needsAudioPicker(V('s', 1, 1, 1, 'separate'), [tr[0]]));
  check('default audio is first, a valid pick is kept', sc.defaultAudio(tr) === 't1' && sc.defaultAudio(tr, 't2') === 't2' && sc.defaultAudio(tr, 'gone') === 't1' && sc.defaultAudio([]) === null);
  const sel = sc.buildSelection('hls', { audioTracks: tr }, V('s', 1, 1, 1, 'separate'), 't2');
  check('selection carries audio only when separate', sel.audioId === 't2' && sel.variantId === 's' && sel.kind === 'hls' && !('audioId' in sc.buildSelection('dash', { audioTracks: tr }, V('m', 1, 1, 1, 'muxed'), 't2')));

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
  check('stream sheet probes and starts with the stream selection', /probeStream/.test(read('components/browser/StreamSheet.tsx')) && /stream:/.test(read('components/browser/StreamSheet.tsx')) && /StreamSheet/.test(read('app/browser.tsx')));
  check('native intent routes maglev://browser', /browserIntentRoute/.test(read('app/+native-intent.tsx')));
  {
    const b = read('app/browser.tsx');
    const k = read('modules/maglev-engine/android/src/main/java/com/maglev/engine/browser/MaglevBrowserView.kt');
    check('a download hand-off ends loading in the screen', /onDownloadRequest = useCallback[\s\S]{0,200}loading: false/.test(b));
    check('Stop always clears loading in the screen', /browserRef\.current\?\.stop\(\);\s*setPage\(\(p\) => \(p \? \{ \.\.\.p, loading: false \}/.test(b));
    check('native download hand-off and stop emit loading false', /private fun onDownload[\s\S]{0,900}loading = false[\s\S]{0,40}emitPage/.test(k) && /fun stop\(\)[\s\S]{0,200}loading = false/.test(k));
  }
  check('perf measure prints null percentiles when no frames', /f\+0 == 0[\s\S]{0,120}\\"p50\\":null[\s\S]{0,200}no frames \(list empty\?\)/.test(read('scripts/perf/measure.sh')));
  check('search tab has a labelled Browser button', /label="Browser"/.test(read('app/(tabs)/search.tsx')));
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
