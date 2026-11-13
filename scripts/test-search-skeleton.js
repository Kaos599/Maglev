#!/usr/bin/env node
// Search list: skeleton rows, stable order while sources answer, and the one background file-list read.
// Pure helpers run directly (Node 22.18+ type stripping); screen wiring is checked in the source.

process.removeAllListeners('warning');

const fs = require('node:fs');
const path = require('node:path');

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
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

function fakeEngine() {
  const calls = [];
  const cancels = [];
  return {
    calls,
    cancels,
    resolveMetadata(source, timeoutMs) {
      const d = deferred();
      calls.push({ source, timeoutMs, d });
      return d.promise;
    },
    cancelResolve(hash) {
      cancels.push(hash);
      const c = calls.find((x) => x.source.toLowerCase().includes(hash));
      if (c) c.d.resolve({ ok: false, code: 'CANCELLED', message: 'Cancelled' });
      return Promise.resolve({ ok: true });
    },
  };
}

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const mag = (h) => `magnet:?xt=urn:btih:${h}`;
const meta = (h) => ({ ok: true, infoHash: h, name: 'x', totalBytes: 1, files: [{ index: 0, path: 'x', length: 1 }] });

async function main() {
  const { stableOrder, seenRowCount, MIN_ROW_PX } = await import('../components/search/stableOrder.ts');
  const { MetadataPrefetcher, prefetchAllowed, PREFETCH_TIMEOUT_MS } = await import('../components/search/prefetch.ts');

  // ---- seenRowCount
  check('seen: nothing measured is 0', seenRowCount(0) === 0 && seenRowCount(NaN) === 0 && seenRowCount(-5) === 0);
  check('seen: rounds up with the shortest row', seenRowCount(MIN_ROW_PX * 8 + 1) === 9 && seenRowCount(MIN_ROW_PX * 8) === 8);

  // ---- stableOrder
  const k = (r) => r.h;
  const row = (h, s) => ({ h, s });
  const first = [row('a', 50), row('b', 40), row('c', 30)];
  check('order: nothing shown yet is the ranked list itself', stableOrder([], first, 10, k) === first);
  check('order: nothing seen is the ranked list itself', stableOrder(['a', 'b', 'c'], first, 0, k) === first);
  // A later source brings a better row and fresh copies of the shown ones.
  const second = [row('x', 99), row('a', 51), row('b', 40), row('y', 35), row('c', 30)];
  const kept = stableOrder(['a', 'b', 'c'], second, 2, k);
  check('order: seen rows keep their slots', kept[0].h === 'a' && kept[1].h === 'b', kept.map(k).join(''));
  check('order: seen rows carry the fresh data', kept[0].s === 51);
  check('order: the rest is ranked below them', kept.slice(2).map(k).join('') === 'xyc', kept.map(k).join(''));
  check('order: no row lost or doubled', kept.length === second.length && new Set(kept.map(k)).size === kept.length);
  const all = stableOrder(['a', 'b', 'c'], second, 99, k);
  check('order: pin count above what was shown pins only what was shown', all.map(k).join('') === 'abcxy', all.map(k).join(''));
  const unchanged = [row('a', 1), row('b', 1), row('n', 1)];
  check('order: when nothing moves the ranked array comes back', stableOrder(['a', 'b'], unchanged, 2, k) === unchanged);
  const gone = stableOrder(['z', 'a'], [row('b', 9), row('a', 1)], 2, k);
  check('order: a shown row that left drops out', gone.map(k).join('') === 'ab', gone.map(k).join(''));
  check('order: empty ranked stays empty', stableOrder(['a'], [], 5, k).length === 0);
  // Streaming: three sources answer in turn; the first screen (3 rows) never moves.
  let shown = [];
  const waves = [
    [row('a', 10), row('b', 9), row('c', 8), row('d', 7)],
    [row('e', 50), row('a', 10), row('b', 9), row('f', 8.5), row('c', 8), row('d', 7)],
    [row('g', 90), row('e', 50), row('a', 12), row('b', 9), row('f', 8.5), row('c', 8), row('d', 7)],
  ];
  let firstScreen = null;
  let steady = true;
  for (const ranked of waves) {
    const out = stableOrder(shown.map(k), ranked, 3, k);
    const top = out.slice(0, 3).map(k).join('');
    if (firstScreen === null) firstScreen = top;
    else if (top !== firstScreen) steady = false;
    shown = out;
  }
  check('order: streamed answers never move the first screen', steady && firstScreen === 'abc', shown.map(k).join(''));
  check('order: later better rows sit right under the seen ones, best first', shown.slice(3, 5).map(k).join('') === 'ge', shown.map(k).join(''));

  // ---- MetadataPrefetcher
  {
    const eng = fakeEngine();
    const p = new MetadataPrefetcher(eng);
    check('prefetch: a magnet starts one read', p.start(H1, mag(H1)) === true && eng.calls.length === 1);
    check('prefetch: shorter wait than the Add screen', eng.calls[0].timeoutMs === PREFETCH_TIMEOUT_MS && PREFETCH_TIMEOUT_MS < 60_000);
    check('prefetch: the same hash is not read twice', p.start(H1, mag(H1)) === false && eng.calls.length === 1);
    check('prefetch: not a magnet is skipped', p.start(H2, 'https://x.test/a.torrent') === false && p.start('', mag(H2)) === false);
    p.start(H2, mag(H2));
    await tick();
    check('prefetch: only one read at a time (the older one is cancelled)', eng.cancels.includes(H1) && p.runningHash === H2 && !p.has(H1));
    eng.calls[1].d.resolve(meta(H2));
    await tick();
    check('prefetch: a finished read is kept by hash', p.peek(H2)?.ok === true && p.runningHash === null);
    const t = p.take(H2.toUpperCase());
    check('prefetch: take() finds it, any case', !!t && (await t).ok === true);
    check('prefetch: take() of an unknown hash is null', p.take(H3) === null);
  }
  {
    const eng = fakeEngine();
    const p = new MetadataPrefetcher(eng);
    p.start(H1, mag(H1));
    const taken = p.take(H1);
    p.cancel();
    p.cancelIf(H1);
    p.start(H2, mag(H2));
    check('prefetch: a read the Add screen took is never cancelled', !eng.cancels.includes(H1));
    eng.calls[0].d.resolve(meta(H1));
    check('prefetch: the Add screen gets the running read', (await taken).ok === true);
  }
  {
    const eng = fakeEngine();
    let now = 1_000;
    const p = new MetadataPrefetcher(eng, { now: () => now, retryAfterMs: 5_000 });
    p.start(H1, mag(H1));
    eng.calls[0].d.resolve({ ok: false, code: 'METADATA_TIMEOUT', message: 'slow' });
    await tick();
    check('prefetch: a failed read is not kept', !p.has(H1) && p.take(H1) === null);
    check('prefetch: a failed hash waits before another try', p.start(H1, mag(H1)) === false);
    now += 6_000;
    check('prefetch: and is tried again later', p.start(H1, mag(H1)) === true);
    p.cancelIf(H2);
    check('prefetch: cancelIf another hash leaves the read alone', p.runningHash === H1);
    p.cancelIf(H1);
    await tick();
    check('prefetch: cancelIf its hash stops it, and a cancel is not a failure', p.runningHash === null && p.start(H1, mag(H1)) === true);
  }
  {
    const eng = fakeEngine();
    const p = new MetadataPrefetcher(eng);
    p.start(H1, mag(H1));
    const taken = p.take(H1);
    eng.calls[0].d.reject(new Error('bridge gone'));
    let threw = false;
    try {
      await taken;
    } catch {
      threw = true;
    }
    check('prefetch: an engine error reaches the Add screen like its own call', threw && !p.has(H1));
  }
  {
    const eng = fakeEngine();
    const p = new MetadataPrefetcher(eng, { maxEntries: 2 });
    for (const h of [H1, H2, H3]) {
      p.start(h, mag(h));
      eng.calls[eng.calls.length - 1].d.resolve(meta(h));
      await tick();
    }
    check('prefetch: the session cache is capped, oldest out', !p.has(H1) && p.has(H2) && p.has(H3));
  }

  // ---- prefetchAllowed
  check('network: Wi-Fi only off allows reads', prefetchAllowed({ wifiOnly: false, torrents: [] }));
  check('network: Wi-Fi only on with no proof says no', !prefetchAllowed({ wifiOnly: true, torrents: [] }));
  check('network: Wi-Fi only on, all paused by the user, says no', !prefetchAllowed({ wifiOnly: true, torrents: [{ state: 'PAUSED', pausedBy: 'user' }] }));
  check('network: a moving transfer proves Wi-Fi', prefetchAllowed({ wifiOnly: true, torrents: [{ state: 'SEEDING', pausedBy: null }] }));
  check('network: a link download moving proves Wi-Fi', prefetchAllowed({ wifiOnly: true, torrents: [], downloads: [{ state: 'downloading', pausedBy: null }] }));
  check(
    'network: anything waiting for Wi-Fi says no',
    !prefetchAllowed({ wifiOnly: true, torrents: [{ state: 'DOWNLOADING' }, { state: 'PAUSED', pausedBy: 'wifi_only' }] }),
  );

  // ---- wiring (source checks)
  const search = read('app/(tabs)/search.tsx');
  const transfers = read('app/(tabs)/index.tsx');
  const skeleton = read('components/search/SkeletonRows.tsx');
  const add = read('app/add-torrent.tsx');
  check('search: results use FlashList, not FlatList', /<FlashList\b/.test(search) && !/\bFlatList\b/.test(search));
  check('search: skeleton rows before the first result', /ListEmptyComponent=\{\s*searching \?\s*\(\s*<SkeletonRows count=\{SKELETON_FIRST_COUNT\}/.test(search));
  check('search: stable order applied to the shown rows', /stableOrder\(shownKeys\.current/.test(search));
  check('search: per-source status line kept', /sources answered, results appear as they arrive/.test(search));
  check('search: the read waits for the top row to hold its place', /PREFETCH_STABLE_MS = 1500/.test(search) && /metadataPrefetch\.start\(/.test(search));
  check('search: the read obeys the network rule', /prefetchAllowed\(/.test(search) && /settings\.network\.wifiOnly/.test(search));
  check('search: a direct add stops a read of the same torrent', /metadataPrefetch\.cancelIf\(readHash\)[\s\S]{0,80}startTorrent\(ready\.magnet\)/.test(search));
  check('transfers: list uses FlashList, not FlatList', /<FlashList\b/.test(transfers) && !/<FlatList\b/.test(transfers));
  check('transfers: steadyRow still shapes each card', /torrent=\{steadyRow\(item\.torrent\)\}/.test(transfers));
  check('transfers: no scroll anchoring on a live-sorted list', /maintainVisibleContentPosition=\{NO_ANCHOR\}/.test(transfers));
  const SK_MIN = 'SKELETON_FIRST_COUNT = ';
  const n = Number(skeleton.slice(skeleton.indexOf(SK_MIN) + SK_MIN.length).match(/^\d+/)?.[0]);
  check('skeleton: 4 to 6 rows before results', n >= 4 && n <= 6, String(n));
  check('skeleton: no loop, shimmer or pulse (AGENTS 5)', !/Animated\.loop|withRepeat|shimmer|pulse/i.test(skeleton.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')));
  check('skeleton: theme tokens only, no hex', !/#[0-9a-fA-F]{3,8}\b/.test(skeleton) && /useTheme\(\)/.test(skeleton));
  check('skeleton: respects reduce motion', /useReduceMotion\(\)/.test(skeleton));
  check('add: uses the background read when there is one', /takePrefetchedMetadata\(source\)/.test(add));
  check('add: a background read that gave up early is retried for the rest of the wait', /METADATA_TIMEOUT'[\s\S]{0,120}RESOLVE_TIMEOUT_MS - \(Date\.now\(\) - began\)/.test(add));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
