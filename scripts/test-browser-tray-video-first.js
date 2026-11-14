#!/usr/bin/env node
// Found-files tray, video first: default filter, page title as the source line, hide small files,
// size sort for every kind. Needs Node 22.18+ (runs TypeScript source directly).
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
const MB = 1024 * 1024;
const mk = (id, over = {}) => ({
  id, url: `https://cdn.test/${id}.mp4`, kind: 'video', mime: 'video/mp4', ext: 'mp4', name: `${id}.mp4`,
  size: null, width: null, height: null, source: 'network', stream: null, pageUrl: 'https://www.site.test/a', pageTitle: 'A film', ...over,
});

async function main() {
  const f = await import('../components/browser/foundFilter.ts');
  const prefs = await import('../utils/prefs/browser.ts');
  const copy = await import('../constants/copy.ts');

  console.log('default filter');
  const withVideo = f.countByKind([mk('a'), mk('b', { kind: 'image' })]);
  const noVideo = f.countByKind([mk('b', { kind: 'image' })]);
  check('opens on Video when a video exists', f.defaultFilter(withVideo) === 'video');
  check('opens on All when there is no video', f.defaultFilter(noVideo) === 'all');
  const k1 = f.pageKeyOf([mk('a')]);
  check('a chosen filter is kept on the same page', f.chosenFilter({ key: k1, filter: 'image' }, k1) === 'image');
  check('a chosen filter resets on a new page', f.chosenFilter({ key: k1, filter: 'image' }, f.pageKeyOf([mk('z', { pageUrl: 'https://site.test/b' })])) === null);
  check('a #fragment is the same page', f.pageKeyOf([mk('a', { pageUrl: 'https://www.site.test/a#x' })]) === k1);
  check('no choice returns null', f.chosenFilter(null, k1) === null);

  console.log('row source line');
  check('the page title is the source', f.sourceLabel(mk('a')) === 'A film');
  check('a blank title falls back to the site host', f.sourceLabel(mk('a', { pageTitle: '  ' })) === 'site.test');
  check('the fallback is never the CDN host', f.sourceLabel(mk('a', { pageTitle: '' })) !== 'cdn.test');
  check('a two-part country suffix keeps three labels', f.sourceLabel(mk('a', { pageTitle: '', pageUrl: 'https://m.news.example.co.uk/x' })) === 'example.co.uk');
  check('a subdomain collapses to the registrable host', f.sourceLabel(mk('a', { pageTitle: '', pageUrl: 'https://video.site.test/x' })) === 'site.test');

  console.log('hide small files');
  const items = [
    mk('smallv', { size: 500 * 1024 }),
    mk('bigv', { size: 5 * MB }),
    mk('smalla', { kind: 'audio', ext: 'mp3', size: 900 * 1024 }),
    mk('smalli', { kind: 'image', ext: 'jpg', size: 10 * 1024 }),
    mk('bigi', { kind: 'image', ext: 'jpg', size: 60 * 1024 }),
    mk('unk', { size: null }),
    mk('unki', { kind: 'image', size: null }),
    mk('hls', { stream: 'hls', ext: 'm3u8', size: 100 }),
    mk('tinydoc', { kind: 'document', ext: 'pdf', size: 10 }),
  ];
  const r = f.splitSmall(items);
  check('hidden: small video, audio and image', r.hidden.map((i) => i.id).sort().join() === 'smalla,smalli,smallv');
  check('shown keeps unknown sizes, streams, big files and documents', r.shown.map((i) => i.id).sort().join() === 'bigi,bigv,hls,tinydoc,unk,unki');
  check('exactly 1 MB video is kept', f.splitSmall([mk('e', { size: MB })]).hidden.length === 0);
  check('exactly 50 KB image is kept', f.splitSmall([mk('e', { kind: 'image', size: 50 * 1024 })]).hidden.length === 0);
  check('input is not mutated', items.length === 9);
  check('probed size can decide', f.splitSmall([mk('p')], () => 10).hidden.length === 1);
  check('hide small is on by default', prefs.defaultBrowserPrefs().hideSmallFiles === true);
  check('hide small can be turned off and survives a parse', prefs.normalizeBrowserPrefs({ hideSmallFiles: false }).hideSmallFiles === false);
  check('a missing value means on', prefs.normalizeBrowserPrefs({}).hideSmallFiles === true);
  check('copy has the toggle and the count', typeof copy.foundTray.hideSmall === 'string' && copy.foundTray.hidden(3) === '3 hidden');

  console.log('size sort for every kind');
  const doc = (id, size, over = {}) => mk(id, { kind: 'document', ext: 'pdf', size, ...over });
  const sorted = f.sortFound([doc('d1', 10), doc('d2', null), doc('d3', 900), doc('d4', 500)], 'document').map((i) => i.id).join();
  check('documents: largest first, unknown last', sorted === 'd3,d4,d1,d2', sorted);
  const all = f.sortFound([mk('v1', { size: 1 * MB }), doc('d1', 5 * MB), mk('n', { size: null })], 'all').map((i) => i.id).join();
  check('All: largest first across kinds, unknown last', all === 'd1,v1,n', all);
  const ties = f.sortFound([doc('o', null), doc('n', null)], 'document').map((i) => i.id).join();
  check('ties: newest first', ties === 'n,o', ties);

  console.log('tray wiring');
  const tray = read('components/browser/FoundTray.tsx');
  check('tray uses the default filter', /defaultFilter\(/.test(tray) && /pageKeyOf\(/.test(tray));
  check('tray shows the source label, not the CDN host', /sourceLabel\(/.test(tray) && !/hostOf\(item\.url\)/.test(tray));
  check('tray reads and writes the pref', /useBrowserPrefs/.test(tray) && /hideSmallFiles/.test(tray));
  check('tray applies splitSmall', /splitSmall\(/.test(tray));
  check('tray labels come from copy', /foundTray\.hideSmall/.test(tray) && /foundTray\.hidden\(/.test(tray));
  check('hidden control has a 44px target', /minHeight: 44/.test(tray));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall ok');
}
main().catch((e) => { console.error(e); process.exit(1); });
