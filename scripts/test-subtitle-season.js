#!/usr/bin/env node
// NATIVE_CONTRACT 46: subtitles for a season. Plurals, one row per file in status mode, the qualification rule for
// "Use the best match", stored candidates, bulk save with its single retry, and the page row's button. Pure: no rendering.
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
  const S = await import('../utils/subtitles/season.ts');
  const R = await import('../utils/subtitles/requests.ts');
  const copy = await import('../utils/subtitles/copy.ts');
  const M = await import('../components/subtitles/rowModel.ts');

  const EN = ['en'];
  const ctx = { show: 'The Mentalist', season: 2, episode: 1, languages: EN };
  const cand = (o = {}) => ({ p: 'os', id: 'a1', rel: 'The.Mentalist.S02E01.720p.HDTV.x264-CTU', l: 'en', t: 'The Mentalist', s: 2, e: 1, ...o });

  console.log('[46.1 plural rules]');
  check('1 video / 2 videos', copy.multiTitle(1) === 'Subtitles for 1 video' && copy.multiTitle(2) === 'Subtitles for 2 videos');
  check('1 episode / 23 episodes', copy.multiTitle(1, true) === 'Subtitles for 1 episode' && copy.multiTitle(23, true) === 'Subtitles for 23 episodes');
  check('0 takes the plural', copy.multiTitle(0) === 'Subtitles for 0 videos');
  check('1 subtitle / 3 subtitles', copy.groupFoundLine(1) === '1 subtitle' && copy.groupFoundLine(3) === '3 subtitles');
  check('"1 needs you" / "2 need you" in the summary and the pack line', copy.statusSummary({ saved: 0, needsYou: 1, waiting: 0 }) === '1 needs you' && copy.rowPackLine({ saved: 0, total: 5, needYou: 1 }) === '0 of 5 saved · 1 needs you' && copy.statusSummary({ saved: 21, needsYou: 2, waiting: 0 }) === '21 saved · 2 need you');
  check('non-video footnote follows the count', copy.nonVideoMany(2) === '2 other adds are not videos, so they get no subtitles.' && copy.nonVideoMany(1) === '1 other add is not a video, so it gets no subtitles.');
  check('sources off: 1 source / 2 sources', copy.offSourcesTail(1) === '1 source off' && copy.offSourcesTail(2) === '2 sources off');
  check('bulk copy: button, progress, result', copy.useBestMatchFor(18) === 'Use the best match for 18' && copy.bulkProgress(3, 18) === 'Saving 3 of 18…' && copy.USE_BEST_MATCH === 'Use best match');
  check('bulk result: second part left out at 0, "1 still needs you" at 1', copy.bulkResult(18, 0) === 'Saved 18.' && copy.bulkResult(18, 5) === 'Saved 18. 5 still need you.' && copy.bulkResult(22, 1) === 'Saved 22. 1 still needs you.');

  console.log('[46.1 a pack gives one row per file]');
  const files = {
    'The Mentalist S02/The.Mentalist.S02E03.Red.Tide.720p.HDTV.x264-CTU.mkv': { phase: 'saved', tries: 1, bytes: 1_200_000_000, vp: '/d/e3.mkv' },
    'The Mentalist S02/The.Mentalist.S02E01.Redemption.720p.HDTV.x264-CTU.mkv': { phase: 'needs-pick', tries: 1, bytes: 1_100_000_000 },
    'The Mentalist S02/The.Mentalist.S02E02.720p.HDTV.x264-CTU.mkv': { phase: 'queued', tries: 0 },
    'The Mentalist S02/extras behind the scenes.mkv': { phase: 'none', tries: 1, bytes: 50_000_000 },
    'The Mentalist S02/The.Mentalist.S02E04.720p.HDTV.x264-CTU.mkv': { phase: 'failed', tries: 1 },
  };
  const entry = { ask: { key: 't:abc', title: 'The Mentalist S02 · 5 episodes', detail: '' }, files };
  check('a request with two or more runs is an episode request', S.isEpisodeRequest(entry) && !S.isEpisodeRequest({ files: { a: files['The Mentalist S02/extras behind the scenes.mkv'] } }) && !S.isEpisodeRequest({}));
  const rows = S.episodeRows(entry, (vp) => (vp === '/d/e3.mkv' ? 'en' : null));
  check('five file runs give five rows (not one for the request)', rows.length === 5);
  check('rows that need you first, then the rest in episode order', rows.map((r) => r.main).join('|') === 'S02E01 · Redemption|S02E04|extras behind the scenes|S02E02|S02E03 · Red Tide');
  check('an unreadable name shows the file name without its extension', rows.some((r) => r.main === 'extras behind the scenes'));
  check('the title is dropped when the name has none, and release tags are not a title', S.episodeLabel('The.Mentalist.S02E02.720p.HDTV.x264-CTU.mkv') === 'S02E02' && S.episodeLabel('Show.S01E05-GRP.mkv') === 'S01E05' && S.episodeLabel('Show S01E05 Pilot.mkv') === 'S01E05 · Pilot');
  check('second line: size, then the result in words', rows[0].detail === '1.0 GB · Close match · pick');
  check('saved names its language', rows.find((r) => r.phase === 'saved').detail.endsWith('Saved · English'));
  check('result words: none, getting, waiting, failed', S.episodeWord('none', null) === 'None found · edit name' && S.episodeWord('searching', null) === 'Getting…' && S.episodeWord('queued', null) === 'Waiting for the file' && S.episodeWord('failed', null) === "Sources didn't answer");
  check('saved with no known language says "Saved"', S.episodeWord('saved', null) === 'Saved');
  check('a row without a known size shows only the words', rows.find((r) => r.phase === 'queued').detail === 'Waiting for the file');
  check('a tap opens results for needs-pick and saved, the name field for none, nothing while waiting', S.episodeStart('needs-pick') === 'results' && S.episodeStart('saved') === 'results' && S.episodeStart('none') === 'edit-name' && S.episodeStart('queued') === null && S.episodeStart('searching') === null);
  check('phase counts feed the summary', JSON.stringify(S.phaseCounts(rows.map((r) => r.phase))) === JSON.stringify({ saved: 1, needsYou: 1, waiting: 1 }));
  check('23 files: 21 saved and 2 need you', copy.statusSummary(S.phaseCounts([...Array(21).fill('saved'), 'needs-pick', 'needs-pick'])) === '21 saved · 2 need you');

  console.log('[46.3 qualification]');
  check('the right show, season, episode and language qualifies', S.qualifies(cand(), ctx));
  check('wrong episode: no', !S.qualifies(cand({ e: 2, rel: 'The.Mentalist.S02E02.720p' }), ctx));
  check('wrong season: no', !S.qualifies(cand({ s: 3, rel: 'The.Mentalist.S03E01.720p' }), ctx));
  check('no episode stated: no', !S.qualifies(cand({ s: undefined, e: undefined, rel: 'The.Mentalist.720p' }), ctx));
  check('a season-pack subtitle: no', !S.qualifies(cand({ s: 2, e: undefined, rel: 'The.Mentalist.S02.Complete.720p' }), ctx));
  check('a season pack that carries the episode number is still a pack', !S.qualifies(cand({ rel: 'The Mentalist Complete Season 2 S02E01' }), ctx));
  check('multi-episode subtitles: no (S02E01E02, S02E01-E03, S02E01 S02E02, 2x01-02)', !S.qualifies(cand({ rel: 'The.Mentalist.S02E01E02.720p' }), ctx) && !S.qualifies(cand({ rel: 'The.Mentalist.S02E01-E03.720p' }), ctx) && !S.qualifies(cand({ rel: 'The Mentalist S02E01 S02E02' }), ctx) && !S.qualifies(cand({ rel: 'The Mentalist 2x01-02' }), ctx));
  check('a wrong show: no', !S.qualifies(cand({ t: 'The Mentalist Reborn' }), ctx) && !S.qualifies(cand({ t: 'Mentalist Kids' }), ctx) && !S.qualifies(cand({ t: '' }), ctx));
  check('the same show without "The" and with accents still matches', S.qualifies(cand({ t: 'Mentalist' }), ctx));
  check('a title with an (aka ...) alias matches', S.qualifies(cand({ t: 'Der Mentalist / The Mentalist' }), ctx));
  check('a wrong language: no', !S.qualifies(cand({ l: 'fr' }), ctx) && !S.qualifies(cand({ l: 'fr' }), { ...ctx, languages: ['en', 'de'] }));
  check('a language of the user\'s list (not the first) qualifies', S.qualifies(cand({ l: 'de' }), { ...ctx, languages: ['en', 'de'] }));
  check('nothing stored: no', !S.qualifies(undefined, ctx));

  console.log('[46.3 which runs count (k)]');
  const mk = (n, o = {}) => ({ phase: 'needs-pick', tries: 1, cands: [cand({ e: n, rel: `The.Mentalist.S02E0${n}.720p.HDTV-CTU` })], ...o });
  const pk = (over) => ({
    ask: { key: 't:abc', title: 'The Mentalist S02 · 6 episodes', detail: '' },
    files: {
      'S02/The.Mentalist.S02E01.mkv': mk(1),
      'S02/The.Mentalist.S02E02.mkv': mk(2, { cands: [cand({ e: 5, rel: 'The.Mentalist.S02E05.720p' })] }), // wrong episode
      'S02/The.Mentalist.S02E03.mkv': mk(3, { cands: [cand({ e: undefined, rel: 'The.Mentalist.S02.Complete' })] }), // pack
      'S02/The.Mentalist.S02E04.mkv': mk(4, { cands: [cand({ e: 4, t: 'Another Show', rel: 'Another.Show.S02E04.720p' })] }), // wrong show
      'S02/The.Mentalist.S02E05.mkv': mk(5, { cands: [cand({ e: 5, l: 'fr', rel: 'The.Mentalist.S02E05.FR' })] }), // wrong language
      'S02/The.Mentalist.S02E06.mkv': { phase: 'saved', tries: 1 }, // not needs-pick
      ...over,
    },
  });
  const q = S.qualifyingRuns(pk(), EN);
  check('only the run whose best candidate qualifies counts (k = 1)', q.length === 1 && q[0].fileKey === 'S02/The.Mentalist.S02E01.mkv' && q[0].ctx.season === 2 && q[0].ctx.episode === 1);
  check('a needs-pick run with nothing stored does not count', S.qualifyingRuns(pk({ 'S02/The.Mentalist.S02E02.mkv': { phase: 'needs-pick', tries: 1 } }), EN).length === 1);
  check('a single-video request is never a bulk', S.qualifyingRuns({ ask: { key: 't:x', title: 'Movie' }, files: { 'a.S01E01.mkv': mk(1) } }, EN).length === 0);
  check('the context needs a sure season and episode in the file name', S.runCtx('Show - 047.mkv', 'Show', EN) === null && S.runCtx('The.Mentalist.S02E07.mkv', 'The Mentalist S02 · 6 episodes', EN).episode === 7);
  check('a file with no show in its name uses the pack title', S.runCtx('S02E07.mkv', 'The Mentalist S02 · 6 episodes', EN).show === 'The Mentalist');

  console.log('[46.5 the page row]');
  check('k >= 1: "Use best match"; k = 0: "See all"', S.pageRowAction(1) === 'use-best' && S.pageRowAction(5) === 'use-best' && S.pageRowAction(0) === 'see-all');
  const base = { fileListKnown: true, started: true, canOpenSheet: false, phase: 'needs-pick', pack: { total: 23, saved: 0, needYou: 23 } };
  let m = M.rowModel({ ...base, bestK: 4 });
  check('a pack with a qualifying run: button "Use best match"', m.button.label === 'Use best match' && m.button.action === 'use-best');
  check('"See all" stays one tap away', m.extra && m.extra.label === 'See all' && m.extra.action === 'see-all');
  check('the line stays "{s} of {n} saved · {p} need you"', m.line === '0 of 23 saved · 23 need you');
  m = M.rowModel({ ...base, bestK: 0 });
  check('a pack with none qualifying keeps "See all"', m.button.label === 'See all' && m.button.action === 'see-all' && !m.extra);
  m = M.rowModel({ ...base });
  check('no bestK given: "See all"', m.button.action === 'see-all');
  m = M.rowModel({ ...base, bestK: 4, bulk: { done: 2, total: 4 } });
  check('while it runs the button reads "Saving 3 of 4…" and does nothing', m.button.label === 'Saving 3 of 4…' && m.button.action === 'busy');
  m = M.rowModel({ ...base, bestK: 4, bulk: { done: 4, total: 4 } });
  check('progress never passes k', m.button.label === 'Saving 4 of 4…');

  console.log('[46.4 stored candidates]');
  const rk = (language, group, id, releaseName) => ({ group, candidate: { providerId: 'os', id, language, releaseName: releaseName ?? `The.Mentalist.S02E01.${id}.720p-X`, matchedBy: 'title', hearingImpaired: true, format: 'srt', downloads: 99 } });
  const st = S.toStored([rk('de', 'fits', 'a'), rk('en', 'probably', 'b'), rk('en', 'maybe', 'c'), rk('fr', 'maybe', 'd')], ['en', 'de']);
  check('at most 2, one per language, the user\'s languages first', st.length === 2 && st[0].l === 'de' && st[1].l === 'en' && st[1].id === 'b');
  check('the top candidate of a language is the one kept', S.toStored([rk('en', 'probably', 'top'), rk('en', 'maybe', 'low')], ['en']).map((c) => c.id).join() === 'top');
  check('a language the user did not pick comes last', S.toStored([rk('fr', 'fits', 'f'), rk('en', 'maybe', 'e')], ['en'])[0].l === 'en');
  const one = st[0];
  check('it keeps provider, id, release, language, title, season, episode and nothing else', Object.keys(one).sort().join() === 'e,id,l,p,rel,s,t' && one.t === 'The Mentalist' && one.s === 2 && one.e === 1);
  const big = S.toStored([rk('en', 'fits', 'x', 'The.Mentalist.S02E01.' + 'z'.repeat(300))], ['en']);
  check('the release name is cut to 120', big[0].rel.length === 120);
  check('a release with no episode stores no season or episode', !('s' in S.toStored([rk('en', 'fits', 'x', 'The.Mentalist.2008.720p')], ['en'])[0]));
  const bytesOf = JSON.stringify(st).length;
  check(`a run's two candidates take about ${bytesOf} bytes of kv (under 600)`, bytesOf < 600);
  check('stored candidates read back clean; junk is dropped', S.cleanStored([one, { p: 1 }, null, 'x']).length === 1 && S.cleanStored('no') === undefined && S.cleanStored([]) === undefined);

  console.log('[46.4 the store keeps them with the run]');
  R.resetRequestsForTests();
  R.askSubtitles([{ key: 't:pack', title: 'The Mentalist S02 · 2 episodes', detail: '' }], { auto: false });
  const p1 = 'S/The.Mentalist.S02E01.mkv';
  const p2 = 'S/The.Mentalist.S02E02.mkv';
  R.setFileList('t:pack', [p1, p2], { [p1]: 111, [p2]: 222 });
  let e = R.getRequests()['t:pack'];
  check('the file list stores each size', e.files[p1].bytes === 111 && e.files[p2].bytes === 222);
  R.setRun('t:pack', p1, { phase: 'needs-pick', tries: 1, cands: [one] });
  e = R.getRequests()['t:pack'];
  check('a needs-pick run keeps its candidates and its size', e.files[p1].cands.length === 1 && e.files[p1].bytes === 111);
  check('they survive the kv round trip', JSON.parse(JSON.stringify(R.getRequests()))['t:pack'].files[p1].cands[0].id === one.id);
  R.setRun('t:pack', p1, { phase: 'searching', tries: 1 });
  check('a run that goes on to search drops them, and keeps its size', !R.getRequests()['t:pack'].files[p1].cands && R.getRequests()['t:pack'].files[p1].bytes === 111);
  R.setRun('t:pack', p1, { phase: 'needs-pick', tries: 2, cands: [one] });
  R.markSaved('t:pack', p1);
  e = R.getRequests()['t:pack'];
  check('markSaved marks the run saved and drops the candidates', e.files[p1].phase === 'saved' && e.files[p1].saved === true && !e.files[p1].cands && e.phase !== 'saved');
  R.setRun('t:pack', p2, { phase: 'needs-pick', tries: 1, cands: [one] });
  R.renameRequest('t:pack', 'Mentalist');
  check('a rename starts the runs again without candidates, size kept', !R.getRequests()['t:pack'].files[p2].cands && R.getRequests()['t:pack'].files[p2].bytes === 222);

  console.log('[46.3 bulk save marks saved and leaves the rest]');
  R.resetRequestsForTests();
  R.askSubtitles([{ key: 't:pack', title: 'The Mentalist S02 · 4 episodes', detail: '' }], { auto: false });
  const names = [1, 2, 3, 4].map((n) => `S/The.Mentalist.S02E0${n}.mkv`);
  R.setFileList('t:pack', names);
  names.forEach((n, i) => R.setRun('t:pack', n, { phase: 'needs-pick', tries: 1, cands: [cand({ e: i + 1, id: `c${i + 1}`, rel: `The.Mentalist.S02E0${i + 1}.720p` })] }));
  // episode 3's best is for the wrong episode
  R.setRun('t:pack', names[2], { phase: 'needs-pick', tries: 1, cands: [cand({ e: 9, id: 'c3', rel: 'The.Mentalist.S02E09.720p' })] });
  const runs = S.qualifyingRuns(R.getRequests()['t:pack'], EN);
  check('k = 3 of the 4 needs-pick runs', runs.length === 3);
  const calls = [];
  let live = 0;
  let maxLive = 0;
  const progress = [];
  const deps = {
    valid: (r) => R.getRequests()['t:pack'].files[r.fileKey].phase === 'needs-pick',
    save: async (r, c) => {
      calls.push(`${r.fileKey.slice(-7, -4)}:${c.id}`);
      live++;
      maxLive = Math.max(maxLive, live);
      await new Promise((res) => setTimeout(res, 5));
      live--;
      return 'saved';
    },
    research: async () => {
      throw new Error('no retry expected');
    },
    saved: (r) => R.markSaved('t:pack', r.fileKey),
    progress: (d, t) => progress.push(`${d}/${t}`),
  };
  let out = await S.runBulk(runs, deps);
  e = R.getRequests()['t:pack'];
  check('3 runs saved, each marked saved', out.saved === 3 && out.total === 3 && out.retried === 0 && [0, 1, 3].every((i) => e.files[names[i]].phase === 'saved'));
  check('the run that did not qualify stays in needs-pick', e.files[names[2]].phase === 'needs-pick' && out.left === 0 && S.needPickCount(e.files) === 1);
  check('the request is not saved as a whole', e.phase === 'needs-pick');
  check('each save used the stored candidate', calls.sort().join() === '1:c1,2:c2,4:c4'.replace(/(\d):/g, 'E0$1:'));
  check('saves run at most 2 at a time', maxLive === 2);
  check('progress counts ended runs up to k', progress.join() === '1/3,2/3,3/3' && S.bulkIndex(0, 3) === 1 && S.bulkIndex(3, 3) === 3);
  check('a second pass finds nothing left to do', S.qualifyingRuns(R.getRequests()['t:pack'], EN).length === 0);

  console.log('[46.4 an expired link is searched again once]');
  const mkRun = (n) => ({ askKey: 't:x', fileKey: `S/The.Mentalist.S02E0${n}.mkv`, cand: cand({ e: n, id: `old${n}` }), ctx: { ...ctx, episode: n } });
  const saves = [];
  let researched = 0;
  const flaky = {
    valid: () => true,
    save: async (r, c) => {
      saves.push(c.id);
      return c.id.startsWith('old') ? 'failed' : 'saved';
    },
    research: async (r) => {
      researched++;
      return [cand({ e: r.ctx.episode, id: `new${r.ctx.episode}`, rel: `The.Mentalist.S02E0${r.ctx.episode}.720p` })];
    },
    saved: () => {},
  };
  out = await S.runBulk([mkRun(1)], flaky);
  check('a failed download searches that run once and saves the new best', out.saved === 1 && out.retried === 1 && researched === 1 && saves.join() === 'old1,new1');
  researched = 0;
  const alwaysFails = { ...flaky, save: async () => 'failed' };
  out = await S.runBulk([mkRun(1)], alwaysFails);
  check('if the retry fails too it stays in needs-pick, with no third try', out.saved === 0 && out.left === 1 && researched === 1);
  const wrong = { ...flaky, research: async () => [cand({ e: 7, id: 'bad', rel: 'The.Mentalist.S02E07.720p' })] };
  saves.length = 0;
  out = await S.runBulk([mkRun(1)], wrong);
  check('a new best that does not qualify is not used', out.saved === 0 && saves.join() === 'old1' && out.left === 1);
  const none = { ...flaky, research: async () => null };
  out = await S.runBulk([mkRun(1)], none);
  check('a search that could not run leaves the run in needs-pick', out.saved === 0 && out.left === 1);
  const taken = { ...flaky, save: async () => 'stay' };
  researched = 0;
  out = await S.runBulk([mkRun(1)], taken);
  check('a taken name or an unwritable folder is not searched again', researched === 0 && out.left === 1);
  const gone = { ...flaky, valid: () => false };
  saves.length = 0;
  out = await S.runBulk([mkRun(1)], gone);
  check('a run skipped or renamed meanwhile is left alone', saves.length === 0 && out.saved === 0);
  const throws = { ...flaky, save: async () => { throw new Error('boom'); } };
  out = await S.runBulk([mkRun(1), mkRun(2)], throws);
  check('a run that throws does not stop the others', out.total === 2 && out.left === 2);
  out = await S.runBulk([], flaky);
  check('no runs: nothing happens', out.total === 0 && out.saved === 0);

  console.log('[46 wiring]');
  const runner = read('components/subtitles/useSubtitleRequests.ts');
  const sheet = read('components/subtitles/MultiSubtitleSheet.tsx');
  const page = read('app/torrent/[id].tsx');
  const bulkSrc = read('components/subtitles/bulkSave.ts');
  const rowSrc = read('components/subtitles/SubtitlesRow.tsx');
  check('the runner stores candidates for a pack when a run ends in needs-pick', /toStored\(res\.ranked, languages\)/.test(runner) && /phase === 'needs-pick' && pack && cands\.length > 0/.test(runner));
  check('the runner stores each video\'s size with the file list', /setFileList\(key, videos\.map\(\(f\) => f\.path\), Object\.fromEntries/.test(runner));
  check('the status sheet lists episodeRows and titles itself with the episode plural', /episodeRows\(/.test(sheet) && /multiTitle\(mode === 'status' \? rows\.length : asks\.length, allEpisodes\)/.test(sheet));
  check('the status sheet has the bulk button with its progress and result', /useBestMatchFor\(bestK\)/.test(sheet) && /bulkProgress\(bulkIndex/.test(sheet) && /bulkLine/.test(sheet));
  check('an episode row opens the page\'s single sheet and the list returns on close', /onOpenEpisode=/.test(page) && /torrentTarget\(id, snap\.outputFolder, f, downloadedFiles\)/.test(page) && /setBackToAll\(true\)/.test(page) && /if \(backToAll\)/.test(page));
  check('bulk saves go through the one save path with choice normal, marked with markSaved', /choice: 'normal'/.test(bulkSrc) && /markSaved\(r\.askKey, r\.fileKey\)/.test(bulkSrc) && /downloadAndSave\(/.test(bulkSrc));
  check('the page row starts the bulk and shows its result', /use-best/.test(rowSrc) && /bulk\.start\(\[requestKey\]\)/.test(rowSrc));
  check('skip aborts a bulk run through the abort registry', /registerRun\(r\.askKey, r\.fileKey, ctl\)/.test(bulkSrc));

  if (failed) {
    console.error(`${failed} failed`);
    process.exit(1);
  }
  console.log('subtitle season: all passed');
})();
