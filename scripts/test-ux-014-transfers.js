#!/usr/bin/env node
// 0.14 Transfers: Resume anyway, Done while seeding, Open on finished cards, one merged list, Type a link first.
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
  const m = await import('../components/transfers/model.ts');
  const copy = await import('../utils/downloadCopy.ts');
  const base = { downloadSpeedBytes: 0, uploadSpeedBytes: 2048, downloadedBytes: 1000, totalSizeBytes: 1000, includedBytes: 1000, progressPercent: 100, etaSeconds: -1 };
  const t = (id, state, pausedBy = null, extra = {}) => ({ id, name: id, state, pausedBy, ratio: 0, ...base, ...extra });
  const d = (id, state, extra = {}) => ({ id, name: id, state, pausedBy: null, size: 1000, downloaded: 0, downBps: 0, eta: -1, addedAt: 0, ...extra });

  // Done while seeding
  const seeding = m.torrentStatus(t('a', 'SEEDING'), '—');
  check('seeding reads "Done · Seeding"', seeding.lead === 'Done · Seeding', seeding.lead);
  check('seeding keeps the upload speed slot', seeding.slot === 'upload' && /↑/.test(seeding.value || ''), String(seeding.value));
  const metered = m.torrentStatus(t('a', 'PAUSED', 'seed_metered'), '—');
  check('seed_metered reads "Done · Seeding waits for Wi-Fi"', metered.lead === 'Done · Seeding waits for Wi-Fi', metered.lead);
  check('seeding counts in Done', m.matchesFilter(t('a', 'SEEDING'), 'done'));
  check('seeding still counts in Seeding', m.matchesFilter(t('a', 'SEEDING'), 'seeding'));
  check('seed_metered counts in Done, not Paused', m.matchesFilter(t('a', 'PAUSED', 'seed_metered'), 'done') && !m.matchesFilter(t('a', 'PAUSED', 'seed_metered'), 'paused'));
  const r = m.finishedTransfers([t('a', 'COMPLETED'), t('b', 'SEEDING'), t('c', 'PAUSED', 'seed_limit'), t('d', 'PAUSED', 'user'), t('e', 'DOWNLOADING')], [d('x', 'finished'), d('y', 'paused')]);
  check('finishedTransfers includes seeding torrents', JSON.stringify(r.torrents) === '["a","b","c"]', JSON.stringify(r.torrents));
  const cf = m.clearFinishedCopy(2);
  check('Clear finished says seeding stops and files stay', /seeding/i.test(cf.body) && /files stay/i.test(cf.body), cf.body);

  // Resume anyway
  for (const by of ['wifi_only', 'battery', 'charging_only', 'schedule']) check(`${by} can resume anyway`, m.canResumeAnyway(by));
  for (const by of ['user', 'seed_limit', 'storage_full', 'no_peers', null]) check(`${by} cannot resume anyway`, !m.canResumeAnyway(by));
  check('wifi_only label is "Download now on mobile data"', m.resumeAnywayLabel('wifi_only') === 'Download now on mobile data');
  check('battery label is "Resume anyway"', m.resumeAnywayLabel('battery') === 'Resume anyway');
  check('explainer line exists', copy.WIFI_ANYWAY_NOTE === 'Just this one. Wi-Fi only stays on.');
  const dl = copy.downloadActions(d('x', 'paused', { pausedBy: 'wifi_only' }));
  check('link paused for Wi-Fi offers resumeAnyway', dl.some((a) => a.kind === 'resumeAnyway' && a.label === 'Download now on mobile data'), JSON.stringify(dl));
  const dl2 = copy.downloadActions(d('x', 'paused', { pausedBy: 'battery' }));
  check('link paused for battery offers Resume anyway', dl2.some((a) => a.kind === 'resumeAnyway' && a.label === 'Resume anyway'));

  // Open on finished cards
  check('seed_limit card action is Open', m.torrentCardAction(t('a', 'PAUSED', 'seed_limit'))?.kind === 'open');
  check('seed_metered card action is Resume anyway-free (no action)', m.torrentCardAction(t('a', 'PAUSED', 'seed_metered')) === null || m.torrentCardAction(t('a', 'PAUSED', 'seed_metered')).kind !== 'resume');
  check('wifi_only card action is resumeAnyway', m.torrentCardAction(t('a', 'PAUSED', 'wifi_only'))?.kind === 'resumeAnyway');
  check('user pause card action is resume', m.torrentCardAction(t('a', 'PAUSED', 'user'))?.kind === 'resume');

  // One merged list, sorted by the current sort
  const items = m.mergeTransfers(
    [t('slow', 'DOWNLOADING', null, { downloadSpeedBytes: 100 }), t('fast', 'DOWNLOADING', null, { downloadSpeedBytes: 5000 })],
    [d('link', 'downloading', { downBps: 1000 })],
    { key: 'downSpeed', dir: 'desc' },
  );
  check('a link between torrents by speed', items.map((i) => i.key).join() === 't:fast,d:link,t:slow', items.map((i) => i.key).join());
  const byName = m.mergeTransfers([t('b', 'DOWNLOADING')], [d('a', 'downloading'), d('c', 'finished')], { key: 'name', dir: 'asc' });
  check('name sort interleaves', byName.map((i) => i.key).join() === 'd:a,t:b,d:c');

  // Static checks
  const index = read('app/(tabs)/index.tsx');
  check('index no longer renders the notice banner', !/\{notice \?/.test(index) && !/dismissNotice/.test(index));
  check('index feeds one list (no downloads header)', !/ListHeaderComponent/.test(index) && /mergeTransfers/.test(index));
  check('Clear finished reachable from every filter (sort sheet)', /onClearFinished=/.test(index) && /onClearFinished/.test(read('components/transfers/SortSheet.tsx')));
  const card = read('components/TransferCard.tsx');
  const dsheet = read('components/transfers/DownloadSheet.tsx');
  const detail = read('app/torrent/[id].tsx');
  check('torrent card uses resumeAnyway', /resumeAnyway/.test(card) || /onResumeAnyway/.test(card));
  check('torrent detail uses resumeAnyway', /resumeAnyway/.test(detail));
  check('link sheet uses resumeDownloadAnyway', /resumeDownloadAnyway/.test(index + dsheet));
  check('link sheet shows the explainer', /WIFI_ANYWAY_NOTE/.test(dsheet));
  check('link sheet no longer hides Pause and Resume', !/a\.kind !== 'resume'/.test(dsheet));
  const empty = read('components/transfers/TeachingEmptyState.tsx');
  // 0.15: one primary "Add a link" (the add screen has Paste); the separate Paste link button is gone.
  check('empty state primary is Add a link', /label="Add a link"/.test(empty) && /onAdd/.test(empty));
  check('empty state has no separate Paste link button', !/Paste link/.test(empty));
  const pills = read('components/FilterPills.tsx');
  check('filter pills have a fade edge', /fade/i.test(pills));
  check('seeding is no longer plain "Seeding" on the card', !/line\('Seeding'/.test(read('components/transfers/model.ts')));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nux-014 transfers tests passed');
}
main();
