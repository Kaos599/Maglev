#!/usr/bin/env node
// Tests for the batch 4 subtitle sources (SuperSubtitles, Titrari.ro, Subtitrari Noi, Subsunacs). No network: the
// fixtures are recorded pages, see scripts/fixtures/subtitles/SOURCES_batch4.txt. Needs Node 22.18+ (runs the
// TypeScript sources directly via type stripping).

process.removeAllListeners('warning');

const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, 'fixtures', 'subtitles');
const raw = (n) => new Uint8Array(fs.readFileSync(path.join(FIX, n)));
const text = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');

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

const q = (o) => ({ fileName: 'Fight.Club.1999.1080p.BluRay.x264-SPARKS.mkv', videoBytes: 1e9, title: 'Fight Club', year: 1999, episodeConfidence: 'none', languages: ['en'], ...o });
const ep = (o) => q({ fileName: 'Breaking.Bad.S05E03.720p.HDTV.x264-DEMAND.mkv', title: 'Breaking Bad', year: undefined, season: 5, episode: 3, episodeConfidence: 'sure', ...o });

async function rejects(p) {
  try {
    await p;
  } catch (e) {
    return e;
  }
  return null;
}

/** Runs `fn` with a fake fetch; `answer(url, init)` returns [body, init] for a Response. Returns the calls too. */
async function withFetch(answer, fn) {
  const prev = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const [body, opts] = answer(String(url), init);
    return new Response(body, opts);
  };
  try {
    return { result: await fn(), calls };
  } finally {
    globalThis.fetch = prev;
  }
}

const ctx = (base) => ({ signal: new AbortController().signal, baseUrl: base });

async function main() {
  const ss = await import('../utils/subtitles/providers/supersubtitles.ts');
  const tr = await import('../utils/subtitles/providers/titrari.ts');
  const no = await import('../utils/subtitles/providers/subtitrarinoi.ts');
  const su = await import('../utils/subtitles/providers/subsunacs.ts');
  const b4 = await import('../utils/subtitles/providers/batch4.ts');
  const util = await import('../utils/subtitles/http.ts');
  const match = await import('../utils/subtitles/match.ts');
  const { isLanguageCode } = await import('../utils/subtitles/languages.ts');

  console.log('\n[1] shared helpers');
  {
    check('titles compare without case, accents, "The" or punctuation', match.sameTitleStrict('The Walking Dead', 'walking dead') && match.sameTitleStrict('Amélie', 'Amelie') && !match.sameTitleStrict('Fight Club', 'Zombie Fight Club'));
    check('"A / B" and "(aka B)" titles match either part', match.titleMatchesAlias('Female Fight Club', 'Female Fight Squad / Female Fight Club') && match.titleMatchesAlias('The Bad Guys: Breaking In', 'The Bad Guys: The Series (aka. The Bad Guys: Breaking In)'));
    const a = match.bestRelease({ fileName: 'Movie.2019.720p.NF.WEB-DL.DDP5.1.x264-NTG.mkv' }, 'Movie 2020 1080p BluRay x264-CMRG ( NOU! ); Movie.2019.720p.NF.WEB-DL.DDP5.1.x264-NTG; Movie.2019.HDRip.XviD-EVO si Movie.2019.WEB.X264-AMRAP.');
    check('bestRelease picks the listed release closest to the file', a.name === 'Movie.2019.720p.NF.WEB-DL.DDP5.1.x264-NTG' && a.matchedBy === 'release', JSON.stringify(a));
    const far = match.bestRelease({ fileName: 'Other.Thing.mkv' }, 'Movie.2019.720p.NF.WEB-DL-NTG; Movie.2019.HDRip.XviD-EVO');
    check('bestRelease falls back to the first release, matched by title', far.name === 'Movie.2019.720p.NF.WEB-DL-NTG' && far.matchedBy === 'title');
    check('dates', match.parseDate('2026-06-03') === Date.UTC(2026, 5, 3) && match.parseDate('26.11.2009г. 19:42') === Date.UTC(2009, 10, 26) && match.parseDate('x') === undefined);
  }

  console.log('\n[2] SuperSubtitles (feliratok.eu)');
  {
    const rows = ss.parseRows(text('supersubtitles/movie_search.html'));
    check('movie page: eight rows with id, language, title and year', rows.length === 8 && rows.every((r) => r.id && (r.language === 'hu' || r.language === 'en') && r.title === 'Fight Club' && r.year === 1999), `got ${rows.length}`);
    check('file name and date are read', rows[0].fileName === 'Fight Club (1999) (1080p BluRay x265 Celdra).hun.srt' && rows[0].uploadedAt === Date.UTC(2026, 5, 3));
    const c = ss.toCandidates(rows, q({ languages: ['en'] }));
    check('English only: the English rows', c.length > 0 && c.every((x) => x.language === 'en' && x.providerId === 'supersubtitles') && c.length === rows.filter((r) => r.language === 'en').length, `got ${c.length}`);
    check('release name is the uploaded file without language and extension', c.some((x) => x.releaseName === 'Fight.Club.1999.NF.WEB-DL'), c.map((x) => x.releaseName).join(' | '));
    check('a plain .srt is known to be srt, no hash match is claimed', c.every((x) => x.format === 'srt' && x.matchedBy !== 'hash'));
    check('both languages when both are asked (the .rar row is dropped at search time)', ss.toCandidates(rows, q({ languages: ['hu', 'en'] })).length === 7 && rows.length === 8);
    check('another year gives nothing', ss.toCandidates(rows, q({ year: 2001 })).length === 0);
    check('another title gives nothing', ss.toCandidates(rows, q({ title: 'Fight' })).length === 0);

    const tv = ss.parseRows(text('supersubtitles/series_search.html'));
    check('series page: season packs and single episodes are told apart', tv.some((r) => r.pack && r.season === 5 && r.title === 'Breaking Bad') && tv.some((r) => !r.pack && r.season === 3 && r.episode === 3 && r.title === 'Grimsburg'));
    const bb = ss.toCandidates(tv, ep({ languages: ['hu'] }));
    check('episode: the season 5 packs in Hungarian, no other season, no other show', bb.length > 0 && bb.some((x) => x.id === '1574804843') && bb.every((x) => x.language === 'hu' && tv.find((r) => r.id === x.id).season === 5 && tv.find((r) => r.id === x.id).title === 'Breaking Bad'), JSON.stringify(bb.map((x) => x.id)));
    check('a pack candidate has no format yet (it is a zip)', bb.every((x) => x.format === undefined));
    check('another episode number of a single-episode row is skipped', ss.toCandidates(tv, ep({ title: 'Grimsburg', season: 3, episode: 4, languages: ['en'] })).length === 0 && ss.toCandidates(tv, ep({ title: 'Grimsburg', season: 3, episode: 3, languages: ['en'] })).length === 1);
    check('search url: movie tab, or series tab when the season is sure', /tab=film$/.test(ss.searchUrl('https://feliratok.eu', q({}))) && /search=Breaking\+Bad&.*tab=sorozat$/.test(ss.searchUrl('https://feliratok.eu/', ep({}))));
    check('rar and 7z rows are dropped at search time', ss.toCandidates([{ id: '1', language: 'en', title: 'Fight Club', year: 1999, pack: false, releases: '', fileName: 'x.en.rar' }], q({})).length === 0);

    const bad = await rejects((async () => ss.parseRows('plain'))());
    check('a page that is not HTML is a parse error', bad && bad.kind === 'parse');

    const srt = util.toPayload(raw('supersubtitles/download_movie.srt'), { language: 'hu', nameHint: 'x.srt', requireCues: true });
    check('download: BOM text is passed on as text/srt', srt.kind === 'text' && srt.format === 'srt' && srt.bytes.length === 2500);
    const zip = util.toPayload(raw('supersubtitles/download_pack_head.zip'), { language: 'hu', requireCues: true });
    check('download: a pack is a zip payload', zip.kind === 'zip');

    // search end to end
    const run = await withFetch(
      () => [text('supersubtitles/movie_search.html'), { status: 200, headers: { 'content-type': 'text/html' } }],
      () => ss.supersubtitles.search(q({ languages: ['en'] }), ctx('https://feliratok.eu')),
    );
    check('search(): one request, to the movie tab, with the generic User-Agent and no cookies', run.calls.length === 1 && /index\.php\?search=Fight\+Club.*tab=film/.test(run.calls[0].url) && /^Maglev\//.test(run.calls[0].init.headers['User-Agent']) && run.calls[0].init.credentials === 'omit');
    check('search(): returns the English candidates', run.result.length === 3, `got ${run.result.length}`);
    const none = await withFetch(() => ['', { status: 200 }], () => ss.supersubtitles.search(q({ languages: ['fr'] }), ctx('https://feliratok.eu')));
    check('search(): a language the site lacks makes no request', none.calls.length === 0 && none.result.length === 0);
    const dl = await withFetch(
      () => [raw('supersubtitles/download_movie.srt'), { status: 200, headers: { 'content-type': 'application/text' } }],
      () => ss.supersubtitles.download(c[0], ctx('https://feliratok.eu')),
    );
    check('download(): asks for the file by id with a Referer', dl.calls.length === 1 && dl.calls[0].url === `https://feliratok.eu/index.php?action=letolt&felirat=${c[0].id}` && /feliratok\.eu/.test(dl.calls[0].init.headers.Referer) && dl.result.kind === 'text');
    const lim = await withFetch(() => ['slow down', { status: 429 }], () => rejects(ss.supersubtitles.download(c[0], ctx('https://feliratok.eu'))));
    check('429 is an http error with status 429 (the limit message)', lim.result && lim.result.kind === 'http' && lim.result.status === 429);
    const cf = await withFetch(() => ['<!doctype html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x"></script>', { status: 403, headers: { server: 'cloudflare', 'content-type': 'text/html' } }], () => rejects(ss.supersubtitles.search(q({}), ctx('https://feliratok.eu'))));
    check('a Cloudflare check is a challenge', cf.result && cf.result.kind === 'challenge');
  }

  console.log('\n[3] Titrari.ro');
  {
    const rows = tr.parseRows(text('titrari/movie_search_ro.html'));
    check('movie page: rows with id, language ro, title and year', rows.length === 7 && rows.every((r) => /^\d+$/.test(r.id) && r.language === 'ro') && rows[0].title === 'Fight Club' && rows[0].year === 1999, `got ${rows.length}`);
    check('downloads and date are read', rows[0].downloads === 105 && rows[0].uploadedAt === Date.UTC(2025, 5, 23));
    const c = tr.toCandidates(rows, q({ languages: ['ro'] }));
    check('only the film asked for (not "Zombie Fight Club")', c.length > 0 && c.every((x) => rows.find((r) => r.id === x.id).title === 'Fight Club'), String(c.length));
    check('candidate carries downloads, language and no hash match', c.every((x) => x.language === 'ro' && x.downloads > 0 && x.matchedBy !== 'hash'));
    const long = c.find((x) => x.id === '92340');
    check('a comment that lists many releases gives the closest one as the release name', long && long.releaseName === 'Fight.Club.1999.REMASTERED.1080p.BluRay.x265-RARBG' && long.matchedBy === 'release', long && long.releaseName);

    const en = tr.parseRows(text('titrari/series_search_en.html'));
    check('series page (English): season and episode come from the title or the comment', en.find((r) => r.id === '63144').season === 2 && en.find((r) => r.id === '63144').episode === 12 && en.find((r) => r.id === '60778').episode === 1);
    check('episode asked: only that episode', tr.toCandidates(en, ep({ title: 'Breaking Bad', season: 2, episode: 12, languages: ['en'] })).map((x) => x.id).join() === '63144');
    check('another season gives nothing', tr.toCandidates(en, ep({ title: 'Breaking Bad', season: 4, episode: 1, languages: ['en'] })).length === 0);
    const roSeries = tr.parseRows(text('titrari/series_search_ro.html'));
    check('"- Sezonul 1" is read as season 1 of the show', roSeries[0].title === 'Jurassic Fight Club' && roSeries[0].season === 1);
    check('a season pack fits any episode of that season', tr.toCandidates(roSeries, ep({ title: 'Jurassic Fight Club', season: 1, episode: 7, languages: ['ro'] })).length === 1);
    check('a film search does not return season rows', tr.toCandidates(roSeries, q({ title: 'Jurassic Fight Club' })).length === 0);
    check('wanted site languages: known ones only, in order, no duplicates', tr.wantedSiteIds(q({ languages: ['ro', 'xx', 'en', 'ro'] })).join() === '1,2' && tr.wantedSiteIds(q({ languages: ['ja'] })).length === 0);
    check('search url', tr.searchUrl('https://www.titrari.ro/', 'fight club', '1') === 'https://www.titrari.ro/index.php?page=cautare&z1=0&z2=fight+club&z3=1&z4=1');

    const rarErr = await rejects((async () => util.toPayload(raw('titrari/download_rar_head.rar'), { language: 'ro', requireCues: true }))());
    check('download: RAR is "file type isn\'t supported"', rarErr && rarErr.kind === 'parse' && /file type isn't supported/.test(rarErr.message));
    check('download: zip is a zip payload', util.toPayload(raw('titrari/download_zip_head.zip'), { language: 'ro', requireCues: true }).kind === 'zip');
    const t = util.toPayload(raw('titrari/download_text_cp1252.srt'), { language: 'ro', requireCues: true });
    check('download: single-byte Romanian text is passed on as it is, format srt', t.kind === 'text' && t.format === 'srt' && t.bytes.length === 2500);

    const run = await withFetch(
      (url) => [text('titrari/movie_search_ro.html'), { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } }],
      () => tr.titrari.search(q({ languages: ['ro', 'en'] }), ctx('https://www.titrari.ro')),
    );
    check('search(): one request per wanted language, z3 set', run.calls.length === 2 && /z3=1&/.test(run.calls[0].url) && /z3=2&/.test(run.calls[1].url));
    check('search(): keeps rows of the language each request asked for', run.result.every((x) => x.language === 'ro') && run.result.length > 0);
    const dl = await withFetch(() => [raw('titrari/download_zip_head.zip'), { status: 200 }], () => tr.titrari.download(c[0], ctx('https://www.titrari.ro')));
    check('download(): get.php with the site as Referer', dl.calls[0].url === `https://www.titrari.ro/get.php?id=${c[0].id}` && dl.calls[0].init.headers.Referer === 'https://www.titrari.ro/' && dl.result.kind === 'zip');
  }

  console.log('\n[4] Subtitrari Noi');
  {
    const rows = no.parseRows(text('subtitrarinoi/movie_search.html'));
    check('film answer: four rows with download link, title and year', rows.length === 4 && rows[0].title === 'Fight club' && rows[0].year === 1999 && /^16083-/.test(rows[0].href), `got ${rows.length}`);
    check('"NOU!" tags are removed from comments', rows.every((r) => !/NOU!/.test(r.comment)));
    check('downloads and date', rows[0].downloads === 4586 && rows[0].uploadedAt === Date.UTC(2011, 7, 10));
    const c = no.toCandidates(rows, q({ languages: ['ro'] }));
    check('title and year filter: only Fight Club (1999)', c.length === 1 && c[0].id === rows[0].href && c[0].language === 'ro', JSON.stringify(c.map((x) => x.id)));
    check('"A / B" titles match the second name', no.toCandidates(rows, q({ title: 'Female Fight Club', year: 2016, languages: ['ro'] })).length === 1);
    check('Romanian not asked: nothing', no.toCandidates(rows, q({ languages: ['en'] })).length === 0);
    const tv = no.parseRows(text('subtitrarinoi/series_search.html'));
    check('series answer: a pack of seasons 1-5 fits season 2 episode 3', no.toCandidates(tv, ep({ season: 2, episode: 3, languages: ['ro'] })).length === 1);
    check('season 6 is not in that pack', no.toCandidates(tv, ep({ season: 6, episode: 1, languages: ['ro'] })).length === 0);
    check('the film El Camino is not Breaking Bad', no.toCandidates(tv, ep({ languages: ['ro'] })).every((x) => /Arhive/.test(x.id)));
    check('request body', no.searchBody('fight club') === 'search_q=1&tip=2&an=Toti+anii&gen=Toate&cautare=fight+club&query_q=fight+club');
    check('download url keeps the site\'s odd "id-https://..." form under the site', no.downloadUrl('https://www.subtitrari-noi.ro/', rows[0].href) === `https://www.subtitrari-noi.ro/${rows[0].href}`);

    const direct = await rejects((async () => no.parseRows('<link rel="stylesheet" href="css/table.css">\nAcces direct interzis.'))());
    check('the "direct access refused" answer is a parse error', direct && direct.kind === 'parse');
    const gone = await rejects((async () => util.toPayload(raw('subtitrarinoi/download_unavailable.txt'), { language: 'ro', requireCues: true }))());
    check('download: the "not available" message is a failure, not a subtitle', gone && gone.kind === 'parse');
    check('download: zip', util.toPayload(raw('subtitrarinoi/download_zip_head.zip'), { language: 'ro', requireCues: true }).kind === 'zip');

    const run = await withFetch(() => [text('subtitrarinoi/movie_search.html'), { status: 200, headers: { 'content-type': 'text/html' } }], () => no.subtitrarinoi.search(q({ languages: ['ro'] }), ctx('https://www.subtitrari-noi.ro')));
    const call = run.calls[0];
    check('search(): POST with X-Requested-With, form body and no cookies', run.calls.length === 1 && call.init.method === 'POST' && call.init.headers['X-Requested-With'] === 'XMLHttpRequest' && /cautare=Fight\+Club/.test(call.init.body) && call.init.credentials === 'omit', JSON.stringify(call.init.headers));
    check('search(): returns the Fight Club candidate', run.result.length === 1);
    const skip = await withFetch(() => ['', { status: 200 }], () => no.subtitrarinoi.search(q({ languages: ['en'] }), ctx('https://www.subtitrari-noi.ro')));
    check('search(): no request when Romanian is not asked', skip.calls.length === 0);
  }

  console.log('\n[5] Subsunacs');
  {
    const bg = su.parseRows(su.decodePage(raw('subsunacs/movie_search_bg.html')));
    check('Bulgarian film page: rows with path, title and year', bg.length === 13 && bg[0].path === '/subtitles/Fight_Club-55064/' && bg[0].title === 'Fight Club' && bg[0].year === 1999 && bg.every((r) => r.language === 'bg'), `got ${bg.length}`);
    check('windows-1251 text is decoded (Cyrillic in the uploader note)', bg.some((r) => /субтитри/.test(r.info)));
    check('info, format, downloads and date are read', bg[0].info === 'Fight.Club.1999.720p.BluRay.DTS.x264-HiDt' && bg[0].format === 'SRT' && bg[0].downloads === 5827 && bg[0].uploadedAt === Date.UTC(2009, 10, 26));
    const c = su.toCandidates(bg, q({ languages: ['bg'] }));
    check('SUB (MicroDVD) rows are dropped', bg.some((r) => r.format === 'SUB') && c.every((x) => bg.find((r) => r.path === x.id).format !== 'SUB') && c.length === bg.filter((r) => r.format !== 'SUB' && r.title === 'Fight Club' && r.year === 1999).length, String(c.length));
    check('a file name close to the release is a release match, srt is known', c[0].id === '/subtitles/Fight_Club-55064/' && c[0].matchedBy === 'release' && c[0].format === 'srt', JSON.stringify(c[0]));
    const en = su.parseRows(su.decodePage(raw('subsunacs/movie_search_en.html')));
    check('English page: the "English" label sets the language', en.length === 1 && en[0].language === 'en' && en[0].title === 'Zombie Fight Club');
    check('the other title is not "Fight Club"', su.toCandidates(en, q({ languages: ['en'] })).length === 0 && su.toCandidates(en, q({ title: 'Zombie Fight Club', year: 2014, languages: ['en'] })).length === 1);
    const tv = su.parseRows(su.decodePage(raw('subsunacs/series_search_bg.html')));
    check('series rows carry season and episode from "Show - 05x01"', tv.length === 2 && tv.every((r) => r.title === 'Breaking Bad' && r.season === 5 && r.episode === 1));
    check('episode asked: same season and episode only', su.toCandidates(tv, ep({ season: 5, episode: 1, languages: ['bg'] })).length === 2 && su.toCandidates(tv, ep({ season: 5, episode: 2, languages: ['bg'] })).length === 0);
    check('search words: padded "Title 05 01" for an episode, the title for a film', su.searchWords(ep({ season: 5, episode: 3 })) === 'Breaking Bad 05 03' && su.searchWords(q({})) === 'Fight Club');
    check('search body is the site form with the Cyrillic button label', /^m=fight\+club&l=0&c=&y=1999&action=\+\+\+%D0%A2%D1%8A%D1%80%D1%81%D0%B8\+\+\+&/.test(su.searchBody('fight club', 0, 1999)));

    const entries = su.parseEntries(su.decodePage(raw('subsunacs/detail_page.html')));
    check('download page: the subtitle file is listed, the site\'s .txt note is not', entries.length === 1 && entries[0].name === 'Fight.Club.1999.720p.BluRay.DTS.x264-HiDt.srt' && entries[0].url === '/getentry.php?id=55064&ei=0', JSON.stringify(entries));
    check('pickEntry takes the closest name', su.pickEntry([{ name: 'a.1080p.srt', url: '1' }, { name: 'Fight.Club.1999.720p.BluRay.DTS.x264-HiDt.srt', url: '2' }], 'Fight.Club.1999.720p.BluRay.DTS.x264-HiDt').url === '2');

    // download end to end: the page first, then the file
    const run = await withFetch(
      (url) => (/getentry/.test(url) ? [raw('subsunacs/download_entry.srt'), { status: 200, headers: { 'content-type': 'application/octet-stream' } }] : [raw('subsunacs/detail_page.html'), { status: 200, headers: { 'content-type': 'text/html' } }]),
      () => su.subsunacs.download(c[0], ctx('https://subsunacs.net')),
    );
    check('download(): reads the page, then the listed file', run.calls.length === 2 && run.calls[0].url === 'https://subsunacs.net/subtitles/Fight_Club-55064/!' && run.calls[1].url === 'https://subsunacs.net/getentry.php?id=55064&ei=0', run.calls.map((x) => x.url).join(' '));
    check('download(): the file is srt text', run.result.kind === 'text' && run.result.format === 'srt');
    const empty = await withFetch(() => ['<html><body>no files</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }], () => rejects(su.subsunacs.download(c[0], ctx('https://subsunacs.net'))));
    check('download(): a page with no subtitle file is "file type isn\'t supported"', empty.result && empty.result.kind === 'parse' && /isn't supported/.test(empty.result.message));
    const s = await withFetch(() => ['<html><body></body></html>', { status: 200 }], () => su.subsunacs.search(q({ languages: ['en', 'bg'] }), ctx('https://subsunacs.net')));
    check('search(): one POST per wanted language (bg then en), no cookies', s.calls.length === 2 && s.calls.every((x) => x.init.method === 'POST' && x.init.credentials === 'omit') && /l=0&/.test(s.calls[0].init.body) && /l=1&/.test(s.calls[1].init.body), String(s.calls.length));
  }

  console.log('\n[6] registry entries');
  {
    check('batch 4 lists four unique ids', b4.BATCH_4.length === 4 && new Set(b4.BATCH_4.map((p) => p.id)).size === 4);
    check('every provider declares a group, https mirrors and a homepage', b4.BATCH_4.every((p) => (p.group === 'A' || p.group === 'B') && p.mirrors.length > 0 && p.mirrors.every((m) => /^https:\/\//.test(m)) && /^https:\/\//.test(p.homepage)));
    check('languages are valid codes', b4.BATCH_4.every((p) => p.languages === 'many' || p.languages.every(isLanguageCode)));
    check('regional page scrapers are off by default', b4.BATCH_4.every((p) => p.enabledByDefault === false));
    check('none claims a hash match (the sites cannot match by fingerprint)', b4.BATCH_4.every((p) => !p.matches.includes('hash')));
    check('kinds are set', b4.BATCH_4.every((p) => p.kinds.length > 0));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
