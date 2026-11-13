#!/usr/bin/env node
// "Basic downloader" gaps: open folder everywhere, Saved to row, Clear finished, undo for link removal, notification deep link.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

async function main() {
  const { finishedTransfers, clearFinishedCopy } = await import('../components/transfers/model.ts');
  const t = (id, state, pausedBy = null) => ({ id, state, pausedBy });
  const d = (id, state) => ({ id, state });

  const r = finishedTransfers(
    [t('a', 'COMPLETED'), t('b', 'SEEDING'), t('c', 'PAUSED', 'seed_limit'), t('d', 'PAUSED', 'user'), t('e', 'DOWNLOADING'), t('f', 'ERROR')],
    [d('x', 'finished'), d('y', 'downloading'), d('z', 'error'), d('w', 'paused')],
  );
  check('finished torrents: completed and seed-limit only', JSON.stringify(r.torrents) === '["a","c"]', JSON.stringify(r.torrents));
  check('seeding torrents are kept', !r.torrents.includes('b'));
  check('finished link downloads only', JSON.stringify(r.downloads) === '["x"]', JSON.stringify(r.downloads));
  check('nothing finished gives empty lists', finishedTransfers([t('a', 'DOWNLOADING')], [d('x', 'paused')]).torrents.length === 0);

  check('copy for one', /1 finished/.test(clearFinishedCopy(1).title) && /files stay/i.test(clearFinishedCopy(1).body));
  check('copy for many', /3 finished/.test(clearFinishedCopy(3).title));

  const sheet = read('components/transfers/DownloadSheet.tsx');
  check('link sheet has Open folder', /Open folder/.test(sheet) && /onOpenFolder/.test(sheet));
  check('link sheet has Saved to row', /Saved to/.test(sheet) && /friendlyPath/.test(sheet));
  check('link sheet has Share when finished', /Share/.test(sheet) && /onShare/.test(sheet));

  const detail = read('app/torrent/[id].tsx');
  check('torrent detail renders Open folder for every state', /Open folder/.test(detail) && /Saved to/.test(detail));
  const done = read('components/detail/DoneActions.tsx');
  check('DoneActions exports a state-independent folder button', /export function OpenFolderButton/.test(done));

  const ctx = read('context/EngineContext.tsx');
  check('link removal goes through the undo window', /removingDl/.test(ctx) && /removeTransfers/.test(ctx));
  check('engine exposes removeTransfers', /removeTransfers: \(/.test(ctx));
  check('open folder helper for downloads', /openDownloadFolder/.test(read('app/(tabs)/index.tsx')));

  const tabs = read('app/(tabs)/index.tsx');
  check('transfers reads the download route param', /download\?: string/.test(tabs) && /setSheetDownloadId/.test(tabs));
  check('transfers has Clear finished', /Clear finished/.test(tabs) || /ClearFinishedSheet/.test(tabs));
  check('clear finished keeps files in copy', /files stay/i.test(fs.readFileSync(path.join(__dirname, '../components/transfers/model.ts'), 'utf8')));
  check('clear finished sheet exists', fs.existsSync(path.join(__dirname, '../components/transfers/ClearFinishedSheet.tsx')));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall download-gap checks passed');
}
main();
