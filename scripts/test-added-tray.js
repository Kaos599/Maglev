#!/usr/bin/env node
// The "Added" message (NATIVE_CONTRACT 44.3, 44.4, 44.5): merge, counts, words, timer, action choice, and what counts as a video.
// Needs Node 22.18+.
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
  const t = await import('../utils/addedTray.ts');
  const k = await import('../utils/mediaKind.ts');

  const ask = (hash, name) => t.buildAsk({ infoHash: hash, name });
  const add = (state, hash, name, o = {}) =>
    t.mergeAdd(state, { hash, name, ask: o.video === false ? null : ask(hash, name), auto: !!o.auto, alreadyThere: o.already, note: o.note }, o.now ?? 1000);
  const PRESTIGE = 'The.Prestige.2006.1080p.BluRay.x264-GRP';
  const INCEPTION = 'Inception.2010.1080p.BluRay.x264-GRP';
  const SEVERANCE = 'Severance.S01E01.1080p.WEB-DL';
  const SONGS = 'Hans Zimmer - Interstellar (Original Soundtrack)';

  console.log('[names and asks]');
  check('film reads as title and year', t.readName(PRESTIGE).display === 'The Prestige (2006)');
  check('short is the title', t.readName(PRESTIGE).short === 'The Prestige');
  check('episode reads as S01E01', t.readName(SEVERANCE).display === 'Severance S01E01');
  check('season pack reads as S01', t.readName('Severance.S01.1080p.WEB-DL.x265-GRP').display === 'Severance S01');
  check('pack is a season pack', t.isSeasonPack('Severance.S01.1080p.WEB-DL.x265-GRP') && !t.isSeasonPack(SEVERANCE));
  const a = t.buildAsk({ infoHash: 'ABCDEF', name: 'The.Prestige.2006.1080p.BluRay.x264-GRP', sizeBytes: 2.1 * 1024 ** 3, sourceName: 'YTS' });
  check('key is t:<lowercase hash>', a.key === 't:abcdef');
  check('detail is resolution, source, size', a.detail === '1080p · YTS · 2.1 GB');
  check('unknown detail parts are left out', t.buildAsk({ infoHash: 'x', name: 'Inception 2010' }).detail === '');
  check('detail without source', t.buildAsk({ infoHash: 'x', name: PRESTIGE, sizeBytes: 1024 ** 3 }).detail === '1080p · 1.0 GB');
  check('season pack ask names its episodes', t.buildAsk({ infoHash: 'x', name: 'Severance.S01.1080p.WEB-DL', videoCount: 10 }).title === 'Severance S01 · 10 episodes');

  console.log('[one add]');
  let s = add(null, 'aa', PRESTIGE);
  check('title', t.trayTitle(s) === 'Added to Transfers');
  check('line is the parsed name', t.trayLine(s) === 'The Prestige (2006)');
  check('counts', JSON.stringify(t.trayCounts(s)) === JSON.stringify({ n: 1, v: 1, asked: 0, alreadyCount: 0 }));
  check('video: Get subtitles', t.trayAction(s).main.kind === 'ask' && t.trayAction(s).main.label === 'Get subtitles');
  check('tile is lime', t.trayTileMuted(s) === false);
  check('note shows for one add', t.trayLine(add(null, 'aa', PRESTIGE, { note: 'Leaves 2 GB free' })) === 'The Prestige (2006) · Leaves 2 GB free');

  console.log('[combining adds]');
  s = add(s, 'bb', INCEPTION, { now: 2000 });
  check('two: Added 2 to Transfers', t.trayTitle(s) === 'Added 2 to Transfers');
  check('two: line A, B', t.trayLine(s) === 'The Prestige (2006), Inception (2010)');
  check('two videos: Get subtitles for 2', t.trayAction(s).main.label === 'Get subtitles for 2' && t.trayAction(s).main.count === 2);
  s = add(s, 'cc', 'Dune.Part.Two.2024.1080p.WEB-DL', { now: 3000 });
  s = add(s, 'dd', 'Oppenheimer.2023.1080p.WEB-DL', { now: 4000 });
  check('four: and 2 more', t.trayLine(s) === 'The Prestige (2006), Inception (2010) and 2 more');
  check('four: title', t.trayTitle(s) === 'Added 4 to Transfers');
  check('every add restarts the timer', s.deadline === 4000 + t.TRAY_MS);
  check('note hidden once there are two adds', !t.trayLine(add(add(null, 'aa', PRESTIGE, { note: 'x' }), 'bb', INCEPTION)).includes('x'));

  console.log('[45.3 same name, told apart]');
  const BBB_A = 'Big.Buck.Bunny.2160p.x265';
  const BBB_B = 'Big.Buck.Bunny.BDRip.x264';
  let tw = add(null, 'b1', BBB_A, { now: 1000 });
  tw = add(tw, 'b2', BBB_B, { now: 2000 });
  check('45.3 two adds 1 s apart with identical parsed titles: Added 2 to Transfers, distinct names', t.trayTitle(tw) === 'Added 2 to Transfers' && t.trayLine(tw) === 'Big Buck Bunny (2160p), Big Buck Bunny (BDRip)', t.trayLine(tw));
  check('45.3 the announcement uses the same names', t.trayAnnouncement(tw) === 'Added 2 to Transfers. Big Buck Bunny (2160p), Big Buck Bunny (BDRip)');
  check('45.3 resolution first, then source, then release group, then size', t.tellApart('Film.2160p.BluRay-GRP', 5) === '2160p' && t.tellApart('Film.WEB-DL-GRP', 5) === 'WEB-DL' && t.tellApart('Film-GRP', 5) === 'grp' && t.tellApart('Film', 2.1 * 1024 ** 3) === '2.1 GB' && t.tellApart('Film') === '');
  let tz = t.mergeAdd(null, { hash: 'z1', name: 'Film', ask: null, auto: false, sizeBytes: 1024 ** 3 }, 1000);
  tz = t.mergeAdd(tz, { hash: 'z2', name: 'Film', ask: null, auto: false, sizeBytes: 2 * 1024 ** 3 }, 2000);
  check('45.3 the size tells two bare names apart', t.trayLine(tz) === 'Film (1.0 GB), Film (2.0 GB)', t.trayLine(tz));
  check('45.3 names that already differ are left alone', t.trayLine(add(add(null, 'a1', BBB_A), 'a2', INCEPTION, { now: 2000 })) === 'Big Buck Bunny, Inception (2010)');
  check('45.3 a single add is never changed', t.trayLine(add(null, 'a1', BBB_A)) === 'Big Buck Bunny');
  check('45.3 the Search screen hands the size to the tray', /sizeBytes: size/.test(read('app/(tabs)/search.tsx')));

  console.log('[non-video adds count in n, never in v]');
  let m = add(null, 'aa', PRESTIGE);
  m = add(m, 'ss', SONGS, { video: false });
  check('music counts in n', t.trayCounts(m).n === 2);
  check('music is not a video', t.trayCounts(m).v === 1);
  check('one video left: Get subtitles', t.trayAction(m).main.label === 'Get subtitles');
  const only = add(null, 'ss', SONGS, { video: false });
  check('music alone: no main action', t.trayAction(only).main === null && !t.trayAction(only).skip);
  check('music alone: title', t.trayTitle(only) === 'Added to Transfers');

  console.log('[same hash]');
  let d = add(null, 'aa', PRESTIGE, { already: true });
  check('alone: Already in Transfers', t.trayTitle(d) === 'Already in Transfers');
  check('alone: muted tile', t.trayTileMuted(d) === true);
  check('alone: not counted', t.trayCounts(d).n === 0);
  check('alone: no subtitle action', t.trayAction(d).main === null);
  d = add(null, 'aa', PRESTIGE);
  d = add(d, 'bb', INCEPTION, { already: true });
  check('merged: not counted', t.trayCounts(d).n === 1 && t.trayCounts(d).alreadyCount === 1);
  check('merged: title is the single add', t.trayTitle(d) === 'Added to Transfers');
  check('merged: line ends with was already there', t.trayLine(d) === 'The Prestige (2006) · Inception was already there');
  d = add(d, 'cc', 'Dune.Part.Two.2024.1080p.WEB-DL', { already: true });
  check('merged: k were already there', t.trayLine(d) === 'The Prestige (2006) · 2 were already there');
  const again = add(add(null, 'aa', PRESTIGE), 'AA', PRESTIGE);
  check('the same hash twice in one message counts once', t.trayCounts(again).n === 1 && t.trayCounts(again).alreadyCount === 1);
  check('hash case does not matter', again.items[0].hash === 'aa');

  console.log('[asking for subtitles]');
  let q = add(add(null, 'aa', PRESTIGE), 'bb', INCEPTION);
  q = t.markAsked(q, ['t:aa', 't:bb']);
  check('asked: counts', t.trayCounts(q).asked === 2 && t.trayCounts(q).v === 0);
  check('asked: state row says Getting subtitles for 2', t.trayAction(q).main.kind === 'getting' && t.trayAction(q).main.label === 'Getting subtitles for 2');
  check('asked: state row opens the status sheet', t.trayAction(q).main.opensStatus === true);
  check('asked: no more button', t.trayAction(q).main.more === null);
  check('asked: title is unchanged in manual mode', t.trayTitle(q) === 'Added 2 to Transfers');
  q = add(q, 'cc', 'Dune.Part.Two.2024.1080p.WEB-DL');
  check('later video: shows k more', t.trayAction(q).main.more.label === '1 more');
  check('later video: more label for screen readers', t.trayAction(q).main.more.a11y === 'Get subtitles for 1 more');
  q = add(q, 'ee', 'Heat.1995.1080p.BluRay');
  check('two later videos: 2 more', t.trayAction(q).main.more.label === '2 more' && t.trayAction(q).main.more.count === 2);
  check('pending asks are the unasked videos', t.pendingAsks(q).map((x) => x.key).join() === 't:cc,t:ee');
  check('asked asks are the asked videos', t.askedAsks(q).map((x) => x.key).join() === 't:aa,t:bb');
  const one = t.markAsked(add(null, 'aa', PRESTIGE), ['t:aa']);
  check('one asked: Getting subtitles', t.trayAction(one).main.label === 'Getting subtitles' && t.trayAction(one).main.opensStatus === false);
  check('markAsked ignores keys it does not have', t.trayCounts(t.markAsked(one, ['t:zz'])).asked === 1);

  console.log('[automatic mode]');
  let au = add(null, 'aa', PRESTIGE, { auto: true });
  check('one: Added · Getting subtitles', t.trayTitle(au) === 'Added · Getting subtitles');
  check('one: line is the name', t.trayLine(au) === 'The Prestige (2006)');
  check('one: Skip, no See which', t.trayAction(au).skip === true && t.trayAction(au).see === false && t.trayAction(au).main === null);
  au = add(au, 'bb', INCEPTION, { auto: true });
  au = add(au, 'ss', SONGS, { auto: true, video: false });
  check('several: title counts adds and videos', t.trayTitle(au) === 'Added 3 · Getting subtitles for 2');
  check('several: See which and Skip', t.trayAction(au).see === true && t.trayAction(au).skip === true);
  const sk = t.skipAsked(au);
  check('skip returns the asked keys', sk.keys.join() === 't:aa,t:bb');
  check('after Skip: Added 3 to Transfers', t.trayTitle(sk.state) === 'Added 3 to Transfers');
  check('after Skip: no subtitle action', t.trayAction(sk.state).main === null && !t.trayAction(sk.state).skip);
  check('after Skip: skipped videos are not pending', t.trayCounts(sk.state).v === 0);
  const sk1 = t.skipAsked(add(null, 'aa', PRESTIGE, { auto: true }));
  check('after Skip, one add: Added to Transfers', t.trayTitle(sk1.state) === 'Added to Transfers');
  check('automatic with only music: plain title', t.trayTitle(add(null, 'ss', SONGS, { auto: true, video: false })) === 'Added to Transfers');

  console.log('[timer]');
  check('6 seconds', t.TRAY_MS === 6000);
  check('remaining counts down', t.remainingMs(7000, 5000) === 2000);
  check('remaining never negative', t.remainingMs(7000, 9000) === 0);
  check('a hold moves the deadline out', t.shiftDeadline(7000, 1500) === 8500);
  check('a negative hold moves nothing', t.shiftDeadline(7000, -5) === 7000);
  check('runs when nothing holds it', t.timerRuns({ screenReader: false, held: false }) === true);
  check('a finger holds it', t.timerRuns({ screenReader: false, held: true }) === false);
  check('TalkBack keeps it until dismissed', t.timerRuns({ screenReader: true, held: false }) === false);

  console.log('[what counts as a video]');
  check('Movies category', k.isVideoResult({ category: 'movies', name: 'anything' }));
  check('TV category', k.isVideoResult({ category: 'tv', name: 'anything' }));
  check('Anime category', k.isVideoResult({ category: 'anime', name: 'anything' }));
  check('Music category, even with a year', !k.isVideoResult({ category: 'music', name: 'Album 2014' }));
  check('Apps category', !k.isVideoResult({ category: 'apps', name: 'Tool 2020' }));
  check('Games category', !k.isVideoResult({ category: 'games', name: 'Game 2020' }));
  check('Books category', !k.isVideoResult({ category: 'books', name: 'Book 2020' }));
  check('Other category', !k.isVideoResult({ category: 'other', name: 'Film 2020' }));
  check('Adult category', !k.isVideoResult({ category: 'adult', name: 'Film 2020' }));
  check('no category: title and year', k.isVideoResult({ name: 'Casino Royale (2006)' }));
  check('no category: episode', k.isVideoResult({ name: 'Severance S02E03' }));
  check('no category: season', k.isVideoResult({ name: 'Severance S02' }));
  check('no category: release name', k.isVideoResult({ name: PRESTIGE }));
  check('no category: title only is not a video', !k.isVideoResult({ name: 'Interstellar' }));
  check('no category: a soundtrack is not a video', !k.isVideoResult({ name: SONGS }));
  check('no category: an album with a year is not a video', !k.isVideoResult({ name: 'Artist - Album (2014) [FLAC]' }));
  check('no category: a sample is not a video', !k.isVideoResult({ name: 'Sample' }));
  check('all is read by name', k.isVideoResult({ category: 'all', name: INCEPTION }));

  console.log('[wiring]');
  const search = read('app/(tabs)/search.tsx');
  const row = read('components/search/ResultRow.tsx');
  const addTorrent = read('app/add-torrent.tsx');
  const tray = read('components/search/AddedTray.tsx');
  check('search no longer shows the Added banner', !/title:\s*'Added to Transfers'/.test(search));
  check('search mounts the tray', /useAddedTray\(/.test(search) && /tray\.node/.test(search));
  check('search keeps one slot with the banner', /trayHide\(\)/.test(search) && /dismiss\(\)/.test(search));
  check('search tracks adds in flight as a set', /useState<Set<string>>/.test(search) && /busyHashes/.test(search));
  check('search keeps the sessionAdded clean-up', /sessionAdded/.test(search) && /inList\.has\(h\)/.test(search));
  check('row shows a spinner while adding', /ActivityIndicator|LoadingDots/.test(row) && /colors\.download/.test(row));
  check('row shows the added check in accentText', /icon="check" color=\{colors\.accentText\}/.test(row));
  check('add link screen has the row too', /SubtitlesAutoRow/.test(read('app/add-download.tsx')) && /d:\$\{res\.id\}/.test(read('app/add-download.tsx')) && /fileKind/.test(read('app/add-download.tsx')));
  check('add screen has a Subtitles row with a switch', /SubtitlesAutoRow/.test(addTorrent) && /autoNewVideos/.test(read('components/search/SubtitlesAutoRow.tsx')) && /askSubtitles\(/.test(addTorrent));
  check('tray calls the interface from 44.1', /askSubtitles\(/.test(tray) && /skipSubtitles/.test(tray) && /MultiSubtitleSheet/.test(tray));
  check('tray slides in on motion.duration.focus and honours reduce motion', /motion\.duration\.focus/.test(tray) && /useReduceMotion/.test(tray));
  check('tray has no hex colours', !/#[0-9A-Fa-f]{3,8}\b/.test(tray));

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall passed');
})();
