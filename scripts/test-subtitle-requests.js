#!/usr/bin/env node
// NATIVE_CONTRACT 44.7, 44.8, 44.9, 44.12: subtitle requests. Outcome table, phase roll-up, run planning and the
// retry limit, removal, the 100 cap, dedupe, the autoSince rule, copy and wiring. Pure: no rendering.
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
  const R = await import('../utils/subtitles/requests.ts');
  const copy = await import('../utils/subtitles/copy.ts');
  const types = await import('../modules/maglev-engine/src/MaglevSettings.types.ts');
  const Store = await import('../modules/maglev-engine/src/MaglevSettingsStore.ts');
  const F = await import('../components/subtitles/flow.ts');
  const row = (language, group, id = language + group) => ({ group, candidate: { id, providerId: 'p', language, releaseName: id } });
  const ask = (key, extra = {}) => ({ key, title: key, detail: '', ...extra });

  console.log('[outcome table]');
  let o = R.outcomeFromRanked([row('en', 'probably'), row('de', 'fits')], ['en', 'de']);
  check('a fits in a later language still saves', o.phase === 'saved' && o.pick.candidate.language === 'de');
  check('the first language with a fits wins (ranked order)', R.outcomeFromRanked([row('en', 'fits', 'b'), row('de', 'fits', 'a')], ['en', 'de']).pick.candidate.id === 'b');
  check('top-ranked fits of that language is the pick', R.outcomeFromRanked([row('en', 'fits', 'top'), row('en', 'fits', 'second')], ['en']).pick.candidate.id === 'top');
  o = R.outcomeFromRanked([row('en', 'probably'), row('en', 'maybe')], ['en']);
  check('only probably/maybe: needs-pick, never saved', o.phase === 'needs-pick' && !o.pick && !o.otherLang);
  o = R.outcomeFromRanked([row('fr', 'fits')], ['en']);
  check('results only in other languages: needs-pick with the language', o.phase === 'needs-pick' && o.otherLang === 'fr' && !o.pick);
  check('no results: none', R.outcomeFromRanked([], ['en']).phase === 'none');
  check('"Found in {other} only" copy', copy.foundInOtherOnly('fr') === 'Found in French only');
  const src = (state, message) => ({ providerId: 'x', state, count: 0, ms: 1, message });
  check('every source failed: offline', R.outcomeFromSources([src('error', 'Network request failed'), src('timeout')]) === 'offline');
  check('a source said limit: limited', R.outcomeFromSources([src('limit'), src('error')]) === 'limited');
  check('one answered: results decide', R.outcomeFromSources([src('empty'), src('error')]) === null);

  console.log('[roll-up for a pack]');
  check('saved only when all are saved', R.rollUp(['saved', 'saved']) === 'saved' && R.rollUp(['saved', 'none']) !== 'saved');
  check('needs-pick if any needs one', R.rollUp(['saved', 'needs-pick', 'searching']) === 'needs-pick');
  check('searching beats queued, then limited and offline', R.rollUp(['saved', 'searching', 'queued']) === 'searching' && R.rollUp(['queued', 'saved']) === 'queued' && R.rollUp(['limited', 'offline']) === 'limited');

  console.log('[run planning and retry limit]');
  const now = 1_000_000;
  const o1 = { started: true, complete: false, auto: true, typed: false, now, updatedAt: now };
  check('waits for bytes on disk', R.planRun({ phase: 'queued', tries: 0 }, { ...o1, started: false }) === null);
  check('queued with bytes: search by name', R.planRun({ phase: 'queued', tries: 0 }, o1) === 'name');
  check('none while downloading: no second run yet', R.planRun({ phase: 'none', tries: 1 }, o1) === null);
  check('finished + auto + none: once more with the fingerprint', R.planRun({ phase: 'none', tries: 1 }, { ...o1, complete: true }) === 'fingerprint');
  check('finished + auto + needs-pick: fingerprint', R.planRun({ phase: 'needs-pick', tries: 1 }, { ...o1, complete: true }) === 'fingerprint');
  check('tries stop at 2', R.planRun({ phase: 'none', tries: 2 }, { ...o1, complete: true }) === null);
  check('not from auto: no second run', R.planRun({ phase: 'none', tries: 1 }, { ...o1, complete: true, auto: false }) === null);
  check('a typed name never gets the fingerprint', R.planRun({ phase: 'none', tries: 1 }, { ...o1, complete: true, typed: true }) === null);
  check('saved and has-already never run again', R.planRun({ phase: 'saved', tries: 1 }, { ...o1, complete: true }) === null && R.planRun({ phase: 'has-already', tries: 0 }, o1) === null);
  check(
    'offline waits 30 s, limited 5 min',
    R.planRun({ phase: 'offline', tries: 0 }, { ...o1, now: now + 29_000 }) === null &&
      R.planRun({ phase: 'offline', tries: 0 }, { ...o1, now: now + 30_000 }) === 'name' &&
      R.planRun({ phase: 'limited', tries: 0 }, { ...o1, now: now + 299_000 }) === null &&
      R.planRun({ phase: 'limited', tries: 0 }, { ...o1, now: now + 300_000 }) === 'name',
  );
  check(
    'a settled run stops the file list refresh',
    R.runSettled({ phase: 'saved', tries: 1 }, { auto: true, typed: false }) &&
      !R.runSettled({ phase: 'none', tries: 1 }, { auto: true, typed: false }) &&
      R.runSettled({ phase: 'none', tries: 2 }, { auto: true, typed: false }) &&
      R.runSettled({ phase: 'none', tries: 1 }, { auto: false, typed: false }),
  );
  check('at most 2 searches at a time', R.MAX_CONCURRENT === 2 && R.MAX_TRIES === 2);

  console.log('[removal cancels the request]');
  check('present', R.absence(undefined, true, now).state === 'present');
  check('just gone: absent, since now', R.absence(undefined, false, now).state === 'absent' && R.absence(undefined, false, now).since === now);
  check('back before the grace: absent, then present again', R.absence(now, false, now + 10_000).state === 'absent' && R.absence(now, true, now + 10_000).state === 'present');
  check('past the undo window: delete', R.absence(now, false, now + R.REMOVAL_GRACE_MS).state === 'delete');
  const runner = read('components/subtitles/useSubtitleRequests.ts');
  check('the runner aborts, then deletes the request and its card state', /absence\(/.test(runner) && /c\.abort\(\)/.test(runner) && /deleteRequest\(key\)/.test(runner) && /forgetState\(/.test(runner));

  console.log('[store: dedupe, skip, cap]');
  R.resetRequestsForTests();
  R.askSubtitles([ask('t:aaa'), ask('d:1')], { auto: false });
  check('asked keys are queued', R.phasesFor(['t:aaa'])['t:aaa'] === 'queued' && R.phasesFor(['d:1'])['d:1'] === 'queued' && R.phasesFor(['d:9'])['d:9'] === undefined);
  R.askSubtitles([ask('t:aaa', { title: 'changed' })], { auto: true });
  check('a key already held is ignored (dedupe)', R.getRequests()['t:aaa'].ask.title === 't:aaa' && R.getRequests()['t:aaa'].auto === false && Object.keys(R.getRequests()).length === 2);
  R.askSubtitles([ask('d:1'), ask('d:1')], { auto: true });
  check('the same key twice in one call is held once', Object.keys(R.getRequests()).length === 2);
  R.setRun('d:1', null, { phase: 'saved', tries: 1 });
  R.askSubtitles([ask('d:1')], { auto: true });
  check('a saved key is not asked again', R.getRequests()['d:1'].phase === 'saved' && R.getRequests()['d:1'].tries === 1);
  R.skipSubtitles('t:aaa');
  check('skip marks the key skipped', R.phasesFor(['t:aaa'])['t:aaa'] === 'skipped');
  R.askSubtitles([ask('t:aaa')], { auto: true });
  check('a skipped key is never asked for again', R.phasesFor(['t:aaa'])['t:aaa'] === 'skipped');
  R.setAskSearchName('d:7', 'casino royale 2006');
  R.askSubtitles([ask('d:7')], { auto: false });
  check('a name typed in the sheet rides along', R.getRequests()['d:7'].ask.searchName === 'casino royale 2006');
  R.setFileList('d:7', ['a.mkv', 'b.mkv']);
  R.setRun('d:7', 'a.mkv', { phase: 'saved', tries: 1 });
  check('pack roll-up is stored', R.getRequests()['d:7'].phase === 'queued');
  R.setRun('d:7', 'b.mkv', { phase: 'saved', tries: 1 });
  check('all saved: the pack is saved', R.getRequests()['d:7'].phase === 'saved');
  R.deleteRequest('d:7');
  check('delete leaves nothing', !('d:7' in R.getRequests()));
  R.resetRequestsForTests();
  R.askSubtitles(
    Array.from({ length: 130 }, (_, i) => ask(`d:${i}`)),
    { auto: true },
  );
  check('at most 100 entries kept', Object.keys(R.getRequests()).length === 100);
  const all = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, { ask: ask(`k${i}`), auto: false, phase: 'queued', tries: 0, updatedAt: i }]));
  check('the oldest are dropped first', Object.keys(R.capRequests(all, 3)).sort().join() === 'k2,k3,k4');
  R.resetRequestsForTests();

  console.log('[automatic mode: autoSince]');
  const since = 5_000_000;
  check('off (no on-time): nothing is new', !R.isNewSince(null, 9e12, 9e12));
  check('added at or after the on-time is new', R.isNewSince(since, since, 0) && R.isNewSince(since, since + 1, 0));
  check('added before the on-time is not', !R.isNewSince(since, since - 1, since + 100));
  check('no addedAt: the first time seen counts', R.isNewSince(since, null, since + 1) && !R.isNewSince(since, undefined, since - 1) && R.isNewSince(since, 0, since));
  check('addedAt in seconds is read as ms', R.addedAtMs(1_700_000_000) === 1_700_000_000_000 && R.addedAtMs(1_700_000_000_000) === 1_700_000_000_000 && R.addedAtMs(0) === null);
  R.syncAutoSince(false);
  check('off: no on-time', R.getAutoSince() === null);
  R.syncAutoSince(true, 1234);
  R.syncAutoSince(true, 9999);
  check('on sets it once and keeps it', R.getAutoSince() === 1234);
  R.syncAutoSince(false);
  check('off clears it', R.getAutoSince() === null);
  check('the runner asks for new transfers only in auto mode, by the rule', /sub\.autoNewVideos/.test(runner) && /isNewSince\(since/.test(runner) && /askSubtitles\(fresh, \{ auto: true \}\)/.test(runner));
  check('links count as video by fileKind; every search uses effectiveLanguages', /fileKind\(d\.name\) !== 'video'/.test(runner) && /effectiveLanguages\(sub\)/.test(runner));

  console.log('[copy and settings]');
  check('the settings line', copy.AUTO_NEW_VIDEOS_SUBTITLE === 'In your languages, while Maglev is open');
  const page = read('app/settings/subtitles.tsx');
  check('the Settings switch', /title="Get subtitles for new videos"/.test(page) && /AUTO_NEW_VIDEOS_SUBTITLE/.test(page) && /autoNewVideos/.test(page) && /syncAutoSince/.test(page));
  const { SETTINGS_INDEX } = await import('../utils/settingsIndex.ts');
  check('searchable in Settings search', SETTINGS_INDEX.some((e) => e.page === 'subtitles' && e.title === 'Get subtitles for new videos'));
  check('autoNewVideos defaults off', types.DEFAULT_SETTINGS.subtitles.autoNewVideos === false);
  check(
    'it round-trips and bad values fall back',
    Store.migrateSettings({ settings: { subtitles: { autoNewVideos: true } } }).subtitles.autoNewVideos === true &&
      Store.migrateSettings({ settings: { subtitles: { autoNewVideos: 'yes' } } }).subtitles.autoNewVideos === false &&
      Store.migrateSettings({ settings: {} }).subtitles.autoNewVideos === false,
  );
  check('UI only: toNativeConfig never reads it', !/autoNewVideos/.test(read('modules/maglev-engine/src/toNativeConfig.ts')));

  console.log('[card icon by shape, 44.8]');
  check(
    'labels say the state in words',
    F.cardIconLabel({ state: 'getting', lang: 'en' }).startsWith('Getting subtitles') &&
      F.cardIconLabel({ state: 'saved', lang: 'en' }).startsWith('Subtitles saved') &&
      F.cardIconLabel({ state: 'needs-look', lang: 'en' }).startsWith('Subtitles: pick one') &&
      F.cardIconLabel({ state: 'none', lang: 'en' }).startsWith('No subtitles found'),
  );
  const icon = read('components/subtitles/SubtitleCardIcon.tsx');
  check('no warning colour, no hex, theme roles only', !/colors\.warning/.test(icon) && !/#[0-9A-Fa-f]{3,6}\b/.test(icon) && /colors\.accentText/.test(icon) && /colors\.textMuted/.test(icon));
  check('badges sit on a 2 dp grid', /const CELL = 2/.test(icon));
  const prefs = await import('../utils/subtitles/prefs.ts');
  const t0 = 1_700_000_000_000;
  check('a "none" state shows for 24 h like the others', prefs.stateVisible({ lang: 'en', file: '', savedAt: t0, state: 'none' }, t0 + 23 * 3600e3) && !prefs.stateVisible({ lang: 'en', file: '', savedAt: t0, state: 'none' }, t0 + 25 * 3600e3));

  console.log('[multi-video sheet, 44.9]');
  check('title and button copy', copy.multiTitle(3) === 'Subtitles for 3 videos' && copy.multiButton(2) === 'Get subtitles for 2' && copy.multiButton(0) === 'Get subtitles' && copy.USES_YOUR_LANGUAGES === 'Uses your subtitle languages');
  const a = { key: 'a', title: 'Show S01', detail: '1080p', addedAt: new Date(2026, 0, 1, 9, 5).getTime() };
  const b = { key: 'b', title: 'Show S01', detail: '1080p', addedAt: new Date(2026, 0, 1, 14, 30).getTime() };
  const c = { key: 'c', title: 'Other', detail: '720p', addedAt: a.addedAt };
  const t = R.rowTitles([a, b, c]);
  check('identical rows get " - added h:mm", others stay', t[0] === 'Show S01 · added 9:05' && t[1] === 'Show S01 · added 2:30' && t[2] === 'Other');
  check('footnotes', copy.nonVideoOne('Abbey Road') === 'Abbey Road is music, so it gets no subtitles.' && copy.nonVideoMany(3) === '3 other adds are not videos, so they get no subtitles.');
  check('status words and summary', copy.PHASE_WORDS.queued === 'Waiting for the file' && copy.PHASE_WORDS['needs-pick'] === 'Close match · pick' && copy.statusSummary({ saved: 2, needsYou: 1, waiting: 0 }) === '2 saved · 1 needs you');
  const sheet = read('components/subtitles/MultiSubtitleSheet.tsx');
  check('sheet: pencil, 44 dp checkbox, skip, no hex', /icon="pencil"/.test(sheet) && /width: 44, height: 44/.test(sheet) && /skipSubtitles/.test(sheet) && !/#[0-9A-Fa-f]{6}\b/.test(sheet));
  check('the runner is mounted once in the layout', (read('app/_layout.tsx').match(/<SubtitleRequestRunner \/>/g) || []).length === 1);

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('subtitle requests: all passed');
})();
