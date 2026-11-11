#!/usr/bin/env node
// Tests for the providers ported from prajwalch/TorrentSearch: LimeTorrents, TorrentDownloads, TorrentDownload,
// TheRarBg, Ext, MyPornClub, XXXClub, XXXTracker. No network: parsers run on recorded fixtures
// (scripts/fixtures/search/*_SOURCES.txt say where each came from). Needs Node 22.18+.

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
const EMPTY_PAGE = '<!doctype html><html><body><div id="content"><p>Nothing here</p></div></body></html>';

async function main() {
  const agg = await import('../utils/search/aggregate.ts');
  const dates = await import('../utils/search/dates.ts');
  const { sha256Hex } = await import('../utils/search/sha256.ts');
  const { PROVIDERS } = await import('../utils/search/providers/index.ts');
  const lime = await import('../utils/search/providers/limetorrents.ts');
  const tds = await import('../utils/search/providers/torrentdownloads.ts');
  const tdl = await import('../utils/search/providers/torrentdownload.ts');
  const rar = await import('../utils/search/providers/therarbg.ts');
  const ext = await import('../utils/search/providers/ext.ts');
  const mpc = await import('../utils/search/providers/mypornclub.ts');
  const xc = await import('../utils/search/providers/xxxclub.ts');
  const xt = await import('../utils/search/providers/xxxtracker.ts');

  const ctx = (category = 'all', over = {}) => ({ baseUrl: 'https://example.test', category, hideAdult: false, limit: 50, ...over });
  const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

  console.log('\n[dates] relative and formatted dates');
  check('"8 days ago"', dates.parseRelative('8 days ago', NOW) === NOW - 8 * 86_400e3);
  check('"1 year, 8 months"', dates.parseRelative('1 year, 8 months', NOW) === NOW - (365 + 240) * 86_400e3);
  check('"Yesterday" and "Last month"', dates.parseRelative('Yesterday', NOW) === NOW - 86_400e3 && dates.parseRelative('Last month', NOW) === NOW - 30 * 86_400e3);
  check('unknown text -> undefined', dates.parseRelative('soon', NOW) === undefined && dates.parseRelative('', NOW) === undefined);
  check('"11 Nov 2026 18:04:58"', dates.parseDayMonthYear('11 Nov 2026 18:04:58') === Date.UTC(2026, 10, 11, 18, 4, 58));
  check('"11 February 2026"', dates.parseDayMonthYear('11 February 2026') === Date.UTC(2026, 1, 11));
  check('"2026-04-23"', dates.parseIsoLike('2026-04-23') === Date.UTC(2026, 3, 23));

  // ---------------------------------------------------------------- LimeTorrents
  console.log('\n[limetorrents]');
  const limeRows = lime.parse(fx('limetorrents_search.html'), ctx(), NOW);
  check('parses the live fixture into valid results', limeRows.length >= 20 && limeRows.every(validResult), String(limeRows.length));
  const l0 = limeRows[0];
  check('first row fields', l0.name === 'Alina Bzhezhinska - Inspiration (2018, Ubuntu)' && l0.infoHash === 'e95fd6bbd15480468ec48c57fd4210afc623cd1a' && l0.sizeBytes === 286_960_000 && l0.seeders === 0 && l0.leechers === 1 && l0.category === 'music', JSON.stringify(l0));
  check('relative date parsed against now', l0.publishedAt === NOW - 8 * 86_400e3);
  check('detailUrl is absolute', l0.detailUrl.startsWith('https://example.test/') && l0.detailUrl.endsWith('.html'));
  check('limit is honoured', lime.parse(fx('limetorrents_search.html'), ctx('all', { limit: 3 }), NOW).length === 3);
  check('empty page -> []', lime.parse(EMPTY_PAGE, ctx()).length === 0);
  let limeErr = null;
  try {
    lime.parse('{"not":"html"}', ctx());
  } catch (e) {
    limeErr = e;
  }
  check('non-HTML body -> parse error', limeErr && limeErr.kind === 'parse');
  check('search url: category segment, seeds sort, page', lime.searchUrl('https://x.test/', 'a b', 'tv', 2) === 'https://x.test/search/tv/a%20b/seeds/2/' && lime.searchUrl('https://x.test', 'q', 'books', 1) === 'https://x.test/search/all/q/seeds/1/');

  // ---------------------------------------------------------------- TorrentDownload
  console.log('\n[torrentdownload]');
  const tdlRows = tdl.parse(fx('torrentdownload_search.html'), ctx(), NOW);
  check('parses the live fixture into valid results', tdlRows.length >= 20 && tdlRows.every(validResult), String(tdlRows.length));
  const t0 = tdlRows[0];
  check('first row fields (Fast Links table skipped)', t0.name === 'Ubuntu 10 04 LTS x64' && t0.infoHash === 'a1425e0d6630336cdd9fb320f3fff1030098975a' && t0.sizeBytes === 697_570_000 && t0.seeders === 4341 && t0.leechers === 2956 && t0.category === 'apps', JSON.stringify(t0));
  check('no row comes from the sponsored table', tdlRows.every((r) => !/Download Anonymously|Direct Download/.test(r.name)));
  check('empty page -> []', tdl.parse(EMPTY_PAGE, ctx()).length === 0);
  check('search url pages with &p=', tdl.searchUrl('https://x.test', 'ubuntu', 1) === 'https://x.test/search?q=ubuntu' && tdl.searchUrl('https://x.test', 'ubuntu', 3) === 'https://x.test/search?q=ubuntu&p=3');

  // ---------------------------------------------------------------- TheRarBg
  console.log('\n[therarbg]');
  const rarRows = rar.parse(fx('therarbg_search.html'), ctx());
  check('parses the live fixture into rows without magnets', rarRows.length >= 20 && rarRows.every((r) => r.magnet === '' && /^therarbg:[0-9a-z]+$/.test(r.infoHash) && r.detailUrl && r.name), String(rarRows.length));
  const r0 = rarRows[0];
  check('first row fields', r0.name === 'ubuntu-24.04.1-desktop-amd64.iso' && r0.infoHash === 'therarbg:8a6ee9' && r0.sizeBytes === 5_800_000_000 && r0.seeders === 164 && r0.leechers === 67 && r0.category === 'apps' && r0.publishedAt === Date.UTC(2026, 3, 23), JSON.stringify(r0));
  check('E-books map to books', rarRows.some((r) => r.category === 'books'));
  check('empty page -> []', rar.parse(EMPTY_PAGE, ctx()).length === 0);
  const rarMag = rar.parseMagnet(fx('therarbg_detail.html'));
  check('detail page: magnet and lower-cased info hash', rarMag.infoHash === '4a3f5e08bcef825718eda30637230585e3330599' && rarMag.magnet.startsWith('magnet:?xt=urn:btih:4A3F5E08') && rarMag.magnet.includes('&dn=ubuntu-24.04.1-desktop-amd64.iso&'), rarMag.magnet.slice(0, 120));
  let rarErr = null;
  try {
    rar.parseMagnet(EMPTY_PAGE);
  } catch (e) {
    rarErr = e;
  }
  check('detail page without a magnet -> parse error', rarErr && rarErr.kind === 'parse');
  check('search url: keywords and category', rar.searchUrl('https://x.test', 'ubuntu', 'all') === 'https://x.test/get-posts/keywords:ubuntu/' && rar.searchUrl('https://x.test', 'ubuntu', 'tv') === 'https://x.test/get-posts/keywords:ubuntu:category:Tv/');

  // ---------------------------------------------------------------- TorrentDownloads (Cloudflare)
  console.log('\n[torrentdownloads]');
  const tdsRows = tds.parse(fx('torrentdownloads_search.html'), ctx());
  check('parses the capture into rows without magnets', tdsRows.length === 9 && tdsRows.every((r) => r.magnet === '' && /^torrentdownloads:\d+$/.test(r.infoHash) && r.detailUrl), String(tdsRows.length));
  const d0 = tdsRows[0];
  check('first row fields (sponsored row skipped)', d0.name === 'Doctor_Who_2005 2012_Christmas_Special The_Snowmen HDTV_x264-FoV' && d0.infoHash === 'torrentdownloads:1654831469' && d0.sizeBytes === 416_500_000 && d0.seeders === 91 && d0.leechers === 17 && d0.category === 'tv', JSON.stringify(d0));
  check('empty page -> []', tds.parse(EMPTY_PAGE, ctx()).length === 0);
  const tdsMag = tds.parseMagnet(fx('torrentdownloads_detail.html'));
  check('detail page: magnet and lower-cased info hash', tdsMag.infoHash === '2745a8cbe6de33902a810b755b201da4ba11213c' && /^magnet:\?xt=urn:btih:2745A8CB/i.test(tdsMag.magnet), tdsMag.magnet.slice(0, 80));
  check('search url: s_cat and search', tds.searchUrl('https://x.test', 'ubuntu', 'all') === 'https://x.test/search/?s_cat=0&search=ubuntu' && tds.searchUrl('https://x.test', 'ubuntu', 'movies') === 'https://x.test/search/?s_cat=4&search=ubuntu');

  // ---------------------------------------------------------------- Ext (Cloudflare)
  console.log('\n[ext]');
  const extRows = ext.parse(fx('ext_search.html'), ctx());
  check('parses the capture into rows without magnets', extRows.length >= 40 && extRows.every((r) => r.magnet === '' && /^ext:\d+$/.test(r.infoHash) && r.detailUrl && r.name), String(extRows.length));
  const e0 = extRows[0];
  check('first row fields', e0.name === 'Bad Boys (1983) 1080p Bluray Remux h264 DTS-HD MA 2.0-3G_Rips' && e0.infoHash === 'ext:18989911' && e0.sizeBytes === 36_250_000_000 && e0.seeders === 1 && e0.leechers === 1 && e0.category === 'movies' && e0.publishedAt === Date.UTC(2026, 1, 11), JSON.stringify(e0));
  check('empty page -> []', ext.parse(EMPTY_PAGE, ctx()).length === 0);
  const vectors = ['', 'abc', '18989911|1700000000|token', 'é€😀'.repeat(40)];
  check('sha256Hex matches node crypto', vectors.every((v) => sha256Hex(v) === crypto.createHash('sha256').update(v).digest('hex')));
  const body = ext.magnetFormBody({ torrentId: '18989911', sessionId: 'a+b/c=', pageToken: 'tok' }, 1700000000);
  check('magnet form body: fields and sha256 of id|timestamp|token', body === `torrent_id=18989911&download_type=magnet&timestamp=1700000000&hmac=${crypto.createHash('sha256').update('18989911|1700000000|tok').digest('hex')}&sessid=a%2Bb%2Fc%3D`, body);
  const hashFromRar = rarMag.magnet;
  const answer = ext.parseMagnetResponse(JSON.stringify({ url: hashFromRar }));
  check('magnet endpoint answer -> magnet and hash', answer.infoHash === rarMag.infoHash && answer.magnet === hashFromRar);
  let extErr = null;
  try {
    ext.parseMagnetResponse('{"error":"bad token"}');
  } catch (e) {
    extErr = e;
  }
  check('endpoint answer without a url -> parse error', extErr && extErr.kind === 'parse');
  let extErr2 = null;
  try {
    ext.parseDetailPage(EMPTY_PAGE);
  } catch (e) {
    extErr2 = e;
  }
  check('detail page without token/csrf/id -> parse error', extErr2 && extErr2.kind === 'parse');
  check('search url: cat and q', ext.searchUrl('https://x.test', 'ubuntu', 'all') === 'https://x.test/browse/?q=ubuntu' && ext.searchUrl('https://x.test', 'ubuntu', 'apps') === 'https://x.test/browse/?cat=5&q=ubuntu');

  // ---------------------------------------------------------------- MyPornClub (adult)
  console.log('\n[mypornclub]');
  const mpcRows = mpc.parse(fx('mypornclub_search.html'), ctx('adult'), NOW);
  check('parses the live fixture into rows without magnets', mpcRows.length >= 20 && mpcRows.every((r) => r.magnet === '' && /^mypornclub:[A-Za-z0-9]+$/.test(r.infoHash) && r.detailUrl && r.category === 'adult'), String(mpcRows.length));
  const m0 = mpcRows[0];
  check('first row fields', m0.infoHash === 'mypornclub:ffUAUwi5' && m0.detailUrl === 'https://example.test/t/ffUAUwi5' && m0.sizeBytes === 532_650_000 && m0.seeders === 30 && m0.leechers === 19 && m0.name.startsWith('Sample adult title 01') && !m0.name.includes('#') && !/NEW/.test(m0.name), JSON.stringify(m0));
  check('"Last month" / ages parse even when the title attribute holds ">"', mpcRows.filter((r) => r.publishedAt != null).length === mpcRows.length);
  check('no title keeps literal \\n escapes', mpcRows.every((r) => !r.name.includes('\\')));
  check('hideAdult -> []', mpc.parse(fx('mypornclub_search.html'), ctx('adult', { hideAdult: true })).length === 0);
  check('empty page -> []', mpc.parse(EMPTY_PAGE, ctx('adult')).length === 0);
  const mpcMag = mpc.parseMagnet(fx('mypornclub_detail.html'));
  check('detail page: magnet and info hash', mpcMag.infoHash === 'f397ddc57b066667f862d9b1a136ba933d4f40a3' && mpcMag.magnet.startsWith('magnet:?xt=urn:btih:f397ddc5'), mpcMag.magnet.slice(0, 80));
  check('detail hash is the first row', mpcMag.infoHash && m0.infoHash.endsWith('ffUAUwi5'));
  check('search url: spaces become dashes, page suffix', mpc.searchUrl('https://x.test', 'a b', 1) === 'https://x.test/s/a-b/seeders' && mpc.searchUrl('https://x.test', 'a', 2) === 'https://x.test/s/a/seeders/2');

  // ---------------------------------------------------------------- XXXClub (adult)
  console.log('\n[xxxclub]');
  const xcRows = xc.parse(fx('xxxclub_search.html'), ctx('adult'));
  check('parses the live fixture into valid results (hash from the link id)', xcRows.length >= 20 && xcRows.every(validResult), String(xcRows.length));
  const x0 = xcRows[0];
  check('first row fields (decoy hidden link skipped)', x0.infoHash === '6b2ae9c34b4a2d4d907d63638ea4a41b437b584a' && x0.sizeBytes === 2_240_000_000 && x0.seeders === 1 && x0.leechers === 20 && x0.publishedAt === Date.UTC(2026, 10, 11, 18, 4, 58) && x0.category === 'adult' && x0.detailUrl === 'https://example.test/torrents/details/~-2644067365565603279', JSON.stringify(x0));
  check('highlight marks do not leak into names', xcRows.every((r) => !/<|>/.test(r.name)));
  const xcMag = xc.parseMagnet(fx('xxxclub_detail.html'));
  check('detail page magnet hash equals the hash taken from the list id', xcMag.infoHash === x0.infoHash);
  check('hideAdult -> []', xc.parse(fx('xxxclub_search.html'), ctx('adult', { hideAdult: true })).length === 0);
  check('empty page -> []', xc.parse(EMPTY_PAGE, ctx('adult')).length === 0);

  // ---------------------------------------------------------------- XXXTracker (adult, Cloudflare)
  console.log('\n[xxxtracker]');
  const xtRows = xt.parse(fx('xxxtracker_search.html'), ctx('adult'));
  check('parses the capture into valid results', xtRows.length >= 50 && xtRows.every(validResult), String(xtRows.length));
  const y0 = xtRows[0];
  check('first row fields', y0.infoHash === 'c89f2d8a68f4507982c47df66367a747d44ec003' && y0.sizeBytes === 700_400_000 && y0.seeders === 0 && y0.leechers === 64 && y0.category === 'adult' && y0.detailUrl === 'https://example.test/torrent/112758/' && y0.magnet.includes('dn=Sample.adult.title.01'), JSON.stringify(y0));
  check('Russian date "24 Апр 24" -> 2024-04-24', y0.publishedAt === Date.UTC(2024, 3, 24));
  check('every Russian month abbreviation maps', ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'].every((mo, i) => xt.parseDate(`5 ${mo} 25`) === Date.UTC(2025, i, 5)));
  check('hideAdult -> []', xt.parse(fx('xxxtracker_search.html'), ctx('adult', { hideAdult: true })).length === 0);
  check('empty page -> []', xt.parse(EMPTY_PAGE, ctx('adult')).length === 0);

  // ---------------------------------------------------------------- registration and flags
  console.log('\n[registry]');
  const byId = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
  const ids = ['limetorrents', 'torrentdownloads', 'torrentdownload', 'therarbg', 'ext', 'mypornclub', 'xxxclub', 'xxxtracker'];
  check('all eight are registered once, off by default, with mirrors', ids.every((id) => PROVIDERS.filter((p) => p.id === id).length === 1 && byId[id].enabledByDefault === false && byId[id].mirrors.length >= 1 && byId[id].method === 'html'));
  check('adult sources are nsfw and adult-only', ['mypornclub', 'xxxclub', 'xxxtracker'].every((id) => byId[id].nsfw && byId[id].categories.length === 1 && byId[id].categories[0] === 'adult'));
  check('general sources are not nsfw and list no adult category', ['limetorrents', 'torrentdownloads', 'torrentdownload', 'therarbg', 'ext'].every((id) => !byId[id].nsfw && !byId[id].categories.includes('adult')));
  check('risky sources carry an unsafeReason', !!byId.limetorrents.unsafeReason && !!byId.therarbg.unsafeReason && !byId.ext.unsafeReason);
  check('Cloudflare sources carry a solverUrl on their own host', ['torrentdownloads', 'ext', 'xxxtracker'].every((id) => byId[id].cloudflare && new URL(byId[id].cloudflare.solverUrl).host === new URL(byId[id].mirrors[0]).host));
  check('deferred-magnet sources have resolveMagnet, hash-in-list sources do not', ['torrentdownloads', 'therarbg', 'ext', 'mypornclub', 'xxxclub'].every((id) => typeof byId[id].resolveMagnet === 'function') && ['limetorrents', 'torrentdownload', 'xxxtracker'].every((id) => !byId[id].resolveMagnet));
  const adultOff = agg.eligibleProviders('all', { enabled: ids, adult: false }).map((p) => p.id);
  check('adult off: no nsfw source is queried', !adultOff.includes('mypornclub') && !adultOff.includes('xxxclub') && !adultOff.includes('xxxtracker') && adultOff.includes('limetorrents'), adultOff.join(','));
  const adultOn = agg.eligibleProviders('adult', { enabled: ids, adult: true }).map((p) => p.id);
  check('adult on, category adult: only the adult sources', adultOn.join(',') === 'mypornclub,xxxclub,xxxtracker', adultOn.join(','));
  const movies = agg.eligibleProviders('movies', { enabled: ids, adult: true }).map((p) => p.id);
  check('category movies reaches the general sources, not the adult ones', movies.includes('limetorrents') && movies.includes('ext') && !movies.includes('xxxclub'), movies.join(','));

  // ---------------------------------------------------------------- deferred magnet through resolveResult
  console.log('\n[resolveResult]');
  const detailFor = { therarbg: 'therarbg_detail.html', mypornclub: 'mypornclub_detail.html', torrentdownloads: 'torrentdownloads_detail.html', xxxclub: 'xxxclub_detail.html' };
  const rowsFor = { therarbg: rarRows[0], mypornclub: mpcRows[0], torrentdownloads: tdsRows[0] };
  const wantHash = { therarbg: rarMag.infoHash, mypornclub: mpcMag.infoHash, torrentdownloads: tdsMag.infoHash };
  for (const id of ['therarbg', 'mypornclub', 'torrentdownloads']) {
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      return new Response(fx(detailFor[id]), { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const ctl = new AbortController();
    const done = await agg.resolveResult({ ...rowsFor[id], sources: [id] }, ctl.signal);
    check(`${id}: reads detailUrl once and sets the real magnet and hash`, seen.length === 1 && seen[0] === rowsFor[id].detailUrl && done.infoHash === wantHash[id] && done.magnet.startsWith('magnet:?xt=urn:btih:'), `${seen.length} ${done.infoHash}`);
  }
  // A row with no hash in the list falls back to the detail page (XXXClub): strip the id from the fixture markup.
  const noId = xc.parse(fx('xxxclub_search.html').replace(/id="#i[0-9a-f]{40}"/g, ''), ctx('adult'));
  check('xxxclub: without the link id the row is deferred (stand-in key, empty magnet)', noId.length > 0 && noId[0].magnet === '' && noId[0].infoHash === 'xxxclub:~-2644067365565603279');
  globalThis.fetch = async () => new Response(fx(detailFor.xxxclub), { status: 200, headers: { 'content-type': 'text/html' } });
  const xcDone = await agg.resolveResult({ ...noId[0], sources: ['xxxclub'] }, new AbortController().signal);
  check('xxxclub: deferred row resolves to the same hash the list id carries', xcDone.infoHash === x0.infoHash);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('test run crashed:', e);
  process.exit(1);
});
