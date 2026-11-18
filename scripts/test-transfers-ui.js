#!/usr/bin/env node
// Transfers card status lines, link-download speed in the header total, clipboard links and
// mixed selection. Pure helpers only, no React.
// Needs Node 22.18+ (runs the TypeScript source directly via type stripping).

process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');

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
  // Owner rule 2026-11-18: left = one phrase then the percent last, never an amount; right = one value
  // (speed if data flows, else the amount, else the size, else a dash).
  const left = (x) => (x.pct ? `${x.lead} · ${x.pct}` : x.lead);
  let s = model.torrentStatus(torrent(), '1 min');
  check('downloading with time left: phrase, percent, speed', left(s) === '1 min left · 34%' && s.value === '3.2 MB/s' && s.slot === 'speed' && s.tone === 'download', JSON.stringify(s));
  check('the amount is not on the left but stays in the screen-reader text', !/ of /.test(left(s)) && /412 MB of 1\.2 GB/.test(s.text), s.text);
  check('status has no second line', !('sub' in s));
  s = model.torrentStatus(torrent({ includedBytes: 600 * MB }), '1 min');
  check('includedBytes is the total when set', left(s) === '1 min left · 69%' && /412 MB of 600 MB/.test(s.text), s.text);
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0, downloadSpeedBytes: 0, etaSeconds: -1 }), '—');
  check('nothing downloaded yet: Downloading, no percent, size on the right', left(s) === 'Downloading' && s.value === '1.2 GB' && s.slot === 'size', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1 }), '—');
  check('no data flowing: Downloading, percent, amount on the right', left(s) === 'Downloading · 34%' && s.value === '412 MB of 1.2 GB' && s.slot === 'amount', JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1 }), '—');
  check('data flowing, no time left: speed on the right', left(s) === 'Downloading · 34%' && s.value === '3.2 MB/s', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadedBytes: 1.2 * GB - 1, progressPercent: 99.99 }), '1s');
  check('almost done never rounds up to 100%', s.pct === '99%', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'user', downloadSpeedBytes: 0 }), '—');
  check('paused: phrase and percent, amount on the right', left(s) === 'Paused · 34%' && s.value === '412 MB of 1.2 GB' && s.tone === 'muted', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'wifi_only' }), '—');
  check('held by a rule: reason, percent, amount', /Wi-Fi/.test(s.lead) && s.pct === '34%' && s.value === '412 MB of 1.2 GB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'COMPLETED', finished: true, downloadedBytes: 1.2 * GB }), '—');
  check('done shows total, no percent', s.lead === 'Done' && s.value === '1.2 GB' && !s.pct);
  s = model.torrentStatus(torrent({ state: 'SEEDING', finished: true }), '—');
  check('seeding is unchanged', s.lead === 'Done · Seeding' && !s.pct && s.slot === 'upload');
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'user', downloadedBytes: 0 }), '—');
  check('paused with nothing downloaded: no percent, size on the right', left(s) === 'Paused' && s.value === '1.2 GB' && s.slot === 'size', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'ERROR', error: { code: 'X', message: 'Disk error' } }), '—');
  check('error: message, percent, amount, danger', left(s) === 'Disk error · 34%' && s.value === '412 MB of 1.2 GB' && s.tone === 'danger', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'CHECKING', progressPercent: 40 }), '—');
  check('checking files: no ellipsis, percent, size', left(s) === 'Checking files · 40%' && s.value === '1.2 GB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'MOVING', moveProgress: 0.4 }), '—');
  check('moving files: no ellipsis, percent, size', left(s) === 'Moving files · 40%' && s.value === '1.2 GB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'INITIALIZING', totalSizeBytes: 0, downloadedBytes: 0 }), '—');
  check('getting info: dash on the right, no ellipsis', left(s) === 'Getting info' && s.value === '—', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'QUEUED', downloadSpeedBytes: 0 }), '—');
  check('queued: phrase, percent, amount', left(s).startsWith('Queued') && s.pct === '34%' && s.value === '412 MB of 1.2 GB', JSON.stringify(s));
  check('no status phrase ends with an ellipsis', ['CHECKING', 'MOVING', 'INITIALIZING', 'QUEUED', 'ERROR'].every((st) => !/…$/.test(model.torrentStatus(torrent({ state: st, error: null }), '—').lead)));
  check('status line component keeps the percent as its own non-shrinking text', /pct: \{ flexShrink: 0 \}/.test(fs.readFileSync(path.join(__dirname, '../components/transfers/StatusLine.tsx'), 'utf8')));
  check('link and torrent cards share the one status line', /<StatusLine/.test(fs.readFileSync(path.join(__dirname, '../components/transfers/DownloadCard.tsx'), 'utf8')) && /<StatusLine/.test(fs.readFileSync(path.join(__dirname, '../components/TransferCard.tsx'), 'utf8')));
  check('progress percent uses included bytes', Math.round(model.torrentProgressPercent(torrent({ includedBytes: 824 * MB }))) === 50);
  check('progress percent falls back to the engine value', model.torrentProgressPercent(torrent({ totalSizeBytes: 0, downloadedBytes: 0, progressPercent: 12 })) === 12);

  console.log('link download status');
  let d = copy.downloadStatus(dl(), '1 min');
  check('link with time left: phrase, percent, speed', left(d) === '1 min left · 34%' && d.value === '3.2 MB/s' && d.tone === 'download', JSON.stringify(d));
  check('link amount stays in the screen-reader text only', !/ of /.test(left(d)) && /412 MB of 1\.2 GB/.test(d.text), d.text);
  check('link has no second line', !('sub' in d));
  d = copy.downloadStatus(dl({ size: null }), '—');
  check('unknown size: Downloading, no percent, speed', left(d) === 'Downloading' && d.value === '3.2 MB/s', JSON.stringify(d));
  d = copy.downloadStatus(dl({ size: null, downBps: 0 }), '—');
  check('unknown size, no speed: bytes downloaded on the right', d.value === '412 MB' && d.slot === 'amount', JSON.stringify(d));
  d = copy.downloadStatus(dl({ stream: { kind: 'hls', segmentsDone: 3, segmentsTotal: 10 }, downBps: 0, eta: -1 }), '—');
  check('stream size is an estimate', d.value === '412 MB of ~1.2 GB' && left(d) === 'Downloading · 34%', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user', downBps: 0 }));
  check('paused link: phrase, percent, amount', left(d) === 'Paused · 34%' && d.value === '412 MB of 1.2 GB', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user', size: null, downBps: 0 }));
  check('paused unknown size shows the downloaded bytes on the right', left(d) === 'Paused' && d.value === '412 MB', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'finished' }));
  check('finished link has no percent', !d.pct && d.slot === 'size');
  d = copy.downloadStatus(dl({ state: 'resolving' }));
  check('resolving: Getting info and a dash', left(d) === 'Getting info' && d.value === '—', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'verifying' }));
  check('verifying has no ellipsis', d.lead === 'Finishing');


  console.log('status line edge cases');
  const hold = await import('../components/transfers/speedHold.ts');
  let st = { lastFlowAt: null };
  let r = hold.holdSpeed(st, 0, 1000);
  check('hold: never flowed means no hold', r.hold === false);
  r = hold.holdSpeed(st, 2000, 1000); st = r.state;
  check('hold: data flowing holds', r.hold === true && r.msLeft === 0);
  r = hold.holdSpeed(st, 0, 3000); st = r.state;
  check('hold: 2 s at zero still shows speed', r.hold === true && r.msLeft === 3000, JSON.stringify(r));
  r = hold.holdSpeed(st, 0, 5999); st = r.state;
  check('hold: just under 5 s still holds', r.hold === true, JSON.stringify(r));
  r = hold.holdSpeed(st, 0, 6000); st = r.state;
  check('hold: after 5 s of zero it lets go', r.hold === false && r.msLeft === 0, JSON.stringify(r));
  r = hold.holdSpeed(st, 500, 6100);
  check('hold: speed comes back at once', r.hold === true);
  r = hold.holdSpeed({ lastFlowAt: 1000 }, NaN, 2000);
  check('hold: unknown speed counts as zero', r.hold === true && hold.holdSpeed({ lastFlowAt: 1000 }, NaN, 6500).hold === false);
  check('large font from 1.3', !hold.useCompactAmount(1.29) && hold.useCompactAmount(1.3) && hold.useCompactAmount(2) && !hold.useCompactAmount(NaN));
  const paused = torrent({ state: 'PAUSED', pausedBy: 'user', downloadSpeedBytes: 0, downloadedBytes: 1.23 * GB, totalSizeBytes: 12.4 * GB });
  s = model.torrentStatus(paused, '—');
  check('normal font: full amount', s.value === '1.23 GB of 12.4 GB' || /^1\.2\d? GB of 12\.4 GB$/.test(s.value), s.value);
  s = model.torrentStatus(paused, '—', {}, { shortAmount: true });
  check('large font: amount shortens, left unchanged, full amount in the screen-reader text', /^1\.2\d? GB$/.test(s.value) && s.pct === '10%' && / of 12\.4 GB/.test(s.text), JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1 }), '—', {}, { speedHold: true });
  check('speed hold: right keeps the speed slot with a dash at zero', s.slot === 'speed' && s.value === '—' && s.lead === 'Downloading', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1 }), '—', {}, {});
  check('without the hold, zero speed shows the amount', s.slot === 'amount');
  s = model.torrentStatus(torrent({ totalSizeBytes: 0, includedBytes: 0, downloadedBytes: 40 * MB, progressPercent: 0, downloadSpeedBytes: 0, etaSeconds: -1 }), '—');
  check('torrent with unknown total: Downloading, no percent, downloaded amount', s.lead === 'Downloading' && !s.pct && s.value === '40.0 MB', JSON.stringify(s));
  d = copy.downloadStatus(dl({ size: null, downloaded: 40 * MB, downBps: 0, eta: -1 }));
  check('link with unknown total: Downloading, no percent, downloaded amount', d.lead === 'Downloading' && !d.pct && d.value === '40.0 MB', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user', size: null, downloaded: 40 * MB, downBps: 0 }));
  check('paused with unknown total: reason and downloaded amount', d.lead === 'Paused' && !d.pct && d.value === '40.0 MB', JSON.stringify(d));
  d = copy.downloadStatus(dl({ downloaded: 1.2 * GB, downBps: 0, eta: -1 }));
  check('link never says 100% before it is done', d.pct === '99%', JSON.stringify(d));
  d = copy.downloadStatus(dl({ downloaded: 700 * MB }), '1 min', {}, { shortAmount: true });
  check('link: large font shortens the amount, full text kept', /^700 MB$/.test(copy.downloadStatus(dl({ downloaded: 700 * MB, downBps: 0, eta: -1 }), '—', {}, { shortAmount: true }).value) && /700 MB of 1\.2 GB/.test(d.text), d.text);
  d = copy.downloadStatus(dl({ downloaded: 700 * MB, downBps: 0, eta: -1 }), '—', {}, { speedHold: true });
  check('link: speed hold keeps the speed slot', d.slot === 'speed' && d.value === '—', JSON.stringify(d));
  s = model.torrentStatus(torrent({ downloadedBytes: 1.2 * GB, downloadSpeedBytes: 0, etaSeconds: -1 }), '—');
  check('torrent never says 100% before it is done', s.pct === '99%', JSON.stringify(s));
  s = model.torrentStatus(torrent({ state: 'PAUSED', pausedBy: 'user', downloadSpeedBytes: 0, includedBytes: 600 * MB, totalSizeBytes: 2 * GB, downloadedBytes: 300 * MB }), '—');
  check('skipped files: the amount and the percent use the included bytes', s.pct === '50%' && s.value === '300 MB of 600 MB', JSON.stringify(s));

  // Narrow card: the amount shortens when the phrase would get under MIN_PHRASE_DP (80 dp).
  const lay = (o) => ({ windowWidth: 411, fontScale: 1, hasRail: true, hasPlay: false, hasAction: true, ...o });
  check('line width: window minus margins, border, padding, rail and button', hold.statusLineWidth(lay({})) === 411 - 32 - 2 - 16 - 36 - 52);
  check('line width: Play beside the action button takes 44 more', hold.statusLineWidth(lay({ hasPlay: true })) === hold.statusLineWidth(lay({})) - 44);
  check('line width: no rail gives 36 back', hold.statusLineWidth(lay({ hasRail: false })) === hold.statusLineWidth(lay({})) + 36);
  check('wide card keeps the full amount', hold.shouldShortenAmount(lay({ windowWidth: 600 }), 16) === false);
  check('narrow card shortens the amount', hold.shouldShortenAmount(lay({ windowWidth: 360 }), 16) === true);
  check('Play on a medium card tips it to short', hold.shouldShortenAmount(lay({ windowWidth: 412 }), 16) === false && hold.shouldShortenAmount(lay({ windowWidth: 412, hasPlay: true }), 16) === true);
  check('a short amount fits where a long one does not', hold.shouldShortenAmount(lay({ windowWidth: 420 }), 22) === true && hold.shouldShortenAmount(lay({ windowWidth: 420 }), 6) === false);
  check('large font always shortens, even on a wide card', hold.shouldShortenAmount(lay({ windowWidth: 900, fontScale: 1.3 }), 16) === true);
  const narrow = (n) => (chars) => hold.shouldShortenAmount(lay({ windowWidth: n }), chars);
  s = model.torrentStatus(paused, '—', {}, { shortAmount: narrow(360) });
  check('narrow card: torrent shows downloaded bytes only, full amount in the screen-reader text', /^1\.2\d? GB$/.test(s.value) && / of 12\.4 GB/.test(s.text), JSON.stringify(s));
  s = model.torrentStatus(paused, '—', {}, { shortAmount: narrow(900) });
  check('wide card: torrent keeps the full amount', / of 12\.4 GB$/.test(s.value), s.value);
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user', downBps: 0 }), undefined, {}, { shortAmount: narrow(360) });
  check('narrow card: link shows downloaded bytes only', d.value === '412 MB' && /412 MB of 1\.2 GB/.test(d.text), JSON.stringify(d));

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
