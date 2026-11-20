#!/usr/bin/env node
// Long press on an image or video: payload parsing, URL resolution, classification, menu rows, and source checks
// of the injected page script. Pure; no network. Needs Node 22.18+ (type stripping).
//   node scripts/test-media-hit.js
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${JSON.stringify(extra)})` : ''}`);
  }
}
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

(async () => {
  const M = await import('../utils/browser/mediaHit.ts');
  const S = await import('../utils/browser/mediaHitScript.ts');
  const PAGE = 'https://example.com/a/b/page.html?x=1#top';
  const payload = (o) => ({ type: 'maglev-media-hit', pageUrl: PAGE, ...o });
  const ids = (m) => m.items.map((i) => i.id);

  // ---- URL resolution
  const R = (u) => M.resolveHttpUrl(u, PAGE);
  check('absolute http kept', R('http://cdn.test/x.jpg') === 'http://cdn.test/x.jpg');
  check('protocol-relative', R('//cdn.test/x.jpg') === 'https://cdn.test/x.jpg');
  check('root-relative', R('/img/x.jpg?v=2') === 'https://example.com/img/x.jpg?v=2', R('/img/x.jpg?v=2'));
  check('relative', R('x.jpg') === 'https://example.com/a/b/x.jpg', R('x.jpg'));
  check('dot segments', R('../../y.png') === 'https://example.com/y.png', R('../../y.png'));
  check('dot segments above root stay at root', R('../../../../y.png') === 'https://example.com/y.png');
  check('query only', R('?q=2') === 'https://example.com/a/b/page.html?q=2', R('?q=2'));
  check('fragment dropped', R('x.jpg#frag') === 'https://example.com/a/b/x.jpg');
  check('blob rejected', R('blob:https://example.com/uuid') === null);
  check('data rejected', R('data:image/png;base64,AAAA') === null);
  check('javascript rejected', R('javascript:alert(1)') === null);
  check('file rejected', R('file:///sdcard/x.jpg') === null);
  check('empty and non-string rejected', R('') === null && R(null) === null && R(5) === null);
  check('whitespace inside rejected', R('http://a.test/a b.jpg') === null);
  check('relative with bad page url rejected', M.resolveHttpUrl('x.jpg', 'blob:abc') === null);

  // ---- parse
  const img = M.parseMediaHit(payload({ kind: 'image', src: '/i/cat.jpg', alt: 'A cat' }));
  check('image parsed and resolved', img && img.kind === 'image' && img.url === 'https://example.com/i/cat.jpg' && img.alt === 'A cat', img);
  check('JSON string accepted', M.parseMediaHit(JSON.stringify(payload({ kind: 'image', src: 'https://a.test/x.png' })))?.url === 'https://a.test/x.png');
  check('wrong type rejected', M.parseMediaHit({ type: 'other', kind: 'image', src: 'https://a.test/x.png' }) === null);
  check('missing type rejected', M.parseMediaHit({ kind: 'image', src: 'https://a.test/x.png' }) === null);
  check('link kind is left to the link menu', M.parseMediaHit(payload({ kind: 'link', src: 'https://a.test/' })) === null);
  check('junk rejected', M.parseMediaHit('{nope') === null && M.parseMediaHit(null) === null && M.parseMediaHit(7) === null);
  check('no media at all rejected', M.parseMediaHit(payload({ kind: 'image' })) === null);

  // ---- classification
  const vc = (src) => M.parseMediaHit(payload({ kind: 'video', src }))?.videoClass;
  check('mp4 is direct', vc('https://a.test/v.mp4') === 'direct');
  check('relative mp4 is direct', vc('v.mp4') === 'direct');
  check('m3u8 is hls', vc('https://a.test/live/master.m3u8?t=1') === 'hls');
  check('mpd is dash', vc('/dash/manifest.mpd') === 'dash');
  check('blob is blob', vc('blob:https://example.com/uuid') === 'blob');
  check('data video is data', vc('data:video/mp4;base64,AAAA') === 'data');
  check('empty src with poster is none', M.parseMediaHit(payload({ kind: 'video', src: '', poster: '/p.jpg' }))?.videoClass === 'none');

  // ---- menus
  const imgMenu = M.buildMediaMenu(img);
  check('image rows', JSON.stringify(ids(imgMenu)) === JSON.stringify(['save-image', 'open-tab', 'copy', 'share']), ids(imgMenu));
  check('image titles', imgMenu.items.map((i) => i.title).join('|') === 'Save image|Open image in new tab|Copy image address|Share image link');
  check('image rows carry the address', imgMenu.items.every((i) => i.url === 'https://example.com/i/cat.jpg') && imgMenu.note === null);

  const mp4 = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'video', src: 'https://a.test/v.mp4' })));
  check('direct video rows', JSON.stringify(ids(mp4)) === JSON.stringify(['download-video', 'open-tab', 'copy']), ids(mp4));
  check('direct video titles', mp4.items.map((i) => i.title).join('|') === 'Download video|Open video in new tab|Copy video address');

  const hls = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'video', src: 'https://a.test/m.m3u8' })));
  check('hls goes to the stream path', ids(hls)[0] === 'download-stream' && hls.items[0].title === 'Download video', ids(hls));

  const blob = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'video', src: 'blob:https://example.com/u', poster: '/p.jpg' })));
  check('blob video: plain note, found tray, no download, no copy', !!blob.note && /can't save/.test(blob.note) && ids(blob).includes('show-found') && !ids(blob).includes('download-video') && !ids(blob).includes('copy'), ids(blob));
  check('blob video with poster offers the poster', ids(blob)[0] === 'save-poster' && blob.items[0].url === 'https://example.com/p.jpg');
  const noPoster = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'video', src: 'blob:https://example.com/u' })));
  check('blob video without poster is just the tray row', JSON.stringify(ids(noPoster)) === JSON.stringify(['show-found']));

  const dataImg = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'image', src: 'data:image/png;base64,AAAA' })));
  check('data image: not supported, said plainly, no rows', dataImg.items.length === 0 && /can't save/.test(dataImg.note));

  const combo = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'image', src: 'https://a.test/t.jpg', linkHref: '/post/1' })));
  check('image in a link adds Link options last', ids(combo).at(-1) === 'link-options' && combo.items.at(-1).url === 'https://example.com/post/1', ids(combo));
  const magnet = M.parseMediaHit(payload({ kind: 'image', src: 'https://a.test/t.jpg', linkHref: 'magnet:?xt=urn:btih:abc' }));
  check('magnet link kept on the link only', magnet.linkHref === 'magnet:?xt=urn:btih:abc');
  const bad = M.parseMediaHit(payload({ kind: 'image', src: 'https://a.test/t.jpg', linkHref: 'javascript:void(0)' }));
  check('script link dropped', bad.linkHref === null && !ids(M.buildMediaMenu(bad)).includes('link-options'));
  const blobLink = M.buildMediaMenu(M.parseMediaHit(payload({ kind: 'video', src: 'blob:x', linkHref: 'https://a.test/watch' })));
  check('blob video in a link keeps Link options', ids(blobLink).includes('link-options'));
  check('hasMenu', M.hasMenu(imgMenu) && M.hasMenu(dataImg) && !M.hasMenu({ note: null, items: [] }));

  // ---- the script
  const js = S.mediaHitScript('abc_123');
  check('script is a string that embeds the nonce', typeof js === 'string' && js.includes('"abc_123"') && !js.includes('%NONCE%'));
  check('nonce is sanitised', !S.mediaHitScript('a"b;x').includes('a"b'));
  check('script parses', (() => { try { new Function(js); return true; } catch (e) { return String(e); } })() === true);
  check('posts the media-hit type', js.includes("'maglev-media-hit'") && js.includes('ReactNativeWebView') && js.includes('postMessage'));
  check('falls back to the page bridge', js.includes('MaglevScan.report'));
  check('wrapped in try/catch and one function', /^\s*\(function \(\) \{\s*try \{/.test(js) && (js.match(/try \{/g) || []).length >= 8);
  check('idempotent marker', js.includes('__maglevMH') && /if \(window\.__maglevMH\) return;/.test(js));
  check('listens for contextmenu', js.includes("addEventListener('contextmenu'"));
  check('touch timer fallback, cancelled on move/end/cancel', js.includes("'touchstart'") && js.includes("'touchmove'") && js.includes("'touchend'") && js.includes("'touchcancel'") && js.includes('clearTimeout'));
  const preventCalls = js.match(/preventDefault\(\)/g) || [];
  check('preventDefault only in contextmenu, after a hit', preventCalls.length === 1 && /if \(!o\) return;\s*last = o;\s*e\.preventDefault\(\);/.test(js));
  check('srcset largest candidate', js.includes('function largest') && js.includes('srcset'));
  check('handles picture, source and poster', js.includes('PICTURE') && js.includes('SOURCE') && js.includes('poster'));
  check('no global leaks (only non-enumerable defineProperty)', (js.match(/window\.[A-Za-z_]+ =/g) || []).length === 0);

  // Run the script against a tiny fake DOM to prove behaviour.
  const posts = [];
  const listeners = {};
  const imgEl = {
    nodeType: 1, tagName: 'IMG', currentSrc: '', parentNode: null, title: '',
    getAttribute: (k) => ({ srcset: 'a-1x.jpg 1x, a-2x.jpg 2x, a-small.jpg 320w', src: 'a-1x.jpg', alt: 'Pic' })[k] || null,
    closest(sel) { return /img/.test(sel) && sel.includes('img') ? this : /^a\[href\]/.test(sel) ? { href: 'https://example.com/post' } : null; },
  };
  const textEl = { nodeType: 1, tagName: 'P', closest: () => null, getAttribute: () => null };
  const win = { ReactNativeWebView: { postMessage: (m) => posts.push(JSON.parse(m)) } };
  const doc = { baseURI: 'https://example.com/a/', addEventListener: (t, f) => (listeners[t] = f), elementsFromPoint: () => [] };
  new Function('window', 'document', 'location', 'Date', 'setTimeout', 'clearTimeout', 'URL', 'Object', 'JSON', 'Math', 'parseFloat', S.mediaHitScript('n'))(
    win, doc, { href: 'https://example.com/a/page' }, Date, setTimeout, clearTimeout, URL, Object, JSON, Math, parseFloat,
  );
  let prevented = 0;
  listeners.contextmenu({ target: textEl, clientX: 1, clientY: 1, preventDefault: () => prevented++ });
  check('plain text: no post, no preventDefault', posts.length === 0 && prevented === 0);
  listeners.contextmenu({ target: imgEl, clientX: 1, clientY: 1, preventDefault: () => prevented++ });
  check('image: posted once and prevented', posts.length === 1 && prevented === 1, posts);
  const got = M.parseMediaHit(posts[0]);
  check('largest srcset candidate chosen and resolved against the page', got && got.url === 'https://example.com/a/a-2x.jpg' && got.linkHref === 'https://example.com/post', got);
  check('native pull returns the hit', JSON.parse(win.__maglevMediaHit()).src.endsWith('a-2x.jpg'));
  check('install marker is not enumerable', !Object.keys(win).includes('__maglevMH'));
  const before = Object.keys(listeners).length;
  new Function('window', 'document', S.mediaHitScript('n'))(win, doc);
  check('second injection does nothing', Object.keys(listeners).length === before && posts.length === 1);

  // ---- component wiring (source)
  const comp = read('components/browser/MediaMenu.tsx');
  check('MediaMenu props', ['hit', 'onClose', 'onSave', 'onOpenNewTab', 'onCopy', 'onShare', 'onShowFound', 'onLinkOptions'].every((p) => comp.includes(p)));
  check('MediaMenu uses FloatingSheet and ListRow and no hex', comp.includes('FloatingSheet') && comp.includes('ListRow') && !/#[0-9a-fA-F]{6}/.test(comp));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall media-hit checks passed');
})();
