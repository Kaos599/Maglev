#!/usr/bin/env node
// NATIVE_CONTRACT 45.5: "No results? Point to the sources that are off". The counting (adult excluded, languages,
// anime first, k = 0 shows nothing new), the strings, and the wiring. Pure: no rendering.
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
let failed = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

(async () => {
  const S = await import('../utils/search/offSources.ts');
  const O = await import('../utils/subtitles/offSources.ts');
  const copy = await import('../utils/subtitles/copy.ts');
  const C = await import('../constants/copy.ts');
  const M = await import('../components/subtitles/rowModel.ts');

  console.log('[search count]');
  const list = [
    { id: 'a', categories: ['all'] },
    { id: 'b', categories: ['movies'] },
    { id: 'c', categories: ['adult'], nsfw: true },
    { id: 'd', categories: ['adult'] },
    { id: 'e', categories: ['tv'], turnedOff: { note: null } },
    { id: 'torznab:x', categories: ['all'] },
  ];
  check('off and adult results off: adult and list-disabled sources are left out', S.countOffSources(list, ['a'], false) === 2);
  check('adult results on: adult sources count', S.countOffSources(list, ['a'], true) === 4);
  check('every source on: 0', S.countOffSources(list, ['a', 'b', 'c', 'd', 'e', 'torznab:x'], true) === 0);
  check('Torznab extras count', S.countOffSources([{ id: 'torznab:x', categories: ['all'] }], [], false) === 1);
  check('a repeated id counts once', S.countOffSources([{ id: 'a' }, { id: 'a' }], [], false) === 1);
  check('search strings', C.offSourcesSentence(1) === '1 more source is off.' && C.offSourcesSentence(3) === '3 more sources are off.');
  const none = C.empty.search.noResults('x');
  check('k = 0: body is unchanged', none.body === 'Nothing matches "x". Try fewer words or another category.' && C.empty.search.noResults('x', 0).body === none.body);
  check('k > 0: second sentence', C.empty.search.noResults('x', 3).body.endsWith(' 3 more sources are off.') && C.empty.search.noResults('x', 1).body.endsWith(' 1 more source is off.'));
  check('button label', C.SEARCH_TURN_ON_MORE === 'Turn on more sources');
  const search = read('app/(tabs)/search.tsx');
  check('search screen: count, button opens providers, re-run rides on searchKey', /countOffSources\(/.test(search) && /primary=\{offCount > 0 \? \{ label: SEARCH_TURN_ON_MORE, onPress: openProviders \}/.test(search) && /JSON\.stringify\(\[prefs\.enabled,/.test(search));
  check('"no source answered" block is unchanged', /empty\.search\.noAnswer\.title/.test(search));

  console.log('[subtitle count]');
  const P = (id, languages, extra = {}) => ({ id, name: id.toUpperCase(), languages, enabledByDefault: false, mirrors: [], ...extra });
  const provs = [P('en1', ['en']), P('fr1', ['fr']), P('many', 'many'), P('kit', ['en', 'ja'], { focus: 'anime' }), P('on', ['en'], { enabledByDefault: true }), P('ptbr', ['pt-BR'])];
  const prefs = { enabled: true, languages: ['en'], sourceEnabled: {} };
  let r = O.subtitleOffSources(prefs, null, { providers: provs });
  check('only off sources that cover a chosen language count (fr and pt-BR do not)', r.count === 3 && r.names.join() === 'EN1,MANY,KIT');
  r = O.subtitleOffSources({ ...prefs, languages: ['pt'] }, null, { providers: provs });
  check('a base language matches a regional one', r.count === 2 && r.names.join() === 'MANY,PTBR');
  r = O.subtitleOffSources({ ...prefs, languages: ['fr', 'en'] }, null, { providers: provs });
  check('any chosen language is enough', r.count === 4);
  r = O.subtitleOffSources(prefs, null, { providers: [P('nolang', [])] });
  check('no language data counts as every language', r.count === 1);
  r = O.subtitleOffSources(prefs, null, { providers: provs, anime: true });
  check('anime: the anime source comes first and is named', r.names[0] === 'KIT' && r.animeName === 'KIT' && r.count === 3);
  r = O.subtitleOffSources(prefs, null, { providers: provs });
  check('not anime: nothing named', r.animeName === null);
  r = O.subtitleOffSources({ ...prefs, sourceEnabled: { en1: true, many: true, kit: true } }, null, { providers: provs });
  check('k = 0 when the covering sources are on', r.count === 0 && r.animeName === null);
  r = O.subtitleOffSources(prefs, { en1: { enabled: false } }, { providers: provs });
  check('a source the signed list turned off does not count', !r.names.includes('EN1') && r.count === 2);
  r = O.subtitleOffSources({ ...prefs, enabled: false }, null, { providers: provs });
  check('master switch off: 0', r.count === 0);
  const real = require('fs').readFileSync(path.join(root, 'utils/subtitles/providers/kitsunekko.ts'), 'utf8');
  check('Kitsunekko is the anime-focused source', /focus: 'anime'/.test(real));
  check('anime detection: [Group] tag and absolute numbering', O.looksLikeAnime('[SubsPlease] Frieren - 12 (1080p).mkv') && O.looksLikeAnime('Show - 047.mkv') && !O.looksLikeAnime('Casino.Royale.2006.1080p.mkv') && !O.looksLikeAnime('Show.S01E02.mkv'));
  check('real list: default languages count only sources that cover them', O.subtitleOffSources({ enabled: true, languages: ['en'], sourceEnabled: {} }, null).count > 0);

  console.log('[subtitle strings and wiring]');
  check('sheet line', copy.offSourcesLine(3) === '3 more subtitle sources are off' && copy.offSourcesLine(1) === '1 more subtitle source is off');
  check('sheet line names the anime source', copy.offSourcesLine(3, 'Kitsunekko') === '3 more subtitle sources are off, including Kitsunekko' && copy.offSourcesLine(1, 'Kitsunekko') === '1 more subtitle source is off (Kitsunekko)');
  check('action label and multi tail', copy.TURN_ON_MORE_SOURCES === 'Turn on more sources' && copy.offSourcesTail(2) === '2 sources off' && copy.MORE_SOURCES === 'More sources');
  const base = { fileListKnown: true, started: true, canOpenSheet: true, phase: 'none' };
  let m = M.rowModel(base);
  check('row, k = 0: "No match yet", Edit name, no second button', m.line === 'No match yet' && m.button.label === 'Edit name' && !m.extra);
  m = M.rowModel({ ...base, offSources: 2 });
  check('row, k > 0: "No match yet · 2 sources off", Edit name stays, "More sources" second', m.line === 'No match yet · 2 sources off' && m.button.label === 'Edit name' && m.extra.label === 'More sources' && m.extra.action === 'more-sources');
  m = M.rowModel({ ...base, phase: 'saved', language: 'en', offSources: 2 });
  check('row: other phases ignore the count', !m.extra && !/off/.test(m.line));
  const sheet = read('components/subtitles/SubtitleSheet.tsx');
  check('single sheet: nothing block has the line, the action and keeps "Other language"', /offSourcesLine\(offSources\.count, offSources\.animeName\)/.test(sheet) && /TURN_ON_MORE_SOURCES/.test(sheet) && /errorCopy\('nothing'\)\.action/.test(sheet));
  check('single sheet: opens the sources screen and searches again on return', /subtitle-sources/.test(sheet) && /useIsFocused/.test(sheet) && /RETRY_SEARCH/.test(sheet));
  const multi = read('components/subtitles/MultiSubtitleSheet.tsx');
  check('multi sheet: summary tail links to the sources screen', /offSourcesTail\(offSources\.count\)/.test(multi) && /subtitle-sources/.test(multi));
  const rowTsx = read('components/subtitles/SubtitlesRow.tsx');
  check('page row: "More sources" opens the sources screen', /subtitle-sources/.test(rowTsx) && /offSources: off\.count/.test(rowTsx));
  check('npm test runs this file', /test-off-sources\.js/.test(read('package.json')));

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('off sources: all passed');
})();
