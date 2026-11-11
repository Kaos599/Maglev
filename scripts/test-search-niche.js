#!/usr/bin/env node
// Tests for the games, books and regional providers (FitGirl, BlueRoms, AudioBookBay, EpubLibre, Rutor,
// MegaPeer, OxTorrent, Torrent9). No network: fixtures are recorded pages, see scripts/fixtures/search/*_SOURCES.txt.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'search');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
// MegaPeer serves windows-1251; the fixture is the raw bytes.
const fxCp1251 = (n) => new TextDecoder('windows-1251').decode(fs.readFileSync(path.join(FIX, n)));

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
const ctx = (category = 'all', over = {}) => ({ baseUrl: 'https://example.test', category, hideAdult: true, limit: 50, ...over });
const standIn = (r, id) => r.infoHash.startsWith(`${id}:`) && r.magnet === '' && /^https?:\/\//.test(r.detailUrl);

async function main() {
  const fg = await import('../utils/search/providers/fitgirl.ts');
  const br = await import('../utils/search/providers/blueroms.ts');
  const ab = await import('../utils/search/providers/audiobookbay.ts');
  const el = await import('../utils/search/providers/epublibre.ts');
  const ru = await import('../utils/search/providers/rutor.ts');
  const mp = await import('../utils/search/providers/megapeer.ts');
  const ox = await import('../utils/search/providers/oxtorrent.ts');
  const t9 = await import('../utils/search/providers/torrent9.ts');
  const nt = await import('../utils/search/providers/nicheText.ts');
  const cs = await import('../utils/search/charset.ts');
  const idx = await import('../utils/search/providers/index.ts');
  const http = await import('../utils/search/http.ts');

  console.log('\n[1] FitGirl Repacks (games)');
  {
    const r = fg.parse(fx('fitgirl_search.html'), ctx('games'));
    check('parses repack posts', r.length >= 3, `got ${r.length}`);
    check('rows are games with stand-in key and detail url', r.every((x) => x.category === 'games' && standIn(x, 'fitgirl')));
    check('title entities decoded', r.some((x) => /Witcher 3: Wild Hunt – Remastered/.test(x.name)), r[0] && r[0].name);
    check('date from datetime attr', r.every((x) => x.publishedAt > Date.UTC(2010, 0, 1)) && r[0].publishedAt === Date.UTC(2026, 8, 30, 3, 3, 17));
    const m = fg.fitgirl;
    check('provider is off by default and games only', m.enabledByDefault === false && m.categories.join() === 'games');
  }

  console.log('\n[2] FitGirl magnet resolves from the post');
  {
    const prev = globalThis.fetch;
    globalThis.fetch = async (url) => new Response(fx('fitgirl_detail.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    const found = await fg.fitgirl.resolveMagnet({ detailUrl: 'https://example.test/the-witcher-3-wild-hunt-remastered/' }, new AbortController().signal);
    globalThis.fetch = prev;
    check('hash is 40-hex', HEX40.test(found.infoHash), found.infoHash);
    check('magnet carries the hash', found.magnet.startsWith('magnet:?xt=urn:btih:') && found.magnet.toLowerCase().includes(found.infoHash));
  }

  console.log('\n[3] BlueRoms (games)');
  {
    const r = br.parse(fx('blueroms_search.html'), ctx('games', { baseUrl: 'https://www.blueroms.ws' }));
    check('parses cards', r.length >= 1, `got ${r.length}`);
    check('rows are games with stand-in key', r.every((x) => x.category === 'games' && standIn(x, 'blueroms')));
    check('name carries the platform', r.some((x) => / - Nintendo Switch$/.test(x.name)), r[0] && r[0].name);
    check('size parsed', r.some((x) => x.sizeBytes > 1e9), String(r[0] && r[0].sizeBytes));
    const old = br.parseMagnet(fx('blueroms_detail.html'));
    check('plain magnet link (2022 layout) parses', old.infoHash === 'fd60f1b1815b176d2bc535cba8e9ff484d0cea17', old.infoHash);
    // The current layout hides the same kind of magnet in button#magnet-button[data-link] as Base64.
    const encoded = Buffer.from(old.magnet).toString('base64');
    const modern = br.parseMagnet(`<button id="magnet-button" class="btn" data-link="${encoded}">Magnet</button>`);
    check('Base64 data-link layout parses', modern.infoHash === old.infoHash);
    check('Cloudflare solver page is set', br.blueroms.cloudflare && /blueroms/.test(br.blueroms.cloudflare.solverUrl));
  }

  console.log('\n[4] AudioBookBay (books)');
  {
    const r = ab.parse(fx('audiobookbay_search.html'), ctx('books', { baseUrl: 'https://audiobookbay.lu' }));
    check('parses posts', r.length >= 5, `got ${r.length}`);
    check('rows are books with stand-in key', r.every((x) => x.category === 'books' && standIn(x, 'audiobookbay')));
    check('size and date parsed', r.every((x) => x.sizeBytes > 1e6 && x.publishedAt > Date.UTC(2020, 0, 1)), JSON.stringify(r[0]));
    check('size is binary (558.19 MB)', r[0].sizeBytes === Math.round(558.19 * 1024 * 1024), String(r[0].sizeBytes));
    const d = ab.parseDetail(fx('audiobookbay_detail.html'), r[0].name);
    check('info hash from the post page', d.infoHash === '9a95bdf8921b97c53c96d2286d7ef4be0aa8a7cf', d.infoHash);
    check('magnet built with trackers', d.magnet.startsWith('magnet:?xt=urn:btih:9a95bdf8') && d.magnet.includes('&tr='));
  }

  console.log('\n[5] EpubLibre (books)');
  {
    const r = el.parse(fx('epublibre_search.json'), ctx('books'));
    check('parses covers', r.length >= 5, `got ${r.length}`);
    check('rows are books with stand-in key', r.every((x) => x.category === 'books' && standIn(x, 'epublibre')));
    check('name is "Title - Author"', r.some((x) => /^Don Quijote de la Mancha \(IV CENTENARIO\) - Miguel de Cervantes Saavedra$/.test(x.name)), r[0] && r[0].name);
    const prev = globalThis.fetch;
    let init;
    globalThis.fetch = async (url, i) => {
      init = i;
      return new Response(fx('epublibre_detail.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    };
    const found = await el.epublibre.resolveMagnet({ detailUrl: 'https://epublibre.org/libro/detalle/4765' }, new AbortController().signal);
    check('magnet from the detail page', found.infoHash === '2d361e98bf4ad38ff0c4f3b023caaeec096896a4', found.infoHash);
    let seen = {};
    globalThis.fetch = async (url, i) => {
      seen = { url: String(url), init: i };
      return new Response(fx('epublibre_search.json'), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const rows = await el.epublibre.search('don quijote', 'books', 1, { baseUrl: 'https://epublibre.org', signal: new AbortController().signal, hideAdult: true, limit: 50 });
    globalThis.fetch = prev;
    check('search is a POST with X-Requested-With', seen.init.method === 'POST' && seen.init.headers['X-Requested-With'] === 'XMLHttpRequest', JSON.stringify(seen.init));
    check('query is URL-encoded in the path', seen.url.endsWith('/don%20quijote/ajax'), seen.url);
    check('search returns rows', rows.length >= 5);
    let threw = false;
    try {
      el.parse('<html>not json</html>', ctx());
    } catch (e) {
      threw = e.name === 'ProviderError';
    }
    check('HTML instead of JSON is a ProviderError', threw);
  }

  console.log('\n[6] Rutor (all categories)');
  {
    const r = ru.parse(fx('rutor_search.html'), ctx('all', { baseUrl: 'https://rutor.info' }));
    check('parses rows with real hashes and magnets', r.length >= 20 && r.every((x) => HEX40.test(x.infoHash) && x.magnet.startsWith('magnet:?xt=urn:btih:') && x.magnet.includes(x.infoHash)), `got ${r.length}`);
    check('no duplicate hashes', new Set(r.map((x) => x.infoHash)).size === r.length);
    const first = r[0];
    check('Russian date parsed (13 Dec 2025)', first.publishedAt === Date.UTC(2025, 11, 13), String(first.publishedAt));
    check('seeders, leechers and size parsed', first.seeders === 1375 && first.leechers === 22 && first.sizeBytes === Math.round(639.07 * 1024 * 1024), JSON.stringify(first));
    check('detail url is absolute', first.detailUrl.startsWith('https://rutor.info/torrent/1064659/'), first.detailUrl);
    check('"all" leaves category unset, a category search labels rows', first.category === undefined && ru.parse(fx('rutor_search.html'), ctx('games'))[0].category === 'games');
    check('category ids in the URL', ru.searchUrl('https://rutor.info', 'linux', 'games', 1) === 'https://rutor.info/search/0/8/010/2/linux' && ru.searchUrl('https://rutor.info', 'a b', 'books', 2) === 'https://rutor.info/search/1/11/010/2/a%20b' && ru.searchUrl('https://rutor.info', 'x', 'tv', 1).includes('/4/010/'));
  }

  console.log('\n[7] MegaPeer (windows-1251)');
  {
    const r = mp.parse(fxCp1251('megapeer_search.html'), ctx('all', { baseUrl: 'https://megapeer.vip' }));
    check('parses the row', r.length >= 1, `got ${r.length}`);
    check('stand-in key and absolute detail url', r.every((x) => standIn(x, 'megapeer')) && r[0].detailUrl === 'https://megapeer.vip/torrent/212745/counter-strike-16-pv48_1127_b10211-2003-linux', r[0] && r[0].detailUrl);
    check('seeders, leechers, size, date', r[0].seeders === 7 && r[0].leechers === 8 && r[0].sizeBytes === Math.round(361.92 * 1024 * 1024) && r[0].publishedAt === Date.UTC(2026, 8, 11), JSON.stringify(r[0]));
    const prev = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(fs.readFileSync(path.join(FIX, 'megapeer_detail.html')), { status: 200, headers: { 'content-type': 'text/html; charset=windows-1251' } });
    const found = await mp.megapeer.resolveMagnet({ detailUrl: 'http://megapeer.vip/torrent/212745/x' }, new AbortController().signal);
    check('magnet from the detail page', HEX40.test(found.infoHash), found.infoHash);
    // The same fixture through httpText: Cyrillic must survive the windows-1251 decode.
    globalThis.fetch = async () =>
      new Response(fs.readFileSync(path.join(FIX, 'megapeer_search.html')), { status: 200, headers: { 'content-type': 'text/html; charset=windows-1251' } });
    const viaHttp = await http.httpText('https://megapeer.vip/browse.php', { signal: new AbortController().signal, accept: 'text/html' });
    globalThis.fetch = prev;
    check('httpText decodes windows-1251 pages', viaHttp === fxCp1251('megapeer_search.html') && /Поиск торрентов/.test(viaHttp));
    check('category id in the URL', mp.searchUrl('https://megapeer.vip', 'doom', 'games').includes('&cat=28&') && mp.searchUrl('https://megapeer.vip', 'doom', 'all').includes('&cat=0&'));
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    // 0x98 is unassigned in windows-1251; Node maps it to U+0098 as the table here does.
    check('decoder matches the platform for every byte', cs.decodeWindows1251(all) === new TextDecoder('windows-1251').decode(all));
  }

  console.log('\n[8] OxTorrent (French)');
  {
    const r = ox.parse(fx('oxtorrent_search.html'), ctx('all', { baseUrl: 'https://oxtorrent.co' }));
    check('parses rows', r.length >= 5, `got ${r.length}`);
    check('stand-in key, detail url', r.every((x) => standIn(x, 'oxtorrent')));
    check('category from the row icon', r[0].category === 'apps' && r.some((x) => x.category === 'books'), r.map((x) => x.category).join());
    check('size, seeders, leechers', r[0].sizeBytes === Math.round(67.3 * 1024 * 1024) && r[0].seeders === 1 && r[0].leechers === 0, JSON.stringify(r[0]));
    check('search url uses the category slug', ox.searchUrl('https://oxtorrent.co', 'linux', 'games') === 'https://oxtorrent.co/recherche/jeux-pc/linux' && ox.searchUrl('https://oxtorrent.co', 'linux', 'all') === 'https://oxtorrent.co/recherche/linux');
    const prev = globalThis.fetch;
    globalThis.fetch = async () => new Response(fx('oxtorrent_detail.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    const found = await ox.oxtorrent.resolveMagnet({ detailUrl: 'https://oxtorrent.co/torrent/49303/nero-linux-v3-5' }, new AbortController().signal);
    globalThis.fetch = prev;
    check('magnet from the detail page', found.infoHash === 'dc356e2e572fa314692893733b55208dd6fcfdcc', found.infoHash);
    check('flagged as Cloudflare-protected', !!ox.oxtorrent.cloudflare);
  }

  console.log('\n[9] Torrent9 (French)');
  {
    const r = t9.parse(fx('torrent9_search.html'), ctx('all', { baseUrl: 'https://www6.torrent9.to' }));
    check('parses rows', r.length >= 5, `got ${r.length}`);
    check('stand-in key, detail url', r.every((x) => standIn(x, 'torrent9')));
    check('"Mo/Go" sizes read as binary', r[0].sizeBytes === Math.round(49.1 * 1024 * 1024) && r[1].sizeBytes === Math.round(3.8 * 1024 ** 3), `${r[0].sizeBytes} ${r[1].sizeBytes}`);
    check('seeders, leechers', r[0].seeders === 20 && r[0].leechers === 0 && r[1].seeders === 3 && r[1].leechers === 3, JSON.stringify([r[0].seeders, r[0].leechers, r[1].seeders, r[1].leechers]));
    check('1970 date is unknown, real date parsed', r[0].publishedAt === undefined && r[1].publishedAt === Date.UTC(2018, 7, 30), `${r[0].publishedAt} ${r[1].publishedAt}`);
    check('category from the icon', r[0].category === 'apps');
    check('search url', t9.searchUrl('https://www6.torrent9.to', 'linux', 'music') === 'https://www6.torrent9.to/search_torrent/musique/linux.html');
    const prev = globalThis.fetch;
    globalThis.fetch = async () => new Response(fx('torrent9_detail.html'), { status: 200, headers: { 'content-type': 'text/html' } });
    const found = await t9.torrent9.resolveMagnet({ detailUrl: 'https://www6.torrent9.to/torrent/87168/linux-file-systems-for-windows' }, new AbortController().signal);
    globalThis.fetch = prev;
    check('base32 magnet normalises to a 40-hex hash', HEX40.test(found.infoHash), found.infoHash);
  }

  console.log('\n[10] helpers and registration');
  {
    check('Russian months (incl. "Мая")', nt.parseRuDate('13 Дек 25') === Date.UTC(2025, 11, 13) && nt.parseRuDate('5 Мая 26') === Date.UTC(2026, 4, 5));
    check('binary sizes', nt.parseBinarySize('1.5 GB') === 1.5 * 1024 ** 3 && nt.parseBinarySize('48.8Mo') === Math.round(48.8 * 1024 ** 2) && nt.parseBinarySize('junk') === undefined);
    const ids = idx.PROVIDERS.map((p) => p.id);
    const mine = ['fitgirl', 'blueroms', 'audiobookbay', 'epublibre', 'rutor', 'megapeer', 'oxtorrent', 'torrent9'];
    check('all eight are registered once, off by default', mine.every((id) => ids.filter((x) => x === id).length === 1 && idx.PROVIDERS.find((p) => p.id === id).enabledByDefault === false));
    check('every provider has a header naming its TorrentSearch source', mine.every((id) => /Ported from prajwalch\/TorrentSearch \(MIT\), https:\/\/github\.com\/prajwalch\/TorrentSearch\/blob\/main\/.+\.kt/.test(fs.readFileSync(path.join(__dirname, '..', 'utils', 'search', 'providers', `${id === 'fitgirl' ? 'fitgirl' : id}.ts`), 'utf8').split('\n', 1)[0])));
    check('stand-in rows are resolvable (resolveMagnet present)', ['fitgirl', 'blueroms', 'audiobookbay', 'epublibre', 'megapeer', 'oxtorrent', 'torrent9'].every((id) => typeof idx.PROVIDERS.find((p) => p.id === id).resolveMagnet === 'function') && typeof idx.PROVIDERS.find((p) => p.id === 'rutor').resolveMagnet === 'undefined');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
