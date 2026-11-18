#!/usr/bin/env node
// Subtitle sources, batch 2 (docs/NATIVE_CONTRACT.md 36.3, 36.12): subf2m, yifysubtitles, subtitlecat, moviesubtitles,
// tvsubtitles. Each source's parse functions run on saved real responses (scripts/fixtures/subtitles/<id>/), and
// search and download run end to end against a fake fetch that serves those files. No network.
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
const FX = path.join(__dirname, 'fixtures', 'subtitles');
const text = (id, f) => fs.readFileSync(path.join(FX, id, f), 'utf8');
const buf = (id, f) => new Uint8Array(fs.readFileSync(path.join(FX, id, f)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Replaces fetch: `routes` is [matcher, () => {status, body, type}] checked in order; every request is logged. */
function fakeFetch(routes) {
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    log.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    for (const [match, make] of routes) {
      if (match(u, init)) {
        const r = make();
        const body = r.body;
        const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
        return {
          status: r.status ?? 200,
          ok: (r.status ?? 200) < 400,
          headers: { get: (n) => (n.toLowerCase() === 'content-type' ? r.type ?? 'text/html' : null) },
          text: async () => bytes.toString('utf8'),
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        };
      }
    }
    throw new Error(`unexpected request ${u}`);
  };
  return log;
}
const ctxFor = (baseUrl) => ({ signal: new AbortController().signal, baseUrl });
const movieQ = (over = {}) => ({ fileName: 'Inception.2010.1080p.BluRay.x264-GRP.mkv', videoBytes: 1e9, title: 'Inception', year: 2010, episodeConfidence: 'none', languages: ['en'], ...over });
const epQ = (over = {}) => ({ fileName: 'Breaking.Bad.S05E16.720p.HDTV.mkv', videoBytes: 1e9, title: 'Breaking Bad', season: 5, episode: 16, episodeConfidence: 'sure', languages: ['en', 'pt-BR'], ...over });

(async () => {
  const reg = await import('../utils/subtitles/providers/index.ts');
  const common = await import('../utils/subtitles/http.ts');
  const match = await import('../utils/subtitles/match.ts');
  const yify = await import('../utils/subtitles/providers/yifysubtitles.ts');
  const cat = await import('../utils/subtitles/providers/subtitlecat.ts');
  const ms = await import('../utils/subtitles/providers/moviesubtitles.ts');
  const tv = await import('../utils/subtitles/providers/tvsubtitles.ts');
  const f2m = await import('../utils/subtitles/providers/subf2m.ts');
  const { BATCH_2 } = await import('../utils/subtitles/providers/batch2.ts');
  const { ProviderError } = await import('../utils/search/http.ts');

  // ------------------------------------------------------------------ declarations
  console.log('[batch 2 declarations]');
  const ids = BATCH_2.map((p) => p.id);
  check('five sources, ids unique and in the registry', ids.length === 5 && new Set(ids).size === 5 && ids.every((id) => reg.SUBTITLE_PROVIDERS.some((p) => p.id === id)), ids.join(','));
  for (const p of BATCH_2) {
    check(`${p.id}: group, https mirrors, kinds, matches declared`, p.group === 'B' && p.mirrors.length > 0 && p.mirrors.every((m) => /^https:\/\//.test(m)) && p.kinds.length > 0 && p.matches.length > 0 && !p.matches.includes('hash'));
    check(`${p.id}: languages are 'many' or ISO codes`, p.languages === 'many' || p.languages.every((l) => /^[a-z]{2}(-[A-Za-z0-9]{2,3})?$/.test(l)));
  }
  check('only the broad reliable source is on by default', eq(BATCH_2.filter((p) => p.enabledByDefault).map((p) => p.id), ['subf2m']));

  // ------------------------------------------------------------------ helpers
  console.log('[batch 2 helpers]');
  check('tokens fold accents and punctuation', eq(match.tokens('Amélie, 2001!'), ['amelie', '2001']));
  check('hasEpisode reads S05E16 and 5x16', match.hasEpisode('Show.S05E16.720p', 5, 16) && match.hasEpisode('Show 5x16', 5, 16) && !match.hasEpisode('Show.S05E15', 5, 16));
  check('isSeasonPack: complete season yes, a single episode no', match.isSeasonPack('Show Complete Season 5', 5) && match.isSeasonPack('Show.S05.720p', 5) && !match.isSeasonPack('Show.S05E01.720p', 5));
  check('safePath encodes spaces and brackets, keeps %XX', match.safePath('/files/A B[1].zip') === '/files/A%20B%5B1%5D.zip' && match.safePath('/a%20b') === '/a%20b');
  check('toPayload: zip stays a zip', common.toPayload(buf('yifysubtitles', 'download_inception-2010-english-yify-392136.zip')).kind === 'zip');
  const srtP = common.toPayload(new Uint8Array(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n')));
  check('toPayload: plain text is typed srt', srtP.kind === 'text' && srtP.format === 'srt');
  const rar = new Uint8Array(Buffer.from('Rar!\x1a\x07\x00abc', 'latin1'));
  let rarErr;
  try {
    common.toPayload(rar);
  } catch (e) {
    rarErr = e;
  }
  check('toPayload: RAR is refused in plain words', rarErr instanceof ProviderError && /file type isn't supported/.test(rarErr.message));

  // ------------------------------------------------------------------ yifysubtitles
  console.log('[yifysubtitles]');
  const yRows = yify.parseMovieRows(text('yifysubtitles', 'movie-imdb_tt1375666.html'));
  check('rows parsed, language codes normalised', yRows.length >= 12 && yRows.every((r) => /^[a-z]{2}(-[A-Z]{2})?$/.test(r.language) && r.releaseName && r.path.startsWith('/subtitles/')), String(yRows.length));
  check('Brazilian Portuguese is pt-BR, Chinese BG code is zh-CN, Big 5 is zh-TW', yRows.some((r) => r.language === 'pt-BR') && yRows.some((r) => r.language === 'zh-CN') && yRows.some((r) => r.language === 'zh-TW'));
  check('hearing impaired flag read from the row', yRows.some((r) => r.hearingImpaired) && yRows.some((r) => !r.hearingImpaired));
  check('first release line is the name, the "subtitle" tag is gone', yRows[0].releaseName === 'Inception.2010.720p.BrRip.x264.YIFY', yRows[0].releaseName);
  check('pickImdb: title and year', yify.pickImdb(JSON.parse(text('yifysubtitles', 'ajax-search_inception.json')), 'Inception', 2010) === 'tt1375666' && yify.pickImdb([{ movie: 'Inception 2010', imdb: 'tt1375666' }], 'Inception', 2011) === null);
  check('pickImdb: ignores junk', yify.pickImdb('nope', 'x') === null && yify.pickImdb([{ movie: 'X 2000', imdb: 'bad' }], 'X') === null);
  check('download link', yify.parseDownloadPath(text('yifysubtitles', 'subtitle-page_inception-2010-english-yify-392136.html')) === '/subtitle/inception-2010-english-yify-392136.zip');
  {
    const log = fakeFetch([
      [(u) => u.includes('/ajax/search/'), () => ({ body: text('yifysubtitles', 'ajax-search_inception.json'), type: 'application/json' })],
      [(u) => u.endsWith('/movie-imdb/tt1375666'), () => ({ body: text('yifysubtitles', 'movie-imdb_tt1375666.html') })],
      [(u) => u.endsWith('/subtitles/inception-2010-arabic-yify-392064'), () => ({ body: text('yifysubtitles', 'subtitle-page_inception-2010-english-yify-392136.html') })],
      [(u) => u.endsWith('.zip'), () => ({ body: buf('yifysubtitles', 'download_inception-2010-english-yify-392136.zip'), type: 'application/zip' })],
    ]);
    const c = ctxFor('https://yifysubtitles.ch');
    const found = await yify.yifysubtitles.search(movieQ({ languages: ['ar', 'pt-BR'] }), c);
    check('search: only the asked languages', found.length > 0 && found.every((x) => x.language === 'ar' || x.language === 'pt'|| x.language === 'pt-BR') && found.some((x) => x.language === 'ar'), found.map((x) => x.language).join(','));
    check('search: candidate fields', found.every((x) => x.providerId === 'yifysubtitles' && x.matchedBy === 'title' && x.id.startsWith('/subtitles/')));
    check('search: an episode query makes no request', (await yify.yifysubtitles.search(epQ(), c)).length === 0 && log.length === 2);
    const arabic = found.find((x) => x.id.endsWith('392064'));
    const p = await yify.yifysubtitles.download(arabic, c);
    check('download: zip, with the subtitle page as referer', p.kind === 'zip' && log.filter((l) => l.url.endsWith('.zip'))[0].headers.Referer === 'https://yifysubtitles.ch/subtitles/inception-2010-arabic-yify-392064');
    fakeFetch([[() => true, () => ({ status: 403, body: '<!DOCTYPE html><html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x.js"></script></html>' })]]);
    let err;
    try {
      await yify.yifysubtitles.download(arabic, c);
    } catch (e) {
      err = e;
    }
    check('a bot check answers challenge or blocked', err instanceof ProviderError && (err.kind === 'challenge' || err.kind === 'blocked'), err && err.kind);
  }

  // ------------------------------------------------------------------ subtitlecat
  console.log('[subtitlecat]');
  const catList = cat.parseSearch(text('subtitlecat', 'search_Inception-2010.html'));
  check('search rows', catList.length === 8 && catList[0].path === '/subs/1655/Inception.2010.1080p.BrRip.x264.html' && catList[0].title === 'Inception.2010.1080p.BrRip.x264' && catList[0].downloads === 17, JSON.stringify(catList[0]));
  const catDetail = cat.parseDetail(text('subtitlecat', 'detail_Inception.2010.720p.BluRay.x264.5xRus.Eng-HiDt.en.html'));
  check('detail: only languages with a file, regional codes normalised', eq(catDetail.map((d) => d.language), ['ar', 'en', 'id', 'mk', 'pt-BR', 'es', 'es-419']), catDetail.map((d) => d.language).join(','));
  check('detail: the original is English, the rest are machine translations', catDetail.find((d) => d.language === 'en').original && !catDetail.find((d) => d.language === 'ar').original);
  check('detail: file path', catDetail[0].path === '/subs/1437/Inception.2010.720p.BluRay.x264.5xRus.Eng-HiDt.en-ar.srt', catDetail[0].path);
  check('queries: movie with year, then without; episode', eq(cat.queriesFor(movieQ()), ['Inception 2010', 'Inception']) && eq(cat.queriesFor(epQ()), ['Breaking Bad S05E16', 'Breaking Bad']));
  check('chooseReleases keeps releases with the title, at most 3', cat.chooseReleases(movieQ(), catList).length === 3 && cat.chooseReleases(movieQ({ title: 'Nothing Like It' }), catList).length === 0);
  check('chooseReleases for an episode needs the episode in the name', cat.chooseReleases(epQ(), [{ path: '/subs/1/a.html', title: 'Breaking Bad S05E15' }, { path: '/subs/2/b.html', title: 'Breaking Bad S05E16 720p' }]).length === 1);
  {
    const log = fakeFetch([
      [(u) => u.includes('index.php?search=Inception%202010'), () => ({ body: text('subtitlecat', 'search_Inception-2010.html') })],
      [(u) => /\/subs\/\d+\/[^/]+\.html$/.test(u), () => ({ body: text('subtitlecat', 'detail_Inception.2010.720p.BluRay.x264.5xRus.Eng-HiDt.en.html') })],
      [(u) => u.endsWith('.srt'), () => ({ body: text('subtitlecat', 'download_Inception-ar.srt'), type: 'application/octet-stream' })],
    ]);
    const c = ctxFor('https://www.subtitlecat.com');
    const found = await cat.subtitlecat.search(movieQ({ languages: ['en', 'ar'] }), c);
    check('search: asked languages from each page, machine translations marked', found.length === 6 && found.filter((x) => x.language === 'ar').every((x) => x.releaseName.endsWith('(machine translated)')) && found.filter((x) => x.language === 'en').every((x) => !x.releaseName.includes('machine')), found.length + ' ' + found.map((x) => x.language).join(','));
    check('search: one search page and three release pages', log.length === 4, String(log.length));
    const p = await cat.subtitlecat.download(found.find((x) => x.language === 'ar'), c);
    check('download: plain text typed as srt', p.kind === 'text' && p.format === 'srt' && p.bytes.length > 100);
  }

  // ------------------------------------------------------------------ moviesubtitles
  console.log('[moviesubtitles]');
  const msMovies = ms.parseSearch(text('moviesubtitles', 'search_Inception.html'));
  check('search: movie id, title and year', eq(msMovies, [{ id: '5012', title: 'Inception (2010)', year: 2010 }]), JSON.stringify(msMovies));
  const msRows = ms.parseMovie(text('moviesubtitles', 'movie-5012.html'));
  check('rows parsed with language and release name', msRows.length === 12 && msRows[0].id === '59143' && msRows[0].language === 'en' && msRows[0].releaseName === 'Inception 2010 (TS.IMAGiNE)', JSON.stringify(msRows[0]));
  check('downloads and parts read', msRows[0].downloads === 27708 && msRows[0].parts === 1 && msRows.some((r) => r.parts === 2));
  check('"portugese(br)" is pt-BR, the ad link is not a language', msRows.some((r) => r.language === 'pt-BR') && ms.labelLanguage('latest DivX/Xvid movies') === null);
  check('chooseMovies: exact title and year first', ms.chooseMovies(movieQ(), msMovies).length === 1 && ms.chooseMovies(movieQ({ year: 1999 }), msMovies).length === 0);
  {
    const log = fakeFetch([
      [(u, i) => u.endsWith('/search.php') && i.method === 'POST', () => ({ status: 500, body: text('moviesubtitles', 'search_Inception.html') })],
      [(u) => u.endsWith('/movie-5012.html'), () => ({ status: 500, body: text('moviesubtitles', 'movie-5012.html') })],
      [(u) => u.endsWith('/download-59143.html'), () => ({ body: buf('moviesubtitles', 'download_59143_Inception_2010.TS.IMAGiNE.en.zip'), type: 'application/zip' })],
    ]);
    const c = ctxFor('https://www.moviesubtitles.org');
    const found = await ms.moviesubtitles.search(movieQ({ languages: ['en', 'de'] }), c);
    check('search: HTTP 500 pages are read, multi-disc subtitles dropped', found.length === 2 && found.every((x) => x.language === 'en' || x.language === 'de') && !found.some((x) => msRows.find((r) => r.id === x.id).parts > 1), found.map((x) => x.id + x.language).join(','));
    check('search: the query is posted as a form', log[0].body === 'q=Inception', String(log[0].body));
    check('search: an episode query makes no request', (await ms.moviesubtitles.search(epQ(), c)).length === 0 && log.length === 2);
    const p = await ms.moviesubtitles.download(found[0], c);
    check('download: zip', p.kind === 'zip' && p.bytes.length > 1000);
  }

  // ------------------------------------------------------------------ tvsubtitles
  console.log('[tvsubtitles]');
  const tvShows = tv.parseShows(text('tvsubtitles', 'search2_breaking-bad.html'));
  check('search: show id, name and first year', tvShows.length >= 1 && tvShows[0].id === '133' && tvShows[0].title === 'Breaking Bad' && tvShows[0].year === 2008, JSON.stringify(tvShows[0]));
  check('pickShow: by name, with year, and refuses a different show', tv.pickShow(tvShows, 'Breaking Bad', 2008)?.id === '133' && tv.pickShow(tvShows, 'Breaking Bad', 1999) === null && tv.pickShow(tvShows, 'Better Call Saul') === null);
  check('pickShow: a (US) tag in the asked title still finds the show', tv.pickShow([{ id: '1', title: 'The Office (US)' }, { id: '2', title: 'The Office (UK)' }], 'The Office (UK)')?.id === '2' && tv.pickShow([{ id: '1', title: 'The Office' }], 'The Office (US)')?.id === '1');
  const tvEps = tv.parseEpisodes(text('tvsubtitles', 'tvshow-133-5.html'));
  check('season page: episode 16 is page 45458', tvEps.get(16) === '45458', JSON.stringify([...tvEps]));
  const tvRows = tv.parseEpisode(text('tvsubtitles', 'episode-45458.html'));
  check('episode page: rows with language and release name', tvRows.length >= 8 && tvRows[0].id === '248324' && tvRows[0].language === 'en' && tvRows[0].releaseName === 'Breaking Bad 5x16 (HDTV.IMMERSE)', JSON.stringify(tvRows[0]));
  check('episode page: downloads, and the br flag is pt-BR', tvRows[0].downloads === 59567 && tvRows.some((r) => r.language === 'pt-BR'));
  check('download page: the file path is rebuilt from the script pieces', tv.parseFilePath(text('tvsubtitles', 'download-248324.html')) === 'files/Breaking Bad_5x16_HDTV.IMMERSE.en.zip', tv.parseFilePath(text('tvsubtitles', 'download-248324.html')));
  {
    const log = fakeFetch([
      [(u, i) => u.endsWith('/search2.php') && i.method === 'POST', () => ({ body: text('tvsubtitles', 'search2_breaking-bad.html') })],
      [(u) => u.endsWith('/tvshow-133-5.html'), () => ({ body: text('tvsubtitles', 'tvshow-133-5.html') })],
      [(u) => u.endsWith('/episode-45458.html'), () => ({ body: text('tvsubtitles', 'episode-45458.html') })],
      [(u) => u.endsWith('/download-248324.html'), () => ({ body: text('tvsubtitles', 'download-248324.html') })],
      [(u) => u.includes('/files/Breaking%20Bad_5x16'), () => ({ body: buf('tvsubtitles', 'download_Breaking Bad_5x16_HDTV.IMMERSE.en.zip'), type: 'application/zip' })],
    ]);
    const c = ctxFor('https://www.tvsubtitles.net');
    const found = await tv.tvsubtitles.search(epQ(), c);
    check('search: asked languages only, three requests (search, season, episode)', found.length >= 2 && found.every((x) => x.language === 'en' || x.language === 'pt-BR' || x.language === 'pt') && found.some((x) => x.language === 'pt-BR') && log.length === 3, found.length + ' ' + log.length);
    check('search: a movie query makes no request', (await tv.tvsubtitles.search(movieQ(), c)).length === 0 && log.length === 3);
    const p = await tv.tvsubtitles.download(found.find((x) => x.id === '248324'), c);
    check('download: zip fetched from the rebuilt, encoded path', p.kind === 'zip');
    fakeFetch([
      [(u, i) => u.endsWith('/search2.php'), () => ({ body: text('tvsubtitles', 'search2_breaking-bad.html') })],
      [() => true, () => ({ status: 404, body: 'Not Found', type: 'text/html' })],
    ]);
    check('a season the show lacks is nothing found, not an error', (await tv.tvsubtitles.search(epQ({ season: 99 }), c)).length === 0);
  }

  // ------------------------------------------------------------------ subf2m
  console.log('[subf2m]');
  const f2Titles = f2m.parseSearch(text('subf2m', 'searchbytitle_Inception.html'));
  check('search: path, title, year', f2Titles.length >= 4 && f2Titles[0].path === '/subtitles/inception' && f2Titles[0].year === 2010, JSON.stringify(f2Titles[0]));
  check('chooseTitles: the 2010 film, not the sequels', eq(f2m.chooseTitles(movieQ(), f2Titles).map((t) => t.path), ['/subtitles/inception']));
  check('season words: Fifth Season, Season 2', f2m.seasonOfTitle('Breaking Bad - Fifth Season (2012)') === 5 && f2m.seasonOfTitle('Show - Season 2') === 2 && f2m.seasonOfTitle('Inception (2010)') === undefined);
  const f2Series = [
    { path: '/subtitles/breaking-bad-first-season', title: 'Breaking Bad - First Season', year: 2008, season: 1 },
    { path: '/subtitles/breaking-bad-fifth-season', title: 'Breaking Bad - Fifth Season', year: 2012, season: 5 },
    { path: '/subtitles/breaking-bad-the-movie', title: 'Breaking Bad The Movie', year: 2019, season: undefined },
  ];
  check('chooseTitles for an episode picks the wanted season', f2m.chooseTitles(epQ(), f2Series)[0].path === '/subtitles/breaking-bad-fifth-season' && !f2m.chooseTitles(epQ(), f2Series).some((t) => t.path.endsWith('first-season')));
  const f2Rows = f2m.parseLanguagePage(text('subf2m', 'language_inception_english.html'));
  check('language page: rows with id, path and release', f2Rows.length === 7 && f2Rows[0].id === '3703203' && f2Rows[0].path === '/subtitles/inception/english/3703203' && f2Rows[0].releaseName === 'Inception.2010.x264 YIFY', JSON.stringify(f2Rows[0]));
  check('language page: HI marker in the release name', f2Rows.filter((r) => r.hearingImpaired).length === 1 && f2Rows.find((r) => r.hearingImpaired).releaseName.endsWith('HI'));
  check('episode filter: exact episode and season packs only', f2m.rowFitsEpisode({ allNames: 'Show.S05E16.720p' }, 5, 16) && !f2m.rowFitsEpisode({ allNames: 'Show.S05E15.720p' }, 5, 16) && f2m.rowFitsEpisode({ allNames: 'Show Complete Season 5' }, 5, 16));
  check('download button', f2m.parseDownloadPath(text('subf2m', 'subtitle-page_inception_english_3703203.html')) === '/subtitles/inception/english/3703203/download');
  check('language folders: user order, regional codes, at most 3', eq(f2m.languageFolders(['pt-BR', 'es-419', 'xx', 'de', 'fr']), ['brazillian-portuguese', 'spanish', 'german']));
  {
    const log = fakeFetch([
      [(u) => u.includes('/subtitles/searchbytitle'), () => ({ body: text('subf2m', 'searchbytitle_Inception.html') })],
      [(u) => u.endsWith('/subtitles/inception/english'), () => ({ body: text('subf2m', 'language_inception_english.html') })],
      [(u) => u.endsWith('/subtitles/inception/german'), () => ({ status: 404, body: 'Not found' })],
      [(u) => u.endsWith('/subtitles/inception/english/3703203'), () => ({ body: text('subf2m', 'subtitle-page_inception_english_3703203.html') })],
      [(u) => u.endsWith('/download'), () => ({ body: buf('subf2m', 'download_inception-english-1809.zip'), type: 'application/zip' })],
    ]);
    const c = ctxFor('https://subf2m.co');
    const found = await f2m.subf2m.search(movieQ({ languages: ['en', 'de'] }), c);
    check('search: English rows, a missing German page is not an error', found.length === 7 && found.every((x) => x.language === 'en' && x.matchedBy === 'title'), String(found.length));
    check('search: HI flag on the candidate', found.some((x) => x.hearingImpaired === true));
    const p = await f2m.subf2m.download(found[0], c);
    check('download: page, then the zip with the page as referer', p.kind === 'zip' && log[log.length - 1].headers.Referer === 'https://subf2m.co/subtitles/inception/english/3703203');
    fakeFetch([[() => true, () => ({ status: 429, body: 'slow down' })]]);
    let err;
    try {
      await f2m.subf2m.search(movieQ(), c);
    } catch (e) {
      err = e;
    }
    check('a 429 is a limit', err instanceof ProviderError && err.kind === 'http' && err.status === 429);
  }

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll batch 2 subtitle checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
