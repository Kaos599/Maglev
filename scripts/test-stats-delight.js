#!/usr/bin/env node
// Stats 0.27 (NATIVE_CONTRACT 34.2 "Live time for Stats"): live active seconds in stats_daily (tick accumulation, the 2x cap,
// local-midnight rollover, only Downloading counts, migration of an old table), plus the delight-pass rules: summary sentence,
// "vs last week", thin-data mode, train day snapping, clock-face hand angle, fire stage, streak flag default and the order of
// the Settings App rows. Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MBy = 1024 ** 2;

function rawDb(d = new DatabaseSync(':memory:')) {
  return {
    raw: d,
    exec: async (sql) => { d.exec(sql); },
    run: async (sql, p = []) => ({ changes: Number(d.prepare(sql).run(...p).changes) }),
    all: async (sql, p = []) => d.prepare(sql).all(...p).map((r) => ({ ...r })),
  };
}

async function main() {
  const Schema = await import('../utils/stats/schema.ts');
  const Store = await import('../utils/stats/store.ts');
  const Rec = await import('../utils/stats/recorder.ts');
  const I = await import('../utils/stats/insights.ts');
  const T = await import('../utils/stats/time.ts');
  const D = await import('../utils/stats/delight.ts');
  const Bk = await import('../utils/stats/backup.ts');
  const Tr = await import('../components/stats/trainMath.ts');
  const N = (s) => T.dayNumber(s);

  // ---- migration
  console.log('migration');
  const old = rawDb();
  for (const sql of Schema.MIGRATIONS[0]) old.raw.exec(sql);
  old.raw.exec('PRAGMA user_version = 1');
  old.raw.prepare('INSERT INTO stats_daily (day, downloaded, finished) VALUES (?, ?, ?)').run('2026-11-10', 500, 2);
  await Schema.migrate(old);
  const cols = old.raw.prepare('PRAGMA table_info(stats_daily)').all().map((c) => c.name);
  check('stats_daily gains active_secs', cols.includes('active_secs'));
  const oldRow = old.raw.prepare('SELECT * FROM stats_daily').get();
  check('an old row keeps its data and reads 0 seconds', oldRow.downloaded === 500 && oldRow.finished === 2 && oldRow.active_secs === 0);
  check('version moves to the latest', old.raw.prepare('PRAGMA user_version').get().user_version === Schema.STATS_VERSION && Schema.STATS_VERSION >= 2);
  await Schema.migrate(old);
  check('migrate again is safe', true);
  const half = rawDb();
  for (const sql of Schema.MIGRATIONS[0]) half.raw.exec(sql);
  half.raw.exec('ALTER TABLE stats_daily ADD COLUMN active_secs INTEGER NOT NULL DEFAULT 0');
  half.raw.exec('PRAGMA user_version = 1');
  let threw = false;
  try { await Schema.migrate(half); } catch { threw = true; }
  check('a crash between the ALTER and the version bump does not break the next start', !threw);

  // ---- store and backup carry the column
  console.log('store');
  const sdb = rawDb();
  await Schema.migrate(sdb);
  const st = Store.createStatsStore(sdb, () => ({ keepStats: true, mobileLimitMb: null }));
  await st.addDaily('2026-11-16', { downloaded: 10, activeSecs: 30 });
  await st.addDaily('2026-11-16', { activeSecs: 12 });
  const d0 = (await st.listDaily())[0];
  check('addDaily adds seconds', d0.activeSecs === 42 && d0.downloaded === 10);
  const sec = await st.exportSection();
  check('export carries activeSecs', sec.daily[0].activeSecs === 42);
  const parsed = Bk.parseStatsSection({ v: 1, records: [], daily: [{ day: '2026-11-15', downloaded: 5 }, { day: '2026-11-14', activeSecs: 9 }], monthly: [] });
  check('a backup from before 0.27 reads 0 seconds', parsed.daily[0].activeSecs === 0 && parsed.daily[1].activeSecs === 9);
  const sdb2 = rawDb();
  await Schema.migrate(sdb2);
  const st2 = Store.createStatsStore(sdb2, () => ({ keepStats: true, mobileLimitMb: null }));
  await st2.importSection(sec);
  check('import restores seconds', (await st2.listDaily())[0].activeSecs === 42);

  // ---- recorder: live active seconds
  console.log('recorder');
  const tsnap = (o = {}) => ({ id: 'h1', name: 'Movie', state: 'DOWNLOADING', pausedBy: null, finished: false, progressBytes: 0, totalBytes: 1000, includedBytes: 1000, uploadedBytes: 0, addedAt: 1, error: null, ...o });
  const lsnap = (o = {}) => ({ id: 'd1', urlDisplay: 'https://x.test/a.zip', name: 'a.zip', state: 'downloading', size: 2000, downloaded: 0, addedAt: 1, error: null, stream: null, ...o });
  const it = (ts, ds = []) => Rec.toItems(ts, ds);
  check('torrent DOWNLOADING is downloading', it([tsnap()])[0].downloading === true);
  check('a seeding torrent is not', it([tsnap({ state: 'SEEDING' })])[0].downloading === false);
  check('a paused torrent is not', it([tsnap({ state: 'PAUSED', pausedBy: 'user' })])[0].downloading === false);
  check('a queued torrent is not', it([tsnap({ state: 'QUEUED' })])[0].downloading === false);
  check('a checking torrent is not', it([tsnap({ state: 'CHECKING' })])[0].downloading === false);
  check('a failed torrent is not', it([tsnap({ state: 'ERROR', error: { code: 'X', message: 'x' } })])[0].downloading === false);
  check('a link downloading is', it([], [lsnap()])[0].downloading === true);
  check('a paused link is not', it([], [lsnap({ state: 'paused' })])[0].downloading === false);
  check('a queued link is not', it([], [lsnap({ state: 'queued' })])[0].downloading === false);
  check('a resolving link is not', it([], [lsnap({ state: 'resolving' })])[0].downloading === false);

  check('tick seconds: one item, one second', Rec.activeTickSecs(1000, 2000, 1, 1000) === 1);
  check('tick seconds: two items at once count real time once', Rec.activeTickSecs(1000, 2000, 2, 1000) === 1);
  check('tick seconds: capped at 2x the interval', Rec.activeTickSecs(1000, 1000 + 30 * 60_000, 1, 1000) === 2);
  check('tick seconds: nothing downloading', Rec.activeTickSecs(1000, 2000, 0, 1000) === 0);
  check('tick seconds: no earlier tick', Rec.activeTickSecs(0, 2000, 1, 1000) === 0);
  check('tick seconds: a clock that went back', Rec.activeTickSecs(5000, 4000, 1, 1000) === 0);
  check('tick seconds: a slower tick cap follows the interval', Rec.activeTickSecs(0 + 1, 1 + 4000, 1, 2000) === 4);

  const mk = async (tickMs) => {
    const db = rawDb();
    await Schema.migrate(db);
    const store = Store.createStatsStore(db, () => ({ keepStats: true, mobileLimitMb: null }));
    let baseline = null;
    let now = 0;
    const r = Rec.createRecorder({
      store, prefs: () => ({ keepStats: true, mobileLimitMb: null }), baselineIO: { load: () => baseline, save: (x) => { baseline = x; } },
      origin: () => ({ source: null, category: null }), now: () => now, tz: () => 0, tickMs,
    });
    return { store, r, at: (n) => { now = n; } };
  };
  const base = Date.UTC(2026, 10, 16, 12, 0, 0);
  const a = await mk(1000);
  a.at(base);
  await a.r.onSnapshot([tsnap()], []); // first look: counts nothing
  for (let s = 1; s <= 3; s++) { a.at(base + s * 1000); await a.r.onSnapshot([tsnap()], []); }
  check('ticks inside the minute wait in memory', (await a.store.listDaily()).length === 0);
  const live = a.r.getLive();
  check('the live view already holds the seconds', live.days['2026-11-16'] && live.days['2026-11-16'].activeSecs === 3 && live.running === true);
  a.at(base + 61_000); // a 58 s gap, capped at 2 s
  await a.r.onSnapshot([tsnap()], []);
  const rows = await a.store.listDaily();
  check('a minute later the seconds are written, the gap capped', rows.length === 1 && rows[0].activeSecs === 5, JSON.stringify(rows));
  check('after a write the live view is empty', Object.keys(a.r.getLive().days).length === 0 || a.r.getLive().days['2026-11-16'].activeSecs === 0);

  const b = await mk(1000);
  b.at(base);
  await b.r.onSnapshot([tsnap(), tsnap({ id: 'h2' }), tsnap({ id: 'h3', state: 'PAUSED', pausedBy: 'user' }), tsnap({ id: 'h4', state: 'SEEDING' })], [lsnap(), lsnap({ id: 'd2', state: 'paused' })]);
  b.at(base + 1000);
  await b.r.onSnapshot([tsnap(), tsnap({ id: 'h2' }), tsnap({ id: 'h3', state: 'PAUSED', pausedBy: 'user' }), tsnap({ id: 'h4', state: 'SEEDING' })], [lsnap(), lsnap({ id: 'd2', state: 'paused' })]);
  await b.r.flush();
  check('3 downloading at once (paused/seeding ignored) count 1 real second', (await b.store.listDaily())[0].activeSecs === 1);

  const c = await mk(1000);
  const before = Date.UTC(2026, 10, 16, 23, 59, 58);
  c.at(before);
  await c.r.onSnapshot([tsnap()], []);
  c.at(before + 1000); // 23:59:59 on the 16th
  await c.r.onSnapshot([tsnap()], []);
  c.at(before + 2000); // 00:00:00 on the 17th
  await c.r.onSnapshot([tsnap()], []);
  await c.r.flush();
  const crow = await c.store.listDaily();
  const byDay = Object.fromEntries(crow.map((r) => [r.day, r.activeSecs]));
  check('a tick belongs to the local day it lands in (midnight rollover)', byDay['2026-11-16'] === 1 && byDay['2026-11-17'] === 1, JSON.stringify(byDay));

  const e = await mk(1000);
  e.at(base);
  await e.r.onSnapshot([tsnap({ state: 'PAUSED', pausedBy: 'user' })], []);
  e.at(base + 1000);
  await e.r.onSnapshot([tsnap({ state: 'PAUSED', pausedBy: 'user' })], []);
  await e.r.flush();
  check('nothing downloading writes no seconds', (await e.store.listDaily()).every((r) => r.activeSecs === 0));

  // ---- Stats read the seconds from stats_daily
  console.log('range time and speed');
  const wk = I.rangeOf('week', N('2026-11-18'));
  const row = (day, o) => ({ day, downloaded: 0, uploaded: 0, mobile: 0, wifi: 0, finished: 0, failed: 0, cancelled: 0, activeSecs: 0, ...o });
  const now = Date.UTC(2026, 10, 18, 12, 0, 0);
  const recs = [{ id: 'r1', kind: 'torrent', name: 'r1', size: 100 * MBy, category: null, source: null, activeSecs: 50, sessionBytes: 100 * MBy, uploaded: 0, bytesWifi: 100 * MBy, bytesMobile: 0, addedAt: 1, finishedAt: Math.floor(Date.UTC(2026, 10, 16, 9) / 1000), retries: 0 }];
  const live1 = I.rangeStats({ records: recs, daily: [row('2026-11-17', { downloaded: 200 * MBy, activeSecs: 100 }), row('2026-11-18', { downloaded: 100 * MBy, activeSecs: 50 })], now, tz: 0 }, wk);
  check('time spent comes from the daily rows', live1.activeSecs === 150 + 50 || live1.activeSecs === 150, `got ${live1.activeSecs}`);
  check('time spent counts days that have live seconds once', live1.activeSecs === 200, `got ${live1.activeSecs}`);
  check('average speed is downloaded / active seconds of the range', Math.abs(live1.avgBps - (300 * MBy) / 200) < 1, `got ${live1.avgBps}`);
  const nolive = I.rangeStats({ records: recs, daily: [row('2026-11-16', { downloaded: 100 * MBy, finished: 1 })], now, tz: 0 }, wk);
  check('a day before 0.27 shows its finished items’ time', nolive.activeSecs === 50 && nolive.avgBps === 2 * MBy);
  // A download that ran while the app was in the background: the live count saw only 10 s, the engine measured 50 s.
  const bg = I.rangeStats({ records: recs, daily: [row('2026-11-16', { downloaded: 100 * MBy, finished: 1, activeSecs: 10 })], now, tz: 0 }, wk);
  check('a day takes the larger of live seconds and its finished items’ time (background time is not lost)', bg.activeSecs === 50 && bg.avgBps === 2 * MBy, `got ${bg.activeSecs}`);
  const zero = I.rangeStats({ records: [], daily: [row('2026-11-18', { downloaded: 5 })], now, tz: 0 }, wk);
  check('no seconds: time 0 and speed unknown', zero.activeSecs === 0 && zero.avgBps === null);
  const most = I.mostInOneRange(recs, wk, 0, N('2026-11-10'), [row('2026-11-17', { activeSecs: 100 }), row('2026-11-18', { activeSecs: 50 })]);
  // 100 + 50 stored, plus the record that finished on Nov 16 (a day with no stored seconds)
  check('most in one range reads the daily seconds too', most === 200, `got ${most}`);

  console.log('live merge');
  const merged = D.mergeLive([row('2026-11-18', { downloaded: 10, activeSecs: 5 })], { days: { '2026-11-18': { downloaded: 7, activeSecs: 3 }, '2026-11-19': { downloaded: 2 } }, running: true });
  check('live adds to a stored day', merged.find((r) => r.day === '2026-11-18').downloaded === 17 && merged.find((r) => r.day === '2026-11-18').activeSecs === 8);
  check('live creates a day that has no row yet', merged.find((r) => r.day === '2026-11-19').downloaded === 2);
  check('nothing live leaves the rows alone', D.mergeLive([row('2026-11-18', { downloaded: 10 })], { days: {}, running: false })[0].downloaded === 10);

  // ---- summary sentence
  console.log('summary sentence');
  const today = N('2026-11-18'); // Wednesday
  const mkDaily = (list) => list.map(([d, o]) => row(d, o));
  const stats = (daily, r = wk, records = []) => I.rangeStats({ records, daily, now, tz: 0 }, r);
  const dly = mkDaily([['2026-11-16', { downloaded: 10 * MBy, finished: 1 }], ['2026-11-17', { downloaded: 20 * MBy, finished: 1 }], ['2026-11-18', { downloaded: 500 * MBy, finished: 2 }]]);
  const sentence = D.summarySentence(stats(dly), wk, today, dly);
  check('sentence leads with the size', sentence && sentence.lead === '530 MB', sentence && sentence.lead);
  check('sentence names the period', sentence.rest.startsWith(' this week.'), sentence.rest);
  check('today the busiest day is said plainly', /Today is the busiest day so far\./.test(sentence.rest), sentence.rest);
  const quiet = mkDaily([['2026-11-16', { downloaded: 400 * MBy, finished: 1 }], ['2026-11-17', { downloaded: 20 * MBy, finished: 1 }], ['2026-11-18', { downloaded: 5 * MBy }]]);
  const s2 = D.summarySentence(stats(quiet), wk, today, quiet);
  check('otherwise it counts what finished', /2 downloads finished\./.test(s2.rest), s2.rest);
  check('nothing downloaded: no sentence', D.summarySentence(stats([]), wk, today, []) === null);
  const lastWeek = I.rangeOf('week', N('2026-11-11'));
  const s3 = D.summarySentence(stats(mkDaily([['2026-11-10', { downloaded: 2 * 1024 * MBy, finished: 3 }]]), lastWeek), lastWeek, today, mkDaily([['2026-11-10', { downloaded: 2 * 1024 * MBy, finished: 3 }]]));
  check('a past week says "last week"', s3.lead === '2.0 GB' && s3.rest.startsWith(' last week.'), JSON.stringify(s3));
  const oneFinish = mkDaily([['2026-11-18', { downloaded: 5 * MBy, finished: 1 }]]);
  check('one finished reads "1 download finished"', /1 download finished\./.test(D.summarySentence(stats(oneFinish), wk, today, oneFinish).rest));

  // ---- vs last week
  console.log('vs last week');
  const both = mkDaily([['2026-11-09', { downloaded: 100 * MBy }], ['2026-11-10', { downloaded: 50 * MBy }], ['2026-11-12', { downloaded: 900 * MBy }], ['2026-11-16', { downloaded: 200 * MBy }], ['2026-11-17', { downloaded: 20 * MBy }]]);
  const vs = D.vsLastWeek(both, wk, today);
  check('compares the same days of last week while this week is open', vs && vs.text === '70 MB more than last week so far' && vs.dir === 'up', vs && vs.text);
  const down = mkDaily([['2026-11-09', { downloaded: 300 * MBy }], ['2026-11-16', { downloaded: 100 * MBy }]]);
  check('less is said plainly', D.vsLastWeek(down, wk, today).text === '200 MB less than last week so far');
  const same = mkDaily([['2026-11-09', { downloaded: 300 * MBy }], ['2026-11-16', { downloaded: 300 * MBy }]]);
  check('equal is said plainly', D.vsLastWeek(same, wk, today).dir === 'same');
  check('absent without a previous week with data', D.vsLastWeek(mkDaily([['2026-11-16', { downloaded: 100 * MBy }]]), wk, today) === null);
  check('a previous week with only zeros is not data', D.vsLastWeek(mkDaily([['2026-11-09', {}], ['2026-11-16', { downloaded: 100 * MBy }]]), wk, today) === null);
  check('absent with no stats at all', D.vsLastWeek([], wk, today) === null);
  check('only for weeks', D.vsLastWeek(both, I.rangeOf('month', today), today) === null && D.vsLastWeek(both, I.rangeOf('year', today), today) === null);
  const pastWeek = I.rangeOf('week', N('2026-11-11'));
  const vp = D.vsLastWeek(mkDaily([['2026-11-02', { downloaded: 100 * MBy }], ['2026-11-10', { downloaded: 400 * MBy }]]), pastWeek, today);
  check('a finished week compares whole weeks', vp && vp.text === '300 MB more than the week before', vp && vp.text);

  // ---- thin data
  console.log('thin data');
  check('day one of stats is thin', D.isThinData(N('2026-11-18'), today) === true);
  check('six days in is thin', D.isThinData(N('2026-11-13'), today) === true);
  check('a week in is not', D.isThinData(N('2026-11-12'), today) === false);
  check('no stats at all is not "thin" (the empty state covers it)', D.isThinData(null, today) === false);
  check('the finish-hour card needs 5 finished downloads', D.hourReady(new Array(24).fill(0).map((_, i) => (i === 3 ? 4 : 0))) === false && D.hourReady(new Array(24).fill(0).map((_, i) => (i < 5 ? 1 : 0))) === true);

  // ---- train snapping
  console.log('train');
  const L = { x0: 7, bw: 16, pitch: 22 };
  const centre = (i) => L.x0 + i * L.pitch + L.bw / 2;
  check('a point over a building snaps to that day', Tr.snapIndex(centre(3) + 4, L, 0, 6) === 3);
  check('halfway between two days rounds to the later one', Tr.snapIndex((centre(2) + centre(3)) / 2, L, 0, 6) === 3);
  check('left of the first day is the first day', Tr.snapIndex(-50, L, 0, 6) === 0);
  check('past the last built day stops at it (the buffer stop)', Tr.snapIndex(centre(6), L, 0, 3) === 3);
  check('never before the first stats day', Tr.snapIndex(centre(0), L, 2, 6) === 2);
  check('the train follows the finger between the first and last day', Tr.trainCentre(centre(1) + 5, L, 0, 3) === centre(1) + 5);
  check('the train stops at the last day’s centre, no further', Tr.trainCentre(500, L, 0, 3) === centre(3) && Tr.trainCentre(-500, L, 0, 3) === centre(0));
  check('an inverted range collapses to one day', Tr.trainCentre(centre(5), L, 4, 2) === centre(4));
  check('with Reduce motion the train sits on a whole day', Tr.cursorAt(centre(1) + 5, L, 0, 6, true) === centre(1) && Tr.cursorAt(centre(1) + 5, L, 0, 6, false) === centre(1) + 5);
  check('the last built day is today in the current range', Tr.lastBuilt([{ future: false }, { future: false }, { future: true }]) === 1 && Tr.lastBuilt([{ future: false }, { future: false }]) === 1);
  check('the run visits every day Monday to today', eq(Tr.runStops(0, 3), [0, 1, 2, 3]));
  check('the run starts the buildings in step with the train', Tr.riseStart(0, 3, 1200) === 0 && Tr.riseStart(3, 3, 1200) === 1200 && Tr.riseStart(0, 0, 1200) === 0);
  check('wagon unit never carries more than the cap', Tr.wagonCount(0, 6) === 0 && Tr.wagonCount(3, 6) === 3 && Tr.wagonCount(40, 6) <= 6);

  // ---- clock face
  console.log('clock face');
  const Pc = await import('../components/stats/clockMath.ts');
  check('the hand at 3 is 90 degrees', Pc.handAngle(3) === 90);
  check('the hand at 15 (3 pm) is also 90 degrees', Pc.handAngle(15) === 90);
  check('midnight and noon point up', Pc.handAngle(0) === 0 && Pc.handAngle(12) === 0);
  check('21:00 is 270', Pc.handAngle(21) === 270);
  check('pm shows the moon and am the sun', Pc.isPm(12) === true && Pc.isPm(23) === true && Pc.isPm(11) === false && Pc.isPm(0) === false);
  const tip = Pc.handTip(3, 4);
  check('the hand tip at 3 is four to the right', tip.dx === 4 && tip.dy === 0);
  const tip9 = Pc.handTip(21, 4);
  check('the hand tip at 9 is four to the left', tip9.dx === -4 && tip9.dy === 0);
  const tip12 = Pc.handTip(0, 4);
  check('the hand tip at 12 is four up', tip12.dx === 0 && tip12.dy === -4);

  // ---- fire and the streak flag
  console.log('streak card');
  check('the streak card flag is OFF by default', D.SHOW_STREAK_CARD === false);
  check('broken or no streak is an ember', D.fireStage(0) === 0);
  check('a streak starts at the flame', D.fireStage(1) === 1 && D.fireStage(2) === 1 && D.fireStage(6) === 1);
  check('a week of days is a full fire', D.fireStage(7) === 2 && D.fireStage(40) === 2);
  const kit = read('components/stats/StatsKit.tsx');
  check('the kit renders the streak card only behind the flag', /SHOW_STREAK_CARD/.test(kit));

  // ---- settings order: About, Updates, Stats (Stats last)
  console.log('settings order');
  const settings = read('app/(tabs)/settings.tsx');
  const appAt = settings.indexOf('const appRows');
  const about = settings.indexOf("title: 'About'", appAt);
  const updates = settings.indexOf("title: 'Updates'", appAt);
  const map = settings.indexOf('appRows.map');
  const statsRow = settings.indexOf('<StatsRow />', map);
  check('App rows are About, then Updates', appAt > 0 && about > appAt && updates > about);
  check('Stats comes after the appRows', map > updates && statsRow > map);
  check('nothing sits between the appRows and Stats', !/<SettingsRow|<\w+Row \/>/.test(settings.slice(map, statsRow).replace('<SettingsRow key={r.route} {...r} />', '')));
  check('Stats is the last row of the App card', /<StatsRow \/>\s*<\/Card>/.test(settings.slice(statsRow - 5, statsRow + 60)));

  if (failed) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall stats delight checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
