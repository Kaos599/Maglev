#!/usr/bin/env node
// NATIVE_CONTRACT 36.5, 36.7, 36.8, 36.10: the subtitle flow in the app. Entry-point rules, the hash gate, name taken,
// every error's copy and action, the sheet's state machine, the card icon, and the wiring. Pure: no rendering.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

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

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const nativeErr = (code) => Object.assign(new Error(code), { code });

(async () => {
  const F = await import('../components/subtitles/flow.ts');
  const M = await import('../components/subtitles/sheetMachine.ts');
  const C = await import('../utils/subtitles/copy.ts');
  const { ProviderError } = await import('../utils/search/http.ts');
  const P = await import('../utils/subtitles/prefs.ts');

  const on = { master: true, sourcesOn: 3 };
  const vid = (extra) => ({ index: 0, path: 'Show/Show.S01E02.1080p.mkv', length: 1000, progressBytes: 1000, included: true, ...extra });

  console.log('[a file becomes a path]');
  check('folder + relative path', F.videoLocation('/storage/emulated/0/Download/Maglev', 'Show/a.mkv') === '/storage/emulated/0/Download/Maglev/Show/a.mkv');
  check('trailing slash and file:// are normalised', F.videoLocation('file:///sdcard/Download/Maglev/', 'a.mkv') === '/sdcard/Download/Maglev/a.mkv');
  check('content:// folder gives null (no document URI can be built)', F.videoLocation('content://x/tree/y', 'a.mkv') === null);
  check('empty or relative folder gives null', F.videoLocation('', 'a.mkv') === null && F.videoLocation('Download', 'a.mkv') === null);
  check('base name drops folders', F.baseName('/a/b/Film.2024.mkv') === 'Film.2024.mkv');

  console.log('[entry points: files]');
  const folder = '/storage/emulated/0/Download/Maglev';
  check('finished video row: enabled', F.fileEntryMode(vid(), { ...on, folder }) === 'enabled');
  check('partly downloaded video row: enabled (42.1)', F.fileEntryMode(vid({ progressBytes: 10 }), { ...on, folder }) === 'enabled');
  check('video row with nothing on disk: disabled', F.fileEntryMode(vid({ progressBytes: 0 }), { ...on, folder }) === 'disabled');
  check('disabled row says "When this file starts" (42.1)', F.DISABLED_ENTRY_SUBTITLE === 'When this file starts');
  check('non-video row: hidden', F.fileEntryMode(vid({ path: 'a/readme.txt' }), { ...on, folder }) === 'hidden');
  check('master off: hidden', F.fileEntryMode(vid(), { master: false, sourcesOn: 3, folder }) === 'hidden');
  check('no source on: hidden', F.fileEntryMode(vid(), { master: true, sourcesOn: 0, folder }) === 'hidden');
  check('a file-picker folder shows the row disabled with the reason (39.1 S6)', F.fileEntryMode(vid(), { ...on, folder: 'content://x' }) === 'unavailable' && F.entrySubtitle('unavailable') === 'Not available yet for folders picked with the file picker' && F.fileEntryMode(vid(), { ...on, folder: 'Download' }) === 'hidden');

  console.log('[entry points: torrent card menu]');
  const done = { finished: true, folder };
  check('finished, one video: enabled and names the file', (() => { const r = F.torrentEntryMode(done, [vid(), vid({ index: 1, path: 'Show/info.nfo' })], on); return r.mode === 'enabled' && r.file.index === 0; })());
  check('finished, two videos: hidden', F.torrentEntryMode(done, [vid(), vid({ index: 1, path: 'Show/b.mkv' })], on).mode === 'hidden');
  check('unfinished, one video with bytes on disk: enabled (42.1)', F.torrentEntryMode({ finished: false, folder }, [vid({ progressBytes: 5 })], on).mode === 'enabled');
  check('unfinished, one video, nothing on disk: disabled', F.torrentEntryMode({ finished: false, folder }, [vid({ progressBytes: 0 })], on).mode === 'disabled');
  check('no video: hidden', F.torrentEntryMode(done, [vid({ path: 'a.txt' })], on).mode === 'hidden');
  check('a skipped second video does not count', F.torrentEntryMode(done, [vid(), vid({ index: 1, path: 'b.mkv', included: false })], on).mode === 'enabled');
  check('master off: hidden', F.torrentEntryMode(done, [vid()], { master: false, sourcesOn: 3 }).mode === 'hidden');
  check('no sources: hidden', F.torrentEntryMode(done, [vid()], { master: true, sourcesOn: 0 }).mode === 'hidden');

  console.log('[entry points: link download card menu]');
  const dl = (o) => ({ state: 'finished', name: 'Clip.mp4', folder, ...o });
  check('finished video link: enabled', F.downloadEntryMode(dl(), on) === 'enabled');
  check('downloading video link, nothing yet: disabled', F.downloadEntryMode(dl({ state: 'downloading' }), on) === 'disabled');
  check('downloading video link with bytes: enabled (42.1)', F.downloadEntryMode(dl({ state: 'downloading', downloaded: 100 }), on) === 'enabled');
  check('stream joining with bytes: still hidden', F.downloadEntryMode(dl({ state: 'downloading', downloaded: 100, muxNeeded: true }), on) === 'hidden');
  check('stream still joining: hidden', F.downloadEntryMode(dl({ state: 'verifying', muxNeeded: true }), on) === 'hidden');
  check('stream joining flag alone: hidden', F.downloadEntryMode(dl({ muxNeeded: true }), on) === 'hidden');
  check('not a video: hidden', F.downloadEntryMode(dl({ name: 'a.zip' }), on) === 'hidden');
  check('master off: hidden', F.downloadEntryMode(dl(), { master: false, sourcesOn: 3 }) === 'hidden');
  check('no sources: hidden', F.downloadEntryMode(dl(), { master: true, sourcesOn: 0 }) === 'hidden');

  console.log('[targets]');
  const tt = F.torrentTarget('abc', folder, vid());
  check('torrent target: path, base name, owner key, complete', tt.videoPath === `${folder}/Show/Show.S01E02.1080p.mkv` && tt.fileName === 'Show.S01E02.1080p.mkv' && tt.ownerKey === 't:abc' && tt.complete);
  check('unfinished file is not complete', F.torrentTarget('abc', folder, vid({ progressBytes: 1 })).complete === false);
  const dt = F.downloadTarget({ id: '7', name: 'Clip.mp4', folder, size: 500, downloaded: 500, state: 'finished' });
  check('download target', dt.ownerKey === 'd:7' && dt.videoBytes === 500 && dt.complete);

  console.log('[hash only when complete]');
  let calls = 0;
  const hashOk = { subtitleHash: async () => { calls++; return { hash: '0123456789abcdef', bytes: 4242 }; } };
  const r0 = await F.hashIfComplete({ videoPath: '/a.mkv', complete: false, videoBytes: 10 }, hashOk);
  check('incomplete file: the bridge is never called', calls === 0 && r0.hash === undefined && r0.videoBytes === 10);
  const r1 = await F.hashIfComplete({ videoPath: '/a.mkv', complete: true, videoBytes: 10 }, hashOk);
  check('complete file: hash and the real size', calls === 1 && r1.hash === '0123456789abcdef' && r1.videoBytes === 4242);
  const r2 = await F.hashIfComplete({ videoPath: '/a.mkv', complete: true, videoBytes: 10 }, { subtitleHash: async () => { throw nativeErr('FILE_TOO_SMALL'); } });
  check('FILE_TOO_SMALL: no hash, search by name, not missing', r2.hash === undefined && !r2.missing);
  const r3 = await F.hashIfComplete({ videoPath: '/a.mkv', complete: true, videoBytes: 10 }, { subtitleHash: async () => { throw nativeErr('IO'); } });
  check('IO error: no hash, not missing', r3.hash === undefined && !r3.missing);
  const r4 = await F.hashIfComplete({ videoPath: '/a.mkv', complete: true, videoBytes: 10 }, { subtitleHash: async () => { throw nativeErr('NOT_FOUND'); } });
  check('NOT_FOUND: the video is gone', r4.missing === true);
  const r5 = await F.hashIfComplete({ videoPath: '/a.mkv', complete: true, videoBytes: 10 }, { subtitleHash: async () => ({ hash: 'nothex', bytes: 1 }) });
  check('a malformed hash is dropped', r5.hash === undefined);

  console.log('[download and save]');
  const candidate = { providerId: 'p', id: '1', language: 'en', releaseName: 'Show.S01E02', matchedBy: 'hash' };
  const provider = (download) => ({ id: 'p', name: 'Podnapisi', mirrors: [], search: async () => [], download });
  const textProvider = provider(async () => ({ kind: 'text', bytes: bytes(SRT), format: 'srt' }));
  const run = (prov, deps, extra = {}) =>
    F.downloadAndSave(
      { candidate, provider: prov, sourceName: 'Podnapisi', target: { videoPath: `${folder}/Show.S01E02.1080p.mkv` }, query: { fileName: 'Show.S01E02.1080p.mkv', season: 1, episode: 2 }, choice: 'normal', ...extra },
      { unzip: async () => [], ...deps },
    );
  const saves = [];
  const okSave = async (v, n, b64, replace) => { saves.push({ v, n, replace }); return { path: `${folder}/${n}` }; };
  const s1 = await run(textProvider, { save: okSave });
  check('saved next to the video as <base>.<lang>.srt', s1.status === 'saved' && s1.fileName === 'Show.S01E02.1080p.en.srt' && saves[0].v.startsWith(folder) && saves[0].replace === false);
  const hi = await run(textProvider, { save: okSave }, { candidate: { ...candidate, hearingImpaired: true } });
  check('hearing impaired adds .hi', hi.fileName === 'Show.S01E02.1080p.en.hi.srt');
  const taken = async () => { throw nativeErr('NAME_TAKEN'); };
  const s2 = await run(textProvider, { save: taken });
  check('NAME_TAKEN comes back as a choice and keeps the downloaded text', s2.status === 'name-taken' && s2.fileName === 'Show.S01E02.1080p.en.srt' && !!s2.prepared);
  let downloads = 0;
  const countingProvider = provider(async () => { downloads++; return { kind: 'text', bytes: bytes(SRT), format: 'srt' }; });
  const s3 = await run(countingProvider, { save: taken });
  const again = await run(countingProvider, { save: okSave }, { prepared: s3.prepared, choice: 'replace' });
  check('Replace saves with replace=true and does not download again', again.status === 'saved' && saves[saves.length - 1].replace === true && downloads === 1);
  const seen = [];
  const keepSave = async (v, n) => { seen.push(n); if (n.endsWith('.en.srt')) throw nativeErr('NAME_TAKEN'); return { path: `${folder}/${n}` }; };
  const kb = await run(textProvider, { save: keepSave }, { choice: 'keep-both' });
  check('Keep both saves as <base>.<lang>.2.srt', kb.status === 'saved' && kb.fileName === 'Show.S01E02.1080p.en.2.srt');
  const kb3 = await run(textProvider, { save: async (v, n) => { if (!/\.3\.srt$/.test(n)) throw nativeErr('NAME_TAKEN'); return { path: n }; } }, { choice: 'keep-both' });
  check('Keep both goes on to .3 when .2 is taken too', kb3.fileName === 'Show.S01E02.1080p.en.3.srt');
  check('the keep-both note says players may not load it', /may not load/.test(C.KEEP_BOTH_NOTE));
  check('name-taken title is the contract sentence', C.NAME_TAKEN_TITLE === 'A subtitle with this name already exists.' && C.NAME_TAKEN_ACTIONS.replace === 'Replace' && C.NAME_TAKEN_ACTIONS.keepBoth === 'Keep both' && C.NAME_TAKEN_ACTIONS.cancel === 'Cancel');

  console.log('[every error is one sentence and one action]');
  const expectErr = async (name, outcome, code, message, action, kind) => {
    check(`${name}: ${message} / ${action}`, outcome.status === 'failed' && outcome.error.code === code && outcome.error.message === message && outcome.error.action === action && outcome.error.actionKind === kind, JSON.stringify(outcome.error));
  };
  await expectErr('CANT_WRITE', await run(textProvider, { save: async () => { throw nativeErr('CANT_WRITE'); } }), 'CANT_WRITE', "Maglev can't write to this folder.", 'Open folder', 'open-folder');
  await expectErr('NO_SPACE', await run(textProvider, { save: async () => { throw nativeErr('NO_SPACE'); } }), 'NO_SPACE', 'Not enough space.', 'Close', 'close');
  await expectErr('VERIFY_FAILED', await run(textProvider, { save: async () => { throw nativeErr('VERIFY_FAILED'); } }), 'VERIFY_FAILED', "The subtitle didn't save correctly.", 'Try again', 'retry');
  await expectErr('NOT_FOUND on save', await run(textProvider, { save: async () => { throw nativeErr('NOT_FOUND'); } }), 'missing', "The video isn't there any more.", 'Close', 'close');
  await expectErr('source timeout', await run(provider(async () => { throw new ProviderError('timeout', 'slow'); }), { save: okSave }), 'timeout', "Podnapisi isn't responding.", 'Try again', 'retry');
  await expectErr('source error', await run(provider(async () => { throw new ProviderError('parse', 'bad'); }), { save: okSave }), 'error', "Podnapisi isn't responding.", 'Try again', 'retry');
  await expectErr('HTTP 429', await run(provider(async () => { throw new ProviderError('http', 'HTTP 429', 429); }), { save: okSave }), 'limit', "Podnapisi says you've reached today's limit.", 'Use another source', 'other-source');
  await expectErr('RAR', await run(provider(async () => ({ kind: 'zip', bytes: new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 1, 2, 3]) })), { save: okSave }), 'unsupported_archive', "This subtitle's file type isn't supported.", 'Pick another', 'pick-another');
  await expectErr('unzip refused', await run(provider(async () => ({ kind: 'zip', bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]) })), { save: okSave, unzip: async () => { throw nativeErr('ARCHIVE_UNSAFE'); } }), 'unsupported_archive', "This subtitle's file type isn't supported.", 'Pick another', 'pick-another');
  await expectErr('unreadable text', await run(provider(async () => ({ kind: 'text', bytes: new Uint8Array([0x83, 0x41, 0x83, 0x80, 0x81]), format: 'srt' })), { save: okSave }, { candidate: { ...candidate, language: 'ja' } }), 'unreadable_text', "Maglev can't read this subtitle's text.", 'Pick another', 'pick-another');
  const off = F.toFlowError('offline');
  check('offline: "You\'re offline." / Retry', off.message === "You're offline." && off.action === 'Retry' && off.actionKind === 'retry');
  const nf = F.toFlowError('nothing', { language: 'pt-BR' });
  check('nothing found names the language / Other language', /^No .*subtitles found\.$/.test(nf.message) && nf.action === 'Other language' && nf.actionKind === 'other-language');
  check('missing video: Close', F.toFlowError('missing').message === "The video isn't there any more." && F.toFlowError('missing').actionKind === 'close');

  console.log('[search status line]');
  const st = (providerId, state, message) => ({ providerId, state, count: 0, ms: 1, message });
  check('"N sources didn\'t respond" reuses the Search wording', F.didntRespondLine([st('a', 'done'), st('b', 'timeout'), st('c', 'error')]) === "2 sources didn't respond" && F.didntRespondLine([st('a', 'timeout')]) === "1 source didn't respond");
  check('all answered: no line', F.didntRespondLine([st('a', 'done'), st('b', 'empty')]) === '');
  check('offline: nobody answered and every failure is a network failure', F.looksOffline([st('a', 'error', 'Network request failed'), st('b', 'error', 'Network request failed')]));
  check('not offline when one source answered', !F.looksOffline([st('a', 'done'), st('b', 'error', 'Network request failed')]));
  check('not offline when a source timed out', !F.looksOffline([st('a', 'timeout', 'No answer in time'), st('b', 'error', 'Network request failed')]));
  const probs = F.sourceProblems([st('a', 'done'), st('b', 'limit'), st('c', 'timeout')], (id) => id.toUpperCase());
  check('per-source problem lines name the source', probs.length === 2 && probs[0].text === "B says you've reached today's limit." && probs[1].text === "C isn't responding.");

  console.log('[sheet state machine]');
  const row = (id, group, language = 'en') => ({ group, candidate: { providerId: 'p', id, language, releaseName: `Rel.${id}`, matchedBy: group === 'fits' ? 'hash' : 'release' } });
  const update = (s, ranked, done = true) => M.sheetReducer(s, { type: 'SEARCH_UPDATE', ranked, sources: [], done });
  let s = M.sheetReducer(M.CLOSED, { type: 'OPEN', languages: ['en', 'fr'], needsNotice: true });
  check('first lookup: the privacy notice comes first', s.phase === 'notice');
  check('Not now closes and searches nothing', M.sheetReducer(s, { type: 'NOTICE_NOT_NOW' }).phase === 'closed');
  s = M.sheetReducer(s, { type: 'NOTICE_CONTINUE' });
  check('Continue starts the search', s.phase === 'searching' && s.language === 'en');
  check('with the notice already accepted, it searches at once', M.sheetReducer(M.CLOSED, { type: 'OPEN', languages: ['en'], needsNotice: false }).phase === 'searching');
  check('Download is disabled while nothing is selected', !M.canDownload(s));
  let fits = update(s, [row('1', 'fits'), row('2', 'probably'), row('3', 'maybe')]);
  check('"Fits this file" first row is selected by default', fits.selectedKey === 'p:1' && M.canDownload(fits) && fits.phase === 'results');
  const noFit = update(s, [row('2', 'probably'), row('3', 'maybe')]);
  check('no "Fits this file": nothing selected, Download disabled', noFit.selectedKey === null && !M.canDownload(noFit));
  check('"Nothing fits this file" box shows then', M.nothingFits(noFit) && !M.nothingFits(fits));
  const picked = M.sheetReducer(noFit, { type: 'SELECT', key: 'p:3' });
  check('picking enables Download', M.canDownload(picked));
  check('a later search update never moves the pick', update(picked, [row('9', 'fits'), row('3', 'maybe')]).selectedKey === 'p:3');
  check('streaming updates keep the default until the user picks', update(update(s, [row('2', 'probably')], false), [row('1', 'fits'), row('2', 'probably')], false).selectedKey === 'p:1');
  check('still searching: tab status is searching', M.tabStatus(update(s, [], false)) === 'searching');
  check('done with nothing in the tab: nothing', M.tabStatus(update(s, [row('1', 'fits', 'de')])) === 'nothing');
  const fr = M.sheetReducer(fits, { type: 'PICK_TAB', language: 'fr' });
  check('switching tab clears the pick and re-defaults', fr.selectedKey === null && fr.language === 'fr');
  const other = M.sheetReducer(fits, { type: 'PICK_OTHER', language: 'de' });
  check('Other… adds one more tab', JSON.stringify(M.tabsOf(other)) === '["en","fr","de"]');
  check('Other… picking a listed language adds no tab', JSON.stringify(M.tabsOf(M.sheetReducer(fits, { type: 'PICK_OTHER', language: 'fr' }))) === '["en","fr"]');
  check('DOWNLOAD without a selection does nothing', M.sheetReducer(noFit, { type: 'DOWNLOAD' }).phase === 'results');
  let dlS = M.sheetReducer(fits, { type: 'DOWNLOAD' });
  check('DOWNLOAD starts', dlS.phase === 'downloading');
  const nt = M.sheetReducer(dlS, { type: 'NAME_TAKEN', fileName: 'x.en.srt' });
  check('name taken: the sheet asks', nt.phase === 'name-taken' && nt.takenName === 'x.en.srt');
  const kbS = M.sheetReducer(nt, { type: 'CHOOSE', choice: 'keep-both' });
  check('Keep both: downloads again with the note and the choice', kbS.phase === 'downloading' && kbS.pendingChoice === 'keep-both' && kbS.keepBothNote);
  check('Replace: downloads again with replace', M.sheetReducer(nt, { type: 'CHOOSE', choice: 'replace' }).pendingChoice === 'replace');
  check('Cancel: back to the results, nothing saved', M.sheetReducer(nt, { type: 'CHOOSE', choice: 'cancel' }).phase === 'results');
  const failedDl = M.sheetReducer(dlS, { type: 'DOWNLOAD_FAILED', error: F.toFlowError('CANT_WRITE') });
  check('a failed save returns to the results with the error, selection kept', failedDl.phase === 'results' && failedDl.error.code === 'CANT_WRITE' && failedDl.selectedKey === 'p:1');
  const savedS = M.sheetReducer(dlS, { type: 'SAVED', fileName: 'x.en.srt', language: 'en' });
  check('saved', savedS.phase === 'saved' && savedS.savedName === 'x.en.srt');
  check('toast text: "English subtitles saved"', F.savedToast('en') === 'English subtitles saved');
  const failedSearch = M.sheetReducer(s, { type: 'SEARCH_FAILED', error: F.toFlowError('offline') });
  check('search that cannot run: failed with Retry', failedSearch.phase === 'failed' && M.sheetReducer(failedSearch, { type: 'RETRY_SEARCH' }).phase === 'searching');
  check('selecting a row clears the old error', M.sheetReducer(failedDl, { type: 'SELECT', key: 'p:1' }).error === null);
  check('a stale update after close is ignored', M.sheetReducer(M.CLOSED, { type: 'SEARCH_UPDATE', ranked: [row('1', 'fits')], sources: [], done: true }).phase === 'closed');
  check('a stale update while saved is ignored', M.sheetReducer(savedS, { type: 'SEARCH_UPDATE', ranked: [], sources: [], done: true }).phase === 'saved');

  console.log('[card state follows the sheet]');
  check('downloading writes "getting"', M.cardStateFor('results', dlS, 5)?.state === 'getting');
  check('keep-both retry does not rewrite getting', M.cardStateFor('name-taken', kbS, 5) === null);
  check('saved writes "saved" with the file', (() => { const w = M.cardStateFor('downloading', savedS, 9); return w.state === 'saved' && w.file === 'x.en.srt' && w.savedAt === 9; })());
  check('a failed save writes "needs a look"', M.cardStateFor('downloading', failedDl, 5)?.state === 'needs-look');
  check('cancel at the name question forgets the state', M.cardStateFor('name-taken', M.sheetReducer(nt, { type: 'CHOOSE', choice: 'cancel' }), 5) === 'clear');
  check('closing while downloading forgets the state', M.cardStateFor('downloading', M.CLOSED, 5) === 'clear');
  check('searching alone writes nothing (the user has not asked for a file yet)', M.cardStateFor('closed', s, 5) === null);

  console.log('[card icon]');
  const now = 1_000_000_000_000;
  const entry = (state, savedAt = now) => ({ lang: 'en', file: '', savedAt, state });
  check('no state: no icon', F.cardIconModel(null, now) === null);
  check('getting shows', F.cardIconModel(entry('getting'), now).state === 'getting');
  check('needs-look shows within 24 h and hides after (39.1 S3)', F.cardIconModel(entry('needs-look', now - 5 * 3600000), now).state === 'needs-look' && F.cardIconModel(entry('needs-look', now - 5 * 86400000), now) === null);
  check('saved shows within 24 h', F.cardIconModel(entry('saved', now - 3600000), now).state === 'saved');
  check('saved hides 24 h after the save', F.cardIconModel(entry('saved', now - 24 * 3600000 - 1), now) === null);
  check('TalkBack label: saved + language', F.cardIconLabel({ state: 'saved', lang: 'en' }).startsWith('Subtitles saved'));
  check('TalkBack label: getting + language', F.cardIconLabel({ state: 'getting', lang: 'pt-BR' }).startsWith('Getting subtitles'));
  check('TalkBack label: needs a look', /pick one/.test(F.cardIconLabel({ state: 'needs-look', lang: 'fr' })) && /No subtitles found/.test(F.cardIconLabel({ state: 'none', lang: 'fr' })));
  check('sameCardIcon: equal, different state, different language, null', F.sameCardIcon({ state: 'saved', lang: 'en' }, { state: 'saved', lang: 'en' }) && !F.sameCardIcon({ state: 'saved', lang: 'en' }, { state: 'getting', lang: 'en' }) && !F.sameCardIcon({ state: 'saved', lang: 'en' }, { state: 'saved', lang: 'fr' }) && F.sameCardIcon(null, undefined) && !F.sameCardIcon(null, { state: 'saved', lang: 'en' }));

  console.log('[state store]');
  const S = await import('../components/subtitles/stateStore.ts');
  let ticks = 0;
  const off2 = S.subscribeStates(() => ticks++);
  const tgt = { videoPath: '/a/b.mkv', fileName: 'b.mkv', videoBytes: 9, complete: true, ownerKey: 't:zzz' };
  S.recordState(tgt, entry('saved'));
  check('recordState keeps the state under the video path and the card key', P.getSubtitleState('/a/b.mkv')?.state === 'saved' && S.stateFor('t:zzz')?.state === 'saved');
  check('listeners hear a write', ticks === 1);
  check('the card can recall the video it stands for', S.recallTarget('t:zzz')?.videoPath === '/a/b.mkv' && S.recallTarget('t:zzz')?.complete === true);
  S.forgetState(tgt);
  check('forgetState clears both keys', S.stateFor('t:zzz') === null && P.getSubtitleState('/a/b.mkv') === null && ticks === 2);
  off2();

  console.log('[wiring]');
  const card = read('components/TransferCard.tsx');
  const dcard = read('components/transfers/DownloadCard.tsx');
  check('TransferCard comparator includes the subtitle prop and callback', /sameCardIcon\(a\.subtitle, b\.subtitle\)/.test(card) && /a\.onSubtitles === b\.onSubtitles/.test(card));
  check('DownloadCard comparator includes the subtitle prop and callback', /sameCardIcon\(a\.subtitle, b\.subtitle\)/.test(dcard) && /a\.onSubtitles === b\.onSubtitles/.test(dcard));
  check('both cards hide the icon in selection mode', /subtitle && onSubtitles && !selectionMode/.test(card) && /subtitle && onSubtitles && !selectionMode/.test(dcard));
  check('both cards keep their swipe wrapper and action button', /<SwipeRow/.test(card) && /<SwipeRow/.test(dcard) && /actionAnchor/.test(card) && /actionAnchor/.test(dcard));
  const icon = read('components/subtitles/SubtitleCardIcon.tsx');
  check('card icon: 44 px tap area (28 box + hitSlop), TalkBack label, PixelIcon only', /hitSlop=\{\{ top: 8, bottom: 8, left: 12, right: 12 \}\}/.test(icon) && /cardIconLabel/.test(icon) && /<PixelIcon/.test(icon));
  check('file menu, torrent menu and link page each get Find subtitles…', /FIND_SUBTITLES/.test(read('components/detail/sheets.tsx')) && /FIND_SUBTITLES/.test(read('components/detail/TorrentMoreSheet.tsx')) && /FIND_SUBTITLES/.test(read('app/download/[id].tsx')));
  check('Transfers, Detail and the link page host the sheet', /<SubtitleSheet/.test(read('app/(tabs)/index.tsx')) && /<SubtitleSheet/.test(read('app/torrent/[id].tsx')) && /<SubtitleSheet/.test(read('app/download/[id].tsx')));
  const sheet = read('components/subtitles/SubtitleSheet.tsx');
  check('sheet: hashes through the bridge, saves through the bridge, unzips through the bridge', /hashIfComplete\(t, maglevEngine\)/.test(sheet) && /maglevEngine\.saveSubtitle/.test(sheet) && /maglevEngine\.unzipSubtitles/.test(sheet));
  check('sheet: uses the shared copy (button, groups, notice)', /DOWNLOAD_BUTTON/.test(sheet) && /GROUP_LABEL/.test(sheet) && /privacyNotice\(/.test(sheet) && /acceptPrivacy\(\)/.test(sheet));
  check('sheet never opens with the switch off or no source', /!sub\.enabled \|\| providersRef\.current\.length === 0/.test(sheet));
  check('sheet confirms a save with a toast through the app notice host', /showNotice\(\{ message: savedToast/.test(sheet));
  const files = fs.readdirSync(path.join(root, 'components/subtitles')).map((f) => read(`components/subtitles/${f}`)).join('\n');
  check('no hex colours in the subtitle components', !/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/.test(files));
  check('no system monospace', !/fontFamily:\s*'monospace'/.test(files));
  check('no emoji or jargon labels', !/[\u{1F300}-\u{1FAFF}]/u.test(files));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
