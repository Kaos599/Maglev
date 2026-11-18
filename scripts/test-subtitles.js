#!/usr/bin/env node
// Subtitles, pure part (docs/NATIVE_CONTRACT.md section 36.12): file name reading, grouping and order, zip member
// choice, text decoding per code page, file naming and the name-taken path, settings and the privacyAck gate, the
// signed-list `subtitles` map, provider switches, and search orchestration with fake providers.
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const bytes = (...a) => Uint8Array.from(a.flatMap((x) => (x instanceof Uint8Array ? Array.from(x) : x)));
const ascii = (s) => Uint8Array.from(Buffer.from(s, 'latin1'));
const utf8 = (s) => Uint8Array.from(Buffer.from(s, 'utf8'));

(async () => {
  const lang = await import('../utils/subtitles/languages.ts');
  const pn = await import('../utils/subtitles/parseName.ts');
  const rank = await import('../utils/subtitles/rank.ts');
  const pay = await import('../utils/subtitles/payload.ts');
  const naming = await import('../utils/subtitles/naming.ts');
  const copy = await import('../utils/subtitles/copy.ts');
  const prefs = await import('../utils/subtitles/prefs.ts');
  const reg = await import('../utils/subtitles/providers/index.ts');
  const srch = await import('../utils/subtitles/search.ts');
  const http = await import('../utils/search/http.ts');
  const S = await import('../utils/lists/schema.ts');
  const store = await import('../utils/lists/store.ts');
  const C = await import('../utils/lists/check.ts');
  const types = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const Store = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');

  // ------------------------------------------------------------------ parseName (36.4)
  console.log('[parseName]');
  const P = pn.parseName;
  let r = P('Show.Name.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTB.mkv');
  check('S01E02 is sure, title from dots', r.title === 'Show Name' && r.season === 1 && r.episode === 2 && r.episodeConfidence === 'sure');
  r = P('Show.S01E02E03.720p.mkv');
  check('S01E02E03 gives the first episode', r.season === 1 && r.episode === 2 && r.episodeConfidence === 'sure');
  r = P('Show - 1x07 - Title.avi');
  check('1x07 is sure', r.title === 'Show' && r.season === 1 && r.episode === 7 && r.episodeConfidence === 'sure');
  r = P('Film.Title.2024.1080p.BluRay.x264-GRP.mkv');
  check('Title.2024. gives the year, no episode', r.title === 'Film Title' && r.year === 2024 && r.episodeConfidence === 'none' && r.episode === undefined);
  r = P('Film Title (2024).mp4');
  check('Title (2024) gives the year', r.title === 'Film Title' && r.year === 2024);
  r = P('Mr_Robot.S02E10.2016.mkv');
  check('underscores become spaces, year after the episode kept', r.title === 'Mr Robot' && r.year === 2016 && r.season === 2 && r.episode === 10);
  r = P('Blade.Runner.2049.2017.2160p.mkv');
  check('a year-like word in the title stays in the title', r.title === 'Blade Runner 2049' && r.year === 2017);
  r = P('2012.2009.720p.mkv');
  check('a title that is a year', r.title === '2012' && r.year === 2009);
  r = P('[SubsPlease] Show Name - 047 [1080p].mkv');
  check('anime absolute numbering is a guess', r.title === 'Show Name' && r.absoluteEpisode === 47 && r.episodeConfidence === 'guess' && r.episode === undefined);
  r = P('[Group] Show - 12v2 (BD 1080p).mkv');
  check('anime with a version suffix', r.title === 'Show' && r.absoluteEpisode === 12 && r.episodeConfidence === 'guess');
  r = P('Some Random Video.mp4');
  check('anything else is none', r.title === 'Some Random Video' && r.episodeConfidence === 'none');
  r = P('Foo.1920x1080.mkv');
  check('a resolution is not 1x08', r.episodeConfidence === 'none' && r.title === 'Foo');
  for (const n of ['Show.S01E02.sample.mkv', 'Movie-Trailer.mp4', 'extras/Featurette.mkv', 'Show.S01E05.Extras.mkv', 'sample-show.s01e01.mkv']) {
    const x = P(n);
    check(`extra file "${n}" is none`, x.episodeConfidence === 'none' && x.extra === true && x.episode === undefined);
  }
  check('"Resample" is not a sample', P('Resample.Story.S01E01.mkv').episodeConfidence === 'sure');
  check('folders are ignored', P('/storage/emulated/0/Download/Maglev/Show.S03E04.mkv').title === 'Show');
  const rel = pn.parseRelease('Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTB.mkv');
  check('release info: group, source, resolution', rel.group === 'ntb' && rel.source === 'webdl' && rel.resolution === '1080p');
  check('release info: BluRay and HDTV', pn.parseRelease('X.2020.720p.BluRay.x264-AMIABLE').source === 'bluray' && pn.parseRelease('X.S01E01.HDTV.x264-LOL').source === 'hdtv' && pn.parseRelease('X.S01E01.WEBRip.x264-ION10').source === 'webrip');
  check('release info: leading [Group]', pn.parseRelease('[SubsPlease] Show - 01 [1080p].mkv').group === 'subsplease');

  // ------------------------------------------------------------------ languages
  console.log('[languages]');
  const N = lang.normalizeLanguage;
  check('639-2 and names', N('eng') === 'en' && N('English') === 'en' && N('ENG') === 'en' && N('fre') === 'fr' && N('fra') === 'fr' && N('ger') === 'de' && N('Deutsch') === 'de' && N('jpn') === 'ja');
  check('pt-BR in every spelling providers use', ['pob', 'pt-BR', 'pt_br', 'PT-BR', 'Portuguese (Brazil)', 'Brazilian', 'ptbr', 'pt-br'].every((x) => N(x) === 'pt-BR'));
  check('plain Portuguese and pt-PT', N('por') === 'pt' && N('Portuguese') === 'pt' && N('pt-PT') === 'pt');
  check('zh variants', N('chs') === 'zh-CN' && N('zh-Hans') === 'zh-CN' && N('zh-Hans-CN') === 'zh-CN' && N('cht') === 'zh-TW' && N('zh-Hant') === 'zh-TW' && N('zh_TW') === 'zh-TW' && N('Chinese (Simplified)') === 'zh-CN' && N('chi') === 'zh' && N('zh-HK') === 'zh-TW');
  check('es-419 and Spain Spanish', N('es-419') === 'es-419' && N('es-MX') === 'es-419' && N('Spanish (Latin America)') === 'es-419' && N('spa') === 'es' && N('es-ES') === 'es' && N('Spanish') === 'es');
  check('regional English and French fold to the base', N('en-US') === 'en' && N('en_GB') === 'en' && N('fr-CA') === 'fr');
  check('unknown and empty give null', N('klingon') === null && N('') === null && N(null) === null && N('xx') === null);
  check('every listed code normalises to itself', lang.LANGUAGES.every((l) => N(l.code) === l.code));
  check('the list has the four regional tags and unique codes', ['pt-BR', 'zh-CN', 'zh-TW', 'es-419'].every(lang.isLanguageCode) && new Set(lang.LANGUAGES.map((l) => l.code)).size === lang.LANGUAGES.length);
  check('every language has an English and native name', lang.LANGUAGES.every((l) => l.name && l.native));
  check('default languages: phone language, then English', eq(lang.defaultLanguages('de-DE'), ['de', 'en']) && eq(lang.defaultLanguages('pt-BR'), ['pt-BR', 'en']) && eq(lang.defaultLanguages('zh-Hans-CN'), ['zh-CN', 'en']));
  check('default languages: English phone gives just English; unknown gives English', eq(lang.defaultLanguages('en-US'), ['en']) && eq(lang.defaultLanguages(null), ['en']) && eq(lang.defaultLanguages('xx'), ['en']));
  check('language rank: exact, same base, none', lang.languageRank('pt-BR', ['en', 'pt-BR']) === 1 && lang.languageRank('pt', ['en', 'pt-BR']) === 1.5 && lang.languageRank('de', ['en']) === Infinity);

  // ------------------------------------------------------------------ rank (36.5)
  console.log('[rank]');
  const cand = (o) => ({ providerId: 'p1', id: String(Math.random()), language: 'en', releaseName: 'Other.Release', matchedBy: 'release', ...o });
  const file = 'Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-NTB.mkv';
  const opt = { fileName: file, episodeConfidence: 'sure', languages: ['en', 'de'], hearingImpaired: 'both' };
  check('releases match on group, source and resolution', rank.releasesMatch(file, 'Show.S01E02.1080p.WEB-DL.x264-NTB') && rank.releasesMatch(file, 'Show S01E02 WEB-DL-ntb'));
  check('a different group, source or resolution does not match', !rank.releasesMatch(file, 'Show.S01E02.1080p.WEB-DL-FLUX') && !rank.releasesMatch(file, 'Show.S01E02.1080p.BluRay-NTB') && !rank.releasesMatch(file, 'Show.S01E02.720p.WEB-DL-NTB'));
  check('a release name with no group never matches', !rank.releasesMatch(file, 'Show S01E02') && !rank.releasesMatch('Show.S01E02.mkv', 'Show.S01E02.mkv'));
  let rows = rank.rankCandidates(
    [
      cand({ id: 'maybe-en', downloads: 900 }),
      cand({ id: 'prob-en', releaseName: 'Show.S01E02.1080p.WEB-DL.x264-NTB', downloads: 5 }),
      cand({ id: 'hash-de', language: 'de', matchedBy: 'hash', downloads: 1 }),
    ],
    opt,
  );
  check('group first: hash, then release match, then the rest', eq(rows.map((x) => x.candidate.id), ['hash-de', 'prob-en', 'maybe-en']) && eq(rows.map((x) => x.group), ['fits', 'probably', 'maybe']));
  check('hash match is "Fits this file" even without a sure episode', rank.rankCandidates([cand({ matchedBy: 'hash' })], { ...opt, episodeConfidence: 'none' })[0].group === 'fits');
  check('with no hash and an unsure episode everything is "May be out of sync"', rank.rankCandidates([cand({ releaseName: 'Show.S01E02.1080p.WEB-DL.x264-NTB' }), cand({})], { ...opt, episodeConfidence: 'guess' }).every((x) => x.group === 'maybe'));
  rows = rank.rankCandidates([cand({ id: 'de', language: 'de' }), cand({ id: 'fr', language: 'fr' }), cand({ id: 'en', language: 'en' })], opt);
  check('within a group: language order, unlisted languages last', eq(rows.map((x) => x.candidate.id), ['en', 'de', 'fr']));
  rows = rank.rankCandidates([cand({ id: 'plain', releaseName: 'A' }), cand({ id: 'hi', releaseName: 'B', hearingImpaired: true })], { ...opt, hearingImpaired: 'prefer' });
  check('hearing impaired: prefer puts it first', rows[0].candidate.id === 'hi');
  rows = rank.rankCandidates([cand({ id: 'hi', releaseName: 'B', hearingImpaired: true, downloads: 99 }), cand({ id: 'plain', releaseName: 'A', downloads: 1 })], { ...opt, hearingImpaired: 'avoid' });
  check('hearing impaired: avoid puts it after, even with more downloads', rows[0].candidate.id === 'plain');
  rows = rank.rankCandidates([cand({ id: 'hi', releaseName: 'B', hearingImpaired: true, downloads: 99 }), cand({ id: 'plain', releaseName: 'A', downloads: 1 })], opt);
  check('hearing impaired: both falls through to downloads', rows[0].candidate.id === 'hi');
  rows = rank.rankCandidates([cand({ id: 'few', releaseName: 'A', downloads: 3 }), cand({ id: 'many', releaseName: 'B', downloads: 300 }), cand({ id: 'none', releaseName: 'C' })], opt);
  check('then downloads, most first, unknown last', eq(rows.map((x) => x.candidate.id), ['many', 'few', 'none']));
  rows = rank.rankCandidates([cand({ id: 'a', releaseName: 'Show.S01E02-NTB', downloads: 2 }), cand({ id: 'b', releaseName: 'show s01e02 ntb', downloads: 50 }), cand({ id: 'c', releaseName: 'Show.S01E02-NTB', language: 'de' }), cand({ id: 'd', providerId: 'p2', releaseName: 'Show.S01E02-NTB' })], opt);
  check('duplicates: same provider and release name once per language', eq(rows.map((x) => x.candidate.id).sort(), ['b', 'c', 'd']));
  check('duplicates keep the hash match', rank.rankCandidates([cand({ id: 'a', releaseName: 'X', downloads: 999 }), cand({ id: 'b', releaseName: 'X', matchedBy: 'hash' })], opt)[0].candidate.id === 'b');
  check('default selection: first row only when it fits', rank.defaultSelection(rank.rankCandidates([cand({ matchedBy: 'hash' }), cand({})], opt)) === 0);
  check('default selection: none when the first row does not fit', rank.defaultSelection(rank.rankCandidates([cand({}), cand({})], opt)) === null && rank.defaultSelection(rank.rankCandidates([cand({ releaseName: 'Show.S01E02.1080p.WEB-DL-NTB' })], opt)) === null && rank.defaultSelection([]) === null);
  check('forLanguage filters a tab', rank.forLanguage(rank.rankCandidates([cand({ language: 'de' }), cand({ releaseName: 'Z' })], opt), 'de').length === 1);

  // ------------------------------------------------------------------ zip member choice (36.7)
  console.log('[zip member]');
  const mem = (name, n = 100) => ({ name, bytes: new Uint8Array(n).fill(65) });
  const want = { fileName: 'Show.S01E03.1080p.WEB-DL.x264-NTB.mkv', season: 1, episode: 3 };
  let pick = pay.pickZipMember([mem('Show.S01E01.srt'), mem('Show.S01E03.srt', 50), mem('Show.S01E02.srt')], want);
  check('same season and episode wins even when smaller', pick.ok && pick.member.name === 'Show.S01E03.srt');
  pick = pay.pickZipMember([mem('Show.S01E03.720p.HDTV-LOL.srt', 900), mem('Show.S01E03.1080p.WEB-DL.NTB.srt', 100), mem('Show.S01E03.WEBRip-ION10.srt', 500)], want);
  check('several for the episode: the closest release name', pick.ok && pick.member.name === 'Show.S01E03.1080p.WEB-DL.NTB.srt');
  pick = pay.pickZipMember([mem('a.srt', 10), mem('b.srt', 300), mem('c.ass', 20)], { fileName: 'Film.2024.mkv' });
  check('no names to compare: the largest member', pick.ok && pick.member.name === 'b.srt');
  pick = pay.pickZipMember([mem('Show.S01E01.srt'), mem('Show.S01E02.srt'), mem('Show.S01E03.srt')], { fileName: 'Show.mkv' });
  check('season pack, episode unknown: ambiguous', !pick.ok && pick.code === 'ambiguous_pack');
  pick = pay.pickZipMember([mem('Show.S01E01.srt'), mem('Show.S01E02.srt')], want);
  check('season pack without our episode: ambiguous, never a guess', !pick.ok && pick.code === 'ambiguous_pack');
  pick = pay.pickZipMember([mem('Show.S01E01.srt')], want);
  check('one member for another episode is refused', !pick.ok && pick.code === 'ambiguous_pack');
  pick = pay.pickZipMember([mem('subtitle.srt')], want);
  check('one unnamed member is taken', pick.ok);
  pick = pay.pickZipMember([mem('readme.txt'), mem('__MACOSX/._a.srt'), mem('empty.srt', 0)], want);
  check('no usable member: unsupported', !pick.ok && pick.code === 'unsupported_archive');
  pick = pay.pickZipMember([mem('[Grp] Show - 046.ass'), mem('[Grp] Show - 047.ass', 5), mem('[Grp] Show - 048.ass')], { fileName: '[Grp] Show - 047 [1080p].mkv', absoluteEpisode: 47 });
  check('absolute episode matches anime packs', pick.ok && pick.member.name.includes('047'));

  // ------------------------------------------------------------------ text (36.7)
  console.log('[text]');
  const dec = (b, l) => pay.decodeSubtitleText(b, l);
  check('UTF-8 with BOM, BOM removed', dec(bytes(0xef, 0xbb, 0xbf, utf8('1\nCafé 😀')), 'fr').text === '1\nCafé 😀');
  check('UTF-8 without BOM', dec(utf8('Привет, мир — ✓'), 'fr').text === 'Привет, мир — ✓' && dec(utf8('Привет'), 'fr').encoding === 'utf-8');
  check('UTF-16 LE with BOM', dec(bytes(0xff, 0xfe, [...'Hé 😀'].flatMap((c) => { const b = Buffer.from(c, 'utf16le'); return [...b]; })), 'en').text === 'Hé 😀');
  check('UTF-16 BE with BOM', dec(bytes(0xfe, 0xff, ...[...Buffer.from('Hé 😀', 'utf16le').swap16()]), 'en').text === 'Hé 😀');
  check('UTF-16 LE without BOM (Latin text)', dec(Uint8Array.from(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nHello', 'utf16le')), 'en').text.endsWith('Hello'));
  check('invalid UTF-8 is not mistaken for UTF-8', pay.decodeUtf8Strict(bytes(0xe9)) === null && pay.decodeUtf8Strict(bytes(0xc0, 0x80)) === null && pay.decodeUtf8Strict(bytes(0xed, 0xa0, 0x80)) === null && pay.decodeUtf8Strict(bytes(0xe2, 0x82)) === null && pay.decodeUtf8Strict(bytes(0xf4, 0x90, 0x80, 0x80)) === null);
  const vectors = [
    ['cp1250 Polish', 'pl', [0xbf, 0xf3, 0xb3, 0xe6], 'żółć', 'cp1250'],
    ['cp1250 Czech', 'cs', [0x50, 0xf8, 0xed, 0x6c, 0x69, 0x9a], 'Příliš', 'cp1250'],
    ['cp1250 Hungarian (ő, ű)', 'hu', [0xf5, 0xfb], 'őű', 'cp1250'],
    ['cp1250 Serbian Latin', 'sr-Latn', [0xe8, 0xe6, 0x9e, 0x9a, 0xf0], 'čćžšđ', 'cp1250'],
    ['cp1251 Russian', 'ru', [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], 'Привет', 'cp1251'],
    ['cp1251 Serbian Cyrillic', 'sr-Cyrl', [0x90, 0xbc, 0x9e], 'ђјћ', 'cp1251'],
    ['cp1251 Ukrainian (і, ї)', 'uk', [0xb3, 0xbf], 'ії', 'cp1251'],
    ['cp1252 French', 'fr', [0x43, 0x61, 0x66, 0xe9, 0x20, 0x73, 0x65, 0xf1, 0x6f, 0x72, 0x80, 0x92], 'Café señor€’', 'cp1252'],
    ['cp1252 for a language with no table of its own', 'de', [0xfc, 0xdf], 'üß', 'cp1252'],
    ['cp1252 when no language is known', undefined, [0xe9], 'é', 'cp1252'],
    ['cp1253 Greek', 'el', [0xc3, 0xe5, 0xe9, 0xdc], 'Γειά', 'cp1253'],
    ['cp1254 Turkish', 'tr', [0x49, 0xfe, 0xfd, 0x6b, 0xf0], 'Işıkğ', 'cp1254'],
    ['cp1256 Arabic', 'ar', [0xd3, 0xe1, 0xc7, 0xe3], 'سلام', 'cp1256'],
    ['cp1256 Persian (پ)', 'fa', [0x81], 'پ', 'cp1256'],
  ];
  for (const [name, l, b, expect, page] of vectors) {
    const out = dec(bytes(b), l);
    check(`${name}`, out.ok && out.text === expect && out.encoding === page, out.ok ? `${out.text} ${out.encoding}` : out.code);
  }
  check('regional tags pick the same page (pl-PL style and es-419)', pay.codePageFor('es-419') === 'cp1252' && pay.codePageFor('pt-BR') === 'cp1252' && pay.codePageFor('sr-Latn') === 'cp1250');
  check('Serbian without a script is told apart by its bytes', pay.codePageFor('sr', bytes(0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x20, 0xe8, 0xe0)) === 'cp1251' && pay.codePageFor('sr', ascii('Dobar dan, èovek, \u009ae')) === 'cp1250');
  check('GBK, Big5, Shift-JIS, EUC-KR that is not UTF-8 are refused', ['zh-CN', 'zh-TW', 'zh', 'ja', 'ko'].every((l) => { const o = dec(bytes(0xc4, 0xe3, 0xba, 0xc3), l); return !o.ok && o.code === 'unreadable_text'; }));
  check('the same languages in UTF-8 are fine', dec(utf8('你好'), 'zh-CN').text === '你好' && dec(utf8('こんにちは'), 'ja').ok);
  check('prepareText throws a SubtitleError the copy knows', (() => { try { pay.prepareText(bytes(0xc4, 0xe3), 'zh'); return false; } catch (e) { return e instanceof pay.SubtitleError && e.code === 'unreadable_text'; } })());
  // The tables agree with a full Unicode library for every byte.
  const WHATWG_1252_80_9F = String.fromCharCode(
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
  );
  const latin1A0toFF = String.fromCharCode(...Array.from({ length: 96 }, (_, i) => 0xa0 + i));
  const tables = { cp1250: 'windows-1250', cp1252: 'windows-1252', cp1253: 'windows-1253', cp1254: 'windows-1254', cp1256: 'windows-1256', cp1251: 'windows-1251' };
  const probe = { cp1250: 'pl', cp1252: 'de', cp1253: 'el', cp1254: 'tr', cp1256: 'ar', cp1251: 'ru' };
  for (const [page, label] of Object.entries(tables)) {
    const all = Uint8Array.from({ length: 128 }, (_, i) => i + 128);
    const mine = dec(all, probe[page]);
    // Bytes a code page leaves undefined come out as U+FFFD or as the C1 control of the same value, depending on the
    // ICU build (Node 22.18 on CI and 22.22 locally disagree) and on the table. Both are "no character here", so
    // both sides are compared with U+FFFD folded to the C1 control at that position.
    const fold = (s) => Array.from(s, (ch, i) => (ch === '�' ? String.fromCharCode(128 + i) : ch)).join('');
    const theirs = fold(new TextDecoder(label).decode(all));
    if (mine.ok) mine.text = fold(mine.text);
    // windows-1252 is checked against the WHATWG index itself (https://encoding.spec.whatwg.org/index-windows-1252.txt):
    // CI's Node 22.18 decoder disagrees with it while Node 22.22 agrees, so the platform is not a reliable oracle there.
    const want = page === 'cp1252' ? fold(WHATWG_1252_80_9F + latin1A0toFF) : theirs;
    const diff = mine.ok ? Array.from(want).map((ch, i) => (mine.text[i] === ch ? '' : `${(128 + i).toString(16)}: ${mine.text.charCodeAt(i).toString(16)} vs ${ch.charCodeAt(0).toString(16)}`)).filter(Boolean) : [];
    // cp1251 comes from utils/search/charset.ts, which maps the undefined byte 0x98 to U+0098 where WHATWG has U+0098 too.
    check(`${page} table matches ${page === 'cp1252' ? 'the WHATWG index' : 'the platform decoder'} for bytes 0x80-0xFF`, mine.ok && mine.encoding === page && diff.length === 0, mine.ok ? `encoding ${mine.encoding}; ${diff.slice(0, 8).join(', ')}` : mine.code);
  }
  check('big files decode (chunked)', dec(ascii('é'.repeat(200000)), 'fr').text.length === 200000);
  check('format: WEBVTT', pay.detectFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nHi') === 'vtt' && pay.detectFormat('﻿WEBVTT - x') === 'vtt');
  check('format: ASS and SSA', pay.detectFormat('[Script Info]\nTitle: x\n[V4+ Styles]\n') === 'ass' && pay.detectFormat('[Script Info]\n[V4 Styles]\nFormat: Name') === 'ssa' && pay.detectFormat('\n[Script Info]\nScriptType: v4.00+') === 'ass');
  check('format: everything else is SRT', pay.detectFormat('1\n00:00:01,000 --> 00:00:02,000\nHi') === 'srt' && pay.detectFormat('{1}{25}MicroDVD') === 'srt');
  check('prepareText gives UTF-8 text and the format', (() => { const t = pay.prepareText(bytes(0xef, 0xbb, 0xbf, utf8('WEBVTT\n')), 'en'); return t.text === 'WEBVTT\n' && t.format === 'vtt'; })());
  check('base64 and UTF-8 helpers round-trip', (() => { const s = 'Zażółć 😀 — ✓\r\n'; const b = pay.textToBase64(s); return b === Buffer.from(s, 'utf8').toString('base64') && Buffer.from(pay.base64ToBytes(b)).toString('utf8') === s && Buffer.from(pay.bytesToBase64(bytes(1, 2, 3, 4, 5))).length > 0 && pay.bytesToBase64(bytes(1, 2, 3, 4, 5)) === Buffer.from([1, 2, 3, 4, 5]).toString('base64'); })());
  check('archive kinds by magic bytes', pay.archiveKind(bytes(0x50, 0x4b, 3, 4)) === 'zip' && pay.archiveKind(ascii('Rar!\x1a\x07\x00')) === 'rar' && pay.archiveKind(bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) === '7z' && pay.archiveKind(ascii('1\n00:00')) === null);

  // ------------------------------------------------------------------ naming (36.8)
  console.log('[naming]');
  const NM = naming.subtitleFileName;
  check('<base>.<lang>.<ext>', NM('Show.S01E03.1080p.mkv', 'en', 'srt') === 'Show.S01E03.1080p.en.srt');
  check('regional tag and hearing impaired', NM('Film.2024.mp4', 'pt-BR', 'srt', { hearingImpaired: true }) === 'Film.2024.pt-BR.hi.srt');
  check('provider spellings are normalised', NM('Film.mkv', 'Portuguese (Brazil)', 'ass') === 'Film.pt-BR.ass' && NM('Film.mkv', 'eng', 'vtt') === 'Film.en.vtt');
  check('keep both adds .2 before the extension', NM('Film.mkv', 'en', 'srt', { keepBoth: true }) === 'Film.en.2.srt' && NM('Film.mkv', 'en', 'srt', { keepBoth: true, hearingImpaired: true }) === 'Film.en.hi.2.srt' && NM('Film.mkv', 'en', 'srt', { keepBoth: true, copy: 3 }) === 'Film.en.3.srt');
  check('folders and a content:// path are dropped', NM('/sdcard/Download/Maglev/Film.mkv', 'de', 'srt') === 'Film.de.srt' && NM('content://x/tree/a%2FDownload%2FFilm.2024.mkv', 'de', 'srt') === 'Film.2024.de.srt');
  check('a name that ends in a year keeps it', naming.videoBaseName('Film.2024') === 'Film.2024' && naming.videoBaseName('Film.2024.mkv') === 'Film.2024');
  check('characters a file name cannot hold are replaced', !/[\\/:*?"<>|]/.test(naming.videoBaseName('a:b*c?.mkv')));
  const calls = [];
  const taken = new Set(['Film.en.srt']);
  const deps = {
    async save(video, fileName, b64, replace) {
      calls.push([fileName, replace]);
      if (taken.has(fileName) && !replace) { const e = new Error('exists'); e.code = 'NAME_TAKEN'; throw e; }
      taken.add(fileName);
      return { path: `/v/${fileName}` };
    },
  };
  let out = await naming.saveWithChoice(deps, { video: '/v/Film.mkv', language: 'en', format: 'srt', base64: 'QQ==' });
  check('name taken: nothing written, the sheet is asked', out.status === 'name-taken' && out.fileName === 'Film.en.srt' && eq(calls, [['Film.en.srt', false]]));
  out = await naming.saveWithChoice(deps, { video: '/v/Film.mkv', language: 'en', format: 'srt', base64: 'QQ==', choice: 'replace' });
  check('replace passes replace=true with the same name', out.status === 'saved' && eq(calls[1], ['Film.en.srt', true]));
  out = await naming.saveWithChoice(deps, { video: '/v/Film.mkv', language: 'en', format: 'srt', base64: 'QQ==', choice: 'keep-both' });
  check('keep both saves as .2', out.status === 'saved' && out.fileName === 'Film.en.2.srt');
  out = await naming.saveWithChoice(deps, { video: '/v/Film.mkv', language: 'en', format: 'srt', base64: 'QQ==', choice: 'keep-both' });
  check('keep both again moves to .3', out.status === 'saved' && out.fileName === 'Film.en.3.srt');
  out = await naming.saveWithChoice(deps, { video: '/v/Film.mkv', language: 'fr', format: 'srt', base64: 'QQ==' });
  check('a free name just saves', out.status === 'saved' && out.path === '/v/Film.fr.srt');
  const failWith = (code) => ({ async save() { const e = new Error(`x ${code}`); e.code = code; throw e; } });
  for (const code of ['CANT_WRITE', 'NO_SPACE', 'VERIFY_FAILED']) {
    let got = null;
    try { await naming.saveWithChoice(failWith(code), { video: '/v/F.mkv', language: 'en', format: 'srt', base64: '' }); } catch (e) { got = e.code; }
    check(`native ${code} becomes a SubtitleError`, got === code);
  }
  { let got = null; try { await naming.saveWithChoice(failWith('NOT_FOUND'), { video: '/v/F.mkv', language: 'en', format: 'srt', base64: '' }); } catch (e) { got = e.code; } check('NOT_FOUND is "the video isn\'t there any more"', got === 'missing'); }

  // ------------------------------------------------------------------ copy (36.10)
  console.log('[copy]');
  const EC = copy.errorCopy;
  check('offline', eq(EC('offline'), { message: "You're offline.", action: 'Retry' }));
  check('timeout and error name the source', EC('timeout', { source: 'Foo' }).message === "Foo isn't responding." && EC('error', { source: 'Foo' }).action === 'Try again' && EC('challenge', { source: 'Foo' }).message === "Foo isn't responding.");
  check('limit', eq(EC('limit', { source: 'Foo' }), { message: "Foo says you've reached today's limit.", action: 'Use another source' }));
  check('nothing found names the language', EC('nothing', { language: 'de' }).message === 'No German subtitles found.' && EC('nothing', { language: 'pt-BR' }).message === 'No Portuguese (Brazil) subtitles found.' && EC('nothing').action === 'Other language');
  check('file, folder, space, verify', EC('missing').message === "The video isn't there any more." && EC('CANT_WRITE').action === 'Open folder' && EC('NO_SPACE').message === 'Not enough space.' && EC('VERIFY_FAILED').message === "The subtitle didn't save correctly.");
  check('archive and text errors', EC('unsupported_archive').message === "This subtitle's file type isn't supported." && EC('unsupported_archive').action === 'Pick another' && EC('unreadable_text').message === "Maglev can't read this subtitle's text." && EC('ambiguous_pack').message.startsWith('This file has subtitles for several episodes'));
  check('notice text', copy.privacyNotice(['A', 'B']) === "Finding subtitles sends this video's file name and a fingerprint of the file to the sources you have on (A, B). They can see what you're watching.");
  check('privacy line and sheet strings', copy.PRIVACY_LINE.endsWith('Nothing is sent until you tap Find subtitles.') && copy.NOTHING_FITS_TITLE === 'Nothing fits this file' && copy.DOWNLOAD_BUTTON === 'Download subtitle');
  const jargon = Object.values(copy).filter((v) => typeof v === 'string').join(' ');
  check('no cryptic words in the copy', !/\b(hash|http|429|api|md5)\b/i.test(jargon.replace(/fingerprint/g, '')));

  // ------------------------------------------------------------------ settings and prefs (36.2)
  console.log('[settings]');
  const d = types.DEFAULT_SETTINGS.subtitles;
  check('defaults: on, phone language, show both, no overrides, notice not accepted', d.enabled === true && eq(d.languages, []) && d.hearingImpaired === 'both' && eq(d.sourceEnabled, {}) && d.privacyAck === false);
  check('prefs defaults equal the settings defaults', eq(prefs.DEFAULT_SUBTITLE_SETTINGS, d));
  check('an older payload without the section gets defaults', eq(Store.migrateSettings({ settings: { appearance: { mode: 'dim' } } }).subtitles, d));
  const mig = Store.migrateSettings({ settings: { subtitles: { enabled: false, languages: ['de', 'pt-BR', 'xx!', 5, 'de'], hearingImpaired: 'prefer', sourceEnabled: { a: true, b: false, c: 'yes' }, privacyAck: true } } }).subtitles;
  check('a saved section survives migrate and is cleaned', mig.enabled === false && eq(mig.languages, ['de', 'pt-BR']) && mig.hearingImpaired === 'prefer' && eq(mig.sourceEnabled, { a: true, b: false }) && mig.privacyAck === true);
  const bad = Store.migrateSettings({ settings: { subtitles: { enabled: 'no', hearingImpaired: 'sometimes', languages: 'en', sourceEnabled: [], privacyAck: 'true' } } }).subtitles;
  check('wrong types fall back to defaults', eq(bad, d));
  const st = Store.MaglevSettingsStore.getInstance();
  st.updateSettings({ subtitles: { ...d, privacyAck: true } });
  check('the store keeps the section on update', st.getSettings().subtitles.privacyAck === true && st.getSettings().subtitles.enabled === true);
  st.resetToDefaults();
  check('reset gives the defaults back', eq(st.getSettings().subtitles, d));
  const nativeCfg = read('modules/maglev-engine/src/toNativeConfig.ts');
  check('UI only: toNativeConfig never reads the subtitle settings', !/subtitle/i.test(nativeCfg));
  const bridge = read('modules/maglev-engine/src/MaglevNativeBridge.ts');
  check('UI only: the settings types say so', /UI only[^\n]*section 36\.2|section 36\.2[^\n]*UI only/i.test(read('modules/maglev-engine/src/MaglevSettings.types.ts')) && !/subtitles\.(enabled|languages|privacyAck)/.test(bridge));
  check('languages: phone language then English, or the user pick', eq(prefs.effectiveLanguages({ languages: [] }, 'fr-FR'), ['fr', 'en']) && eq(prefs.effectiveLanguages({ languages: ['it'] }, 'fr-FR'), ['it']));
  check('privacyAck gate: needed until accepted', prefs.needsPrivacyNotice({ privacyAck: false }) && !prefs.needsPrivacyNotice({ privacyAck: true }) && prefs.privacyAckPatch().privacyAck === true);
  check('source switch and language move helpers', eq(prefs.withSourceEnabled({ sourceEnabled: { a: true } }, 'b', false), { a: true, b: false }) && eq(prefs.withLanguageAt(['en', 'de', 'fr'], 'fr', 0), ['fr', 'en', 'de']) && eq(prefs.withLanguageAt(['en'], 'de', 9), ['en', 'de']));
  console.log('[state]');
  const now = 1_700_000_000_000;
  check('saved shows for 24 h, then hides', prefs.stateVisible({ lang: 'en', file: 'a.srt', savedAt: now, state: 'saved' }, now + 24 * 3600 * 1000 - 1) && !prefs.stateVisible({ lang: 'en', file: 'a.srt', savedAt: now, state: 'saved' }, now + 24 * 3600 * 1000));
  check('getting hides after 2 minutes and needs-look after 24 h (39.1 S3)', prefs.stateVisible({ lang: 'en', file: '', savedAt: now, state: 'getting' }, now + 60e3) && !prefs.stateVisible({ lang: 'en', file: '', savedAt: now, state: 'getting' }, now + 121e3) && prefs.stateVisible({ lang: 'en', file: 'a', savedAt: now, state: 'needs-look' }, now + 23 * 3600e3) && !prefs.stateVisible({ lang: 'en', file: 'a', savedAt: now, state: 'needs-look' }, now + 25 * 3600e3) && !prefs.stateVisible(null, now));
  const key = 'content://tree/Film.mkv';
  check('nothing stored gives null', prefs.getSubtitleState(key) === null);
  prefs.setSubtitleState(key, { lang: 'pt-BR', file: 'Film.pt-BR.srt', savedAt: now, state: 'saved' });
  check('kv state: set and get by video path or URI', eq(prefs.getSubtitleState(key), { lang: 'pt-BR', file: 'Film.pt-BR.srt', savedAt: now, state: 'saved' }));
  prefs.setSubtitleState('/other.mkv', { lang: 'en', file: '', savedAt: now, state: 'getting' });
  prefs.clearSubtitleState(key);
  check('kv state: clear removes only that video', prefs.getSubtitleState(key) === null && prefs.getSubtitleState('/other.mkv').state === 'getting');
  prefs.clearSubtitleState('/other.mkv');

  // ------------------------------------------------------------------ registry and switches
  console.log('[providers]');
  const mk = (id, enabledByDefault, over = {}) => ({ id, name: id.toUpperCase(), homepage: `https://${id}.example`, mirrors: [`https://${id}.example`], languages: 'many', kinds: ['movie', 'episode'], matches: ['name'], group: 'A', enabledByDefault, async search() { return []; }, async download() { return { kind: 'text', bytes: new Uint8Array(), format: 'srt' }; }, ...over });
  const A = mk('a', true), B = mk('b', false), Cc = mk('c', true);
  const ids = (xs) => xs.map((x) => x.id);
  check('the registry ships empty until the sources are ported, and its ids are unique', Array.isArray(reg.SUBTITLE_PROVIDERS) && new Set(ids(reg.SUBTITLE_PROVIDERS)).size === reg.SUBTITLE_PROVIDERS.length && reg.SUBTITLE_PROVIDERS.every((p) => p.group === 'A' || p.group === 'B'));
  check('enabledByDefault decides when the user said nothing', eq(ids(reg.enabledProviders({ enabled: true, sourceEnabled: {} }, null, [A, B, Cc])), ['a', 'c']));
  check('a user switch beats enabledByDefault, both ways', eq(ids(reg.enabledProviders({ enabled: true, sourceEnabled: { a: false, b: true } }, null, [A, B, Cc])), ['b', 'c']));
  check('the list turning a source off beats the user switch', eq(ids(reg.enabledProviders({ enabled: true, sourceEnabled: { b: true, c: true } }, { b: { enabled: false, note: 'Gone' }, c: { enabled: false } }, [A, B, Cc])), ['a']));
  check('the list enabled:true does not force a source on', eq(ids(reg.enabledProviders({ enabled: true, sourceEnabled: {} }, { b: { enabled: true } }, [A, B, Cc])), ['a', 'c']));
  check('the master switch off means no provider at all', reg.enabledProviders({ enabled: false, sourceEnabled: { a: true } }, null, [A, B, Cc]).length === 0);
  check('the list mirrors replace the built-in ones', eq(reg.enabledProviders({ enabled: true, sourceEnabled: {} }, { a: { mirrors: ['https://m1.example', 'https://m2.example'] } }, [A])[0].mirrors, ['https://m1.example', 'https://m2.example']) && eq(A.mirrors, ['https://a.example']));

  // ------------------------------------------------------------------ signed list (36.9)
  console.log('[list subtitles]');
  const base = (over = {}) => ({ schema: 1, serial: 2026111802, generatedAt: '2026-11-18T10:00:00Z', sources: {}, ...over });
  const knownSub = new Set(['a', 'b']);
  let v = S.validateFile(base({ subtitles: { a: { mirrors: ['https://m.example'], enabled: false, note: 'Back soon' }, ghost: { enabled: false } } }), new Set(['nyaa']), knownSub);
  check('a good subtitles map passes; unknown ids are ignored', v.ok && eq(Object.keys(v.file.subtitles), ['a']) && v.file.subtitles.a.enabled === false && v.file.subtitles.a.note === 'Back soon');
  check('a file without `subtitles` has no such key (older files, older apps)', S.validateFile(base(), new Set(), knownSub).file.subtitles === undefined);
  const dropS = (e) => S.validateFile(base({ subtitles: { a: e } }), new Set(), knownSub).file.subtitles.a;
  check('same caps as sources: https mirrors only, at most 5, note at most 140 plain', dropS({ mirrors: ['http://x.example'], enabled: false }).mirrors === undefined && dropS({ mirrors: Array.from({ length: 6 }, (_, i) => `https://m${i}.example`) }).mirrors === undefined && dropS({ mirrors: Array.from({ length: 5 }, (_, i) => `https://m${i}.example`) }).mirrors.length === 5 && dropS({ note: 'x'.repeat(141) }).note === undefined && dropS({ note: '<b>x</b>' }).note === undefined && dropS({ note: 'x'.repeat(140) }).note.length === 140);
  check('a bad field never costs the others', eq(dropS({ mirrors: 5, enabled: false, note: 'Gone' }), { enabled: false, note: 'Gone' }));
  check('subtitles of the wrong type drops only that field', (() => { const r = S.validateFile(base({ subtitles: ['a'], sources: { nyaa: { enabled: false } } }), new Set(['nyaa']), knownSub); return r.ok && r.file.subtitles === undefined && r.file.sources.nyaa.enabled === false; })());
  check('without `knownSubtitles` every id is kept (reading back a stored file)', Object.keys(S.validateFile(base({ subtitles: { zzz: { enabled: false } } })).file.subtitles).join() === 'zzz');
  check('the 256 KB cap and serial rule still apply', S.parseSourcesFile(JSON.stringify(base({ subtitles: { a: { note: 'x' } }, pad: 'x'.repeat(S.MAX_FILE_BYTES) })), new Set(), knownSub).reason === 'size' && S.parseSourcesFile(JSON.stringify(base({ serial: 0 })), new Set(), knownSub).reason === 'schema');
  check('parseSourcesFile passes the subtitle ids on', Object.keys(S.parseSourcesFile(JSON.stringify(base({ subtitles: { a: { enabled: false }, nope: { enabled: false } } })), new Set(), knownSub).file.subtitles).join() === 'a');
  const f1 = S.validateFile(base({ subtitles: { a: { enabled: false } } }), new Set(), knownSub).file;
  const f2 = S.validateFile(base({ subtitles: { a: { enabled: true }, b: { enabled: false } } }), new Set(), knownSub).file;
  check('changed-source count includes subtitle entries', C.countChangedSources(null, f1) === 1 && C.countChangedSources(f1, f2) === 2 && C.countChangedSources(f1, f1) === 0);
  store.setAppliedFile(v.file);
  check('store helpers: disabled, note, mirrors, entries', eq(store.listSubtitleDisabled('a'), { note: 'Back soon' }) && store.listSubtitleDisabled('b') === null && eq(store.listSubtitleMirrors('a'), ['https://m.example']) && Object.keys(store.listSubtitleEntries()).join() === 'a');
  check('an applied entry feeds enabledProviders: the user cannot turn it on', eq(ids(reg.enabledProviders({ enabled: true, sourceEnabled: { a: true, b: true } }, store.listSubtitleEntries(), [A, B])), ['b']));
  store.setAppliedFile(null);
  check('no applied file: nothing disabled, no entries', store.listSubtitleDisabled('a') === null && eq(store.listSubtitleEntries(), {}));
  const idx = read('utils/lists/index.ts');
  check('the list check passes the registry ids as known subtitle providers', /knownSubtitles:\s*new Set\(SUBTITLE_PROVIDERS/.test(idx));

  // ------------------------------------------------------------------ search orchestration
  console.log('[search]');
  const q1 = srch.buildQuery({ fileName: 'Show.S01E02.1080p.WEB-DL.x264-NTB.mkv', videoBytes: 1234, hash: '0123456789abcdef' }, ['en']);
  check('query from a file: name, size, hash, episode', q1.title === 'Show' && q1.season === 1 && q1.episode === 2 && q1.episodeConfidence === 'sure' && q1.hash === '0123456789abcdef' && q1.videoBytes === 1234 && eq(q1.languages, ['en']) && q1.year === undefined);
  const q2 = srch.buildQuery({ fileName: 'Film.2024.mkv', videoBytes: 9 }, ['de', 'en']);
  check('query without a hash, with a year', q2.hash === undefined && !('hash' in q2) && q2.year === 2024 && q2.episodeConfidence === 'none');
  const seen = [];
  const fake = (id, fn, extra = {}) => mk(id, true, { name: id.toUpperCase(), async search(q, ctx) { seen.push([id, q.hash, ctx.baseUrl]); return fn(q, ctx); }, ...extra });
  const c1 = (o) => ({ providerId: 'x', id: 'i', language: 'en', releaseName: 'R', matchedBy: 'release', ...o });
  const hang = () => new Promise(() => {});
  const providers = [
    fake('ok', async () => [c1({ id: 'ok1', matchedBy: 'hash' }), c1({ id: 'ok2', releaseName: 'Other', language: 'de' })]),
    fake('empty', async () => []),
    fake('limit', async () => { throw new http.ProviderError('http', 'HTTP 429', 429); }),
    fake('wall', async () => { throw new http.ProviderError('challenge', 'Needs a quick check', 403); }),
    fake('slow', hang),
    fake('boom', async () => { throw new Error('kaput'); }),
    fake('down', async () => { throw new http.ProviderError('http', 'HTTP 500', 500); }, { mirrors: ['https://one.example'] }),
  ];
  const updates = [];
  const t0 = Date.now();
  const res = await srch.searchSubtitles({ fileName: 'Show.S01E02.1080p.WEB-DL.x264-NTB.mkv', videoBytes: 1234, hash: '0123456789abcdef' }, { providers, languages: ['en', 'de'], hearingImpaired: 'both', waitSeconds: 0.2, onUpdate: (u) => updates.push(u) });
  const state = (id) => res.sources.find((s) => s.providerId === id).state;
  check('done, empty, limit (HTTP 429), challenge, timeout, error', state('ok') === 'done' && state('empty') === 'empty' && state('limit') === 'limit' && state('wall') === 'challenge' && state('slow') === 'timeout' && state('boom') === 'error' && state('down') === 'error');
  check('a hung source times out on its own clock and costs the others nothing', Date.now() - t0 < 2000 && res.ranked.length === 2);
  check('rows are merged, stamped with the provider id and ranked (hash first)', res.ranked[0].candidate.id === 'ok1' && res.ranked[0].group === 'fits' && res.ranked[0].candidate.providerId === 'ok' && res.ranked[1].candidate.language === 'de');
  check('status carries counts, and the source order is the given order', res.sources.find((s) => s.providerId === 'ok').count === 2 && eq(res.sources.map((s) => s.providerId), providers.map((p) => p.id)) && res.sources.every((s) => s.state !== 'searching'));
  check('every provider got the hash and a base URL; the query is returned', seen.every(([, h, b]) => h === '0123456789abcdef' && /^https:/.test(b)) && res.query.episode === 2);
  check('updates: a start snapshot, one per source, then done', updates[0].done === false && updates[0].sources.every((s) => s.state === 'searching') && updates.length === providers.length + 2 && updates[updates.length - 1].done === true);
  check('a throwing listener does not break the search', (await srch.searchSubtitles({ fileName: 'a.mkv', videoBytes: 1 }, { providers: [providers[0]], languages: ['en'], hearingImpaired: 'both', onUpdate() { throw new Error('x'); } })).ranked.length === 2);
  check('no providers: an empty, finished result', (await srch.searchSubtitles({ fileName: 'a.mkv', videoBytes: 1 }, { providers: [], languages: ['en'], hearingImpaired: 'both' })).done === true);
  const ac = new AbortController();
  const pending = srch.searchSubtitles({ fileName: 'a.mkv', videoBytes: 1 }, { providers: [fake('slow2', hang)], languages: ['en'], hearingImpaired: 'both', waitSeconds: 30, signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  const cancelled = await pending;
  check('cancelling ends the search at once', cancelled.done === true && cancelled.sources[0].state === 'error' && cancelled.sources[0].message === 'Cancelled');
  const tried = [];
  const retry = mk('retry', true, { mirrors: ['https://one.example', 'https://two.example', 'https://three.example'], async search(q, ctx) { tried.push(ctx.baseUrl); if (ctx.baseUrl === 'https://one.example') throw new http.ProviderError('network', 'down'); return [c1({})]; } });
  const rr = await srch.searchSubtitles({ fileName: 'a.mkv', videoBytes: 1 }, { providers: [retry], languages: ['en'], hearingImpaired: 'both' });
  check('a network error retries once on the next mirror', rr.sources[0].state === 'done' && eq(tried, ['https://one.example', 'https://two.example']));
  const tried2 = [];
  const noretry = mk('nr', true, { mirrors: ['https://one.example', 'https://two.example'], async search(q, ctx) { tried2.push(ctx.baseUrl); throw new http.ProviderError('http', 'HTTP 429', 429); } });
  await srch.searchSubtitles({ fileName: 'a.mkv', videoBytes: 1 }, { providers: [noretry], languages: ['en'], hearingImpaired: 'both' });
  check('a limit answer is not retried on another mirror', tried2.length === 1);
  check('failureCode maps what the copy needs', srch.failureCode(new http.ProviderError('http', 'x', 429)) === 'limit' && srch.failureCode(new http.ProviderError('timeout', 'x')) === 'timeout' && srch.failureCode(new http.ProviderError('blocked', 'x')) === 'challenge' && srch.failureCode(new http.ProviderError('http', 'x', 500)) === 'error' && srch.failureCode(new Error('x')) === 'error' && srch.failureCode(new pay.SubtitleError('NO_SPACE')) === 'NO_SPACE');

  console.log('[download]');
  const srt = (t) => utf8(`1\n00:00:01,000 --> 00:00:02,000\n${t}\n`);
  const prov = (payload) => mk('dl', true, { async download() { return typeof payload === 'function' ? payload() : payload; } });
  const dq = { fileName: 'Show.S01E03.1080p.WEB-DL.x264-NTB.mkv', season: 1, episode: 3 };
  const noZip = async () => { throw new Error('no zip expected'); };
  const dcand = c1({ language: 'de', hearingImpaired: true });
  let got = await srch.downloadAndPrepare(dcand, { provider: prov({ kind: 'text', bytes: srt('Hallo'), format: 'srt' }), query: dq, unzip: noZip });
  check('text payload: UTF-8 text, format and suggested name', got.text.includes('Hallo') && got.format === 'srt' && got.suggestedName === 'Show.S01E03.1080p.WEB-DL.x264-NTB.de.hi.srt');
  got = await srch.downloadAndPrepare(c1({ language: 'pl' }), { provider: prov({ kind: 'text', bytes: Uint8Array.from([...Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'), 0xbf, 0xf3, 0xb3, 0xe6]), format: 'srt' }), query: dq, unzip: noZip });
  check('a code page is decoded by language', got.text === '1\n00:00:01,000 --> 00:00:02,000\nżółć');
  got = await srch.downloadAndPrepare(c1({}), { provider: prov({ kind: 'text', bytes: utf8('WEBVTT\n\n00:01.000 --> 00:02.000\nHi'), format: 'srt' }), query: dq, unzip: noZip });
  check('the format comes from the content, not the provider', got.format === 'vtt' && got.suggestedName.endsWith('.en.vtt'));
  let unzipArg = null;
  const members = [{ name: 'Show.S01E02.srt', base64: Buffer.from(srt('two')).toString('base64') }, { name: 'Show.S01E03.srt', base64: Buffer.from(srt('three')).toString('base64') }];
  got = await srch.downloadAndPrepare(c1({}), { provider: prov({ kind: 'zip', bytes: bytes(0x50, 0x4b, 3, 4, 9, 9) }), query: dq, unzip: async (b64) => { unzipArg = b64; return members; } });
  check('zip payload: unzipped natively, the member for the episode is saved', got.text.includes('three') && unzipArg === Buffer.from([0x50, 0x4b, 3, 4, 9, 9]).toString('base64'));
  got = await srch.downloadAndPrepare(c1({}), { provider: prov({ kind: 'text', bytes: bytes(0x50, 0x4b, 3, 4, 9, 9), format: 'srt' }), query: dq, unzip: async () => members });
  check('a zip that was labelled text is still unzipped', got.text.includes('three'));
  const fails = async (payload, dep = {}, cand = c1({})) => { try { await srch.downloadAndPrepare(cand, { provider: prov(payload), query: dq, unzip: noZip, ...dep }); return null; } catch (e) { return e.code; } };
  check('a season pack without our episode is ambiguous', (await fails({ kind: 'zip', bytes: bytes(0x50, 0x4b, 3, 4) }, { unzip: async () => [members[0], { name: 'Show.S01E05.srt', base64: members[0].base64 }] })) === 'ambiguous_pack');
  check('RAR and 7z are refused', (await fails({ kind: 'zip', bytes: ascii('Rar!\x1a\x07\x00') })) === 'unsupported_archive' && (await fails({ kind: 'text', bytes: bytes(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), format: 'srt' })) === 'unsupported_archive');
  check('a zip the native side rejects is refused', (await fails({ kind: 'zip', bytes: bytes(0x50, 0x4b, 3, 4) }, { unzip: async () => { throw new Error('ARCHIVE_UNSAFE'); } })) === 'unsupported_archive');
  check('unreadable text is refused', (await fails({ kind: 'text', bytes: bytes(0xc4, 0xe3, 0xba, 0xc3), format: 'srt' }, {}, c1({ language: 'zh-CN' }))) === 'unreadable_text');
  check('a 429 on download is "limit"', (await fails(() => { throw new http.ProviderError('http', 'HTTP 429', 429); })) === 'limit');
  check('a timeout on download is "timeout"', (await fails(() => hang(), { waitSeconds: 0.05 })) === 'timeout');
  check('a bot check on download is "challenge"', (await fails(() => { throw new http.ProviderError('challenge', 'x', 403); })) === 'challenge');

  console.log(failed ? `\n${failed} failed` : '\nsubtitles: all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
