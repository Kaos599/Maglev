#!/usr/bin/env node
// Tests for the anime search providers ported from TorrentSearch. No network: fixtures are real captures
// (see scripts/fixtures/search/*_SOURCES.txt). Needs Node 22.18+.

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

const HEX40 = /^[0-9a-f]{40}$/;
const validResult = (r) => HEX40.test(r.infoHash) && r.magnet.startsWith('magnet:?xt=urn:btih:') && r.magnet.toLowerCase().includes(r.infoHash) && r.name;

async function main() {
  const agg = await import('../utils/search/aggregate.ts');
  const tt = await import('../utils/search/providers/tokyotoshokan.ts');
  const nb = await import('../utils/search/providers/nekobt.ts');
  const mk = await import('../utils/search/providers/mikan.ts');
  const dm = await import('../utils/search/providers/dmhy.ts');
  const bm = await import('../utils/search/providers/bangumimoe.ts');
  const al = await import('../utils/search/providers/anilibria.ts');
  const ar = await import('../utils/search/providers/anirena.ts');
  const idx = await import('../utils/search/providers/index.ts');

  const ctx = (category = 'all', over = {}) => ({ baseUrl: 'https://example.test', category, hideAdult: true, limit: 200, ...over });
  const signal = new AbortController().signal;

  console.log('\n[1] registration');
  for (const id of ['tokyotoshokan', 'nekobt', 'mikan', 'dmhy', 'bangumimoe', 'anilibria', 'anirena']) {
    const p = idx.PROVIDERS.find((x) => x.id === id);
    check(`${id}: registered, off by default, has anime`, p && p.enabledByDefault === false && p.categories.includes('anime'));
  }
  check('tokyotoshokan declares a Cloudflare solver page', idx.tokyotoshokan.cloudflare?.solverUrl.startsWith('https://'));

  console.log('\n[2] fixtures parse');
  const cases = [
    ['tokyotoshokan', tt.parse(fx('tokyotoshokan_search.html'), ctx()), 60],
    ['nekobt', nb.parse(fx('nekobt_search.json'), ctx()), 15],
    ['mikan', mk.parse(fx('mikan_search.html'), ctx()), 20],
    ['dmhy', dm.parse(fx('dmhy_search.html'), ctx()), 70],
    ['bangumimoe', bm.parse(fx('bangumimoe_search.json'), ctx()), 15],
    ['anilibria', al.parse(fx('anilibria_torrents_9542.json'), ctx()), 2],
    ['anirena (rss)', ar.parse(fx('anirena_search.xml'), ctx()), 90],
  ];
  for (const [name, rows, min] of cases) {
    const ok = name.startsWith('anirena') ? rows.every((r) => r.name && r.magnet === '' && r.infoHash.startsWith('anirena:') && r.detailUrl) : rows.every(validResult);
    check(`${name}: ${rows.length} results, all valid`, rows.length >= min && ok, `got ${rows.length}`);
  }

  console.log('\n[3] field checks');
  const t = tt.parse(fx('tokyotoshokan_search.html'), ctx());
  check('tokyotoshokan: base32 magnet converted to hex', HEX40.test(t[0].infoHash) && t[0].infoHash === t[0].magnet.match(/btih:([0-9a-f]{40})/)[1]);
  check('tokyotoshokan: first row Dr. Stone, 1.37GB, S4 L2', t[0].name.startsWith('[Anku & mutagenb] Dr. Stone S4 - 02') && t[0].sizeBytes === 1.37e9 && t[0].seeders === 4 && t[0].leechers === 2 && t[0].publishedAt === Date.UTC(2025, 0, 16, 23, 19), JSON.stringify(t[0]));
  check('tokyotoshokan: adult rows hidden by default, kept when allowed', t.every((r) => r.category !== 'adult') && tt.parse(fx('tokyotoshokan_search.html'), ctx('all', { hideAdult: false })).some((r) => r.category === 'adult'));
  check('tokyotoshokan: details URL absolute', t[0].detailUrl === 'https://example.test/details.php?id=1943387', t[0].detailUrl);

  const n = nb.parse(fx('nekobt_search.json'), ctx());
  check('nekobt: size, seeders, leechers, date, hash', n[0].infoHash === '07a748304e430ed0367e293cab7c3f0d8d89175e' && n[0].sizeBytes === 6107202578 && n[0].seeders === 22 && n[0].leechers === 1 && n[0].publishedAt === 1787099818069, JSON.stringify(n[0]));
  check('nekobt: item without infohash skipped', nb.parse(JSON.stringify({ data: { results: [{ title: 'x' }] } }), ctx()).length === 0);

  const m = mk.parse(fx('mikan_search.html'), ctx());
  check('mikan: hash, size 7.6GB, China-time date', m[0].infoHash === '8e4e8471b226e311eb7b3b77476eec7834052dbd' && m[0].sizeBytes === 7.6e9 && m[0].publishedAt === Date.UTC(2026, 9, 17, 15, 42), JSON.stringify(m[0]));
  check('mikan: name is decoded', m[0].name.includes('Sousou no Frieren') && m[0].name.includes('葬送的芙莉莲'));

  const d = dm.parse(fx('dmhy_search.html'), ctx());
  check('dmhy: base32 magnet converted to hex', HEX40.test(d[0].infoHash) && d[0].infoHash === d[0].magnet.match(/btih:([0-9a-f]{40})/)[1]);
  check('dmhy: size, seeders, peers, date, category', d[0].sizeBytes === 7.6e9 && d[0].seeders === 13 && d[0].leechers === 1 && d[0].publishedAt === Date.UTC(2026, 9, 17, 15, 42) && d[0].category === 'anime', JSON.stringify(d[0]));
  check('dmhy: title has no highlight markup', d.every((r) => !/[<>]/.test(r.name)));
  check('dmhy: sort id mapping', dm.categoryFromSortId('3') === 'books' && dm.categoryFromSortId('44') === 'music' && dm.categoryFromSortId('999') === 'other');

  const b = bm.parse(fx('bangumimoe_search.json'), ctx());
  check('bangumimoe: hash, size 52.02 GB, date', b[0].infoHash === 'f8651444a2c0b3ff7e3da3cbd75da58ef5f09e19' && b[0].sizeBytes === 52.02e9 && b[0].publishedAt === Date.parse('2026-08-27T21:32:36.253Z'), JSON.stringify(b[0]));

  const a = al.parse(fx('anilibria_torrents_9542.json'), ctx());
  check('anilibria: hash, size, seeders, label name', a[0].infoHash === '2f8f88eb64310eb6c72a2193a068514428583927' && a[0].sizeBytes === 8314190487 && a[0].seeders === 114 && a[0].name.includes('AniLiberty'), JSON.stringify(a[0]));
  check('anilibria: releases list', al.parseReleases(fx('anilibria_releases.json')).length === 2 && al.parseReleases(fx('anilibria_releases.json'))[0].id === 9542);

  const r = ar.parse(fx('anirena_search.xml'), ctx());
  check('anirena: tag prefix stripped, size, date, category', r[0].name.startsWith('Sousou no Frieren - S02') && r[0].sizeBytes === 5.7e9 && r[0].publishedAt === Date.parse('Wed, 19 Aug 2026 00:36:00 +0000') && r[0].category === 'anime', JSON.stringify(r[0]));
  check('anirena: non-anime category labels mapped', r.some((x) => x.category === 'music') && r.some((x) => x.category === 'other'));
  const mg = ar.parseMagnet(fx('anirena_detail.html'), 'x');
  check('anirena: detail page gives the info hash and a magnet', mg.infoHash === '07a748304e430ed0367e293cab7c3f0d8d89175e' && mg.magnet.includes(mg.infoHash));

  console.log('\n[4] search flows (mocked fetch)');
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    seen.push({ url: String(url), init });
    if (u.hostname === 'anilibria.test') {
      if (u.pathname.endsWith('/app/search/releases')) return new Response(fx('anilibria_releases.json'), { status: 200, headers: { 'content-type': 'application/json' } });
      if (u.pathname.endsWith('/release/9542')) return new Response(fx('anilibria_torrents_9542.json'), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('boom', { status: 500 });
    }
    if (u.hostname === 'anirena.test') return new Response(fx('anirena_detail.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.hostname === 'bgm.test') return new Response(fx('bangumimoe_search.json'), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new TypeError('no route');
  };
  const alRows = await al.anilibria.search('frieren', 'anime', 1, { baseUrl: 'https://anilibria.test', signal, hideAdult: true, limit: 50 });
  check('anilibria: search = release lookup then torrents per release; a failing release is skipped', alRows.length === a.length && seen.length === 3, `${alRows.length} rows, ${seen.length} calls`);
  seen.length = 0;
  const bmRows = await bm.bangumimoe.search('frieren', 'anime', 1, { baseUrl: 'https://bgm.test', signal, hideAdult: true, limit: 50 });
  check('bangumimoe: search POSTs {query} as JSON', bmRows.length >= 15 && seen[0].init.method === 'POST' && seen[0].init.body === '{"query":"frieren"}' && seen[0].url.endsWith('/api/v2/torrent/search'));
  const arSeen = ar.parse(fx('anirena_search.xml'), ctx({}, { baseUrl: 'https://anirena.test' }));
  const done = await agg.resolveResult({ ...arSeen[0], detailUrl: 'https://anirena.test/torrent/x', sources: [ar.ID] }, signal);
  check('anirena: resolveResult fills the real magnet and hash', done.infoHash === '07a748304e430ed0367e293cab7c3f0d8d89175e' && done.magnet.startsWith('magnet:?xt=urn:btih:07a748'));

  console.log('\n[5] garbage input -> typed error');
  for (const [name, mod, bad] of [['tokyotoshokan', tt, 'oops'], ['nekobt', nb, '{"a":1}'], ['mikan', mk, 'oops'], ['dmhy', dm, 'oops'], ['bangumimoe', bm, '[]'], ['anilibria', al, '{"a":1}'], ['anirena', ar, '<html>oops</html>']]) {
    let kind = null;
    try {
      mod.parse(bad, ctx());
    } catch (e) {
      kind = e.kind;
    }
    check(`${name}: garbage body -> typed error`, kind === 'parse' || kind === 'blocked', String(kind));
  }
  check('dmhy/mikan: page with no rows -> empty list', dm.parse('<html><body></body></html>', ctx()).length === 0 && mk.parse('<html><body></body></html>', ctx()).length === 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('test run crashed:', e);
  process.exit(1);
});
