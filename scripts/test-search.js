#!/usr/bin/env node
// Search contract tests (docs/SEARCH_CONTRACT.md section 6). No network: fetch is mocked from fixtures.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).

// Silence Node's typeless-package ESM reparse notice for the .ts sources.
process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'search');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

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

function jsonRes(body, status = 200, type = 'application/json') {
  return new Response(body, { status, headers: { 'content-type': type } });
}

// Routes fetch() by hostname to a fixture body.
function installFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: String(url), init });
    for (const [host, handler] of Object.entries(routes)) {
      if (u.hostname === host) return handler(u, init);
    }
    throw new TypeError(`no route for ${u.hostname}`);
  };
  return calls;
}

const HEX40 = /^[0-9a-f]{40}$/;
const validResult = (r) => HEX40.test(r.infoHash) && r.magnet.startsWith('magnet:?xt=urn:btih:') && r.magnet.toLowerCase().includes(r.infoHash) && r.name;

async function main() {
  const agg = await import('../utils/search/aggregate.ts');
  const health = await import('../utils/search/health.ts');
  const magnet = await import('../utils/search/magnet.ts');
  const { knaben } = await import('../utils/search/providers/knaben.ts');
  const tcsv = await import('../utils/search/providers/torrentscsv.ts');
  const arch = await import('../utils/search/providers/archive.ts');
  const nyaa = await import('../utils/search/providers/nyaa.ts');
  const suke = await import('../utils/search/providers/sukebei.ts');
  const yts = await import('../utils/search/providers/yts.ts');
  const tpb = await import('../utils/search/providers/tpb.ts');
  const bits = await import('../utils/search/providers/bitsearch.ts');
  const lt = await import('../utils/search/providers/linuxtracker.ts');
  const tz = await import('../utils/search/providers/torznab.ts');
  const kn = await import('../utils/search/providers/knaben.ts');

  const ctx = (category = 'all', over = {}) => ({ baseUrl: 'https://example.test', category, hideAdult: true, limit: 50, ...over });

  // 1. Every provider parses its fixture into valid results.
  console.log('\n[1] fixtures parse to valid results');
  const cases = [
    ['knaben', kn.parse(fx('knaben.json'), ctx()), 2],
    ['torrentscsv', tcsv.parse(fx('torrentscsv.json'), ctx()), 3],
    ['archive', arch.parse(fx('archive.json'), ctx()), 3],
    ['nyaa', nyaa.parse(fx('nyaa.xml'), ctx()), 1],
    ['yts', yts.parse(fx('yts.json'), ctx()), 4],
    ['tpb', tpb.parse(fx('tpb.json'), ctx()), 3],
    ['bitsearch', bits.parse(fx('bitsearch.html'), ctx()), 2],
    ['linuxtracker', lt.parse(fx('linuxtracker.html'), ctx()), 2],
    ['sukebei', suke.parse(fx('sukebei.xml'), ctx('adult', { hideAdult: false })), 1],
    ['torznab', tz.parse(fx('torznab.xml'), ctx()), 2],
  ];
  for (const [name, rows, min] of cases) {
    check(`${name}: ${rows.length} results, all valid`, rows.length >= min && rows.every(validResult), `got ${rows.length}`);
  }

  // Field-level spot checks.
  const knRows = kn.parse(fx('knaben.json'), ctx());
  check('knaben: uses source magnet when present', knRows[0].magnet.includes('tr=') && knRows[0].seeders > 0);
  check('knaben: builds magnet when source has none', knRows[1].magnet.includes('dn='));
  check('knaben: category from numeric id', knRows[0].category === 'apps', knRows[0].category);
  const archRows = arch.parse(fx('archive.json'), ctx());
  check('archive: item without btih skipped', !archRows.some((r) => r.name === 'No btih here'));
  check('archive: seeders undefined', archRows.every((r) => r.seeders === undefined));
  const nyRows = nyaa.parse(fx('nyaa.xml'), ctx());
  check('nyaa: size 624 MiB parsed', nyRows[0].sizeBytes === 624 * 1024 * 1024, String(nyRows[0].sizeBytes));
  check('nyaa: pubDate parsed', nyRows[0].publishedAt === Date.parse('Tue, 03 Nov 2009 07:03:00 -0000'));
  const ytsRows = yts.parse(fx('yts.json'), ctx());
  check('yts: one row per quality, name has quality', ytsRows.every((r) => /\(\d{4}\) \S+/.test(r.name)), ytsRows[0].name);
  check('yts: category movies', ytsRows.every((r) => r.category === 'movies'));
  const btRows = bits.parse(fx('bitsearch.html'), ctx());
  check('bitsearch: title, size and seeders', btRows[0].name.includes('ubuntu') && btRows[0].sizeBytes > 1e9 && btRows[0].seeders === 28, JSON.stringify(btRows[0]));
  const ltRows = lt.parse(fx('linuxtracker.html'), ctx());
  check('linuxtracker: hash from link, seeders', ltRows[0].infoHash === 'e8cbdb334ffaa758d79ec634797b8c8b160a19d6' && ltRows[0].seeders === 7);
  const tzRows = tz.parse(fx('torznab.xml'), ctx());
  check('torznab: entities decoded and hash lowercased', tzRows[0].name === 'Ubuntu 26.04 Desktop amd64 & Tools' && tzRows[0].infoHash === 'dafc8c076ca2f3ed376eeae7c76a0d6be2415c45');
  check('torznab: leechers = peers - seeders', tzRows[0].leechers === 8);
  check('torznab: hash taken from magnet link; item with no hash skipped', tzRows[1].infoHash.startsWith('e8cbdb') && tzRows.length === 2);

  // Malformed input becomes a ProviderError, not a crash.
  for (const [name, mod, bad] of [['knaben', kn, '<html>oops</html>'], ['nyaa', nyaa, 'not xml'], ['yts', yts, '[]'], ['tpb', tpb, '{"a":1}']]) {
    let kind = null;
    try {
      mod.parse(bad, ctx());
    } catch (e) {
      kind = e.kind;
    }
    check(`${name}: garbage body -> typed error`, kind === 'parse' || kind === 'blocked', String(kind));
  }
  check('bitsearch: page with no cards -> empty list', bits.parse('<html><body><p>No results</p></body></html>', ctx()).length === 0);

  // 2. TPB sentinel.
  console.log('\n[2] TPB sentinel row');
  check('tpb: "No results returned" row ignored', tpb.parse(fx('tpb_empty.json'), ctx()).length === 0);

  // 3. Category routing.
  console.log('\n[3] category routing');
  const ids = (cat, prefs) => agg.eligibleProviders(cat, prefs).map((p) => p.id);
  const defaults = agg.PROVIDERS.filter((p) => p.enabledByDefault).map((p) => p.id);
  const all = agg.PROVIDERS.map((p) => p.id);
  check('movies reaches yts', ids('movies', { enabled: defaults }).includes('yts'));
  check('movies does not reach nyaa', !ids('movies', { enabled: defaults }).includes('nyaa'));
  check('anime reaches nyaa, not yts', ids('anime', { enabled: defaults }).includes('nyaa') && !ids('anime', { enabled: defaults }).includes('yts'));
  check('adult reaches nothing when adult is off', ids('adult', { enabled: all, adult: false }).length === 0);
  check('adult reaches sukebei and knaben when adult is on', ['sukebei', 'knaben'].every((i) => ids('adult', { enabled: all, adult: true }).includes(i)));
  check('all skips nsfw providers when adult is off', !ids('all', { enabled: all, adult: false }).includes('sukebei'));
  check('torrentscsv only for all/other', ids('all', { enabled: defaults }).includes('torrentscsv') && ids('other', { enabled: defaults }).includes('torrentscsv') && !ids('movies', { enabled: defaults }).includes('torrentscsv'));
  check('useFor restricts a provider', !ids('music', { enabled: defaults, useFor: { archive: ['books'] } }).includes('archive'));
  check('tpb has no anime', !ids('anime', { enabled: all, adult: true }).includes('tpb'));
  check('eligible order follows priority', ids('all', { enabled: ['yts', 'knaben'] }).join() === 'yts,knaben');
  const chipsOff = agg.availableCategories({ enabled: defaults, adult: false });
  check('chips: All first, no Adult when off', chipsOff[0] === 'all' && !chipsOff.includes('adult'), chipsOff.join());
  check('chips: Adult present when on', agg.availableCategories({ enabled: all, adult: true }).includes('adult'));
  check('chips: only supported categories', !agg.availableCategories({ enabled: ['yts'] }).includes('anime') && agg.availableCategories({ enabled: ['yts'] }).join() === 'all,movies');

  // Network-level routing: a movies search must never call Nyaa.
  health.resetHealth();
  const calls = installFetch({
    'api.knaben.org': () => jsonRes(fx('knaben.json')),
    'movies-api.accel.li': () => jsonRes(fx('yts.json')),
    'nyaa.si': () => jsonRes(fx('nyaa.xml'), 200, 'application/rss+xml'),
    'archive.org': () => jsonRes(fx('archive.json')),
    'torrents-csv.com': () => jsonRes(fx('torrentscsv.json')),
  });
  const upd = await agg.searchAll('matrix', 'movies', { enabled: defaults, waitSeconds: 2 });
  check('movies search: yts called, nyaa not', calls.some((c) => c.url.includes('accel.li')) && !calls.some((c) => c.url.includes('nyaa.si')));
  check('request carries generic UA and no cookies', calls.every((c) => c.init.headers['User-Agent'] === 'Maglev/0.1.0 (Android)' && !('Cookie' in c.init.headers) && c.init.credentials === 'omit'));
  check('final update is done with statuses', upd.done && upd.sources.every((s) => s.state === 'done'), JSON.stringify(upd.sources));
  const knCall = calls.find((c) => c.url.includes('knaben'));
  const knBody = JSON.parse(knCall.init.body);
  check('knaben body: movies category, hide_xxx true', knBody.categories[0] === 3000000 && knBody.hide_xxx === true, knCall.init.body);

  // 4. Merge.
  console.log('\n[4] merge');
  const A = 'dafc8c076ca2f3ed376eeae7c76a0d6be2415c45';
  const mk = (providerId, seeders, extra = {}) => ({ providerId, name: `n-${providerId}`, infoHash: A, magnet: `magnet:?xt=urn:btih:${A}`, seeders, ...extra });
  let merged = agg.mergeResults([mk('tpb', 5, { publishedAt: 2000, leechers: 9 }), mk('knaben', 40, { publishedAt: 1000, leechers: 1 })], ['knaben', 'tpb']);
  check('same hash -> one row', merged.length === 1);
  check('sources in priority order', merged[0].sources.join() === 'knaben,tpb');
  check('max seeders and leechers, earliest date', merged[0].seeders === 40 && merged[0].leechers === 9 && merged[0].publishedAt === 1000);
  merged = agg.mergeResults([mk('tpb', 10), mk('knaben', 10)], ['knaben', 'tpb']);
  check('tie goes to higher priority source', merged[0].providerId === 'knaben');
  merged = agg.mergeResults([mk('archive', undefined), mk('tpb', 3)], ['archive', 'tpb']);
  check('undefined seeders do not beat a count', merged[0].providerId === 'tpb' && merged[0].seeders === 3);
  merged = agg.mergeResults([mk('archive', 3, { name: 'Handbook by Rapha&euml;l Hertzog &ndash; 2nd &amp; final' })], ['archive']);
  check('names are entity-decoded (JSON providers too)', merged[0].name === 'Handbook by Raphaël Hertzog – 2nd & final', merged[0].name);
  // End to end: two providers, same hash.
  health.resetHealth();
  installFetch({
    'api.knaben.org': () => jsonRes(fx('knaben.json')),
    'torrents-csv.com': () => jsonRes(JSON.stringify({ torrents: [{ infohash: 'DAFC8C076CA2F3ED376EEAE7C76A0D6BE2415C45', name: 'ubuntu-26.04-desktop-amd64.iso', size_bytes: 1, seeders: 999, leechers: 0, created_unix: 1700000000 }] })),
  });
  const e2e = await agg.searchAll('ubuntu', 'all', { enabled: ['knaben', 'torrentscsv'], waitSeconds: 2 });
  const dup = e2e.results.find((r) => r.infoHash === A);
  check('e2e: one merged row with both sources and max seeders', e2e.results.filter((r) => r.infoHash === A).length === 1 && dup.sources.length === 2 && dup.seeders === 999, JSON.stringify(dup && dup.sources));
  const sorted = agg.sortResults(
    [mk('a', 1, { infoHash: 'a'.repeat(40), name: 'b', publishedAt: 5, sizeBytes: 1 }), mk('b', undefined, { infoHash: 'b'.repeat(40), name: 'a', publishedAt: 9, sizeBytes: 9 }), mk('c', 7, { infoHash: 'c'.repeat(40), name: 'c', sizeBytes: 5 })].map((r) => ({ ...r, sources: [r.providerId] })),
    'seeders',
  );
  check('sort seeders: undefined last', sorted.map((r) => r.providerId).join() === 'c,a,b');
  check('sort newest / size / name', agg.sortResults(sorted, 'newest')[0].providerId === 'b' && agg.sortResults(sorted, 'size')[0].providerId === 'b' && agg.sortResults(sorted, 'name')[0].name === 'a');

  // 5. Timeout does not block the others.
  console.log('\n[5] timeout and failure isolation');
  health.resetHealth();
  const updates = [];
  installFetch({
    'api.knaben.org': () => new Promise(() => {}), // never resolves, ignores the signal
    'movies-api.accel.li': () => jsonRes(fx('yts.json')),
    'archive.org': () => jsonRes('<html>Just a moment...</html>', 403, 'text/html'),
  });
  const t0 = Date.now();
  const res = await agg.searchAll('matrix', 'movies', { enabled: ['knaben', 'yts', 'archive'], waitSeconds: 0.2, onUpdate: (u) => updates.push(u) });
  const dt = Date.now() - t0;
  const st = Object.fromEntries(res.sources.map((s) => [s.providerId, s]));
  check('hung provider -> timeout', st.knaben.state === 'timeout', st.knaben.state);
  check('resolved within waitSeconds + slack', dt < 1500, `${dt}ms`);
  check('other provider still returns', st.yts.state === 'done' && res.results.length > 0);
  check('403 + html -> blocked', st.archive.state === 'blocked', st.archive.state);
  check('streamed: first update all searching, last done', updates[0].sources.every((s) => s.state === 'searching') && updates[updates.length - 1].done && updates.slice(0, -1).every((u) => !u.done));
  check('yts rows arrive before the timeout fires', updates.some((u) => !u.done && u.results.length > 0 && u.sources.some((s) => s.state === 'searching')));

  // Mirror retry: network error on mirror 1 falls to mirror 2; no retry on 4xx.
  health.resetHealth();
  const mcalls = installFetch({
    'nyaa.si': () => { throw new TypeError('network down'); },
    'nyaa.iss.ink': () => jsonRes(fx('nyaa.xml'), 200, 'application/rss+xml'),
  });
  const mr = await agg.searchAll('ubuntu', 'apps', { enabled: ['nyaa'], hideDead: false, waitSeconds: 2 });
  check('network error -> next mirror', mr.sources[0].state === 'done' && mcalls.length === 2, `${mr.sources[0].state}/${mcalls.length}`);
  health.resetHealth();
  const m2 = installFetch({ 'nyaa.si': () => jsonRes('nope', 404), 'nyaa.iss.ink': () => jsonRes(fx('nyaa.xml')) });
  const m2r = await agg.searchAll('ubuntu', 'apps', { enabled: ['nyaa'], hideDead: false, waitSeconds: 2 });
  check('404 does not try another mirror', m2r.sources[0].state === 'error' && m2.length === 1);
  health.resetHealth();
  const m3 = installFetch({ 'mirror.test': () => jsonRes(fx('nyaa.xml')) });
  await agg.searchAll('ubuntu', 'apps', { enabled: ['nyaa'], mirrorOverride: { nyaa: 'https://mirror.test' }, hideDead: false, waitSeconds: 2 });
  check('mirror override is used', m3.length === 1 && m3[0].url.startsWith('https://mirror.test/'));

  // Cancel.
  health.resetHealth();
  installFetch({ 'api.knaben.org': () => new Promise(() => {}) });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const c0 = Date.now();
  const cres = await agg.searchAll('x', 'all', { enabled: ['knaben'], waitSeconds: 15, signal: ac.signal });
  check('user cancel ends the search quickly', Date.now() - c0 < 1000 && cres.done);

  // Health: 3 consecutive failures pause a provider for 5 minutes.
  health.resetHealth();
  let now = 1_000_000;
  health.setClock(() => now);
  const hcalls = installFetch({ 'api.knaben.org': () => jsonRes('boom', 500) });
  for (let i = 0; i < 3; i++) await agg.searchAll('x', 'all', { enabled: ['knaben'], waitSeconds: 2 });
  const before = hcalls.length;
  const paused = await agg.searchAll('x', 'all', { enabled: ['knaben'], waitSeconds: 2 });
  check('3 failures -> provider skipped', hcalls.length === before && paused.sources[0].state === 'error' && /Paused/.test(paused.sources[0].message), paused.sources[0].message);
  now += 5 * 60 * 1000 + 1;
  await agg.searchAll('x', 'all', { enabled: ['knaben'], waitSeconds: 2 });
  check('retried after 5 minutes', hcalls.length > before);
  health.setClock(null);
  health.resetHealth();

  // testProvider.
  installFetch({ 'api.knaben.org': () => jsonRes(fx('knaben.json')) });
  const tp = await agg.testProvider('knaben');
  check('testProvider ok', tp.ok && tp.count === 2 && tp.ms >= 0, JSON.stringify(tp));
  installFetch({ 'api.knaben.org': () => jsonRes('<html></html>', 503, 'text/html') });
  const tp2 = await agg.testProvider('knaben');
  check('testProvider reports blocked', !tp2.ok && /bot check/i.test(tp2.message), tp2.message);
  health.resetHealth();

  // Torznab factory.
  health.resetHealth();
  const tprov = agg.createTorznabProvider({ id: 'abc', name: 'My Jackett', url: 'http://192.168.1.5:9117/api/v2.0/indexers/all/results/torznab/', categories: ['movies', 'tv'] }, 'KEY');
  const tcalls = installFetch({ '192.168.1.5': () => jsonRes(fx('torznab.xml'), 200, 'application/xml') });
  const tzres = await agg.searchAll('ubuntu', 'movies', { enabled: ['torznab:abc'], extraProviders: [tprov], waitSeconds: 2 });
  check('torznab: id prefix, url, key, cat', tprov.id === 'torznab:abc' && tcalls[0].url.includes('/torznab/api?t=search') && tcalls[0].url.includes('apikey=KEY') && tcalls[0].url.includes('cat=2000'), tcalls[0].url);
  check('torznab: results merged', tzres.results.length === 2 && tzres.results[0].providerId === 'torznab:abc');
  const tzAdult = agg.eligibleProviders('adult', { enabled: ['torznab:abc'], extraProviders: [tprov], adult: true });
  check('torznab: respects its category list', tzAdult.length === 0);

  // 6. hideDead.
  console.log('\n[6] hideDead');
  health.resetHealth();
  const dead = JSON.stringify({ torrents: [
    { infohash: '1'.repeat(40), name: 'zero', seeders: 0, leechers: 0 },
    { infohash: '2'.repeat(40), name: 'many', seeders: 4, leechers: 0 },
    { infohash: '3'.repeat(40), name: 'unknown' },
  ] });
  installFetch({ 'torrents-csv.com': () => jsonRes(dead) });
  const hd = await agg.searchAll('x', 'all', { enabled: ['torrentscsv'], hideDead: true, waitSeconds: 2 });
  check('hideDead drops 0, keeps undefined', hd.results.map((r) => r.name).sort().join() === 'many,unknown', hd.results.map((r) => r.name).join());
  const hd2 = await agg.searchAll('x', 'all', { enabled: ['torrentscsv'], hideDead: false, waitSeconds: 2 });
  check('hideDead off keeps everything', hd2.results.length === 3);

  // Magnet builder.
  console.log('\n[magnet]');
  const m = magnet.buildMagnet(A.toUpperCase(), 'A & B');
  check('magnet: lowercase hash, encoded name, trackers', m.startsWith(`magnet:?xt=urn:btih:${A}&dn=A%20%26%20B&tr=`) && m.includes('tracker.opentrackr.org'));
  const b32 = (hex) => {
    const A32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const bits = hex.match(/../g).map((h) => parseInt(h, 16).toString(2).padStart(8, '0')).join('');
    return bits.match(/.{5}/g).map((b) => A32[parseInt(b, 2)]).join('');
  };
  check('normalizeInfoHash: base32 round trip, zero hash rejected', magnet.normalizeInfoHash(b32(A)) === A && magnet.normalizeInfoHash('0'.repeat(40)) === null);
  check('infoHashFromMagnet reads btih', magnet.infoHashFromMagnet(`magnet:?dn=x&xt=urn:btih:${A.toUpperCase()}`) === A);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('test run crashed:', e);
  process.exit(1);
});
