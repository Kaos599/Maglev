#!/usr/bin/env node
// Batch download from the found-files tray (docs/BROWSER_DOWNLOAD_GAPS.md R4): long-press to select, Select all
// skips streams and installers, one admission check for the summed known sizes, cap of 25, one failing item does
// not stop the rest, one summary notice. Needs Node 22.18+ (runs TypeScript source directly).
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
const item = (id, over = {}) => ({ id, url: `https://cdn.test/${id}.pdf`, kind: 'document', mime: 'application/pdf', ext: 'pdf', name: `${id}.pdf`, size: null, width: null, height: null, source: 'page', stream: null, pageUrl: 'https://site.test/a', pageTitle: 'A', ...over });

async function main() {
  const b = await import('../components/browser/foundBatch.ts');
  const many = (n) => Array.from({ length: n }, (_, i) => item(`f${i}`));

  console.log('what can be picked');
  const apk = item('app', { ext: 'apk', name: 'app.apk', kind: 'other' });
  const hls = item('hls', { stream: 'hls', kind: 'video', ext: 'm3u8', name: 'v.m3u8' });
  const dash = item('dash', { stream: 'dash', kind: 'video', ext: 'mpd', name: 'v.mpd' });
  check('a plain file is batchable', b.isBatchable(item('a')));
  check('an installer is not batchable', !b.isBatchable(apk));
  check('streams are not batchable', !b.isBatchable(hls) && !b.isBatchable(dash));
  check('an installer can still be ticked by hand', b.canSelect(apk));
  check('a stream cannot be ticked (it needs its quality sheet)', !b.canSelect(hls) && !b.canSelect(dash));

  console.log('Select all');
  const mixed = [item('a'), apk, hls, item('b'), dash];
  check('Select all skips streams and installers', b.selectAllIds(mixed).join() === 'a,b');
  check('Select all stops at the cap', b.selectAllIds(many(40)).length === 25 && b.BATCH_CAP === 25);
  check('Select all keeps list order', b.selectAllIds(many(30)).slice(0, 3).join() === 'f0,f1,f2');

  console.log('toggle');
  const t1 = b.toggleSelected(new Set(), 'a');
  check('ticks an id', t1.has('a'));
  check('unticks it again', !b.toggleSelected(t1, 'a').has('a'));
  const full = new Set(many(25).map((i) => i.id));
  check('refuses the 26th', b.toggleSelected(full, 'extra') === full || b.toggleSelected(full, 'extra').size === 25);
  check('still allows unticking at the cap', !b.toggleSelected(full, 'f0').has('f0'));
  check('allSelected is true only for every batchable row', b.allSelected(new Set(['a', 'b']), mixed) && !b.allSelected(new Set(['a']), mixed));

  console.log('totals');
  const sized = [item('a', { size: 100 }), item('b'), item('c', { size: 50 })];
  const sizeOf = (i) => i.size;
  const tot = b.batchTotals(sized, sizeOf);
  check('known sizes are summed', tot.knownBytes === 150);
  check('unknown ones are counted, not guessed', tot.unknownCount === 1 && tot.knownCount === 2);
  check('a probed size counts as known', b.batchTotals(sized, (i) => (i.id === 'b' ? 25 : i.size)).knownBytes === 175);
  check('nothing known gives zero, not NaN', b.batchTotals([item('a')], sizeOf).knownBytes === 0);

  console.log('runBatch');
  const calls = [];
  const startOk = async (i) => { calls.push(i.id); return { ok: true }; };
  const r1 = await b.runBatch(many(5), startOk);
  check('every item is tried', calls.length === 5 && r1.added === 5 && r1.failed.length === 0 && r1.duplicate === 0);
  const calls2 = [];
  const mixedStart = async (i) => {
    calls2.push(i.id);
    if (i.id === 'f1') return { ok: false, code: 'HTTP_STATUS', message: 'no' };
    if (i.id === 'f2') throw new Error('boom');
    if (i.id === 'f3') return { ok: false, code: 'DUPLICATE', message: 'dup' };
    return { ok: true };
  };
  const r2 = await b.runBatch(many(5), mixedStart);
  check('a failing item does not stop the rest', calls2.length === 5);
  check('a throw counts as a failure', r2.failed.map((i) => i.id).sort().join() === 'f1,f2');
  check('DUPLICATE is counted apart from failures', r2.duplicate === 1);
  check('added counts only the ones that went in', r2.added === 2);
  check('failed items come back for Retry, in order', r2.failed.map((i) => i.id).join() === 'f1,f2');
  const r3 = await b.runBatch(many(30), startOk);
  check('a batch over the cap only runs the first 25', r3.added === 25);
  let live = 0, peak = 0;
  await b.runBatch(many(10), async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return { ok: true }; });
  check('runs a few at a time, not all at once', peak > 1 && peak <= 3, `peak ${peak}`);

  console.log('summary copy');
  const copy = await import('../constants/copy.ts');
  const s = copy.notices.browser.batchDone;
  check('all added', s(7, 0, 0) === 'Added 7.');
  check('some failed', s(7, 0, 1) === 'Added 7. 1 failed.');
  check('some already there', s(3, 2, 0) === 'Added 3. 2 already in Transfers.');
  check('everything failed', s(0, 0, 2) === "Couldn't add 2 files.");
  check('nothing new, all duplicates', s(0, 2, 0) === '2 already in Transfers.');
  check('one failed says file, not files', s(0, 0, 1) === "Couldn't add 1 file.");

  console.log('wiring');
  const tray = read('components/browser/FoundTray.tsx');
  const scr = read('app/browser.tsx');
  const sheet = read('components/browser/BatchSheet.tsx');
  check('a long press selects (it no longer copies)', /onLongPress/.test(tray) && /setPicked\(new Set\(\[item\.id\]\)\)/.test(tray) && !/copyLink\(item\)/.test(tray));
  check('the tray offers Select all and Download (N)', /foundTray\.selectAll/.test(tray) && /foundTray\.downloadN/.test(tray));
  check('the tray can copy a link from the selection bar', /foundTray\.copyLink/.test(tray));
  check('the tray hands the picked rows to the screen', /onDownloadSelected/.test(tray) && /onDownloadSelected=/.test(scr));
  check('Select all uses selectAllIds', /selectAllIds\(/.test(tray));
  check('the batch sheet checks space once for the summed size', /useDownloadAdmission\(/.test(sheet) && /batchTotals\(/.test(sheet));
  check('the batch sheet says when sizes are unknown', /foundTray\.unknownSizes|batch\.unknown/.test(sheet));
  check('the batch sheet warns about installers', /banners\.browser\.installer/.test(sheet) && /isInstaller\(/.test(sheet));
  check('each item goes through probeUrl then addDownload', /startFound\(/.test(scr) && /probeUrl/.test(read('components/browser/startFound.ts')) && /startDownload/.test(read('components/browser/startFound.ts')));
  check('the summary notice offers Retry for failures', /batchDone\(/.test(scr) && /actionLabel:\s*['"]Retry['"]/.test(scr));
}

main().then(() => {
  if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
  console.log('\nall ok');
}, (e) => { console.error(e); process.exit(1); });
