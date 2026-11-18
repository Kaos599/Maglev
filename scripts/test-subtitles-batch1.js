#!/usr/bin/env node
// Subtitle sources, batch 1 (docs/NATIVE_CONTRACT.md section 36.12): gestdown, napisy24, regielive, subtis, vladoon.
// Parse functions run on recorded responses, see scripts/fixtures/subtitles/<id>/SOURCES.txt. No network.
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
const FIX = path.join(__dirname, 'fixtures', 'subtitles');
const raw = (id, n) => fs.readFileSync(path.join(FIX, id, n));
const txt = (id, n) => raw(id, n).toString('utf8');
const u8 = (b) => new Uint8Array(b);
const q = (over = {}) => ({ fileName: 'Film.2010.1080p.BluRay.x264-GRP.mkv', videoBytes: 1500000000, title: 'Film', episodeConfidence: 'none', languages: ['en'], ...over });

async function rejects(fn, kind, status) {
  try {
    await fn();
    return false;
  } catch (e) {
    return e && e.name === 'ProviderError' && e.kind === kind && (status === undefined || e.status === status);
  }
}

(async () => {
  const { BATCH_1 } = await import('../utils/subtitles/providers/batch1.ts');
  const reg = await import('../utils/subtitles/providers/index.ts');
  const pay = await import('../utils/subtitles/payload.ts');
  const H = await import('../utils/subtitles/http.ts');
  const M = await import('../utils/subtitles/match.ts');
  const gd = await import('../utils/subtitles/providers/gestdown.ts');
  const n24 = await import('../utils/subtitles/providers/napisy24.ts');
  const rl = await import('../utils/subtitles/providers/regielive.ts');
  const st = await import('../utils/subtitles/providers/subtis.ts');
  const vl = await import('../utils/subtitles/providers/vladoon.ts');
  const LANG = await import('../utils/subtitles/languages.ts');

  console.log('registry');
  const ids = BATCH_1.map((p) => p.id);
  check('batch 1 ids are unique and in the registry', new Set(ids).size === ids.length && ids.every((i) => reg.SUBTITLE_PROVIDERS.some((p) => p.id === i)), ids.join(','));
  for (const p of BATCH_1) {
    check(`${p.id}: declares group, https mirrors, kinds, matches and a function pair`,
      (p.group === 'A' || p.group === 'B') && p.mirrors.length > 0 && p.mirrors.every((m) => /^https:\/\//.test(m)) && p.kinds.length > 0 && p.matches.length > 0 && typeof p.search === 'function' && typeof p.download === 'function' && typeof p.enabledByDefault === 'boolean');
    const codes = p.languages === 'many' ? [] : p.languages;
    check(`${p.id}: languages are known codes`, codes.every((c) => LANG.isLanguageCode(c)), codes.join(','));
  }
  check('only the broad source is on by default', BATCH_1.filter((p) => p.enabledByDefault).map((p) => p.id).join() === 'gestdown');

  console.log('gestdown');
  const shows = gd.parseShows(txt('gestdown', 'shows_search_breaking_bad.json'));
  check('show search parses two shows', shows.length === 2 && shows[0].name === 'Breaking Bad' && shows[0].id === '1WLU6zJky4nlJQa5oojv5R');
  check('the exact name is picked, the minisodes are not', gd.pickShows(shows, 'breaking bad').map((s) => s.name).join() === 'Breaking Bad');
  check('no match for another title when there are several', gd.pickShows(shows, 'Better Call Saul').length === 0 && gd.pickShows([shows[0]], 'Better Call Saul').length === 1);
  const gs = gd.parseSubtitles(txt('gestdown', 'subtitles_bb_s01e01_english.json'), 'Breaking Bad', 1, 1);
  check('subtitles parse', gs.length === 4 && gs.every((c) => c.providerId === 'gestdown' && c.language === 'en' && c.format === 'srt' && c.matchedBy === 'title'));
  check('release name carries show, episode and version', gs[0].releaseName === 'Breaking Bad S01E01 0tv' && gs[1].releaseName === 'Breaking Bad S01E01 DVDRip ORPHEUS', gs[1].releaseName);
  check('downloads, date and id', gs[0].downloads === 436 && gs[0].uploadedAt === Math.floor(Date.parse('2022-05-17T02:28:20.084012Z') / 1000) && gs[0].id === '3Df15bUM1njyzL2GHv0PaX');
  check('unfinished subtitles are dropped', gd.parseSubtitles(JSON.stringify({ matchingSubtitles: [{ subtitleId: 'abc', completed: false, language: 'English', version: 'x' }] }), 'S', 1, 1).length === 0);
  check('hearing impaired flag', gd.parseSubtitles(JSON.stringify({ matchingSubtitles: [{ subtitleId: 'abc', completed: true, hearingImpaired: true, language: 'French', version: 'a,b' }] }), 'S', 1, 2)[0].hearingImpaired === true);
  check('language names', gd.gestdownLanguage('pt-BR') === 'Portuguese (Brazilian)' && gd.gestdownLanguage('es-419') === 'Spanish' && gd.gestdownLanguage('zh-TW') === null && gd.gestdownLanguage('xx') === null);
  check('urls', gd.showsUrl('https://api.gestdown.info/', 'Breaking Bad') === 'https://api.gestdown.info/shows/search/Breaking%20Bad' && gd.subtitlesUrl('https://api.gestdown.info', 'abc', 1, 2, 'Portuguese (Brazilian)') === 'https://api.gestdown.info/subtitles/get/abc/1/2/Portuguese%20(Brazilian)' && gd.downloadUrl('https://api.gestdown.info', 'a/b') === null);
  check('a download is text with a format', (() => { const p = H.toPayload(u8(raw('gestdown', 'download_head.srt')), 'en'); return p.kind === 'text' && p.format === 'srt'; })());
  check('movies are skipped', (await BATCH_1.find((p) => p.id === 'gestdown').search(q(), { signal: new AbortController().signal, baseUrl: 'https://x.test' })).length === 0);

  console.log('subtis');
  const sc = st.parseFind(txt('subtis', 'find_name.json'), 'name');
  check('find parses', sc && sc.id === '25826' && sc.language === 'es' && sc.format === 'srt' && sc.matchedBy === 'release' && sc.downloads === 73, JSON.stringify(sc));
  check('release name is the video file name', sc.releaseName === 'Just.Play.Dead.2026.1080p.WEBRip.x264.AAC5.1-[YTS.GG - YTS.BZ].mp4');
  check('hash match is a hash match, a fuzzy one is a title match', st.parseFind(txt('subtis', 'find_name.json'), 'hash').matchedBy === 'hash' && st.parseFind(txt('subtis', 'find_name.json'), 'alternative').matchedBy === 'title' && /fuzzy/.test(st.parseFind(txt('subtis', 'find_name.json'), 'alternative').releaseName));
  check('an answer with no subtitle is no candidate', st.parseFind('{"message":"x"}', 'hash') === null && st.parseFind('{"subtitle":{"id":"../x"}}', 'hash') === null);
  const sq = q({ hash: '4e63ff4da5d016d8', videoBytes: 61878609, fileName: 'A B.mkv' });
  check('urls: hash, bytes, name, alternative', st.findUrl('https://api.subt.is', 'hash', sq) === 'https://api.subt.is/v1/subtitle/find/file/hash/4e63ff4da5d016d8' && st.findUrl('https://api.subt.is/', 'bytes', sq) === 'https://api.subt.is/v1/subtitle/find/file/bytes/61878609' && st.findUrl('https://api.subt.is', 'name', sq) === 'https://api.subt.is/v1/subtitle/find/file/name/A%20B.mkv' && st.findUrl('https://api.subt.is', 'alternative', sq) === 'https://api.subt.is/v1/subtitle/file/alternative/A%20B.mkv' && st.findUrl('https://api.subt.is', 'hash', q()) === null);
  check('download url', st.downloadUrl('https://api.subt.is', '25826') === 'https://api.subt.is/v1/subtitle/link/25826');
  check('a download is text', H.toPayload(u8(raw('subtis', 'download_head.srt')), 'es').kind === 'text');
  check('Spanish only, movies only', (await st.subtis.search(q({ languages: ['en'] }), { signal: new AbortController().signal, baseUrl: 'https://x.test' })).length === 0 && (await st.subtis.search(q({ languages: ['es'], season: 1, episode: 1 }), { signal: new AbortController().signal, baseUrl: 'https://x.test' })).length === 0);

  console.log('regielive');
  const rs = rl.parseSearch(txt('regielive', 'search_inception_2010.json'));
  const rlRating = {};
  for (const g of Object.values(JSON.parse(txt('regielive', 'search_inception_2010.json')).rezultate)) for (const [id, it] of Object.entries(g.subtitrari)) rlRating[id] = it.rating.nota;
  const rlNotes = rs.map((c) => rlRating[/-(\d+)\.zip$/.exec(c.id)[1]]);
  check('search parses, best rated first', rs.length > 3 && rs.every((c) => c.language === 'ro' && /^descarca-\d+-\d+\.zip$/.test(c.id)) && rlNotes.every((n, i) => i === 0 || rlNotes[i - 1] >= n), rlNotes.join());
  check('download url comes from the id', rl.downloadUrl('descarca-14880-677974.zip') === 'https://subtitrari.regielive.ro/descarca-14880-677974.zip' && rl.downloadUrl('../x') === null);
  check('empty and odd answers', rl.parseSearch('{"rezultate":[]}').length === 0 && rl.parseSearch('{}').length === 0);
  check('search url: movie with year, episode', rl.searchUrl('https://api.regielive.ro', q({ title: 'Inception', year: 2010 })) === 'https://api.regielive.ro/bazarr/search.php?nume=Inception&an=2010' && rl.searchUrl('https://api.regielive.ro', q({ title: 'Breaking Bad', season: 1, episode: 2 })) === 'https://api.regielive.ro/bazarr/search.php?nume=Breaking+Bad&sezon=1&episod=2' && rl.searchUrl('https://api.regielive.ro', q({ title: ' ' })) === null);
  const rp = H.toPayload(u8(raw('regielive', 'download.zip')), 'ro');
  check('download is a zip', rp.kind === 'zip' && pay.archiveKind(rp.bytes) === 'zip');

  console.log('vladoon');
  const vm = vl.parseSearch(txt('vladoon', 'search_inception.json'), q({ title: 'Inception', year: 2010 }));
  check('movie: the other production with "Inception" in its title is dropped', vm.length === 1 && vm[0].id === '6705' && vm[0].language === 'bg' && vm[0].releaseName === 'Inception.2010.1080p.BluRay.x265-RARBG' && vm[0].downloads === 44, JSON.stringify(vm));
  check('movie: upload date', vm[0].uploadedAt === Math.floor(Date.parse('2025-07-05T13:07:45Z') / 1000));
  check('movie: a different year is dropped', vl.parseSearch(txt('vladoon', 'search_inception.json'), q({ title: 'Inception', year: 1999 })).length === 0);
  const vt = vl.parseSearch(txt('vladoon', 'search_breaking_bad_s01e01.json'), q({ title: 'Breaking Bad', season: 1, episode: 1, episodeConfidence: 'sure' }));
  check('episode: the season pack covering S01E01 is kept, with the matching release name', vt.length === 1 && vt[0].releaseName === 'breaking.bad.s01e01.720p.bluray.x264-reward', JSON.stringify(vt));
  check('episode: a pack of another season is dropped', vl.parseSearch(txt('vladoon', 'search_breaking_bad_s01e01.json'), q({ title: 'Breaking Bad', season: 2, episode: 1, episodeConfidence: 'sure' })).length === 0);
  check('episode query text and urls', vl.searchQuery(q({ title: 'Breaking Bad', season: 1, episode: 2 })) === 'Breaking Bad S01E02' && vl.searchUrl('https://vladoon.com', q({ title: 'Inception' })) === 'https://vladoon.com/subs/search-subtitles?q=Inception' && vl.downloadUrl('https://vladoon.com', '6705') === 'https://vladoon.com/subs/download/6705' && vl.downloadUrl('https://vladoon.com', '../1') === null);
  check('bad response is a parse error', (() => { try { vl.parseSearch('<html>', q({ title: 'x' })); return false; } catch (e) { return e.kind === 'blocked' || e.kind === 'parse'; } })() && (() => { try { vl.parseSearch('{"results":3}', q({ title: 'x' })); return false; } catch (e) { return e.kind === 'parse'; } })());
  const vp = H.toPayload(u8(raw('vladoon', 'download.zip')), 'bg');
  check('download is a zip', vp.kind === 'zip');

  console.log('napisy24');
  const ok0 = n24.parseResponse(u8(raw('napisy24', 'ok0_unknown_file.bin')));
  const ok1 = n24.parseResponse(u8(raw('napisy24', 'ok1_known_film_no_subtitle.bin')));
  check('OK-0 and OK-1 parse and give nothing', ok0.status === 'OK-0' && ok1.status === 'OK-1' && ok1.fields.imdb === '369702' && ok1.archive.length === 0 && n24.toCandidates(ok0, { hash: '4e63ff4da5d016d8', videoBytes: 1, fileName: 'a.mkv' }).length === 0 && n24.toCandidates(ok1, { hash: '8e245d9679d31e12', videoBytes: 1, fileName: 'a.mkv' }).length === 0);
  const zip = raw('regielive', 'download.zip');
  const ok2body = u8(Buffer.concat([raw('napisy24', 'ok2_head_SYNTHETIC.txt'), Buffer.from('||'), zip]));
  const ok2 = n24.parseResponse(ok2body);
  check('OK-2 splits the header from the archive', ok2.status === 'OK-2' && ok2.fields.napisId === '123456' && ok2.archive.length === zip.length && pay.archiveKind(ok2.archive) === 'zip');
  const nq = { hash: '8e245d9679d31e12', videoBytes: 12909756, fileName: 'Brake Dance (2000).avi' };
  const nc = n24.toCandidates(ok2, nq);
  check('OK-2 is one hash candidate in Polish', nc.length === 1 && nc[0].matchedBy === 'hash' && nc[0].language === 'pl' && nc[0].releaseName === 'Brake Dance (2000)', JSON.stringify(nc));
  const back = n24.parseId(nc[0].id);
  check('the id round-trips the lookup', back && back.hash === nq.hash && back.bytes === nq.videoBytes && back.fileName === nq.fileName && n24.parseId('nope') === null);
  check('request body', (() => { const p = new URLSearchParams(n24.requestBody('8e245d9679d31e12', 5, 'a b.mkv')); return p.get('postAction') === 'CheckSub' && p.get('fh') === '8e245d9679d31e12' && p.get('fs') === '5' && p.get('fn') === 'a b.mkv' && p.get('ua') === 'subliminal'; })());
  check('login error is an http error', (() => { try { n24.toCandidates(n24.parseResponse(u8(Buffer.from('login error||'))), nq); return false; } catch (e) { return e.kind === 'http'; } })());
  check('garbage is a parse error', (() => { try { n24.parseResponse(u8(Buffer.from('<html>no</html>'))); return false; } catch (e) { return e.kind === 'parse'; } })());
  check('no hash, no lookup', (await n24.napisy24.search(q({ languages: ['pl'] }), { signal: new AbortController().signal, baseUrl: 'https://x.test' })).length === 0);

  console.log('payload');
  const pngish = u8(Buffer.from('<!doctype html><html>nope</html>'));
  check('an HTML page is not a subtitle', await rejects(async () => H.toPayload(pngish), 'parse'));
  check('RAR and 7z are refused with the plain message', await rejects(async () => H.toPayload(u8([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])), 'parse') && await rejects(async () => H.toPayload(u8([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), 'parse'));
  check('empty is refused', await rejects(async () => H.toPayload(u8([])), 'parse'));
  check('format sniffing: ass, vtt, srt', H.sniffFormat(u8(Buffer.from('[Script Info]\nTitle: x\n[V4+ Styles]'))) === 'ass' && H.sniffFormat(u8(Buffer.from('WEBVTT\n\n00:00.000 --> 00:01.000\nHi'))) === 'vtt' && H.sniffFormat(u8(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi'))) === 'srt');
  check('title words compare without accents and case', M.sameTitle('Amélie', 'amelie') && !M.sameTitle('Dune', 'Dune Part Two'));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall subtitle batch 1 checks passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
