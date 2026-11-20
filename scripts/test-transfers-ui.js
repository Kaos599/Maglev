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
  check('downloading with time left: phrase, percent, speed', left(s) === '1 min left · 34%' && s.value === '3.20 MB/s' && s.slot === 'speed' && s.tone === 'download', JSON.stringify(s));
  check('the amount is not on the left but stays in the screen-reader text', !/ of /.test(left(s)) && /412 MB of 1\.2 GB/.test(s.text), s.text);
  check('status has no second line', !('sub' in s));
  s = model.torrentStatus(torrent({ includedBytes: 600 * MB }), '1 min');
  check('includedBytes is the total when set', left(s) === '1 min left · 69%' && /412 MB of 600 MB/.test(s.text), s.text);
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0, downloadSpeedBytes: 0, etaSeconds: -1 }), '—');
  check('nothing downloaded yet, not flowing: Connecting to peers, no percent, size on the right', left(s) === 'Connecting to peers' && s.value === '1.2 GB' && s.slot === 'size', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1 }), '—');
  check('no data flowing: Downloading, percent, amount on the right', left(s) === 'Downloading · 34%' && s.value === '412 MB of 1.2 GB' && s.slot === 'amount', JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1 }), '—');
  check('data flowing, no time left: speed on the right', left(s) === 'Downloading · 34%' && s.value === '3.20 MB/s', JSON.stringify(s));
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
  check('link with time left: phrase, percent, speed', left(d) === '1 min left · 34%' && d.value === '3.20 MB/s' && d.tone === 'download', JSON.stringify(d));
  check('link amount stays in the screen-reader text only', !/ of /.test(left(d)) && /412 MB of 1\.2 GB/.test(d.text), d.text);
  check('link has no second line', !('sub' in d));
  d = copy.downloadStatus(dl({ size: null }), '—');
  check('unknown size: Downloading, no percent, speed', left(d) === 'Downloading' && d.value === '3.20 MB/s', JSON.stringify(d));
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

  // NATIVE_CONTRACT 43: say what a download is doing, and why it isn't moving.
  console.log('flow clock and stuck states (43)');
  const fc = await import('../components/transfers/flowClock.ts');
  check('QUIET_MS is the same 5 s as the speed hold', fc.QUIET_MS === 5000 && fc.QUIET_MS === hold.SPEED_HOLD_MS);
  let rec = fc.advanceFlow(undefined, { downloading: true, speedBytes: 0 }, 1000);
  check('flow clock: first quiet tick starts the run', rec.quietSince === 1000 && rec.lastFlowAt === null, JSON.stringify(rec));
  rec = fc.advanceFlow(rec, { downloading: true, speedBytes: 0 }, 3000);
  check('flow clock: the run keeps its first tick', rec.quietSince === 1000 && fc.quietMs(rec, 3000) === 2000);
  check('flow clock: quiet threshold is 5 s (4.9 s is not, 5 s is)', fc.quietMs(rec, 1000 + 4900) < fc.QUIET_MS && fc.quietMs(rec, 1000 + 5000) >= fc.QUIET_MS);
  rec = fc.advanceFlow(rec, { downloading: true, speedBytes: 500 }, 4000);
  check('flow clock: data ends the run and stamps lastFlowAt', rec.quietSince === null && rec.lastFlowAt === 4000 && fc.quietMs(rec, 9000) === 0);
  rec = fc.advanceFlow(rec, { downloading: true, speedBytes: 0 }, 5000);
  check('flow clock: a new run starts at its own first tick, lastFlowAt stays', rec.quietSince === 5000 && rec.lastFlowAt === 4000);
  check('flow clock: hold lasts 5 s after the last data', fc.flowHold(rec, 8999) === true && fc.flowHold(rec, 9000) === false);
  check('flow clock: last data ago, null when never seen', fc.lastDataAgoMs(rec, 12000) === 8000 && fc.lastDataAgoMs(undefined, 1) === null && fc.lastDataAgoMs(fc.EMPTY_FLOW, 1) === null);
  const paused2 = fc.advanceFlow(rec, { downloading: false, speedBytes: 0 }, 6000);
  check('flow clock: a state other than downloading clears quietSince', paused2.quietSince === null && paused2.lastFlowAt === 4000);
  const afterGap = fc.advanceFlow({ lastFlowAt: null, quietSince: 1000, seenAt: 2000 }, { downloading: true, speedBytes: 0 }, 2000 + fc.STALE_MS + 1);
  check('flow clock: a long gap without ticks restarts the run instead of inventing a wait', afterGap.quietSince === 2000 + fc.STALE_MS + 1);
  fc.resetFlow();
  fc.feedFlow('x', { downloading: true, speedBytes: 0 }, 100);
  check('flow clock store: one record per id, shared by whoever reads it', fc.peekFlow('x').quietSince === 100 && fc.peekFlow('y') === undefined);
  fc.forgetFlow('x');
  check('flow clock store: forget', fc.peekFlow('x') === undefined);
  check('flow clock is pure: no Date.now in it', !/Date\.now|new Date/.test(fs.readFileSync(path.join(__dirname, '../components/transfers/flowClock.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));

  console.log('torrent card (43.2)');
  const quiet = (ms, o = {}) => model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1, ...o }), '—', {}, { quietMs: ms });
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0, downloadSpeedBytes: 0, etaSeconds: -1, peersTotal: 0 }), '—');
  check('connecting with 0 peers: no "found"', s.lead === 'Connecting to peers' && s.value === '1.2 GB' && s.slot === 'size', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0, downloadSpeedBytes: 0, etaSeconds: -1, peersTotal: 24 }), '—');
  check('connecting with 24 peers: "Connecting to peers · 24 found", size on the right', s.lead === 'Connecting to peers · 24 found' && !s.pct && s.value === '1.2 GB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0, downloadSpeedBytes: 0, totalSizeBytes: 0, peersTotal: 3 }), '—');
  check('connecting with unknown size shows a dash', s.lead === 'Connecting to peers · 3 found' && s.value === '—', JSON.stringify(s));
  s = quiet(4900);
  check('quiet 4.9 s with data downloaded: still Downloading', left(s) === 'Downloading · 34%' && s.value === '412 MB of 1.2 GB' && s.tone === 'download', JSON.stringify(s));
  s = quiet(5000);
  check('quiet 5 s: Waiting for peers, percent, muted, amount on the right', left(s) === 'Waiting for peers · 34%' && s.tone === 'muted' && s.value === '412 MB of 1.2 GB' && s.slot === 'amount', JSON.stringify(s));
  s = quiet(60000);
  check('waiting keeps the percent and never says Downloading', s.lead === 'Waiting for peers' && s.pct === '34%');
  s = quiet(9000, { totalSizeBytes: 0, includedBytes: 0, progressPercent: 0 });
  check('waiting with unknown total: no percent, downloaded amount', s.lead === 'Waiting for peers' && !s.pct && s.value === '412 MB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1 }), '—', {}, { quietMs: 9000, speedHold: true });
  check('inside the 5 s hold counts as flowing, not waiting', s.slot === 'speed' && s.lead === 'Downloading', JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1 }), '—');
  check('flowing: amount then speed on the right, speed in the download colour', s.amount === '412 MB of 1.2 GB' && s.value === '3.20 MB/s' && s.slot === 'speed' && s.tone === 'download', JSON.stringify(s));
  check('flowing: the screen-reader text reads the whole line, amount included', s.text === 'Downloading · 34% · 412 MB of 1.2 GB · 3.20 MB/s', s.text);
  s = model.torrentStatus(torrent({ etaSeconds: -1 }), '—', {}, { shortAmount: true });
  check('flowing, short: downloaded bytes and speed, full amount still read aloud', s.amount === '412 MB' && s.value === '3.20 MB/s' && /412 MB of 1\.2 GB/.test(s.text), JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1 }), '—', {}, { shortAmount: narrow(360) });
  check('flowing on a narrow card: shortens', s.amount === '412 MB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1 }), '—', {}, { shortAmount: narrow(900) });
  check('flowing on a wide card: full amount', s.amount === '412 MB of 1.2 GB', JSON.stringify(s));
  let seen = 0;
  model.torrentStatus(torrent({ etaSeconds: -1 }), '—', {}, { shortAmount: (n) => { seen = n; return false; } });
  check('the narrow test sees the whole right text (amount, separator, speed)', seen === '412 MB of 1.2 GB · 3.20 MB/s'.length, String(seen));
  // NATIVE_CONTRACT 45.2: the compact amount while data flows.
  const tight = (n) => (chars) => chars > n; // fits only when the right side is n characters or fewer
  s = model.torrentStatus(torrent({ etaSeconds: -1, downloadedBytes: 134 * MB, totalSizeBytes: 587 * MB }), '—', {}, { shortAmount: tight(25) });
  check('45.2 same unit: "134/587 MB" then the speed, long form read aloud', s.amount === '134/587 MB' && s.value === '3.20 MB/s' && /134 MB of 587 MB/.test(s.text), JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1, downloadedBytes: 820 * MB, totalSizeBytes: 2.1 * GB }), '—', {}, { shortAmount: tight(25) });
  check('45.2 different units: "820 MB/2.1 GB"', s.amount === '820 MB/2.1 GB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1, downloadedBytes: 3 * GB, totalSizeBytes: 12.4 * GB }), '—', {}, { shortAmount: tight(25) });
  check('45.2 done drops a trailing ".0"', s.amount === '3/12.4 GB', JSON.stringify(s));
  s = model.torrentStatus(torrent({ etaSeconds: -1, downloadedBytes: 134 * MB, totalSizeBytes: 587 * MB }), '—', {}, { shortAmount: tight(5) });
  check('45.2 the check runs again with the compact length: still too long, amount alone', s.amount === '134 MB', JSON.stringify(s));
  const lens = [];
  model.torrentStatus(torrent({ etaSeconds: -1, downloadedBytes: 134 * MB, totalSizeBytes: 587 * MB }), '—', {}, { shortAmount: (n) => { lens.push(n); return true; } });
  check('45.2 the second check sees "134/587 MB · 3.20 MB/s"', lens.at(-1) === '134/587 MB · 3.20 MB/s'.length, JSON.stringify(lens));
  s = model.torrentStatus(torrent({ etaSeconds: -1, totalSizeBytes: 0, includedBytes: 0 }), '—', {}, { shortAmount: true });
  check('45.2 unknown size: the amount alone, no compact form', s.amount === '412 MB', JSON.stringify(s));
  d = copy.downloadStatus(dl({ downBps: 8.4 * MB, downloaded: 460 * MB, eta: -1 }), '—', {}, { shortAmount: tight(25) });
  check('45.2 links use the same rule', d.amount === '460 MB/1.2 GB' && /460 MB of 1\.2 GB/.test(d.text), JSON.stringify(d));
  d = copy.downloadStatus(dl({ downBps: 8.4 * MB, downloaded: 460 * MB, eta: -1 }), '—', {}, { shortAmount: tight(5) });
  check('45.2 links fall back to the amount alone when compact does not fit', d.amount === '460 MB', JSON.stringify(d));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1 }), '—', {}, { shortAmount: tight(5), quietMs: 0, speedHold: false });
  check('45.2 not flowing: the amount-only form is unchanged', /^412 MB$/.test(s.value), JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadedBytes: 0, progressPercent: 0, etaSeconds: -1 }), '—');
  check('flowing with nothing downloaded yet: speed only, no amount', s.amount === undefined && s.value === '3.20 MB/s' && s.text === 'Downloading · 0% · 3.20 MB/s', JSON.stringify(s));
  s = model.torrentStatus(torrent({ downloadSpeedBytes: 0, etaSeconds: -1, downloadedBytes: 0, peersTotal: 5 }), '—', { blocks: [{ tag: 'offline' }] });
  check('offline keeps priority over Connecting', s.lead === 'No internet connection', JSON.stringify(s));
  for (const st of ['PAUSED', 'QUEUED', 'CHECKING', 'MOVING', 'SEEDING', 'COMPLETED', 'ERROR', 'INITIALIZING']) {
    const x = model.torrentStatus(torrent({ state: st, downloadSpeedBytes: 0, downloadedBytes: 0, error: { code: 'X', message: 'm' } }), '—', {}, { quietMs: 99999 });
    check(`${st} is not touched by the stuck states`, !/Connecting|Waiting for peers/.test(x.lead), x.lead);
  }
  s = model.torrentStatus({ ...torrent({ downloadSpeedBytes: 0, downloadedBytes: 0 }), lastKnown: true }, '—');
  check('saved numbers (lastKnown) never claim Connecting', !/Connecting/.test(s.lead), s.lead);

  console.log('link card (43.3)');
  const lq = (ms, o = {}) => copy.downloadStatus(dl({ downBps: 0, eta: -1, ...o }), '—', {}, { quietMs: ms });
  d = copy.downloadStatus(dl({ downBps: 8.4 * MB, downloaded: 460 * MB, eta: -1 }), '—');
  check('link flowing: amount then speed', d.amount === '460 MB of 1.2 GB' && d.value === '8.40 MB/s' && d.slot === 'speed' && d.tone === 'download', JSON.stringify(d));
  check('link flowing: whole line read aloud', d.text === 'Downloading · 37% · 460 MB of 1.2 GB · 8.40 MB/s', d.text);
  d = copy.downloadStatus(dl({ downBps: 8.4 * MB, downloaded: 460 * MB, eta: -1 }), '—', {}, { shortAmount: true });
  check('link flowing, short: 460 MB and speed', d.amount === '460 MB' && d.value === '8.40 MB/s', JSON.stringify(d));
  d = copy.downloadStatus(dl({ downBps: 8.4 * MB, downloaded: 460 * MB, size: null, eta: -1 }), '—');
  check('link flowing, unknown size: 460 MB and speed', d.amount === '460 MB' && d.value === '8.40 MB/s' && !d.pct, JSON.stringify(d));
  d = lq(0, { downloaded: 0 });
  check('link, nothing downloaded, not flowing: Connecting to the server, size on the right', d.lead === 'Connecting to the server' && d.value === '1.2 GB' && d.slot === 'size' && !d.pct, JSON.stringify(d));
  d = lq(0, { downloaded: 0, size: null });
  check('link connecting with unknown size: a dash', d.lead === 'Connecting to the server' && d.value === '—', JSON.stringify(d));
  d = lq(4900);
  check('link quiet 4.9 s: still Downloading', left(d) === 'Downloading · 34%' && d.value === '412 MB of 1.2 GB', JSON.stringify(d));
  d = lq(5000);
  check('link quiet 5 s: Waiting for the server, percent, amount', left(d) === 'Waiting for the server · 34%' && d.value === '412 MB of 1.2 GB' && d.tone === 'muted', JSON.stringify(d));
  d = lq(0, { stalled: true });
  check('link stalled by the engine flag alone: Waiting for the server', left(d) === 'Waiting for the server · 34%' && d.value === '412 MB of 1.2 GB', JSON.stringify(d));
  // Offline while still downloading (2026-11-20 phone test: Wi-Fi off said "Waiting for the server"). Same line as a torrent.
  const off = { blocks: [{ tag: 'offline' }] };
  d = copy.downloadStatus(dl({ downBps: 0, eta: -1 }), '—', off, { quietMs: 9000 });
  check('link waiting while offline: No internet connection', left(d) === 'No internet connection · 34%' && d.tone === 'muted' && d.value === '412 MB of 1.2 GB', JSON.stringify(d));
  d = copy.downloadStatus(dl({ downBps: 0, eta: -1, stalled: true }), '—', off, { quietMs: 0 });
  check('link stalled while offline: No internet connection', left(d) === 'No internet connection · 34%', JSON.stringify(d));
  d = copy.downloadStatus(dl({ downBps: 0, eta: -1, downloaded: 0 }), '—', off, { quietMs: 0 });
  check('link connecting while offline: No internet connection', d.lead === 'No internet connection', JSON.stringify(d));
  d = copy.downloadStatus(dl({ downBps: 8.4 * MB, downloaded: 460 * MB, eta: -1 }), '—', off);
  check('link with data arriving keeps its speed even with the offline tag', d.slot === 'speed' && d.lead === 'Downloading', JSON.stringify(d));
  check('page caption while offline says when it continues', copy.downloadCaption(dl({ stalled: true }), off) === "No internet connection. Transfers continue when you're back online.", String(copy.downloadCaption(dl({ stalled: true }), off)));
  d = copy.downloadStatus(dl({ downBps: 0, eta: -1 }), '—', {}, { quietMs: 9000, speedHold: true });
  check('link inside the hold counts as flowing', d.slot === 'speed' && d.lead === 'Downloading', JSON.stringify(d));
  d = copy.downloadStatus(dl({ state: 'paused', pausedBy: 'user', downBps: 0 }), '—', {}, { quietMs: 99999 });
  check('a paused link is untouched', left(d) === 'Paused · 34%');

  console.log('why block (43.4, 43.5)');
  const sit = (o, opts, ctx) => model.torrentSituation({ state: 'DOWNLOADING', downloadSpeedBytes: 0, downloadedBytes: 0, ...o }, opts, ctx);
  check('why: nothing downloaded, no data: connecting', sit({}) === 'connecting');
  check('why: some downloaded, quiet < 5 s: no block', sit({ downloadedBytes: 5 }, { quietMs: 4900 }) === 'quiet');
  check('why: some downloaded, quiet 5 s: waiting', sit({ downloadedBytes: 5 }, { quietMs: 5000 }) === 'waiting');
  check('why: data flowing hides it', sit({ downloadSpeedBytes: 10 }) === 'flowing' && sit({ downloadedBytes: 5 }, { speedHold: true, quietMs: 9000 }) === 'flowing');
  check('why: no block for other states, saved numbers or offline', sit({ state: 'PAUSED' }) === null && sit({ lastKnown: true }) === null && sit({}, {}, { blocks: [{ tag: 'offline' }] }) === null);
  check('link why: same situations, the engine flag counts alone', copy.linkSituation({ state: 'downloading', downBps: 0, downloaded: 0 }) === 'connecting' && copy.linkSituation({ state: 'downloading', downBps: 0, downloaded: 9 }, { quietMs: 5000 }) === 'waiting' && copy.linkSituation({ state: 'downloading', downBps: 0, downloaded: 9, stalled: true }) === 'waiting' && copy.linkSituation({ state: 'downloading', downBps: 1, downloaded: 9 }) === 'flowing' && copy.linkSituation({ state: 'paused', downBps: 0, downloaded: 0 }) === null);
  const base = { peersTotal: 24, peersConnected: 2, trackers: [{ status: 'working' }, { status: 'error' }, { status: 'working' }], peers: [{ downBps: 0 }], quietMs: 75000, lastDataAgoMs: 125000, peerTimeoutMins: 10 };
  let w = copy.torrentWhy({ ...base, situation: 'connecting' });
  check('why connecting: title and sentence', w.title === "Why it hasn't started" && w.sentence === 'Maglev knows who has this and is connecting to them. Popular torrents usually start within a minute.', w.sentence);
  check('why connecting: stats', w.stats.map((x) => `${x.label}=${x.value}`).join('|') === 'Peers found=24|Connected=2|Trackers replied=2 of 3|Trying for=1:15', JSON.stringify(w.stats));
  check('why connecting: has the Ask trackers button', w.askTrackers === true);
  w = copy.torrentWhy({ ...base, situation: 'connecting', peersTotal: 0, trackers: [], quietMs: 4000 });
  check('why connecting with 0 peers: the other sentence', w.sentence === 'No one sharing this has been found yet. Maglev keeps asking trackers and other peers.', w.sentence);
  check('why connecting: Trackers replied is hidden with no trackers', !w.stats.some((x) => x.label === 'Trackers replied') && w.stats.at(-1).value === '0:04', JSON.stringify(w.stats));
  w = copy.torrentWhy({ ...base, situation: 'waiting' });
  check('why waiting: title, sentence and the Stop waiting limit', w.title === 'Why it stopped' && w.sentence === 'No data for 1 min. The peers it had stopped sending. Maglev keeps looking. After 10 min with no one sharing, it stops waiting.', w.sentence);
  check('why waiting: stats, none sending, last data ago', w.stats.map((x) => `${x.label}=${x.value}`).join('|') === 'Peers found=24|Connected=2, none sending|Last data=2 min ago', JSON.stringify(w.stats));
  w = copy.torrentWhy({ ...base, situation: 'waiting', peerTimeoutMins: 0, peers: [{ downBps: 0 }, { downBps: 100 }], lastDataAgoMs: null, quietMs: 12000 });
  check('why waiting: setting Never drops the sentence; a sending peer drops "none sending"; unseen last data is a dash', w.sentence === 'No data for 12 s. The peers it had stopped sending. Maglev keeps looking.' && w.stats[1].value === '2' && w.stats[2].value === '—', JSON.stringify(w));
  // NATIVE_CONTRACT 45.1: the block while the torrent has no file list.
  let rw = copy.torrentResolvingWhy({ peersTotal: 0, trackers: [], resolvingSecs: 75 });
  check('45.1 title, no peers: sentence plus "No one sharing it has been found yet."', rw.title === "Why it hasn't started" && rw.sentence === "Maglev needs this torrent's file list from someone who has it. No one sharing it has been found yet.", rw.sentence);
  check('45.1 stats with no trackers: Peers found and Trying for (m:ss) only', rw.stats.map((x) => `${x.label}=${x.value}`).join('|') === 'Peers found=0|Trying for=1:15', JSON.stringify(rw.stats));
  rw = copy.torrentResolvingWhy({ peersTotal: 7, trackers: [{ status: 'working' }, { status: 'error' }], resolvingSecs: 9 });
  check('45.1 with peers: "Asking the 7 it found."', rw.sentence === "Maglev needs this torrent's file list from someone who has it. Asking the 7 it found.", rw.sentence);
  check('45.1 Trackers replied shows "{working} of {total}"', rw.stats.map((x) => `${x.label}=${x.value}`).join('|') === 'Peers found=7|Trackers replied=1 of 2|Trying for=0:09', JSON.stringify(rw.stats));
  check('45.1 no Ask trackers button: the engine refuses reannounce until the torrent is downloading or seeding', rw.askTrackers === false && rw.kind === 'resolving');
  check('stop-waiting limit words come from the setting', copy.peerLimitText(10) === '10 min' && copy.peerLimitText(60) === '1 hour' && copy.peerLimitText(360) === '6 hours' && copy.peerLimitText(0) === null);
  let lw = copy.linkWhy({ situation: 'connecting', host: 'x.test', resumable: true, quietMs: 7000, lastDataAgoMs: null });
  check('link why connecting: sentence and stats, no button', lw.sentence === 'Waiting for x.test to send the file.' && lw.stats.map((x) => `${x.label}=${x.value}`).join('|') === 'Server=x.test|Trying for=0:07' && lw.askTrackers === false && lw.title === "Why it hasn't started", JSON.stringify(lw));
  lw = copy.linkWhy({ situation: 'waiting', host: 'x.test', resumable: true, quietMs: 7000, lastDataAgoMs: 9000 });
  check('link why waiting: sentence, Last data, no hint when it can resume', lw.sentence === 'x.test stopped sending. Maglev retries by itself.' && lw.stats[1].value === '9 s ago' && !lw.note && lw.title === 'Why it stopped', JSON.stringify(lw));
  lw = copy.linkWhy({ situation: 'waiting', host: 'x.test', resumable: false, quietMs: 7000, lastDataAgoMs: null });
  check('link why waiting, cannot resume: the existing hint as a second line', lw.note === copy.CANT_RESUME_HINT && lw.stats[1].value === '—');
  check('span words', copy.formatSpan(59000) === '59 s' && copy.formatSpan(3600000) === '1 h' && copy.formatSpan(3900000) === '1 h 5 min' && copy.formatClock(65000) === '1:05');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const whySrc = read('components/detail/WhyStuck.tsx');
  const torrentPage = read('app/torrent/[id].tsx');
  const linkPage = read('app/download/[id].tsx');
  check('WhyStuck: reannounce icon, secondary button, disabled while the cool-down runs, themed, no hex', /icon="reannounce"/.test(whySrc) && /variant="secondary"/.test(whySrc) && /disabled=\{waiting/.test(whySrc) && /useTheme\(\)/.test(whySrc) && !/#[0-9a-fA-F]{3,8}\b/.test(whySrc));
  check('torrent page: the block sits right under the progress card, outside the Compact/Detailed switch, and reuses handleReannounce', /<\/ProgressCard>\s*\{\/\*[^*]*\*\/\}\s*\{whyModel \? <WhyStuck[^>]*onAskTrackers=\{\(\) => void handleReannounce\(\)\}[^>]*retryInSecs=\{retryInSecs\}/.test(torrentPage) && (torrentPage.match(/maglevEngine\.reannounce/g) ?? []).length === 1);
  check("45.1 torrent page: the block also shows for INITIALIZING with resolvingSecs, from torrentResolvingWhy", /snap\?\.state === 'INITIALIZING' && snap\.resolvingSecs != null\s*\?\s*torrentResolvingWhy\(/.test(torrentPage));
  check('45.1 the card keeps its resolving line', /resolvingLine\(t\.peersTotal, t\.resolvingSecs\)/.test(read('components/transfers/model.ts')));
  check('45.2 compact helper lives in constants/format', /export function formatCompactAmount/.test(read('constants/format.ts')));
  check('link page: the block has no button and the hint is not repeated', /<WhyStuck model=\{whyModel\} \/>/.test(linkPage) && /!whyModel\?\.note/.test(linkPage));
  check('cards and pages feed the one flow clock', /feedFlow/.test(read('components/transfers/useStatusOpts.ts')) && /useFlowClock/.test(torrentPage) && /useFlowClock/.test(linkPage) && /}, t\.state === "DOWNLOADING" && !t\.lastKnown\)/.test(read('components/TransferCard.tsx')));
  check('status line draws the amount in the muted telemetry colour before the speed', /colors\.textMuted/.test(read('components/transfers/StatusLine.tsx')) && /status\.amount/.test(read('components/transfers/StatusLine.tsx')));

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
