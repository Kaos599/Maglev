#!/usr/bin/env node
// browse_torrents: the pure window, release-year, collapse and order rules (utils/search/browse.ts), the source
// fan-out with a fake fetch (recorded response shapes for YTS, Knaben, TPB and Nyaa), and the tool runner on top.
// No network. Needs Node 22.18+ (runs the TypeScript sources directly).
process.removeAllListeners('warning');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${extra !== undefined ? ` (${typeof extra === 'string' ? extra : JSON.stringify(extra)})` : ''}`);
  }
}

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 12, 0, 0); // Thu 12 Nov 2026
const sec = (ms) => Math.floor(ms / 1000);
const hex = (n) => n.toString(16).padStart(40, '0');

// ---------------------------------------------------------------- recorded-shape fixtures (trimmed to the fields parsers read)

const ytsBody = () => JSON.stringify({
  status: 'ok', status_message: 'Query was successful',
  data: {
    movie_count: 3, limit: 50, page_number: 1,
    movies: [
      {
        id: 1, url: 'https://yts.bz/movies/the-day-she-left-us-2026', title: 'The Day She Left Us', title_long: 'The Day She Left Us (2026)', year: 2026,
        date_uploaded: '2026-11-11 10:28:04', date_uploaded_unix: sec(NOW - 1 * DAY),
        torrents: [
          { hash: hex(0x101).toUpperCase(), quality: '720p', type: 'web', seeds: 40, peers: 10, size_bytes: 1.1 * GB, date_uploaded_unix: sec(NOW - 1 * DAY) },
          { hash: hex(0x102).toUpperCase(), quality: '1080p', type: 'web', seeds: 90, peers: 20, size_bytes: 2.0 * GB, date_uploaded_unix: sec(NOW - 1 * DAY) },
        ],
      },
      {
        id: 2, url: 'https://yts.bz/movies/strongher-2026', title: 'StrongHer', title_long: 'StrongHer (2026)', year: 2026,
        date_uploaded_unix: sec(NOW - 3 * DAY),
        torrents: [{ hash: hex(0x103), quality: '1080p', type: 'web', seeds: 30, peers: 5, size_bytes: 1.8 * GB, date_uploaded_unix: sec(NOW - 3 * DAY) }],
      },
      {
        // An old film uploaded this week: not a new release.
        id: 3, url: 'https://yts.bz/movies/superbad-2007', title: 'Superbad', title_long: 'Superbad (2007)', year: 2007,
        date_uploaded_unix: sec(NOW - 2 * DAY),
        torrents: [{ hash: hex(0x104), quality: '1080p', type: 'bluray', seeds: 300, peers: 50, size_bytes: 1.9 * GB, date_uploaded_unix: sec(NOW - 2 * DAY) }],
      },
    ],
  },
});

const knabenHit = (o) => ({
  title: o.title, hash: o.hash, bytes: o.bytes, seeders: o.seeders, peers: 3, date: new Date(o.at).toISOString(),
  categoryId: o.cat, details: 'https://knaben.org/x', magnetUrl: `magnet:?xt=urn:btih:${o.hash}&dn=x`,
});
const knabenMovies = () => JSON.stringify({
  hits: [
    // Same film as YTS, another copy: collapses into one title.
    knabenHit({ title: 'The.Day.She.Left.Us.2026.1080p.WEB-DL.x264-GRP', hash: hex(0x201), bytes: 2.4 * GB, seeders: 12, at: NOW - 1 * DAY, cat: [3001000, 3000000] }),
    knabenHit({ title: 'Colony (2026) Bluray.1080p.x264-Dr4gon.mkv', hash: hex(0x202), bytes: 2.2 * GB, seeders: 25, at: NOW - 2 * DAY, cat: [3001000, 3000000] }),
    knabenHit({ title: 'Heart of the Sea 2 2025 1080p WEB-DL x265-GRP', hash: hex(0x203), bytes: 1.6 * GB, seeders: 18, at: NOW - 5 * DAY, cat: [3001000, 3000000] }),
    // Uploaded a month ago: outside "this week".
    knabenHit({ title: 'Old.Upload.2026.1080p.WEB-DL.x264-GRP', hash: hex(0x204), bytes: 2 * GB, seeders: 60, at: NOW - 30 * DAY, cat: [3001000, 3000000] }),
    // A cinema recording: never shown.
    knabenHit({ title: 'Brand.New.Film.2026.HDCAM.x264-BAD', hash: hex(0x205), bytes: 1.2 * GB, seeders: 80, at: NOW - 1 * DAY, cat: [3001000, 3000000] }),
  ],
  max_score: 1, total: { value: 5 },
});
const knabenTv = () => JSON.stringify({
  hits: [
    knabenHit({ title: 'MobLand S02E08 We Dont Talk Anymore 1080p AMZN WEB-DL DDP5 1 H 264-RAWR', hash: hex(0x301), bytes: 3 * GB, seeders: 4993, at: NOW - 2 * DAY, cat: [2001000, 2000000] }),
    knabenHit({ title: 'MobLand.S02E08.720p.WEB.h264-ETHEL', hash: hex(0x302), bytes: 1 * GB, seeders: 900, at: NOW - 2 * DAY, cat: [2001000, 2000000] }),
    knabenHit({ title: 'VisionQuest S01E08 Forever 1080p WEB H264-GRACE', hash: hex(0x303), bytes: 2.5 * GB, seeders: 4866, at: NOW - 3 * DAY, cat: [2001000, 2000000] }),
  ],
});
const knabenAnime = () => JSON.stringify({ hits: [knabenHit({ title: '[SubsPlease] Sousou no Frieren - 07 (1080p) [ABCD1234].mkv', hash: hex(0x401), bytes: 1.4 * GB, seeders: 500, at: NOW - 1 * DAY, cat: [6001000, 6000000] })] });

const tpbRow = (o) => ({ id: String(o.id), info_hash: o.hash.toUpperCase(), category: String(o.cat), name: o.name, status: 'vip', num_files: '3', size: String(o.size), seeders: String(o.seeders), leechers: '10', username: 'x', added: String(sec(o.at)), anon: '0', imdb: '' });
const tpbTv48h = () => JSON.stringify([
  tpbRow({ id: 1, hash: hex(0x501), cat: 205, name: 'The Lord of the Rings The Rings of Power S03E01 480p x264-mSD', size: 500 * MB, seeders: 371, at: NOW - 1 * DAY }),
  tpbRow({ id: 2, hash: hex(0x502), cat: 208, name: 'MobLand.S02E08.1080p.WEB.H264-SuccessfulCrab', size: 2.8 * GB, seeders: 300, at: NOW - 2 * DAY }),
]);
const tpbEmpty = () => JSON.stringify([{ id: '0', name: 'No results returned', info_hash: '0000000000000000000000000000000000000000', category: '0', size: '0', seeders: '0', leechers: '0', added: '0' }]);

const nyaaRss = () => `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:atom="http://www.w3.org/2005/Atom" xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel><title>Nyaa - Home - Torrent File RSS</title>
<item><title>[Trix] FX Fighter Kurumi-chan S01E07 [WEBRip 1080p AV1 Opus] (Dual Audio)</title><link>https://nyaa.si/download/1.torrent</link><guid isPermaLink="true">https://nyaa.si/view/1</guid>
<pubDate>${new Date(NOW - 2 * 3600e3).toUTCString().replace('GMT', '-0000')}</pubDate><nyaa:seeders>15</nyaa:seeders><nyaa:leechers>12</nyaa:leechers><nyaa:infoHash>${hex(0x601)}</nyaa:infoHash><nyaa:categoryId>1_2</nyaa:categoryId><nyaa:size>234.5 MiB</nyaa:size></item>
<item><title>[SubsPlease] Sousou no Frieren - 07 (720p) [EFGH5678].mkv</title><link>https://nyaa.si/download/2.torrent</link><guid isPermaLink="true">https://nyaa.si/view/2</guid>
<pubDate>${new Date(NOW - 20 * 3600e3).toUTCString().replace('GMT', '-0000')}</pubDate><nyaa:seeders>300</nyaa:seeders><nyaa:leechers>12</nyaa:leechers><nyaa:infoHash>${hex(0x602)}</nyaa:infoHash><nyaa:categoryId>1_2</nyaa:categoryId><nyaa:size>700 MiB</nyaa:size></item>
</channel></rss>`;

/** A fetch that answers from a route table and records every request. `fail` holds URL parts that throw. */
function fakeFetch(routes, log, fail = []) {
  return async (url, init = {}) => {
    const u = String(url);
    log.push({ url: u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (fail.some((f) => u.includes(f))) throw new TypeError('fetch failed');
    const hit = routes.find(([match]) => (typeof match === 'function' ? match(u, init) : u.includes(match)));
    if (!hit) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = hit[1](u, init);
    const type = body.startsWith('<?xml') ? 'application/rss+xml' : 'application/json';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  };
}

const knabenRoute = (u, init) => {
  const b = JSON.parse(init.body);
  const cat = b.categories?.[0];
  if (cat === 3000000) return knabenMovies();
  if (cat === 2000000) return knabenTv();
  if (cat === 6000000) return knabenAnime();
  return JSON.stringify({ hits: [] });
};
const ROUTES = [
  ['movies-api.accel.li/api/v2/list_movies.json', () => ytsBody()],
  ['api.knaben.org/v1', knabenRoute],
  ['precompiled/data_top100_48h_205.json', () => tpbTv48h()],
  ['precompiled/data_top100', () => tpbEmpty()],
  ['nyaa.si/?page=rss', () => nyaaRss()],
];

async function main() {
  const B = await import('../utils/search/browse.ts');
  const { resetHealth } = await import('../utils/search/health.ts');
  const { createToolRunner } = await import('../utils/assistant/toolRunner.ts');
  const { validateArgs } = await import('../utils/assistant/tools.ts');

  // ---------------------------------------------------------------- pure rules

  console.log('browse: period window');
  check('day/week/month/year are 1, 7, 31, 366 days', B.PERIOD_DAYS.day === 1 && B.PERIOD_DAYS.week === 7 && B.PERIOD_DAYS.month === 31 && B.PERIOD_DAYS.year === 366);
  check('a row from 3 days ago is in "week"', B.inPeriod(NOW - 3 * DAY, 'week', 'new', NOW));
  check('a row from 8 days ago is not in "week"', !B.inPeriod(NOW - 8 * DAY, 'week', 'new', NOW));
  check('a row from 20 hours ago is in "day"', B.inPeriod(NOW - 20 * 3600e3, 'day', 'new', NOW));
  check('a row from 30 hours ago is not in "day"', !B.inPeriod(NOW - 30 * 3600e3, 'day', 'popular', NOW));
  check('a row from 300 days ago is in "year"', B.inPeriod(NOW - 300 * DAY, 'year', 'new', NOW));
  check('no date: dropped for new', !B.inPeriod(undefined, 'week', 'new', NOW));
  check('no date: kept for popular', B.inPeriod(undefined, 'week', 'popular', NOW));
  check('a date in the future (clock skew) still counts as in the window', B.inPeriod(NOW + 3600e3, 'day', 'new', NOW));

  console.log('browse: new means newly released for movies and tv');
  check('movie from this year is new', B.isNewRelease('Colony (2026) 1080p', 'movies', NOW));
  check('movie from last year is new', B.isNewRelease('Heart.of.the.Sea.2.2025.1080p.WEB-DL', 'movies', NOW));
  check('movie from 2007 is not new', !B.isNewRelease('Superbad (2007) 1080p', 'movies', NOW));
  check('movie with no year is not new', !B.isNewRelease('Some Film 1080p WEB-DL', 'movies', NOW));
  check('tv episode with no year is new', B.isNewRelease('MobLand S02E08 1080p WEB', 'tv', NOW));
  check('tv pack from 2011 is not new', !B.isNewRelease('Star Trek The Next Generation 1987 Complete Series', 'tv', NOW));
  check('tv pack with no year and no episode is not new', !B.isNewRelease('Star Trek The Next Generation Season 1-7 Deluxe', 'tv', NOW));
  check('books, games, music, apps ignore the year (new = newly uploaded)', ['books', 'games', 'music', 'apps', 'anime'].every((k) => B.isNewRelease('Something 1999', k, NOW)));
  check('the year rule follows the clock', !B.isNewRelease('Colony (2026) 1080p', 'movies', Date.UTC(2028, 0, 2)));

  console.log('browse: filterForBrowse');
  {
    const rows = [
      { name: 'Colony (2026) 1080p', publishedAt: NOW - 2 * DAY },
      { name: 'Superbad (2007) 1080p', publishedAt: NOW - 2 * DAY },
      { name: 'Old.Upload.2026.1080p', publishedAt: NOW - 30 * DAY },
      { name: 'No.Date.2026.1080p' },
    ];
    const n = B.filterForBrowse(rows, { kind: 'movies', order: 'new', period: 'week', now: NOW });
    check('new movies keeps only new releases uploaded this week', n.kept.map((r) => r.name).join('|') === 'Colony (2026) 1080p', n.kept);
    check('counts what it dropped', n.dropped === 3, n.dropped);
    const p = B.filterForBrowse(rows, { kind: 'movies', order: 'popular', period: 'week', now: NOW });
    check('popular keeps old films and undated rows, drops old uploads', p.kept.map((r) => r.name).join('|') === 'Colony (2026) 1080p|Superbad (2007) 1080p|No.Date.2026.1080p', p.kept);
  }

  console.log('browse: the name must fit the kind (sources mislabel)');
  check('a film name is not a show', !B.fitsKind('The Odyssey (2026) [1080p] [BluRay] [5.1]', 'tv'));
  check('an episode is a show', B.fitsKind('VisionQuest S01E08 Forever 1080p WEB H264-GRACE', 'tv'));
  check('a season pack is a show', B.fitsKind('Lanterns.S01.1080p.WEB-DL.x265-NTb', 'tv'));
  check('an episode is not a film', !B.fitsKind('MobLand.S02E08.1080p.WEB.H264-GRP', 'movies'));
  check('a film is a film', B.fitsKind('Colony (2026) 1080p', 'movies'));
  check('other kinds take any name', ['anime', 'books', 'games', 'music', 'apps'].every((k) => B.fitsKind('Anything 2026', k)));
  {
    const f = B.filterForBrowse([{ name: 'The Odyssey (2026) [1080p] [BluRay]', publishedAt: NOW - DAY }, { name: 'VisionQuest S01E08 1080p', publishedAt: NOW - DAY }], { kind: 'tv', order: 'popular', period: 'week', now: NOW });
    check('filterForBrowse drops a film listed as a show', f.kept.length === 1 && /VisionQuest/.test(f.kept[0].name), f.kept);
  }

  console.log('browse: one copy per title');
  check('two copies of one film share a key', B.workKey('The Day She Left Us (2026) 1080p', 'movies') === B.workKey('The.Day.She.Left.Us.2026.1080p.WEB-DL.x264-GRP', 'movies'));
  check('a remake (other year) is a different title', B.workKey('Dune (2021) 1080p', 'movies') !== B.workKey('Dune 1984 1080p BluRay', 'movies'));
  check('same episode, two groups, share a key', B.workKey('MobLand S02E08 We Dont Talk Anymore 1080p AMZN WEB-DL', 'tv') === B.workKey('MobLand.S02E08.720p.WEB.h264-ETHEL', 'tv'));
  check('another episode is a different key', B.workKey('MobLand S02E08 1080p', 'tv') !== B.workKey('MobLand S02E09 1080p', 'tv'));
  check('anime episode in two qualities share a key', B.workKey('[SubsPlease] Sousou no Frieren - 07 (1080p) [AB].mkv', 'anime') === B.workKey('[SubsPlease] Sousou no Frieren - 07 (720p) [CD].mkv', 'anime'));
  {
    const list = [{ k: 'a', n: 1 }, { k: 'b', n: 2 }, { k: 'a', n: 3 }, { k: 'c', n: 4 }, { k: 'b', n: 5 }];
    const c = B.collapseWorks(list, (x) => x.k);
    check('collapseWorks keeps the first (best) of each key, in order', c.map((x) => x.n).join() === '1,2,4', c);
  }
  {
    const rows = [
      { id: 'a', publishedAt: NOW - 5 * DAY, seeders: 900 },
      { id: 'b', publishedAt: NOW - 1 * DAY, seeders: 10 },
      { id: 'c', seeders: 50 },
      { id: 'd', publishedAt: NOW - 3 * DAY, seeders: undefined },
    ];
    check('order new: newest upload first, undated last', B.orderBrowse(rows, 'new', (r) => r).map((r) => r.id).join() === 'b,d,a,c');
    check('order popular: most sharing first, unknown last', B.orderBrowse(rows, 'popular', (r) => r).map((r) => r.id).join() === 'a,c,b,d');
  }

  console.log('browse: a search query that is really a browse');
  const q = (t, c = 'all', s = 'best') => B.browseArgsFromQuery(t, c, s);
  check('"latest movies" → new movies this week', JSON.stringify(q('latest movies')) === JSON.stringify({ kind: 'movies', order: 'new', period: 'week' }), q('latest movies'));
  check('"movies" sort seeders → popular', q('movies', 'movies', 'seeders')?.order === 'popular');
  check('"popular shows this week" → popular tv', JSON.stringify(q('popular shows this week')) === JSON.stringify({ kind: 'tv', order: 'popular', period: 'week' }), q('popular shows this week'));
  check('"new anime" → anime', q('new anime')?.kind === 'anime');
  check('"top games this month" → popular games month', JSON.stringify(q('top games this month')) === JSON.stringify({ kind: 'games', order: 'popular', period: 'month' }));
  check('"best movies today" → day', q('best movies today')?.period === 'day');
  check('category wins over the words', q('new releases', 'books')?.kind === 'books');
  check('no kind to be found → null (a normal search)', q('new releases') === null);
  check('sort newest beats "popular" in the words', q('popular movies', 'movies', 'newest')?.order === 'new');

  // ---------------------------------------------------------------- browseAll with a fake fetch

  const realFetch = globalThis.fetch;
  const ALL_ON = { enabled: ['knaben', 'yts', 'tpb', 'nyaa'], adult: false, waitSeconds: 2, now: NOW };

  console.log('browse: sources per kind');
  {
    resetHealth();
    const log = [];
    globalThis.fetch = fakeFetch(ROUTES, log);
    const u = await B.browseAll('movies', 'new', 'week', ALL_ON);
    check('new movies asks YTS and Knaben, not TPB', log.some((l) => /list_movies\.json/.test(l.url)) && log.some((l) => /knaben/.test(l.url)) && !log.some((l) => /apibay/.test(l.url)), log.map((l) => l.url));
    const yts = log.find((l) => /list_movies/.test(l.url));
    check('YTS is asked for the newest uploads, 50 rows', /sort_by=date_added/.test(yts.url) && /limit=50/.test(yts.url), yts.url);
    const kn = log.find((l) => /knaben/.test(l.url));
    check('Knaben gets no query, order by date, the movies category and hide_xxx', kn.method === 'POST' && kn.body.query === undefined && kn.body.order_by === 'date' && kn.body.order_direction === 'desc' && kn.body.categories[0] === 3000000 && kn.body.hide_xxx === true && kn.body.size === 50, kn.body);
    check('done, with both sources answered', u.done && u.sources.length === 2 && u.sources.every((s) => s.state === 'done'), u.sources);
    check('YTS rows carry magnets built from the hash', u.results.some((r) => r.providerId === 'yts' && r.magnet.startsWith(`magnet:?xt=urn:btih:${hex(0x101)}`)));

    log.length = 0;
    await B.browseAll('movies', 'popular', 'week', ALL_ON);
    check('popular movies also asks TPB, 48h lists for 201 and 207', log.some((l) => /data_top100_48h_201\.json/.test(l.url)) && log.some((l) => /data_top100_48h_207\.json/.test(l.url)), log.map((l) => l.url));
    check('Knaben orders by seeders for popular', log.find((l) => /knaben/.test(l.url)).body.order_by === 'seeders');
    log.length = 0;
    await B.browseAll('movies', 'popular', 'year', ALL_ON);
    check('popular over a year uses the all-time TPB list', log.some((l) => /data_top100_201\.json/.test(l.url)) && !log.some((l) => /48h/.test(l.url)), log.map((l) => l.url));

    log.length = 0;
    await B.browseAll('tv', 'new', 'week', ALL_ON);
    check('tv asks Knaben and TPB (205 and 208)', log.some((l) => /knaben/.test(l.url)) && log.some((l) => /48h_205/.test(l.url)) && log.some((l) => /48h_208/.test(l.url)) && !log.some((l) => /yts|accel|nyaa/.test(l.url)), log.map((l) => l.url));
    log.length = 0;
    await B.browseAll('anime', 'new', 'week', ALL_ON);
    check('anime asks Nyaa (English-translated, no query) and Knaben', log.some((l) => /nyaa\.si\/\?page=rss&f=0&c=1_2&q=$/.test(l.url)) && log.some((l) => /knaben/.test(l.url)) && !log.some((l) => /apibay/.test(l.url)), log.map((l) => l.url));
    log.length = 0;
    await B.browseAll('books', 'new', 'week', ALL_ON);
    check('books asks Knaben (books) and TPB 601', log.some((l) => /knaben/.test(l.url) && l.body.categories[0] === 9000000) && log.some((l) => /48h_601/.test(l.url)), log.map((l) => l.url));

    log.length = 0;
    await B.browseAll('movies', 'popular', 'week', { ...ALL_ON, enabled: ['knaben', 'yts'] });
    check('a source the user turned off is never asked', !log.some((l) => /apibay/.test(l.url)), log.map((l) => l.url));
    log.length = 0;
    await B.browseAll('movies', 'new', 'week', { ...ALL_ON, useFor: { knaben: ['tv'] } });
    check('a source limited to other kinds is not asked', !log.some((l) => /knaben/.test(l.url)), log.map((l) => l.url));
    log.length = 0;
    const none = await B.browseAll('movies', 'new', 'week', { ...ALL_ON, enabled: [] });
    check('no eligible source: done, empty, no request', none.done && none.results.length === 0 && none.sources.length === 0 && log.length === 0);
  }

  console.log('browse: failures are tolerated');
  {
    resetHealth();
    const log = [];
    globalThis.fetch = fakeFetch(ROUTES, log, ['accel.li']);
    const updates = [];
    const u = await B.browseAll('movies', 'new', 'week', { ...ALL_ON, onUpdate: (x) => updates.push(x) });
    const yts = u.sources.find((s) => s.providerId === 'yts');
    check('a source that fails is marked, the rest still answer', yts && yts.state === 'error' && u.sources.find((s) => s.providerId === 'knaben').state === 'done', u.sources);
    check('rows from the working source come back', u.results.length > 0 && u.results.every((r) => r.providerId === 'knaben'));
    check('updates start, then end with done', updates.length >= 2 && updates[0].done === false && updates[updates.length - 1].done === true);

    resetHealth();
    globalThis.fetch = async (url, init) => {
      if (/accel\.li/.test(String(url))) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      return fakeFetch(ROUTES, [])(url, init);
    };
    const t = await B.browseAll('movies', 'new', 'week', { ...ALL_ON, waitSeconds: 0.2 });
    check('a slow source times out', t.sources.find((s) => s.providerId === 'yts')?.state === 'timeout', t.sources);
  }

  // ---------------------------------------------------------------- the tool runner on top

  function runnerWith(o = {}) {
    const w = { searchCalls: 0, free: 50 * GB, calls: [] };
    const providers = new Map([['knaben', { name: 'Knaben' }], ['yts', { name: 'YTS' }], ['tpb', { name: 'The Pirate Bay', unsafeReason: 'Many fake uploads.' }], ['nyaa', { name: 'Nyaa' }]]);
    const deps = {
      async search() { w.searchCalls++; return { results: [], sources: [], done: true }; },
      browse: o.noBrowse ? undefined : (kind, order, period, opts) => B.browseAll(kind, order, period, { ...ALL_ON, ...(o.prefs ?? {}), signal: opts.signal, onUpdate: opts.onUpdate }),
      searchPrefs: () => ({ warnUnsafe: true, providers }),
      async resolveResult(r) { return r; },
      engine: {
        async listTorrents() { return { ok: true, torrents: [], downloads: [] }; },
        async getDetail() { return { ok: false, code: 'NOT_FOUND', message: '' }; },
        async resolveMetadata(source) {
          w.calls.push(['resolveMetadata', source]);
          const h = /btih:([0-9a-f]{40})/i.exec(source)[1].toLowerCase();
          return { ok: true, infoHash: h, name: 'The Day She Left Us (2026) 1080p', totalBytes: 2 * GB, files: [{ index: 0, path: 'The Day She Left Us (2026)/The.Day.She.Left.Us.2026.1080p.WEBRip.x264.mp4', length: 2 * GB }] };
        },
        async cancelResolve() { return { ok: true }; },
        async addTorrent() { return { ok: true, id: 'n1', infoHash: hex(1) }; },
        async setFilePriorities() { return { ok: true }; },
        async pause() { return { ok: true }; },
        async resume() { return { ok: true }; },
        async removeFiles() { return { ok: true, freedBytes: 0 }; },
        async delete() { return { ok: true }; },
        async getFreeSpace() { return { ok: true, path: '/storage/emulated/0/Download/Maglev', freeBytes: w.free, totalBytes: 128 * GB, mode: 'direct' }; },
        async pauseDownload() { return { ok: true }; },
        async resumeDownload() { return { ok: true }; },
        async removeDownload() { return { ok: true }; },
      },
      playbackSupport: async () => null,
      now: () => NOW,
    };
    return { w, runner: createToolRunner(deps) };
  }
  const ctxOf = () => {
    const lines = [];
    return { signal: new AbortController().signal, progress: (text, state) => lines.push([text, state ?? 'running']), lines };
  };
  const parse = (out) => JSON.parse(out.content);
  const run = (runner, name, raw, ctx = ctxOf()) => {
    const v = validateArgs(name, raw, runner.registry, true);
    if (!v.ok) throw new Error(`validateArgs failed: ${v.error.message}`);
    return runner.run({ id: 'k1', name, args: v.args }, ctx);
  };

  console.log('runner: browse_torrents new movies this week');
  {
    resetHealth();
    globalThis.fetch = fakeFetch(ROUTES, []);
    const { runner } = runnerWith();
    const ctx = ctxOf();
    const out = await run(runner, 'browse_torrents', { kind: 'movies' }, ctx);
    const j = parse(out);
    check('ok, and echoes kind, order and period', j.ok && j.data.kind === 'movies' && j.data.order === 'new' && j.data.period === 'week', j.data && { kind: j.data.kind, order: j.data.order, period: j.data.period });
    const titles = j.data.results.map((r) => r.name_untrusted);
    check('one row per title: The Day She Left Us appears once', titles.filter((t) => /day.she.left/i.test(t)).length === 1, titles);
    check('old films, old uploads and cinema copies are gone', !titles.some((t) => /superbad|old\.upload|hdcam/i.test(t)), titles);
    check('four different titles', j.data.count === 4 && new Set(titles.map((t) => t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 8))).size === 4, titles);
    check('newest upload first', j.data.results.map((r) => r.uploaded).join('|') === '1 day ago|2 days ago|3 days ago|5 days ago', j.data.results.map((r) => r.uploaded));
    check('rows have the search row shape', j.data.results.every((r) => /^r\d+$/.test(r.id) && typeof r.size_text === 'string' && 'sharing' in r && typeof r.fit === 'string' && Array.isArray(r.flags)), j.data.results[0]);
    check('the first 3 rows are on cards, in the same order', out.results.length === 3 && j.data.results.slice(0, 3).every((r, i) => r.on_card === true && r.id === out.results[i].handle), [out.results.map((c) => c.handle), j.data.results.map((r) => r.id)]);
    check('progress names the browse', ctx.lines.some(([t, s]) => t === 'Looking at new movies this week' && s === 'running') && ctx.lines.some(([t, s]) => t === 'Looking at new movies this week' && s === 'done'), ctx.lines);
    check('detail line counts titles and sources', out.detail === '4 titles from 2 sources', out.detail);
    check('no hashes or magnets in the content', !/magnet:|[0-9a-f]{40}/i.test(out.content));

    // Same handle registry and stored entries as search: details and propose_add work.
    const second = out.results[1].handle;
    const d = parse(await run(runner, 'get_result_details', { result_id: second }));
    check('get_result_details opens a browse row', d.ok === true, d);
    const first = out.results[0].handle;
    const d1 = parse(await run(runner, 'get_result_details', { result_id: first }));
    check('the film matching its own title has no title warning', d1.ok && d1.data.safety !== 'red', d1.data);
    const v = validateArgs('propose_add', { result_id: first, reason: 'x' }, runner.registry, true);
    const card = await runner.prepareCard('c1', 'propose_add', v.args);
    check('propose_add builds a card for a browse row', !('error' in card), card);
  }

  console.log('runner: browse popular tv, failures and empty periods');
  {
    resetHealth();
    globalThis.fetch = fakeFetch(ROUTES, []);
    const { runner } = runnerWith();
    const out = await run(runner, 'browse_torrents', { kind: 'shows', order: 'trending', period: 'this week', limit: '4' });
    const j = parse(out);
    check('coerced args: tv, popular, week', j.ok && j.data.kind === 'tv' && j.data.order === 'popular' && j.data.period === 'week', j.data);
    const names = j.data.results.map((r) => r.name_untrusted);
    check('MobLand S02E08 appears once (three copies, two sources)', names.filter((n) => /mobland/i.test(n)).length === 1, names);
    check('most sharing first', j.data.results.map((r) => r.sharing).every((s, i, a) => i === 0 || (a[i - 1] ?? -1) >= (s ?? -1)), j.data.results.map((r) => r.sharing));
    check('the best copy of the episode is kept', /MobLand S02E08 We Dont Talk Anymore 1080p/.test(names.find((n) => /mobland/i.test(n))), names);
  }
  {
    resetHealth();
    globalThis.fetch = fakeFetch(ROUTES, [], ['knaben']);
    const { runner } = runnerWith();
    const j = parse(await run(runner, 'browse_torrents', { kind: 'movies' }));
    check('a source that fails is named in notes like search', j.ok && j.data.notes.includes("Knaben didn't answer."), j.data.notes);
    check('the other source still fills the list', j.data.count === 2, j.data.results.map((r) => r.name_untrusted));
  }
  {
    resetHealth();
    const old = () => JSON.stringify({ hits: [knabenHit({ title: 'Ancient.Film.1999.1080p.BluRay.x264-GRP', hash: hex(0x701), bytes: 2 * GB, seeders: 40, at: NOW - 2 * DAY, cat: [3001000, 3000000] }), knabenHit({ title: 'Last.Month.2026.1080p.WEB-DL.x264-GRP', hash: hex(0x702), bytes: 2 * GB, seeders: 40, at: NOW - 40 * DAY, cat: [3001000, 3000000] })] });
    globalThis.fetch = fakeFetch([['api.knaben.org/v1', old]], []);
    const { runner } = runnerWith({ prefs: { enabled: ['knaben'] } });
    const out = await run(runner, 'browse_torrents', { kind: 'movies', order: 'new', period: 'week' });
    const j = parse(out);
    check('all rows old: empty result', j.ok && j.data.count === 0 && out.results.length === 0, j.data);
    check('all rows old: a note says nothing new in that period', j.data.notes.some((n) => /^Nothing new in that period/.test(n)), j.data.notes);
    check('detail says no titles', out.detail === 'No titles', out.detail);
  }
  {
    resetHealth();
    globalThis.fetch = fakeFetch(ROUTES, []);
    const { runner } = runnerWith({ prefs: { enabled: [] } });
    const j = parse(await run(runner, 'browse_torrents', { kind: 'movies' }));
    check('no source can list the kind: a plain note', j.ok && j.data.count === 0 && j.data.notes.some((n) => /None of your sources can list/.test(n)), j.data.notes);
  }
  {
    resetHealth();
    globalThis.fetch = fakeFetch(ROUTES, []);
    const { runner, w } = runnerWith();
    w.free = 1 * GB;
    const j = parse(await run(runner, 'browse_torrents', { kind: 'movies' }));
    check('nothing fits: all_too_big and shortfall_text like search', j.data.all_too_big === true && /more space needed/.test(j.data.shortfall_text), j.data);
  }

  console.log('runner: search_torrents falls back to browse for a generic query');
  {
    resetHealth();
    globalThis.fetch = fakeFetch(ROUTES, []);
    const { runner, w } = runnerWith();
    const out = await run(runner, 'search_torrents', { query: 'latest movies', category: 'movies', sort: 'newest' });
    const j = parse(out);
    check('ran browse, not search', w.searchCalls === 0 && j.ok && j.data.kind === 'movies' && j.data.order === 'new' && j.data.period === 'week', j.data);
    check('adds the note', j.data.notes.includes('Treated as a browse request.'), j.data.notes);
    check('cards come back', out.results.length === 3);
    const p = parse(await run(runner, 'search_torrents', { query: 'popular movies', category: 'movies' }));
    check('"popular movies" → order popular', p.data.order === 'popular', p.data);
    const s = parse(await run(runner, 'search_torrents', { query: 'Colony', category: 'movies' }));
    check('a real title still searches', w.searchCalls === 1 && s.data.kind === undefined, s.data);
    const r = parse(await run(runner, 'search_torrents', { query: 'new releases' }));
    check('a generic query with no kind still searches', w.searchCalls === 2 && r.data.kind === undefined);
  }
  {
    const { runner, w } = runnerWith({ noBrowse: true });
    const j = parse(await run(runner, 'search_torrents', { query: 'latest movies', category: 'movies', sort: 'newest' }));
    check('without a browse dependency the search runs as before', w.searchCalls === 1 && j.ok && j.data.kind === undefined);
    const b = parse(await run(runner, 'browse_torrents', { kind: 'movies' }));
    check('browse_torrents without a browse dependency fails plainly', b.ok === false && typeof b.error.message === 'string', b);
  }

  globalThis.fetch = realFetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
