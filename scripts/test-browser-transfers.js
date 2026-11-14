#!/usr/bin/env node
// Progress and "already have it" in the browser (docs/BROWSER_DOWNLOAD_GAPS.md R3): the downloads chip, the
// "In Transfers" tag matched on the normalized link, and the View action on the "Added to Transfers" notice.
// The snapshot only carries urlDisplay (scheme, host, path; no query), so a link with a query never matches.
// Needs Node 22.18+ (runs TypeScript source directly).
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
const item = (id, url, over = {}) => ({ id, url, kind: 'video', mime: 'video/mp4', ext: 'mp4', name: `${id}.mp4`, size: null, width: null, height: null, source: 'network', stream: null, pageUrl: 'https://site.test/a', pageTitle: 'A', ...over });
const dl = (id, urlDisplay, over = {}) => ({ id, urlDisplay, name: `${id}.mp4`, state: 'downloading', size: null, downloaded: 0, addedAt: 1, ...over });

async function main() {
  const t = await import('../components/browser/foundTransfers.ts');

  console.log('transferKey (same rules as the native normalize, minus the query)');
  check('scheme and host are lower case', t.transferKey('HTTPS://CDN.Test/A/b.mp4') === 'https://cdn.test/A/b.mp4');
  check('fragment is dropped', t.transferKey('https://cdn.test/a.mp4#t=5') === 'https://cdn.test/a.mp4');
  check('credentials are dropped', t.transferKey('https://u:p@cdn.test/a.mp4') === 'https://cdn.test/a.mp4');
  check('an empty path is /', t.transferKey('https://cdn.test') === 'https://cdn.test/');
  check('the query is dropped (the snapshot has none)', t.transferKey('https://cdn.test/a.mp4?token=1') === 'https://cdn.test/a.mp4');
  check('blob and data are not keys', t.transferKey('blob:https://x.test/1') === null && t.transferKey('data:text/plain,1') === null);

  console.log('matchTransfers');
  const items = [item('a', 'https://cdn.test/a.mp4'), item('b', 'https://cdn.test/b.mp4'), item('c', 'https://cdn.test/c.mp4?id=7')];
  const m = t.matchTransfers(items, [dl('d1', 'https://cdn.test/a.mp4'), dl('d2', 'https://cdn.test/c.mp4')]);
  check('a row whose link is a download matches', m.get('a') === 'd1');
  check('a different path does not match', !m.has('b'));
  check('a row with a query never matches (no false "saved")', !m.has('c'));
  check('a range parameter does not change the match', t.matchTransfers([item('a', 'https://cdn.test/a.mp4?range=0-99')], [dl('d1', 'https://cdn.test/a.mp4')]).get('a') === 'd1');
  check('a finished and an errored download both match', t.matchTransfers(items, [dl('d1', 'https://cdn.test/a.mp4', { state: 'finished' })]).has('a') && t.matchTransfers(items, [dl('d1', 'https://cdn.test/a.mp4', { state: 'error' })]).has('a'));
  check('the newest download wins', t.matchTransfers(items, [dl('old', 'https://cdn.test/a.mp4', { addedAt: 1 }), dl('new', 'https://cdn.test/a.mp4', { addedAt: 9 })]).get('a') === 'new');
  check('no downloads, no tags', t.matchTransfers(items, []).size === 0);
  check('a stream matches by its playlist address', t.matchTransfers([item('s', 'https://cdn.test/v/master.m3u8', { stream: 'hls' })], [dl('d1', 'https://cdn.test/v/master.m3u8')]).get('s') === 'd1');

  console.log('activeSummary');
  check('none running gives null', t.activeSummary([dl('a', 'https://x.test/a', { state: 'finished' }), dl('b', 'https://x.test/b', { state: 'paused' })]) === null);
  const two = t.activeSummary([dl('a', 'https://x.test/a', { size: 100, downloaded: 50 }), dl('b', 'https://x.test/b', { size: 100, downloaded: 30 })]);
  check('counts downloading ones', two && two.count === 2);
  check('percent is total downloaded over total size', two && two.percent === 40);
  const unk = t.activeSummary([dl('a', 'https://x.test/a', { size: 100, downloaded: 50 }), dl('b', 'https://x.test/b', { size: null, downloaded: 30 })]);
  check('a running download of unknown size leaves the percent unknown', unk && unk.count === 2 && unk.percent === null);
  check('percent never passes 100', t.activeSummary([dl('a', 'https://x.test/a', { size: 10, downloaded: 99 })]).percent === 100);
  check('label with a percent', t.activeLabel({ count: 2, percent: 40 }) === '2 downloading · 40%');
  check('label without a percent', t.activeLabel({ count: 1, percent: null }) === '1 downloading');

  console.log('wiring');
  const scr = read('app/browser.tsx');
  const tray = read('components/browser/FoundTray.tsx');
  const sheet = read('components/browser/FoundDownload.tsx');
  check('the screen reads the downloads list', /downloads/.test(scr) && /useMaglevEngine\(\)/.test(scr));
  check('the screen computes the matches and the summary', /matchTransfers\(/.test(scr) && /activeSummary\(/.test(scr));
  check('the footer chip opens Transfers', /activeLabel\(/.test(scr) && /router\.(push|navigate)\(/.test(scr));
  check('the chip is at least 44 px and labelled', /accessibilityLabel=\{[^}]*download/i.test(scr));
  check('the tray shows the tag', /foundTray\.inTransfers/.test(tray));
  check('tapping a tagged row opens that transfer', /onOpenTransfer/.test(tray) && /onOpenTransfer=/.test(scr));
  check('the notice offers View', /actionLabel:\s*foundTray\.view/.test(sheet) && /onAction/.test(sheet));
  check('the sheet is told how to open a transfer', /onView/.test(sheet) && /onView=/.test(scr));
  const copy = await import('../constants/copy.ts');
  check('copy exists', copy.foundTray.inTransfers === 'In Transfers' && copy.foundTray.view === 'View');
}

main().then(() => {
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall ok');
}, (e) => { console.error(e); process.exit(1); });
