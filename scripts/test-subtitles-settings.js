#!/usr/bin/env node
// Settings > Subtitles (docs/NATIVE_CONTRACT.md 36.2, 36.9, 36.10): the page wiring, the languages order helpers,
// and the Sources screen with fake providers, including a source the signed list turned off.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`);
  }
}

(async () => {
  console.log('Subtitle settings');
  const S = await import('../utils/subtitleSettings.ts');
  const reg = await import('../utils/subtitles/providers/index.ts');
  const prefs = await import('../utils/subtitles/prefs.ts');
  const copy = await import('../utils/subtitles/copy.ts');
  const { SETTINGS_INDEX } = await import('../utils/settingsIndex.ts');

  console.log('[page]');
  const page = read('app/settings/subtitles.tsx');
  check('the three screens exist and are registered in the layout', ['subtitles', 'subtitle-languages', 'subtitle-sources'].every((n) => exists(`app/settings/${n}.tsx`) && read('app/_layout.tsx').includes(`name="settings/${n}"`)));
  check('master switch "Subtitles" with the contract subtitle', copy.SETTINGS_TITLE === 'Subtitles' && copy.SETTINGS_SWITCH_SUBTITLE === 'Show Find subtitles on videos' && /SETTINGS_SWITCH_SUBTITLE/.test(page) && /patch\(\{ enabled \}\)/.test(page));
  check('rows in order: switch, Languages, Hearing impaired, Sources, privacy line', (() => { const p = ['patch({ enabled })', 'copy.languages.title', 'copy.hearing.title', 'copy.sources.title', '<Caption>{PRIVACY_LINE}'].map((x) => page.indexOf(x)); return p.every((x, i) => x > 0 && (i === 0 || x > p[i - 1])); })());
  check('hearing options are Show both / Prefer / Avoid', eq(Object.values(copy.HEARING_OPTIONS), ['Show both', 'Prefer', 'Avoid']) && /hearingImpaired/.test(page));
  check('with the master switch off the other rows stay visible but are disabled', /const off = !sub\.enabled/.test(page) && /pointerEvents=\{off \? 'none' : 'auto'\}/.test(page) && /opacity: 0\.45/.test(page) && (page.match(/disabled=\{off\}/g) || []).length >= 2);
  check('the privacy line is the contract text', copy.PRIVACY_LINE === "Looking up subtitles sends the video's file name and a fingerprint of the file to the source you use. Nothing is sent until you tap Find subtitles.");
  check('the OpenSubtitles row is gated by hasOpenSubtitlesKey, which is false without a build key', /hasOpenSubtitlesKey\(\) \? \(/.test(page) && S.hasOpenSubtitlesKey() === false);
  check('settings are UI only: written through updateSettings({subtitles}), never toNativeConfig', /subtitles: \{ \.\.\.prev\.subtitles/.test(read('components/subtitles-settings/useSubtitleSettings.ts')) && !/subtitle/i.test(read('modules/maglev-engine/src/toNativeConfig.ts')));
  const tab = read('app/(tabs)/settings.tsx');
  check('the Settings tab lists Subtitles under Finding things', /findRows: RowSpec\[\][\s\S]*title: 'Subtitles'[^}]*route: 'subtitles'[\s\S]*?\];/.test(tab) && /icon: 'subtitles'/.test(tab));
  check('the subtitles icon exists', read('components/icons.generated.ts').includes('"subtitles":') && /subtitles: 'badge-captions'/.test(read('scripts/gen-icons.js')));
  check('every new row and screen is in the search index (rule 7)', ['subtitles-enabled', 'subtitles-languages', 'subtitles-hearing', 'subtitles-sources', 'subtitles-privacy', 'subtitle-languages-yours', 'subtitle-sources-list', 'updates-highlights'].every((id) => SETTINGS_INDEX.some((x) => x.id === id)));
  const kw = (id) => (SETTINGS_INDEX.find((x) => x.id === id) || { keywords: [] }).keywords.join(' ');
  check('search keywords cover captions, srt, cc, sdh, opensubtitles, providers, language', /captions/.test(kw('subtitles-enabled')) && /srt/.test(kw('subtitles-enabled')) && /\bcc\b/.test(kw('subtitles-enabled')) && /sdh/.test(kw('subtitles-hearing')) && /opensubtitles/.test(kw('subtitles-sources')) && /providers/.test(kw('subtitles-sources')) && /language/.test(kw('subtitles-languages')));

  console.log('[languages]');
  check('empty list shows the phone language', S.languagesValue([], 'en-US') === 'Phone language (English)' && S.phoneLanguageLabel('de-DE') === 'Phone language (German)');
  check('chosen languages are named, long lists are cut', S.languagesValue(['de', 'en'], 'en-US') === 'German, English' && S.languagesValue(['de', 'fr', 'es', 'it'], 'en-US') === 'German, French +2');
  check('an empty pick follows the phone: the order in force is phone then English', eq(S.languageOrder({ languages: [] }, 'de-DE'), ['de', 'en']) && eq(S.languageOrder({ languages: ['fr'] }, 'de-DE'), ['fr']));
  check('toggle adds at the end and removes', eq(S.toggleLanguage(['de'], 'fr'), ['de', 'fr']) && eq(S.toggleLanguage(['de', 'fr'], 'de'), ['fr']));
  check('move up and down swap one place', eq(S.moveLanguage(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']) && eq(S.moveLanguage(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']));
  check('moving past either end changes nothing', eq(S.moveLanguage(['a', 'b'], 'a', -1), ['a', 'b']) && eq(S.moveLanguage(['a', 'b'], 'b', 1), ['a', 'b']) && eq(S.moveLanguage(['a', 'b'], 'zz', 1), ['a', 'b']));
  check('moving returns a new array', (() => { const l = ['a', 'b']; return S.moveLanguage(l, 'a', 1) !== l && eq(l, ['a', 'b']); })());
  check('the picker hides chosen languages and searches by name, native name and code', (() => {
    const all = S.pickableLanguages([], '').length;
    const noDe = S.pickableLanguages(['de'], '');
    return all > 40 && noDe.length === all - 1 && !noDe.some((l) => l.code === 'de') && S.pickableLanguages([], 'deutsch').some((l) => l.code === 'de') && S.pickableLanguages([], 'GERM').some((l) => l.code === 'de') && S.pickableLanguages([], 'pt-br').some((l) => l.code === 'pt-BR') && S.pickableLanguages([], 'zzzzzz').length === 0;
  })());
  check('regional tags can be picked and kept in order', eq(S.toggleLanguage(S.toggleLanguage([], 'pt-BR'), 'zh-TW'), ['pt-BR', 'zh-TW']));
  const langScreen = read('app/settings/subtitle-languages.tsx');
  check('the languages screen: chosen on top with move up, move down and remove, then a search over all languages', langScreen.indexOf('copy.yours') < langScreen.indexOf('copy.all') && /moveLanguage\(chosen, code, -1\)/.test(langScreen) && /moveLanguage\(chosen, code, 1\)/.test(langScreen) && /copy\.remove\(name\)/.test(langScreen) && /pickableLanguages\(chosen, query\)/.test(langScreen) && /phoneLanguageLabel\(\)/.test(langScreen));

  console.log('[sources: wiring]');
  const src = read('app/settings/subtitle-sources.tsx');
  const search = read('app/settings/search-providers.tsx');
  check('built like Search sources: same page shell, rows, section headers and cards', /SettingsPage/.test(src) && /ProviderRow/.test(src) && /SectionHeader/.test(src) && /Card/.test(src) && /ProviderRow/.test(search) && /listsCopy\.providers\.turnedOff/.test(src) && /TURNED_OFF_BY_MAGLEV/.test(src));
  check('the row component is shared, not copied', exists('components/search-providers/ProviderRow.tsx') && !exists('components/subtitles-settings/SourceRow.tsx') && /toggleLabel/.test(read('components/search-providers/ProviderRow.tsx')));
  check('switches are stored in sourceEnabled through withSourceEnabled', /withSourceEnabled\(sub, id, on\)/.test(src) && /patch\(\{ sourceEnabled/.test(src));
  check('a turned-off source is locked and shows the note', /locked=\{!!r\.turnedOff\}/.test(src) && /turnedOffWithNote\(r\.turnedOff\.note\)/.test(src));
  check('the list-updated line is shown, with the same words as Updates', /listsCopy\.sources\.updated/.test(src) && /listsCopy\.sources\.builtIn/.test(src) && /copy\.listLine\(listLine\)/.test(src));
  check('re-reads when a new list is applied', /useListsVersion\(\)/.test(src) && /listSubtitleEntries\(\)/.test(src));
  check('an empty registry shows "No sources yet"', /rows\.length === 0/.test(src) && /empty: 'No sources yet'/.test(read('constants/copy.ts')));

  console.log('[sources: rows with fake providers]');
  const fake = (id, o = {}) => ({ id, name: o.name || id.toUpperCase(), homepage: `https://${id}.example`, mirrors: [`https://${id}.example`], languages: 'many', kinds: ['movie', 'episode'], matches: ['name'], group: 'A', enabledByDefault: true, search: async () => [], download: async () => ({ kind: 'text', bytes: new Uint8Array(), format: 'srt' }), ...o });
  const A = fake('alpha', { name: 'Alpha Subs', matches: ['hash', 'name'] });
  const B = fake('beta', { name: 'Beta', matches: ['imdb'], languages: ['de', 'fr'], enabledByDefault: false, group: 'B' });
  const C = fake('gamma', { name: 'Gamma', matches: ['hash', 'name', 'imdb'], languages: ['en', 'de', 'fr', 'es', 'it'] });
  const rows = S.sourceRows([A, B, C], { sourceEnabled: {} }, null);
  check('one row per provider, in registry order, with name and monogram', eq(rows.map((r) => r.id), ['alpha', 'beta', 'gamma']) && rows[0].name === 'Alpha Subs' && rows[0].abbr === 'AL');
  check('"matches by" reads fingerprint, name, IMDb', rows[0].matches === 'By fingerprint and name' && rows[1].matches === 'By IMDb' && rows[2].matches === 'By fingerprint, name and IMDb');
  check('languages read "Many languages", the list, or a short list with a count', rows[0].languages === 'Many languages' && rows[1].languages === 'German, French' && rows[2].languages === 'English, German, French and 2 more');
  check('on/off follows enabledByDefault when the user said nothing', eq(rows.map((r) => r.on), [true, false, true]));
  const mine = S.sourceRows([A, B, C], { sourceEnabled: prefs.withSourceEnabled({ sourceEnabled: {} }, 'beta', true) }, null);
  check('a user switch turns a source on', mine[1].on === true && mine[0].on === true);
  const mine2 = S.sourceRows([A, B, C], { sourceEnabled: prefs.withSourceEnabled({ sourceEnabled: {} }, 'alpha', false) }, null);
  check('and off', mine2[0].on === false);
  const ov = { alpha: { enabled: false, note: 'Back next week' }, beta: { enabled: false } };
  const off = S.sourceRows([A, B, C], { sourceEnabled: { alpha: true, beta: true } }, ov);
  check('"Turned off by Maglev": the list wins over the user switch and carries its note', off[0].on === false && off[0].turnedOff.note === 'Back next week' && off[1].on === false && off[1].turnedOff.note === null && off[2].turnedOff === null);
  check('turned-off text is the contract wording', copy.TURNED_OFF_BY_MAGLEV === 'Turned off by Maglev');
  check('the rows agree with enabledProviders (what actually runs)', eq(S.sourceRows([A, B, C], { sourceEnabled: { beta: true } }, ov).filter((r) => r.on).map((r) => r.id), reg.enabledProviders({ enabled: true, sourceEnabled: { beta: true } }, ov, [A, B, C]).map((p) => p.id)));
  check('the page value counts sources that are on, and says so when there are none', S.sourcesValue(rows) === '2 on' && S.sourcesValue(off) === '1 on' && S.sourcesValue([]) === 'None yet');
  check('with the shipped registry the rows build without error', Array.isArray(S.sourceRows(reg.SUBTITLE_PROVIDERS, { sourceEnabled: {} }, null)));

  console.log(failed ? `\n${failed} failed` : '\nsubtitle settings: all passed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
