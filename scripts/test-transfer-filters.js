#!/usr/bin/env node
// Transfers filters: link downloads must show under the filter that matches their state, and be counted the same way.
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

async function main() {
  const m = await import('../components/transfers/model.ts');
  const dl = (id, state) => ({ id, state });
  const t = (id, state, pausedBy = null) => ({ id, state, pausedBy });
  const downloads = [
    dl('a', 'resolving'),
    dl('b', 'queued'),
    dl('c', 'downloading'),
    dl('d', 'verifying'),
    dl('e', 'paused'),
    dl('f', 'finished'),
    dl('g', 'error'),
    dl('h', 'needs_link'),
  ];
  const ids = (f) => downloads.filter((x) => m.downloadMatchesFilter(x, f)).map((x) => x.id).join('');

  console.log('link downloads per filter');
  check('all shows every download', ids('all') === 'abcdefgh');
  check('downloading', ids('downloading') === 'abcd');
  check('paused', ids('paused') === 'e');
  check('done', ids('done') === 'f');
  check('errors includes needs_link', ids('errors') === 'gh');
  check('seeding has no downloads', ids('seeding') === '');
  check('every download is in exactly one non-all filter', downloads.every((x) => m.FILTERS.filter((f) => f.id !== 'all' && m.downloadMatchesFilter(x, f.id)).length === 1));

  console.log('counts');
  const torrents = [t('x', 'DOWNLOADING'), t('y', 'SEEDING'), t('z', 'COMPLETED')];
  const c = m.countByFilter(torrents, downloads);
  check('all adds both lists', c.all === 11);
  check('downloading adds links', c.downloading === 5);
  check('seeding counts torrents only', c.seeding === 1);
  check('paused', c.paused === 1);
  check('done includes the seeding torrent (0.14)', c.done === 3);
  check('errors', c.errors === 2);
  check('torrent-only call still works', m.countByFilter(torrents).all === 3 && m.countByFilter(torrents).done === 2);

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\ntransfer filter tests passed');
}
main();
