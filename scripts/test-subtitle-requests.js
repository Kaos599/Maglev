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
  check('every source failed while the phone is offline: offline', R.outcomeFromSources([src('error', 'Network request failed'), src('timeout')], false) === 'offline');
  check('every source failed with the phone online: failed, not offline (D8)', R.outcomeFromSources([src('error', 'Network request failed'), src('timeout')], true) === 'failed');
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
  check('D3: not from auto: the fingerprint run still happens', R.planRun({ phase: 'none', tries: 1 }, { ...o1, complete: true, auto: false }) === 'fingerprint');
  check('a typed name never gets the fingerprint', R.planRun({ phase: 'none', tries: 1 }, { ...o1, complete: true, typed: true }) === null);
  check('saved and has-already never run again', R.planRun({ phase: 'saved', tries: 1 }, { ...o1, complete: true }) === null && R.planRun({ phase: 'has-already', tries: 0 }, o1) === null);
  check(
    'D8: offline has no timer: it goes when the network is back; limited waits 5 min',
    R.planRun({ phase: 'offline', tries: 0 }, { ...o1, now: now + 1e9, online: false }) === null &&
      R.planRun({ phase: 'offline', tries: 0 }, { ...o1, now, online: true }) === 'name' &&
      R.planRun({ phase: 'limited', tries: 0, retryAt: now + 300_000 }, { ...o1, now: now + 299_000 }) === null &&
      R.planRun({ phase: 'limited', tries: 0, retryAt: now + 300_000 }, { ...o1, now: now + 300_000 }) === 'name',
  );
  check(
    'a settled run stops the file list refresh',
    R.runSettled({ phase: 'saved', tries: 1 }, { auto: true, typed: false }) &&
      !R.runSettled({ phase: 'none', tries: 1 }, { auto: true, typed: false }) &&
      R.runSettled({ phase: 'none', tries: 2 }, { auto: true, typed: false }) &&
      R.runSettled({ phase: 'none', tries: 1 }, { typed: true }),
  );
  check('at most 2 searches at a time', R.MAX_CONCURRENT === 2 && R.MAX_TRIES === 2);

  console.log('[removal cancels the request]');
  check('present', R.absence(undefined, true, now).state === 'present');
  check('just gone: absent, since now', R.absence(undefined, false, now).state === 'absent' && R.absence(undefined, false, now).since === now);
  check('back before the grace: absent, then present again', R.absence(now, false, now + 10_000).state === 'absent' && R.absence(now, true, now + 10_000).state === 'present');
  check('past the undo window: delete', R.absence(now, false, now + R.REMOVAL_GRACE_MS).state === 'delete');
  const runner = read('components/subtitles/useSubtitleRequests.ts');
  check('the runner aborts, then deletes the request and its card state', /absence\(/.test(runner) && /abortKey\(key\)/.test(runner) && /deleteRequest\(key\)/.test(runner) && /forgetAll\(/.test(runner));

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
  R.setPresentKeys(new Set());
  R.askSubtitles(
    Array.from({ length: 130 }, (_, i) => ask(`d:${i}`)),
    { auto: true },
  );
  for (let i = 0; i < 130; i++) R.setRun(`d:${i}`, null, { phase: 'none', tries: 1 });
  check('F3: settled requests of absent transfers are capped at 100', Object.keys(R.getRequests()).length === 100);
  const all = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, { ask: ask(`k${i}`), auto: false, phase: 'none', tries: 0, updatedAt: i }]));
  check('the oldest are dropped first', Object.keys(R.capRequests(all, 3, new Set())).sort().join() === 'k2,k3,k4');
  R.resetRequestsForTests();

  console.log('[automatic mode: baseline (D5)]');
  check('the runner asks for new transfers only in auto mode, by the baseline rule', /sub\.autoNewVideos/.test(runner) && /isNewTransfer\(key, baseline\)/.test(runner) && /askSubtitles\(fresh, \{ auto: true, byRunner: true \}\)/.test(runner));
  check('links count as video by their name; every search uses effectiveLanguages', /linkNameKind\(d\.name\)/.test(runner) && /effectiveLanguages\(sub\)/.test(runner));

  console.log('[copy and settings]');
  check('the settings line', copy.AUTO_NEW_VIDEOS_SUBTITLE === 'In your languages, while Maglev is open');
  const page = read('app/settings/subtitles.tsx');
  check('the Settings switch', /title="Get subtitles for new videos"/.test(page) && /AUTO_NEW_VIDEOS_SUBTITLE/.test(page) && /autoNewVideos/.test(page) && /useSubtitleConsent/.test(page));
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
  check('D6: identical rows get " · 2nd", the first and others stay', t[0] === 'Show S01' && t[1] === 'Show S01 · 2nd' && t[2] === 'Other');
  check('footnotes', copy.nonVideoOne('Abbey Road') === 'Abbey Road is music, so it gets no subtitles.' && copy.nonVideoMany(3) === '3 other adds are not videos, so they get no subtitles.');
  check('status words and summary', copy.PHASE_WORDS.queued === 'Waiting for the file' && copy.PHASE_WORDS['needs-pick'] === 'Close match · pick' && copy.statusSummary({ saved: 2, needsYou: 1, waiting: 0 }) === '2 saved · 1 needs you');
  const sheet = read('components/subtitles/MultiSubtitleSheet.tsx');
  check('sheet: pencil, 44 dp checkbox, skip, no hex', /icon="pencil"/.test(sheet) && /width: (?:44|touch\.min), height: (?:44|touch\.min)/.test(sheet) && /skipSubtitles/.test(sheet) && !/#[0-9A-Fa-f]{6}\b/.test(sheet));
  check('the runner is mounted once in the layout', (read('app/_layout.tsx').match(/<SubtitleRequestRunner \/>/g) || []).length === 1);


  // ============================================================ NATIVE_CONTRACT 44.15
  {
    const TR = await import('../utils/addedTray.ts');
    const MK = await import('../utils/mediaKind.ts');
    const RM = await import('../components/subtitles/rowModel.ts');
    const PF = await import('../utils/subtitles/prefs.ts');
    const ST = await import('../components/subtitles/stateStore.ts');
    const noop = () => {};
    const askOf = (key, o = {}) => ({ key, title: key, detail: '', ...o });
    const tryAdd = (state, hash, name, o = {}) => TR.mergeAdd(state, { hash, name, ask: TR.buildAsk({ infoHash: hash, name }), auto: !!o.auto, phase: o.phase }, o.now ?? 1000);
    const MOVIE = 'The.Prestige.2006.1080p.BluRay.x264-GRP';

    console.log('[44.15 D1 skip aborts and is never overwritten]');
    R.resetRequestsForTests();
    R.askSubtitles([askOf('t:aa')], { auto: false });
    R.setFileList('t:aa', ['a.mkv']);
    const ctl1 = new AbortController();
    R.registerRun('t:aa', 'a.mkv', ctl1);
    R.skipSubtitles('t:aa');
    check('D1: skip aborts the running search through the shared registry', ctl1.signal.aborted);
    R.setRun('t:aa', 'a.mkv', { phase: 'saved', tries: 1 });
    check('D1: a run that finishes late never overwrites skipped', R.getRequests()['t:aa'].phase === 'skipped' && R.getRequests()['t:aa'].files['a.mkv'].phase === 'skipped');
    check('D1: requests.ts and the runner share the one registry', /registerRun\(key, fileKey, ctl\)/.test(runner) && /abortKey\(key\)/.test(R.skipSubtitles.toString()));
    let tray = tryAdd(null, 'aaa', MOVIE, { auto: true });
    tray = tryAdd(tray, 'bbb', 'Inception.2010.1080p.BluRay.x264-GRP');
    tray = TR.markAsked(tray, ['t:bbb']);
    const sk = TR.skipAsked(tray);
    check('D1: the tray Skip skips only what it asked for in automatic mode, never a Get subtitles ask', sk.keys.join() === 't:aaa' && sk.state.items.find((x) => x.hash === 'bbb').sub === 'asked');

    console.log('[44.15 D2 unticking]');
    check('D2: an unticked row is simply not asked and gets no mark', TR.markAsked(tryAdd(tryAdd(null, 'aaa', MOVIE), 'bbb', 'Inception.2010.1080p.BluRay.x264-GRP'), ['t:aaa']).items.find((x) => x.hash === 'bbb').sub === 'none');
    check('D2: confirm in choose mode never calls skipSubtitles', !/skipSubtitles/.test(read('components/search/AddedTray.tsx').split('const confirm')[1].split('const skip')[0]));

    console.log('[44.15 D3 exact re-check for everyone]');
    check('D3: a manual ask runs the fingerprint once more; a typed name never does; never beyond 2 tries', R.planRun({ phase: 'needs-pick', tries: 1 }, { ...{ started: true, complete: true, typed: false, now: 5 }, auto: false }) === 'fingerprint' && R.planRun({ phase: 'none', tries: 1 }, { started: true, complete: true, typed: true, now: 5 }) === null && R.planRun({ phase: 'none', tries: 2 }, { started: true, complete: true, typed: false, now: 5 }) === null);

    console.log('[44.15 D4 not this one]');
    R.resetRequestsForTests();
    R.markNotThisOne([askOf('t:nn')]);
    check('D4: an Add screen with its switch off writes a skipped mark', R.phasesFor(['t:nn'])['t:nn'] === 'skipped');
    R.askSubtitles([askOf('t:nn')], { auto: true, byRunner: true });
    check('D4: the runner never asks for a marked key', R.phasesFor(['t:nn'])['t:nn'] === 'skipped');
    R.askSubtitles([askOf('t:held')], { auto: false });
    R.markNotThisOne([askOf('t:held')]);
    check('D4: a held request is not overwritten by the mark', R.phasesFor(['t:held'])['t:held'] === 'queued');
    check('D4: both Add screens write it', /markNotThisOne/.test(read('app/add-torrent.tsx')) && /markNotThisOne/.test(read('app/add-download.tsx')));
    check('D4: a Search add of a non-video writes nothing (no ask, no request)', tryAdd(null, 'mmm', 'Hans Zimmer - Interstellar (Original Soundtrack)').items.length === 1 && !MK.isVideoResult({ name: 'Hans Zimmer - Interstellar (Original Soundtrack)' }) && !read('app/(tabs)/search.tsx').includes('markNotThisOne'));

    console.log('[44.15 D5 what counts as new]');
    R.syncAutoBaseline(false, null);
    check('D5: switched on before the lists are live: waits for the first live load', R.syncAutoBaseline(true, null) === 'pending' && R.getAutoBaseline() === null);
    check('D5: the first live load stores the ids present', R.syncAutoBaseline(true, ['t:aa', 'd:1']) === 'taken' && R.getAutoBaseline().has('d:1'));
    check('D5: later loads keep it', R.syncAutoBaseline(true, ['t:aa', 'd:1', 't:new']) === 'kept' && !R.getAutoBaseline().has('t:new'));
    check('D5: new = not in the baseline; no baseline = nothing new; no clock or addedAt', R.isNewTransfer('t:new', R.getAutoBaseline()) && !R.isNewTransfer('t:aa', R.getAutoBaseline()) && !R.isNewTransfer('t:x', null) && !/addedAt/.test(runner));
    R.syncAutoBaseline(false, null);
    check('D5: off clears it', R.getAutoBaseline() === null);

    console.log('[44.15 D6 same-looking rows]');
    check('D6: ordinals in add order', copy.ordinalSuffix(2) === ' · 2nd' && copy.ordinalSuffix(3) === ' · 3rd' && copy.ordinalSuffix(4) === ' · 4th' && copy.ordinalSuffix(11) === ' · 11th' && copy.ordinalSuffix(21) === ' · 21st');
    const sameRows = R.rowTitles([askOf('x', { title: 'Show S01E01', detail: '1080p' }), askOf('y', { title: 'Show S01E01', detail: '1080p' }), askOf('z', { title: 'Show S01E01', detail: '1080p' })]);
    check('D6: first plain, then 2nd and 3rd', sameRows.join('|') === 'Show S01E01|Show S01E01 · 2nd|Show S01E01 · 3rd');
    check('D6: the h:mm rule is gone', !('addedAtSuffix' in copy) && !('clockHm' in R));

    console.log('[44.15 D7 packs]');
    check('D7: a pack row has no pencil', R.isPackAsk(askOf('p', { title: 'Severance S01 · 10 episodes' })) && R.isPackAsk(askOf('p', { title: 'Severance S01' })) && !R.isPackAsk(askOf('p', { title: 'Severance S01E01' })) && /canEdit = !pack/.test(read('components/subtitles/MultiSubtitleSheet.tsx')));
    check('D7: the pack card shows ? if any needs a pick, check if all saved, else the ring', R.packCardState(['saved', 'needs-pick']) === 'needs-look' && R.packCardState(['saved', 'saved']) === 'saved' && R.packCardState(['saved', 'searching']) === 'getting' && R.packCardState(['none', 'saved']) === 'none');
    check('D7: the roll-up is written whenever an episode run changes', /packCardState/.test(runner) && /recordOwnerState/.test(runner));
    const packFacts = RM.torrentRowFacts({ finished: false, folder: '/x' }, [{ index: 0, path: 'a.mkv', length: 10, progressBytes: 5, included: true }, { index: 1, path: 'b.mkv', length: 10, progressBytes: 0, included: true }], { master: true, sourcesOn: 1 }, false);
    const packRow = RM.rowModel({ fileListKnown: false, started: true, canOpenSheet: false, canAskPack: packFacts.canAskPack });
    check('D7: a pack page row with no request says "Not asked yet" with Get subtitles', packRow.line === 'Not asked yet' && packRow.button.label === 'Get subtitles' && packRow.button.action === 'ask-pack');

    console.log('[44.15 D8 failures are not offline]');
    const T0 = 1_000_000;
    let r1 = R.afterFailure('failed', { phase: 'searching', tries: 0 }, T0);
    check('D8: 1st failure counts and retries after 2 min', r1.phase === 'queued' && r1.fails === 1 && r1.retryAt === T0 + 120_000);
    let r2 = R.afterFailure('failed', r1, T0);
    check('D8: 2nd failure retries after 10 min', r2.phase === 'queued' && r2.fails === 2 && r2.retryAt === T0 + 600_000);
    const r3 = R.afterFailure('failed', r2, T0);
    check('D8: 3rd failure ends as failed', r3.phase === 'failed' && r3.fails === 3);
    check('D8: limited keeps its wait and stops after 3 attempts', R.afterFailure('limited', { phase: 'searching', tries: 0 }, T0).retryAt === T0 + R.LIMITED_RETRY_MS && R.afterFailure('limited', { phase: 'searching', tries: 0, fails: 2 }, T0).phase === 'failed');
    check('D8: offline never counts an attempt and has no timer', R.afterFailure('offline', { phase: 'searching', tries: 1, fails: 1 }, T0).fails === 1 && R.retryAt(R.afterFailure('offline', { phase: 'searching', tries: 0 }, T0)) === null);
    check('D8: a retry time in the future holds the run', R.planRun(r1, { started: true, complete: false, typed: false, now: T0 + 1000 }) === null && R.planRun(r1, { started: true, complete: false, typed: false, now: T0 + 120_000 }) === 'name');
    const failedRow = RM.rowModel({ phase: 'failed', fileListKnown: true, started: true, canOpenSheet: true });
    check('D8: failed reads "Sources didn\'t answer" with Try again', failedRow.line === "Sources didn't answer" && failedRow.button.label === 'Try again' && failedRow.button.action === 'try-again');
    R.resetRequestsForTests();
    R.askSubtitles([askOf('d:f1')], { auto: false });
    R.setRun('d:f1', null, { phase: 'failed', tries: 1, fails: 3 });
    R.retryRequest('d:f1');
    check('D8: Try again requeues with a clean count', R.getRequests()['d:f1'].phase === 'queued' && R.getRequests()['d:f1'].fails === undefined);
    check('D8: no 30 s offline polling any more', !('OFFLINE_RETRY_MS' in R) && /networkOnline/.test(runner));

    console.log('[44.15 D9 cannot save here]');
    const unavailable = RM.rowModel({ phase: 'unavailable', fileListKnown: true, started: true, canOpenSheet: true });
    check('D9: unavailable has its line and no button', unavailable.line === "Can't save subtitles in this folder" && unavailable.button === null);
    check('D9: it is settled (the runner stops polling) and not "none"', R.runSettled({ phase: 'unavailable', tries: 0 }, { typed: false }) && R.rollUp(['unavailable']) === 'unavailable' && /phase: 'unavailable'/.test(runner));

    console.log('[44.15 D10 consent before asking]');
    const next = PF.acceptPrivacy({ autoNewVideos: true })({ subtitles: { ...types.DEFAULT_SETTINGS.subtitles, languages: ['fr'] } });
    check('D10: accepting is a functional update that keeps fresh values and sets the OK', next.subtitles.privacyAck === true && next.subtitles.autoNewVideos === true && next.subtitles.languages[0] === 'fr');
    check('D10: the runner never shows a notice', !/showNotice|privacyNotice|consentShown/.test(runner));
    check('D10: the runner makes no automatic request before the OK', /sub\.autoNewVideos && sub\.privacyAck/.test(runner));
    const heldRow = RM.rowModel({ phase: 'queued', needsOk: true, fileListKnown: true, started: true, canOpenSheet: true });
    check('D10: a held request reads "Needs your OK" with Review', heldRow.line === 'Needs your OK' && heldRow.button.label === 'Review' && heldRow.button.action === 'review');
    check('D10: the notice is shown at opt-in: Settings switch, Add switch, tray and row', /consent\.require/.test(read('app/settings/subtitles.tsx')) && /consent\.require/.test(read('components/search/SubtitlesAutoRow.tsx')) && /consent\.require/.test(read('components/search/AddedTray.tsx')) && /consent\.require/.test(read('components/subtitles/SubtitlesRow.tsx')));
    check('D10: it reuses the existing notice text and the single sheet accepts the same way', /privacyNotice\(names\)/.test(read('components/subtitles/useSubtitleConsent.tsx')) && /acceptPrivacy\(\)/.test(read('components/subtitles/SubtitleSheet.tsx')));

    console.log('[45.4 confirm before automatic mode turns on]');
    check('45.4 copy: title, body and buttons', copy.AUTO_CONFIRM_TITLE === 'Get subtitles for new videos?' && copy.AUTO_CONFIRM_BODY === 'While Maglev is open, it sends the names of new videos you add to your subtitle sources, and saves a subtitle when one fits. Close matches wait for you.' && copy.AUTO_CONFIRM_TURN_ON === 'Turn on' && copy.AUTO_CONFIRM_NOT_NOW === 'Not now');
    check('45.4 notice already accepted: the sheet says only the confirm text', copy.autoConfirmBody(false, ['A']) === copy.AUTO_CONFIRM_BODY);
    check('45.4 notice never accepted: the privacy text comes first in the same sheet', copy.autoConfirmBody(true, ['A', 'B']) === `${copy.privacyNotice(['A', 'B'])}\n\n${copy.AUTO_CONFIRM_BODY}`);
    const hook = read('components/subtitles/useSubtitleConsent.tsx');
    check('45.4 confirm shows even when no notice is due, and Turn on accepts the notice only when it was due', /!needsOk && !opts\?\.confirm/.test(hook) && /if \(needsOk\) updateSettings\(acceptPrivacy\(p\?\.more\)\)/.test(hook) && /AUTO_CONFIRM_TURN_ON/.test(hook) && /autoConfirmBody\(needsOk, names\)/.test(hook));
    check('45.4 the Settings switch always confirms; the Add-screen Auto switch does not', /\{ confirm: true \}/.test(read('app/settings/subtitles.tsx')) && !/confirm/.test(read('components/search/SubtitlesAutoRow.tsx')));

    console.log('[44.15 D11 a manual save updates the request]');
    R.resetRequestsForTests();
    R.askSubtitles([askOf('d:m1'), askOf('t:pk')], { auto: false });
    R.setFileList('t:pk', ['e1.mkv', 'e2.mkv']);
    R.markSaved('d:m1');
    R.markSaved('t:pk', 'e1.mkv');
    check('D11: the sheet\'s save makes the request saved (a pack: that episode)', R.getRequests()['d:m1'].phase === 'saved' && R.getRequests()['t:pk'].files['e1.mkv'].saved === true && R.getRequests()['t:pk'].phase === 'queued');
    check('D11: a taken name after Maglev saved is saved, not has-already; before it, has-already', R.resolveExisting({ saved: true }) === 'saved' && R.resolveExisting({}) === 'has-already');
    check('D11: the sheet calls markSaved', /markSaved\(t\.ownerKey/.test(read('components/subtitles/SubtitleSheet.tsx')));

    console.log('[44.15 D12 rename]');
    R.resetRequestsForTests();
    R.askSubtitles([askOf('d:r1')], { auto: false });
    const ctlR = new AbortController();
    R.registerRun('d:r1', null, ctlR);
    R.renameRequest('d:r1', 'new name');
    check('D12: rename aborts the running search and bumps the epoch', ctlR.signal.aborted && R.getRequests()['d:r1'].epoch === 1 && R.getRequests()['d:r1'].ask.searchName === 'new name');
    R.setRun('d:r1', null, { phase: 'has-already', tries: 1 }, { epoch: 0 });
    check('D12: a finishing run with an old epoch is dropped', R.getRequests()['d:r1'].phase === 'queued' && R.epochOk(R.getRequests()['d:r1'], 1) && !R.epochOk(R.getRequests()['d:r1'], 0));
    check('D12: the pencil is hidden on saved rows', /phase !== 'saved'/.test(read('components/subtitles/MultiSubtitleSheet.tsx')));

    console.log('[44.15 D13 one video test]');
    check('D13: release tokens count even with no year', MK.isVideoResult({ name: 'Some.Show.WEB.x265' }) && MK.isVideoResult({ name: 'Thing.HDR.2160p' }) && MK.isVideoResult({ name: 'Movie.REMUX' }));
    check('D13: category Movies/TV/Anime count; music, books, apps and games never', MK.isVideoResult({ category: 'Movies', name: 'x' }) && !MK.isVideoResult({ category: 'Music', name: 'Album 2014 1080p' }) && !MK.isVideoResult({ name: 'Artist - Album 2014 FLAC' }) && !MK.isVideoResult({ name: 'Some Game REPACK 2020' }));
    check('D13: a link with no extension yet is unknown, not skipped', R.linkNameKind('download') === 'unknown' && R.linkNameKind('movie.mkv') === 'video' && R.linkNameKind('a.zip') === 'not-video');

    console.log('[44.15 F1 getDetail backoff]');
    check('F1: 5 s, doubling, up to 60 s', [0, 1, 2, 3, 4, 5, 9].map(R.detailBackoffMs).join() === '0,5000,10000,20000,40000,60000,60000');
    check('F1: next fetch time follows the last failure or success', R.nextDetailAt({ fail: { fails: 2, at: 1000 } }) === 11_000 && R.nextDetailAt({ lastOkAt: 1000 }) === 6000 && R.nextDetailAt({}) === 0);
    check('F1: at most 3 calls in flight', R.detailDue({ needed: true, changed: true, now: 9, at: 0, busy: 2 }) && !R.detailDue({ needed: true, changed: true, now: 9, at: 0, busy: 3 }) && R.MAX_DETAIL_INFLIGHT === 3);
    check('F1: no detail fetch for a request whose runs are all settled', R.requestSettled({ ask: askOf('t:s'), auto: false, phase: 'saved', tries: 1, updatedAt: 0, files: { a: { phase: 'saved', tries: 1 }, b: { phase: 'has-already', tries: 0 } } }) && !R.requestSettled({ ask: askOf('t:s'), auto: false, phase: 'queued', tries: 0, updatedAt: 0 }));

    console.log('[44.15 F2 absence needs live lists]');
    check('F2: not live: never absent', R.absence(undefined, false, 9e9, R.REMOVAL_GRACE_MS, false).state === 'present' && R.absence(0, false, 9e9, R.REMOVAL_GRACE_MS, true).state === 'delete');
    check('F2: the engine context exposes listsLive and the runner uses it', /listsLive/.test(read('context/EngineContext.tsx')) && /absence\(.*REMOVAL_GRACE_MS, live\)/.test(runner));

    console.log('[44.15 F3 the cap]');
    const mk = (phase, updatedAt) => ({ ask: askOf('x'), auto: false, phase, tries: 0, updatedAt });
    const capped = R.capRequests({ a: mk('none', 1), b: mk('saved', 2), c: mk('skipped', 3), d: mk('queued', 0), e: mk('none', 4) }, 3, new Set(['a', 'c']));
    check('F3: present transfers and unsettled requests are never evicted; settled absent ones go oldest first (only b and e can go)', !('b' in capped) && !('e' in capped) && 'a' in capped && 'c' in capped && 'd' in capped);

    console.log('[44.15 F4 each run keeps its own time]');
    R.resetRequestsForTests();
    R.askSubtitles([askOf('t:two')], { auto: false });
    R.setFileList('t:two', ['a.mkv', 'b.mkv']);
    R.setRun('t:two', 'a.mkv', R.afterFailure('failed', { phase: 'searching', tries: 0 }, 5_000_000));
    R.setRun('t:two', 'b.mkv', { phase: 'searching', tries: 0 });
    check('F4: one episode\'s retry time is its own and another\'s change leaves it alone', R.getRequests()['t:two'].files['a.mkv'].retryAt === 5_120_000 && R.retryAt(R.getRequests()['t:two'].files['b.mkv']) === null && typeof R.getRequests()['t:two'].files['b.mkv'].at === 'number');
    check('F4: the runner reads retryAt(run), not the request time', /retryAt\(r\)/.test(runner) && !/cur\.updatedAt/.test(runner));

    console.log('[44.15 F5 switches off abort at once]');
    check('F5: off, no sources, or automatic mode off for the runner\'s own requests stops them', !R.shouldRun({}, { enabled: false, providers: 1, autoOn: true }) && !R.shouldRun({}, { enabled: true, providers: 0, autoOn: true }) && !R.shouldRun({ byRunner: true }, { enabled: true, providers: 1, autoOn: false }) && R.shouldRun({ byRunner: true }, { enabled: true, providers: 1, autoOn: true }) && R.shouldRun({}, { enabled: true, providers: 1, autoOn: false }));
    R.resetRequestsForTests();
    const ctlF5 = new AbortController();
    const ctlF5b = new AbortController();
    R.registerRun('t:f5', 'a', ctlF5);
    R.registerRun('t:keep', 'a', ctlF5b);
    R.abortWhere((k) => k === 't:f5');
    check('F5: the runner aborts through the shared registry', ctlF5.signal.aborted && !ctlF5b.signal.aborted && /abortWhere\(/.test(runner));

    console.log('[44.15 F6 state writes check the request]');
    check('F6: no write for a deleted request or an old epoch; a skipped request takes only saved', !R.canWriteState(undefined, 0, 'getting') && !R.canWriteState({ epoch: 2, phase: 'queued' }, 1, 'saved') && R.canWriteState({ phase: 'queued' }, 0, 'getting') && !R.canWriteState({ phase: 'skipped' }, 0, 'getting') && R.canWriteState({ phase: 'skipped' }, 0, 'saved'));
    check('F6: deleting clears every episode\'s state and target', R.statePathsToClear({ files: { a: { phase: 'saved', tries: 1, vp: '/v/a.mkv' }, b: { phase: 'none', tries: 1, vp: '/v/b.mkv' } } }, '/v/b.mkv').sort().join() === '/v/a.mkv,/v/b.mkv' && /forgetAll\(/.test(runner));
    R.resetRequestsForTests();
    R.setRun('t:gone', null, { phase: 'saved', tries: 1 });
    check('F6: a late write for a deleted request does nothing', !('t:gone' in R.getRequests()));

    console.log('[44.15 F7 a banner never closes a sheet]');
    check('F7: with a sheet open the banner waits', TR.bannerPlan({ sheetOpen: true }) === 'wait' && TR.bannerPlan({ sheetOpen: false }) === 'now');
    check('F7: Search hides only the message, and shows the waiting banner after the sheet closes', /hideMessage/.test(read('app/(tabs)/search.tsx')) && /waitingBanner/.test(read('app/(tabs)/search.tsx')) && !/trayHide = tray\.hide;/.test(read('app/(tabs)/search.tsx')));

    console.log('[44.15 F8 one lowercase key]');
    check('F8: torrent keys are lowercased in one place', ST.normKey('t:AbC') === 't:abc' && ST.normKey('d:AbC') === 'd:AbC' && F.torrentTarget('ABC', '/dl', { index: 0, path: 'a.mkv', length: 1, progressBytes: 1, included: true }).ownerKey === 't:abc');
    ST.recordState({ videoPath: '/dl/a.mkv', fileName: 'a.mkv', videoBytes: 1, complete: true, ownerKey: 't:ABC' }, { state: 'saved', lang: 'en', file: 'a.srt', savedAt: Date.now() });
    check('F8: card state, targets and requests all find the same entry', ST.stateFor('t:abc') !== null && ST.stateFor('t:ABC') !== null && ST.recallTarget('t:ABC').ownerKey === 't:abc');
    ST.forgetAll('t:ABC', ['/dl/a.mkv']);

    console.log('[44.15 F9 the tray follows the requests]');
    check('F9: the action row shows the live result', TR.liveLabel(['a'], { a: 'searching' }) === 'Getting subtitles' && TR.liveLabel(['a', 'b'], { a: 'saved', b: 'queued' }) === 'Getting subtitles for 2' && TR.liveLabel(['a'], { a: 'saved' }) === 'Subtitles saved' && TR.liveLabel(['a', 'b'], { a: 'needs-pick', b: 'needs-pick' }) === '2 need you' && TR.liveLabel(['a'], { a: 'none' }) === 'No subtitles found');
    let liveTray = tryAdd(null, 'aaa', MOVIE, { auto: true });
    check('F9: trayAction takes the phases', TR.trayAction(liveTray, { 't:aaa': 'saved' }).skip === true && TR.trayAction(tryAdd(null, 'aaa', MOVIE), undefined).main.kind === 'ask');
    const reAdded = tryAdd(null, 'aaa', MOVIE, { auto: true, phase: 'skipped' });
    check('F9: a re-add of a skipped or saved key does not say Getting', reAdded.items[0].sub === 'skipped' && !/Getting/.test(TR.trayTitle(reAdded)) && tryAdd(null, 'aaa', MOVIE, { auto: true, phase: 'saved' }).items[0].sub === 'skipped');
    const sr = tryAdd(null, 'aaa', MOVIE, { now: 0 });
    check('F9: under TalkBack the tray stops merging after 60 s; off the Search tab it never joins', TR.trayMayMerge(sr, { now: 59_000, screenReader: true, focused: true }) && !TR.trayMayMerge(sr, { now: 61_000, screenReader: true, focused: true }) && TR.trayMayMerge(sr, { now: 61_000, screenReader: false, focused: true }) && !TR.trayMayMerge(sr, { now: 1, screenReader: false, focused: false }));
    check('F9: the hook reads useRequestPhases and joinTrayIfShowing needs focus', /useRequestPhases/.test(read('components/search/AddedTray.tsx')) && /live\.focused\(\)/.test(read('components/search/AddedTray.tsx')));

    console.log('[44.15 F10 re-add, richer ask, moving]');
    R.resetRequestsForTests();
    R.askSubtitles([askOf('t:re', { title: 'thin', detail: '' })], { auto: true, byRunner: true });
    R.askSubtitles([askOf('t:re', { title: 'Rich (2006)', detail: '1080p · YTS' })], { auto: false });
    check('F10: the tray\'s richer ask fills the runner\'s thin one', R.getRequests()['t:re'].ask.title === 'Rich (2006)' && R.getRequests()['t:re'].ask.detail === '1080p · YTS' && !R.getRequests()['t:re'].byRunner);
    const back = R.resetEntryForReturn({ ask: askOf('t:z'), auto: false, phase: 'none', tries: 2, updatedAt: 0, files: { a: { phase: 'saved', tries: 1, saved: true, vp: '/a' }, b: { phase: 'none', tries: 2 } } });
    check('F10: a re-added hash whose files are gone starts again; what Maglev saved is remembered', back.files.a.phase === 'queued' && back.files.a.saved === true && back.files.b.tries === 0 && back.phase === 'queued' && R.videosGone([{ path: 'a.mkv', length: 5, progressBytes: 0 }]) && !R.videosGone([{ path: 'a.mkv', length: 5, progressBytes: 2 }]));
    check('F10: the run waits while the transfer is MOVING', !R.canWriteNow('MOVING') && R.canWriteNow('DOWNLOADING') && /canWriteNow\(t\.state\)/.test(runner));

    console.log('[44.15 F11 a missing video keeps needs-pick]');
    check('F11: missing keeps an earlier needs-pick, otherwise none', R.afterMissing('needs-pick') === 'needs-pick' && R.afterMissing('queued') === 'none' && /afterMissing\(prev\.phase\)/.test(runner));
    void noop;
  }

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('subtitle requests: all passed');
})();
