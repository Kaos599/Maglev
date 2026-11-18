#!/usr/bin/env node
// Subtitle sources, batch 5 (NATIVE_CONTRACT 36.3, 36.12): Sous-Titres.eu, SubSynchro, Subclub, Subtitri Nekur,
// SubtitleStar, Subtitulamos.tv. No network: the parse functions run on recorded pages (scripts/fixtures/subtitles/*/SOURCES.txt)
// and the search/download wrappers run against a fake fetch that serves those pages.
// Needs Node 22.18+ (runs the TypeScript sources directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'subtitles');
const bytes = (p) => new Uint8Array(fs.readFileSync(path.join(FIX, p)));
const fx = (p) => fs.readFileSync(path.join(FIX, p), 'utf8');

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

/** Fake fetch: `routes` maps a URL (or a function of url and init) to a body, Uint8Array or {status, body, type}. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, headers: init.headers });
    let hit = routes[String(url)];
    if (hit === undefined) for (const [k, v] of Object.entries(routes)) if (k.endsWith('*') && String(url).startsWith(k.slice(0, -1))) hit = v;
    if (typeof hit === 'function') hit = hit(String(url), init);
    if (hit === undefined) return new Response('not found', { status: 404 });
    const o = typeof hit === 'string' || hit instanceof Uint8Array ? { body: hit } : hit;
    return new Response(o.body, { status: o.status ?? 200, headers: { 'content-type': o.type ?? 'text/html; charset=utf-8' } });
  };
  fn.calls = calls;
  return fn;
}

const ctx = (baseUrl) => ({ signal: new AbortController().signal, baseUrl });
const query = (over = {}) => ({ fileName: 'x.mkv', videoBytes: 1, title: 'Inception', year: 2010, episodeConfidence: 'none', languages: ['fr'], ...over });
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

async function main() {
  const types = await import('../utils/subtitles/providers/batch5.ts');
  const common = await import('../utils/subtitles/http.ts');
  const match = await import('../utils/subtitles/match.ts');
  const ss = await import('../utils/subtitles/providers/soustitreseu.ts');
  const sy = await import('../utils/subtitles/providers/subsynchro.ts');
  const sc = await import('../utils/subtitles/providers/subclub.ts');
  const nk = await import('../utils/subtitles/providers/nekur.ts');
  const st = await import('../utils/subtitles/providers/subtitlestar.ts');
  const tv = await import('../utils/subtitles/providers/subtitulamostv.ts');
  const { archiveKind } = await import('../utils/subtitles/payload.ts');
  const { normalizeLanguage } = await import('../utils/subtitles/languages.ts');
  const realFetch = globalThis.fetch;

  console.log('registry');
  {
    const ids = types.BATCH_5.map((p) => p.id);
    check('six sources, unique ids', ids.length === 6 && new Set(ids).size === 6, ids.join(','));
    check('every source declares group B and is off by default', types.BATCH_5.every((p) => p.group === 'B' && p.enabledByDefault === false));
    check('mirrors are https and languages are known codes', types.BATCH_5.every((p) => p.mirrors.length > 0 && p.mirrors.every((m) => m.startsWith('https://')) && p.languages !== 'many' && p.languages.every((l) => normalizeLanguage(l) === l)));
    check('kinds and matches are set', types.BATCH_5.every((p) => p.kinds.length > 0 && p.matches.length > 0));
  }

  console.log('shared helpers');
  {
    check('resolveHref: relative, parent, root, absolute', match.resolveHref('https://a.test/films/x.html', 'download/y.zip') === 'https://a.test/films/download/y.zip' && match.resolveHref('https://a.test/films/x.html', '../img/a.jpg') === 'https://a.test/img/a.jpg' && match.resolveHref('https://a.test/films/x.html', '/z') === 'https://a.test/z' && match.resolveHref('https://a.test/', 'https://b.test/q') === 'https://b.test/q');
    check('pathOf keeps path and query', match.pathOf('https://a.test/d.php?id=1&f=2') === '/d.php?id=1&f=2');
    check('titleMatches folds accents and needs every word', match.titleMatches('Amélie', 'AMELIE (2001)') && !match.titleMatches('The Matrix', 'Matrix Reloaded'));
    const zip = common.toPayload(bytes('soustitreseu/download.zip'));
    check('a zip stays a zip', zip.kind === 'zip' && archiveKind(zip.bytes) === 'zip');
    const srt = common.toPayload(bytes('subclub/download.srt'));
    check('a subtitle file is text with its format read', srt.kind === 'text' && srt.format === 'srt' && srt.bytes.length > 1000);
    const rar = await throws(() => common.toPayload(new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 1, 2, 3])));
    check('RAR is refused as an unsupported file type', rar?.kind === 'parse' && /isn't supported/.test(rar.message));
    const sevenZ = await throws(() => common.toPayload(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4, 1, 1])));
    check('7z is refused', sevenZ?.kind === 'parse');
    const page = await throws(() => common.toPayload(new TextEncoder().encode('<!DOCTYPE html><html><body>nope</body></html>')));
    check('a page is refused', page?.kind === 'parse');
    check('an empty body is refused', (await throws(() => common.toPayload(new Uint8Array(0))))?.kind === 'parse');
    const ass = common.toPayload(new TextEncoder().encode('[Script Info]\nTitle: x\n[V4+ Styles]\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi\n'));
    check('ASS is recognised', ass.kind === 'text' && ass.format === 'ass');
    globalThis.fetch = fakeFetch({ 'https://a.test/limit': { status: 429, body: 'slow down' }, 'https://a.test/bot': { status: 403, body: '<html>Just a moment... cloudflare</html>' }, 'https://a.test/down': { status: 503, body: 'x', type: 'text/plain' } });
    const lim = await throws(() => common.httpBytes('https://a.test/limit', { signal: new AbortController().signal }));
    check('HTTP 429 is a limit (kind http, status 429)', lim?.kind === 'http' && lim.status === 429);
    const bot = await throws(() => common.httpBytes('https://a.test/bot', { signal: new AbortController().signal }));
    check('a Cloudflare page is a challenge', bot?.kind === 'challenge');
    globalThis.fetch = realFetch;
  }

  console.log('soustitreseu');
  {
    check('name tags: VO, VF, ENFR, a lone EN', JSON.stringify(ss.nameLanguages('Show.S01E01.VO.zip')) === '["en"]' && JSON.stringify(ss.nameLanguages('Show.1x07.ENFR.zip')) === '["en","fr"]' && JSON.stringify(ss.nameLanguages('Breaking.Bad.5x16.FR.FBK.zip')) === '["fr"]' && ss.nameLanguages('Asterix.en.Bretagne.zip').length === 0);
    const base = 'https://www.sous-titres.eu/search.html?q=Inception';
    const rows = ss.parseSearch(fx('soustitreseu/search_inception.html'), base);
    const inc = rows[0];
    check('search rows: kind, title, year, exact flag, absolute URL', rows.length === 6 && inc.mediaType === 'film' && inc.title === 'Inception' && inc.year === 2010 && inc.exact && inc.url === 'https://www.sous-titres.eu/films/inception.html', JSON.stringify(inc));
    check('aliases are read (Inspecteur Gadget)', rows.some((r) => r.aliases.includes('Inspecteur Gadget')));
    const ranked = ss.rankRows(rows, 'Inception', 'film', 2010);
    check('ranking keeps only fitting films, the exact one first', ranked.length === 1 && ranked[0].url.endsWith('/films/inception.html'));
    check('a different year is dropped', ss.rankRows(rows, 'Inception', 'film', 1999).length === 0);
    const archives = ss.parseArchives(fx('soustitreseu/film_inception.html'), inc.url);
    check('film page: 5 archives with absolute download URLs', archives.length === 5 && archives[0].url === 'https://www.sous-titres.eu/films/download/hkysl6er07d42d8/Inception.%282010%29.Z1.REFiNED.zip' && archives[0].filename === 'Inception.(2010).Z1.REFiNED.zip', String(archives.length));
    const c = ss.candidatesFor(archives, inc, { languages: ['fr'] });
    check('French candidates carry a site-path id and the release name', c.length === 5 && c[0].language === 'fr' && c[0].providerId === 'soustitreseu' && c[0].id.startsWith('/films/download/') && c[0].releaseName === 'Inception.(2010).Z1.REFiNED' && c[0].matchedBy === 'title');
    check('English asked, no English archive: nothing', ss.candidatesFor(archives, inc, { languages: ['en'] }).length === 0);
    const bb = ss.parseArchives(fx('soustitreseu/series_breaking_bad.html'), 'https://www.sous-titres.eu/series/breaking_bad.html');
    check('series page: 95 archives, labels give season and episode', bb.length === 95 && bb.some((a) => a.season === 5 && a.episode === 16) && bb.some((a) => a.season === 1 && a.episode === undefined));
    const ep = ss.candidatesFor(bb, { mediaType: 'series' }, { languages: ['fr', 'en'], season: 5, episode: 16 });
    check('episode 5x16: the episode archive and season-5 packs only', ep.length >= 2 && ep.some((x) => /5x16/.test(x.releaseName)) && ep.every((x) => /(5x16|S0?5)/.test(x.releaseName)), ep.map((x) => x.releaseName).join(' | '));
    check('two-language (ENFR) archives are skipped, so a zip never holds the wrong language', ss.candidatesFor(bb, { mediaType: 'series' }, { languages: ['en', 'fr'], season: 1, episode: 7 }).every((x) => !/ENFR/.test(x.releaseName)));
    const sr = ss.parseSearch(fx('soustitreseu/search_breaking_bad.html'), 'https://www.sous-titres.eu/search.html?q=Breaking+Bad');
    check('series block is read as a series', sr.length === 1 && sr[0].mediaType === 'series' && sr[0].title === 'Breaking Bad');
    check('search on an unrelated page fails as parse', (await throws(() => ss.parseSearch('plain text', base)))?.kind === 'parse');

    // search + download through the fake fetch
    globalThis.fetch = fakeFetch({
      'https://www.sous-titres.eu/search.html?q=Inception': fx('soustitreseu/search_inception.html'),
      'https://www.sous-titres.eu/films/inception.html': fx('soustitreseu/film_inception.html'),
      'https://www.sous-titres.eu/films/download/hkysl6er07d42d8/*': { body: bytes('soustitreseu/download.zip'), type: 'application/force-download' },
    });
    const found = await ss.soustitreseu.search(query(), ctx('https://www.sous-titres.eu'));
    check('search() walks search page then film page', found.length === 5 && found[0].language === 'fr');
    const dl = await ss.soustitreseu.download(found[0], ctx('https://www.sous-titres.eu'));
    check('download() gives the zip', dl.kind === 'zip' && archiveKind(dl.bytes) === 'zip');
    const before = globalThis.fetch.calls.length;
    check('a language the source lacks asks nothing', (await ss.soustitreseu.search(query({ languages: ['de'] }), ctx('https://www.sous-titres.eu'))).length === 0 && globalThis.fetch.calls.length === before);
    globalThis.fetch = realFetch;
  }

  console.log('subsynchro');
  {
    const base = 'https://www.subsynchro.com';
    const film = fx('subsynchro/film_inception.html');
    check('film header', JSON.stringify(sy.parseFilmHeader(film)) === '{"title":"Inception","year":2010}');
    const rel = sy.parseReleases(film, base);
    check('release rows: id, name, group, absolute URL; rows with no file are skipped', rel.length === 2 && rel[0].releaseId === '6001' && rel[0].info === 'Inception.RERiP.DVDRiP.XviD-ARROW' && rel[0].group === 'ARROW' && rel[0].url === `${base}/2010/inception/inception-rerip-dvdrip-xvid-arrow.html`, JSON.stringify(rel[0]));
    const list = sy.parseFilmList(fx('subsynchro/list_matrix.html'), base);
    check('film list: year from the path, absolute URLs, no duplicates', list.length >= 4 && list.some((f) => f.title === 'Matrix' && f.year === 1999 && f.url === `${base}/1999/791-the-matrix.html`) && new Set(list.map((f) => f.url)).size === list.length);
    const files = sy.parseFiles(fx('subsynchro/release_inception_arrow.html'), base);
    check('file article: name, download URL, format, count', files.length === 1 && files[0].filename === 'Inception.RERiP.DVDRiP.XviD-ARROW.zip' && files[0].format === 'zip' && files[0].downloads === 64 && files[0].downloadUrl.includes('/telecharger-le-fichier-5661-'), JSON.stringify(files[0]));
    const cands = sy.candidatesFromFiles(files, rel[0]);
    check('candidate is French, keeps release name and a site-path id', cands.length === 1 && cands[0].language === 'fr' && cands[0].releaseName === rel[0].info && cands[0].id.startsWith('/telecharger-le-fichier-5661-') && cands[0].downloads === 64);
    check('RAR files are dropped at search time', sy.candidatesFromFiles([{ ...files[0], format: 'rar', filename: 'a.rar' }], rel[0]).length === 0);

    globalThis.fetch = fakeFetch({
      [`${base}/tous-les-films.html`]: (u, init) => (init.method === 'POST' && /q=Inception/.test(init.body) ? film : 'nope'),
      [`${base}/2010/inception/inception-rerip-dvdrip-xvid-arrow.html`]: fx('subsynchro/release_inception_arrow.html'),
      [`${base}/2010/inception/*`]: fx('subsynchro/release_inception_arrow.html'),
      [`${base}/telecharger-le-fichier-5661-*`]: { body: bytes('subsynchro/download.zip'), type: 'application/zip' },
    });
    const found = await sy.subsynchro.search(query(), ctx(base));
    check('search() posts the title and reads release pages', found.length >= 1 && found.every((c) => c.language === 'fr'), String(found.length));
    check('the POST sends a form body', globalThis.fetch.calls[0].method === 'POST' && globalThis.fetch.calls[0].body === 'q=Inception');
    const dl = await sy.subsynchro.download(found[0], ctx(base));
    check('download() gives the zip', dl.kind === 'zip');
    globalThis.fetch = fakeFetch({ [`${base}/tous-les-films.html`]: (u, init) => 'x' });
    check('an episode query is not searched (movies only)', (await sy.subsynchro.search(query({ season: 1, episode: 2, episodeConfidence: 'sure' }), ctx(base))).length === 0 && globalThis.fetch.calls.length === 0);
    globalThis.fetch = realFetch;
  }

  console.log('subclub');
  {
    const base = 'https://www.subclub.eu';
    const hits = sc.parseSearch(fx('subclub/search_inception.html'));
    check('search row: id, title, year, IMDb, downloads, rating', hits.length === 1 && hits[0].archiveId === '10100' && hits[0].title === 'Inception' && hits[0].year === 2010 && hits[0].imdbId === 'tt1375666' && hits[0].downloads === 41769 && hits[0].rating === 5, JSON.stringify(hits));
    const files = sc.parseArchiveList(fx('subclub/archive_list.html'), base);
    check('archive list: 7 subtitle files, each a direct per-file link', files.length === 7 && files[0].filename === 'Inception (2010) DVDRip XviD-MAXSPEED.srt' && files[0].path === '/down.php?id=10100&filename=SW5jZXB0aW9uICgyMDEwKSBEVkRSaXAgWHZpRC1NQVhTUEVFRC5zcnQ=', String(files.length));
    const q = query({ languages: ['et'] });
    check('hitFits: title and year', sc.hitFits(hits[0], q) && !sc.hitFits(hits[0], { ...q, year: 1999 }) && !sc.hitFits({ ...hits[0], season: 1, episode: 2 }, q));
    check('hitFits: an episode needs the same season and episode', sc.hitFits({ ...hits[0], season: 1, episode: 2 }, { ...q, season: 1, episode: 2, episodeConfidence: 'sure' }));
    const cands = sc.candidatesFor(hits[0], files);
    check('one candidate per file, Estonian, format from the name', cands.length === 7 && cands.every((c) => c.language === 'et' && c.format === 'srt' && c.downloads === 41769) && cands[2].releaseName === 'Inception.720p.BluRay.x264-CROSSBOW');
    check('an empty listing falls back to the whole archive', sc.candidatesFor(hits[0], [])[0].id === '/down.php?id=10100');

    globalThis.fetch = fakeFetch({
      [`${base}/jutud.php?otsing=Inception`]: fx('subclub/search_inception.html'),
      [`${base}/subtitles_archivecontent.php?id=10100`]: fx('subclub/archive_list.html'),
      [`${base}/down.php?id=10100&filename=*`]: { body: bytes('subclub/download.srt'), type: 'text/plain; charset=UTF-8' },
    });
    const found = await sc.subclub.search(q, ctx(base));
    check('search() lists the archive files', found.length === 7);
    const dl = await sc.subclub.download(found[2], ctx(base));
    check('download() gives subtitle text', dl.kind === 'text' && dl.format === 'srt');
    globalThis.fetch = fakeFetch({ [`${base}/down.php?id=10100`]: { body: new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 7, 0, 1, 2, 3, 4]), type: 'application/octet-stream' } });
    const rar = await throws(() => sc.subclub.download(sc.candidatesFor(hits[0], [])[0], ctx(base)));
    check('a whole-archive RAR fails as an unsupported type', rar?.kind === 'parse' && /isn't supported/.test(rar.message));
    globalThis.fetch = realFetch;
  }

  console.log('nekur');
  {
    const base = 'https://subtitri.nekur.net';
    const rows = nk.parseSearch(fx('nekur/search_inception.html'), base);
    check('row: title, year, IMDb, notes, site path', rows.length === 1 && rows[0].title === 'Inception' && rows[0].year === 2010 && rows[0].imdbId === 'tt1375666' && rows[0].notes === 'DVD, BD' && rows[0].path === '/filmu-subtitri/download/a5f2dfe46e3d41cb342349b881d03cb0', JSON.stringify(rows));
    check('rowFits: title and year', nk.rowFits(rows[0], { title: 'Inception', year: 2010 }) && !nk.rowFits(rows[0], { title: 'Inception', year: 2011 }) && !nk.rowFits(rows[0], { title: 'Insomnia' }));
    const c = nk.toCandidate(rows[0]);
    check('candidate is Latvian with the notes as release name', c.language === 'lv' && c.releaseName === 'DVD, BD' && c.id === rows[0].path);
    check('a row without an IMDb link is skipped', nk.parseSearch(fx('nekur/search_inception.html').replace(/imdb\.com\/title\/tt\d+/, 'x.test/a'), base).length === 0);

    globalThis.fetch = fakeFetch({
      [`${base}/modules/Subtitles.php`]: { status: 500, body: fx('nekur/search_inception.html') },
      [`${base}/filmu-subtitri/download/*`]: { body: bytes('nekur/download.zip'), type: 'application/octet-stream' },
    });
    const found = await nk.nekur.search(query({ languages: ['lv'] }), ctx(base));
    check('search() reads the table the site sends with HTTP 500', found.length === 1);
    check('the search POST is the site\'s ajax form', globalThis.fetch.calls[0].method === 'POST' && globalThis.fetch.calls[0].body === 'ajax=1&sSearch=Inception');
    const dl = await nk.nekur.download(found[0], ctx(base));
    check('download() gives the zip', dl.kind === 'zip');
    globalThis.fetch = fakeFetch({ [`${base}/modules/Subtitles.php`]: { status: 500, body: 'oops' } });
    check('a 500 with no table is an http error', (await throws(() => nk.nekur.search(query({ languages: ['lv'] }), ctx(base))))?.kind === 'http');
    globalThis.fetch = realFetch;
  }

  console.log('subtitlestar');
  {
    const base = 'https://subtitlestar.com';
    const posts = st.parseSearch(fx('subtitlestar/search_inception.html'));
    check('result titles and URLs', posts.length === 4 && posts[0].title.includes('Inception 2010') && posts[0].url.startsWith(`${base}/`), JSON.stringify(posts[0]));
    const q = query({ languages: ['fa'] });
    check('postFits: title words and year', st.postFits(posts[0], q) && !st.postFits(posts[1], q) && !st.postFits(posts[0], { ...q, year: 1999 }));
    const d = st.parseDetail(fx('subtitlestar/detail_inception.html'));
    check('detail: IMDb, year, trailer excluded', d.imdbId === 'tt1375666' && d.year === 2010 && d.links.length === 1 && d.links[0] === 'https://dl.subtitlestar.com/dlsub/inception-2010-All.zip', JSON.stringify(d));
    const mc = st.candidatesFor(d, q);
    check('movie candidate: Persian, zip file name as release', mc.length === 1 && mc[0].language === 'fa' && mc[0].id === d.links[0] && mc[0].releaseName === 'inception-2010-All');
    const sd = st.parseDetail(fx('subtitlestar/detail_series.html'));
    check('series detail lists season and episode zips', sd.links.length === 9 && st.linkEpisode(sd.links[0]).season === 1 && st.linkEpisode(sd.links[1]).episode === 8 && st.linkEpisode(sd.links[0]).episode === undefined);
    const ec = st.candidatesFor(sd, { season: 1, episode: 7, episodeConfidence: 'sure' });
    check('episode 1x07: that episode and the season pack only', ec.length === 2 && ec.some((c) => /S01E07/.test(c.releaseName)) && ec.some((c) => /All-S01$/.test(c.releaseName)), ec.map((c) => c.releaseName).join(','));
    check('a movie query ignores season zips', st.candidatesFor(sd, { episodeConfidence: 'none' }).length === 0);
    check('queries: title and year first', JSON.stringify(st.queriesFor({ title: 'Inception', year: 2010, episodeConfidence: 'none' })) === '["Inception 2010","Inception"]' && JSON.stringify(st.queriesFor({ title: 'Show', season: 1, episode: 2, episodeConfidence: 'sure' })) === '["Show"]');

    globalThis.fetch = fakeFetch({
      [`${base}/?s=Inception%202010&post_type=post`]: fx('subtitlestar/search_inception.html'),
      [`${posts[0].url}`]: fx('subtitlestar/detail_inception.html'),
      'https://dl.subtitlestar.com/dlsub/inception-2010-All.zip': { body: bytes('subtitlestar/download.zip'), type: 'application/zip' },
    });
    const found = await st.subtitlestar.search(q, ctx(base));
    check('search() finds the movie on the first query', found.length === 1 && globalThis.fetch.calls.length === 2);
    const dl = await st.subtitlestar.download(found[0], ctx(base));
    check('download() gives the zip', dl.kind === 'zip');
    check('a download id outside the source\'s file host is refused', (await throws(() => st.subtitlestar.download({ ...found[0], id: 'https://evil.test/a.zip' }, ctx(base))))?.kind === 'parse');
    globalThis.fetch = realFetch;
  }

  console.log('subtitulamostv');
  {
    const base = 'https://www.subtitulamos.tv';
    const shows = tv.parseShows(fx('subtitulamostv/search_the_strain.json'));
    check('shows parsed', shows.length === 5 && shows[0].id === '11' && shows[0].name === 'The Strain');
    check('only the exact show name counts (the site search is loose)', tv.exactShows(shows, 'The Strain').length === 1 && tv.exactShows(shows, 'The Strain (2014)').length === 1 && tv.exactShows(shows, 'The Wire').length === 0);
    check('search that answers a page is blocked', (await throws(() => tv.parseShows('<html>x</html>')))?.kind === 'blocked');
    const seasons = tv.parseChoices(fx('subtitulamostv/show_the_strain.html'), 'season-choices');
    const eps = tv.parseChoices(fx('subtitulamostv/show_the_strain.html'), 'episode-choices');
    check('season and episode choices', seasons.length === 1 && seasons[0].number === 4 && seasons[0].selected && eps.length >= 9 && eps[0].number === 1 && eps[0].href === '/episodes/61/the-strain-4x01-the-worm-turns');
    const vs = tv.parseVersions(fx('subtitulamostv/episode_the_strain_4x01.html'), `${base}/episodes/61/the-strain-4x01-the-worm-turns`);
    check('versions: language from the block, release text, download path', vs.length === 2 && vs[0].language === 'en' && vs[1].language === 'es' && vs[0].releaseName === 'AVS, AFG y SDI' && vs[0].path === '/subtitles/144/download', JSON.stringify(vs));
    check('site language labels map to our codes', tv.siteLanguage('Español (Latinoamérica)') === 'es-419' && tv.siteLanguage('Brazilian') === 'pt-BR' && tv.siteLanguage('Català') === 'ca' && tv.siteLanguage('Klingon') === null);
    const only = tv.candidatesFor(vs, ['es']);
    check('candidates keep the asked languages', only.length === 1 && only[0].language === 'es' && only[0].format === 'srt' && tv.candidatesFor(vs, ['es', 'en']).length === 2);
    check('an unavailable download is skipped', tv.parseVersions(fx('subtitulamostv/episode_the_strain_4x01.html').replace(/class="download-button /g, 'class="download-button unavailable '), `${base}/e`).length === 0);

    const q = { fileName: 'The.Strain.S04E01.mkv', videoBytes: 1, title: 'The Strain', episodeConfidence: 'sure', season: 4, episode: 1, languages: ['en', 'es'] };
    globalThis.fetch = fakeFetch({
      [`${base}/search/query?q=The%20Strain`]: { body: fx('subtitulamostv/search_the_strain.json'), type: 'application/json' },
      [`${base}/shows/11`]: fx('subtitulamostv/show_the_strain.html'),
      [`${base}/episodes/61/the-strain-4x01-the-worm-turns`]: fx('subtitulamostv/episode_the_strain_4x01.html'),
      [`${base}/subtitles/144/download`]: { body: bytes('subclub/download.srt'), type: 'text/srt;charset=UTF-8' },
    });
    const found = await tv.subtitulamostv.search(q, ctx(base));
    check('search() walks search, show, episode', found.length === 2 && found[0].id === '/subtitles/144/download');
    const dl = await tv.subtitulamostv.download(found[0], ctx(base));
    check('download() gives subtitle text', dl.kind === 'text' && dl.format === 'srt');
    check('a movie-like query is not searched (episodes only)', (await tv.subtitulamostv.search({ ...q, episodeConfidence: 'none' }, ctx(base))).length === 0);
    globalThis.fetch = realFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
