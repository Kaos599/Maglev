#!/usr/bin/env node
// SEARCH_CONTRACT section 9: direct-file results. No network. Needs Node 22.18+.

process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

const directRow = (over = {}) => ({
  providerId: 'gutenberg',
  name: 'Pride and Prejudice - Jane Austen',
  infoHash: 'gutenberg:1342',
  magnet: '',
  directUrl: 'https://www.gutenberg.org/ebooks/1342.epub3.images',
  category: 'books',
  ...over,
});
const HASH = 'a'.repeat(40);
const magnetRow = (over = {}) => ({
  providerId: 'tpb',
  name: 'Some torrent',
  infoHash: HASH,
  magnet: `magnet:?xt=urn:btih:${HASH}`,
  seeders: 5,
  ...over,
});

async function main() {
  const agg = await import('../utils/search/aggregate.ts');
  const sharing = await import('../components/search/sharing.ts');
  const watch = await import('../utils/watch/logic.ts');
  const ac = new AbortController();

  const merged = agg.mergeResults([directRow(), magnetRow()], ['tpb', 'gutenberg']);
  const d = merged.find((r) => r.infoHash === 'gutenberg:1342');
  check('a direct result survives merge with its directUrl', !!d && d.directUrl === directRow().directUrl && d.magnet === '');
  check('a direct result keeps its own key next to magnet rows', merged.length === 2);
  check('two providers with the same stand-in hash merge into one', agg.mergeResults([directRow(), directRow({ providerId: 'other' })], []).length === 1);

  check('hideDead keeps a direct result (seeders unknown)', sharing.passesResultFilter(d, { hideDead: true, minBytes: 0 }));
  check('hideDead still drops a dead torrent', !sharing.passesResultFilter(magnetRow({ seeders: 0 }), { hideDead: true, minBytes: 0 }));
  check('size range keeps a direct result of unknown size', sharing.passesResultFilter(d, { hideDead: false, minBytes: 100, maxBytes: 200 }));

  const sorted = agg.sortResults(merged, 'seeders');
  check('sorts with unknown seeders (magnet row first, direct last)', sorted[0].infoHash === HASH && sorted[1].infoHash === 'gutenberg:1342');
  check('sorts by name without throwing', agg.sortResults(merged, 'name').length === 2);

  const r = await agg.resolveResult(d, ac.signal);
  check('resolveResult returns a direct result unchanged', r === d);
  const m = await agg.resolveResult(magnetRow(), ac.signal);
  check('resolveResult still passes a magnet result through', m.magnet.startsWith('magnet:'));
  let threw = false;
  try {
    await agg.resolveResult({ ...magnetRow(), magnet: '' }, ac.signal);
  } catch {
    threw = true;
  }
  check('a row with neither magnet nor directUrl still fails to resolve', threw);

  const route = agg.directAddRoute(d);
  check('Add routes a direct result to /add-download with the url as source', !!route && route.pathname === '/add-download' && route.params.source === d.directUrl);
  check('Add does not route a magnet result', agg.directAddRoute(magnetRow()) === null);
  check('Add refuses a non-https directUrl', agg.directAddRoute(directRow({ directUrl: 'http://x.test/a.epub' })) === null);

  check('watch notification skips a direct result', watch.downloadUrl(d) === undefined);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
