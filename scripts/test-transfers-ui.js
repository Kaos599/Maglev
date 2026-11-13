#!/usr/bin/env node
// Transfers card status lines, link-download speed in the header total, clipboard links and
// mixed selection. Pure helpers only, no React.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

const torrent = (o = {}) => ({
  id: 'a', name: 'x', state: 'DOWNLOADING', finished: false, downloadSpeedBytes: 3.2 * MB, uploadSpeedBytes: 0,
  progressPercent: 34, downloadedBytes: 412 * MB, uploadedBytes: 0, totalSizeBytes: 1.2 * GB, etaSeconds: 90,
  includedBytes: 0, pausedBy: null, error: null, ...o,
});
const dl = (o = {}) => ({
  id: 'dl_1', urlDisplay: 'https://x.test/a.bin', name: 'a.bin', state: 'downloading', pausedBy: null, size: 1.2 * GB,
  downloaded: 412 * MB, downBps: 3.2 * MB, eta: 90, segmentsActive: 1, resumable: true, folder: '/d', addedAt: 1, error: null, ...o,
});

async function main() {
  const model = await import('../components/transfers/model.ts');
  const copy = await import('../utils/downloadCopy.ts');
  const { isAddableLink } = await import('../utils/addableLink.ts');
  const { selectionKey, parseSelectionKey, splitSelection } = await import('../utils/bulkSummary.ts');

  console.log('torrent status');
  let s = model.torrentStatus(torrent(), '1 min');
  check('downloading lead keeps time left and speed', s.lead === '1 min left' && s.value === '3.2 MB/s', JSON.stringify(s));
  check('downloading shows size and percent', /412 MB of 1\.2 GB · 34%/.test(s.sub ?? ''), s.sub);
  check('text has everything for screen readers', /412 MB of 1\.2 GB · 34%/.test(s.text) && /1 min left/.test(s.text) && /3\.2 MB\/s/.test(s.text), s.text);
  s = model.torrentStatus(torrent({ includedBytes: 600 * MB }), '1 min');
  check('includedBytes is the total when set', /412 MB of 600 MB · 69%/.test(s.sub ?? ''), s.sub);
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0 }), '—');
  check('0% still shows the size', /^0 B of 1\.2 GB · 0%$/.test(s.sub ?? ''), s.sub);
  s = model.torrentStatus(torrent({ downloadedBytes: 1.2 * GB - 1, progressPercent: 99.99 }), '1s');
  check('almost done never rounds up to 100%', /· 99%$/.test(s.sub ?? ''), s.sub);
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'user' }), '—');
  check('paused keeps how far it got', s.lead === 'Paused' && /412 MB of 1\.2 GB · 34%/.test(s.sub ?? ''), JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'wifi_only' }), '—');
  check('paused for wifi keeps how far it got', /Wi-Fi/.test(s.lead) && !!s.sub);
  s = model.torrentStatus(torrent({ state: 'COMPLETED', finished: true, downloadedBytes: 1.2 * GB }), '—');
  check('done shows total, no progress line', s.lead === 'Done' && s.value === '1.2 GB' && !s.sub);
  s = model.torrentStatus(torrent({ state: 'SEEDING', finished: true }), '—');
  check('seeding has no progress line', s.lead === 'Done · Seeding' && !s.sub);
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'user', downloadedBytes: 0 }), '—');
  check('paused with nothing downloaded has no progress line', !s.sub);
  check('progress percent uses included bytes', Math.round(model.torrentProgressPercent(torrent({ includedBytes: 824 * MB }))) === 50);
  check('progress percent falls back to the engine value', model.torrentProgressPercent(torrent({ totalSizeBytes: 0, downloadedBytes: 0, progressPercent: 12 })) === 12);

  console.log('link download status');
  let d = copy.downloadStatus(dl(), '1 min');
  check('link line keeps time left and speed', d.text === '1 min left · 3.2 MB/s', d.text);
  check('link shows size and percent', d.sub === '412 MB of 1.2 GB · 34%', d.sub);
  d = copy.downloadStatus(dl({ size: null }), '—');
  check('unknown size says so far', /^412 MB so far/.test(d.text) && !d.sub, JSON.stringify(d));
  d = copy.downloadStatus(dl({ stream: { kind: 'hls', segmentsDone: 3, segmentsTotal: 10 } }), '1 min');
  check('stream size is an estimate', d.sub === '412 MB of ~1.2 GB · 34%', d.sub);
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user' }));
  check('paused link keeps how far it got', d.text === 'Paused' && d.sub === '412 MB of 1.2 GB · 34%', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user', size: null }));
  check('paused unknown size shows so far', d.sub === '412 MB so far', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'finished' }));
  check('finished link has no progress line', !d.sub);

  console.log('header speed');
  const memo = new Map();
  const total = copy.smoothDownloadsSpeed([dl(), dl({ id: 'dl_2', downBps: 1 * MB }), dl({ id: 'dl_3', state: 'paused', downBps: 9 * MB })], memo, 1000);
  check('active link downloads add to the total, paused ones do not', total === 4.2 * MB, String(total));
  check('smoothing forgets rows that left', (copy.smoothDownloadsSpeed([], memo, 2000), memo.size === 0));
  check('no downloads is zero', copy.smoothDownloadsSpeed([], new Map(), 0) === 0);

  console.log('addable links');
  for (const ok of ['https://example.com/video.mp4', 'http://x.test/a', 'magnet:?xt=urn:btih:abc', 'https://x.test/a.torrent?x=1', 'https://example.com']) check(`accepts ${ok}`, isAddableLink(ok));
  for (const bad of ['', 'hello world', 'ftp://x.test/a', 'https://x test', 'file:///a', 'https://']) check(`refuses ${JSON.stringify(bad)}`, !isAddableLink(bad));

  console.log('selection');
  check('torrent and link ids never collide', selectionKey('t', 'abc') !== selectionKey('d', 'abc'));
  check('keys round trip', JSON.stringify(parseSelectionKey(selectionKey('d', 'dl_1'))) === JSON.stringify({ kind: 'd', id: 'dl_1' }));
  const split = splitSelection(new Set([selectionKey('t', 'a'), selectionKey('d', 'dl_1'), selectionKey('d', 'dl_2')]));
  check('split by kind', split.torrents.join() === 'a' && split.downloads.join() === 'dl_1,dl_2');

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\ntransfers ui tests passed');
}
main();
