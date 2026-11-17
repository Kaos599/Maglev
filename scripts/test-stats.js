#!/usr/bin/env node
// Local stats (NATIVE_CONTRACT 34.2): schema, store over node:sqlite, recorder, insights, prefs, backup section.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');
let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function fakeDb() {
  const d = new DatabaseSync(':memory:');
  return {
    exec: async (sql) => { d.exec(sql); },
    run: async (sql, p = []) => ({ changes: Number(d.prepare(sql).run(...p).changes) }),
    all: async (sql, p = []) => d.prepare(sql).all(...p).map((r) => ({ ...r })),
  };
}
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0); // 2026-11-16 12:00 UTC
const S = (ms) => Math.floor(ms / 1000);
const DAYMS = 86400000;

async function main() {
  const Schema = await import('../utils/stats/schema.ts');
  const Store = await import('../utils/stats/store.ts');
  const Rec = await import('../utils/stats/recorder.ts');
  const Ins = await import('../utils/stats/insights.ts');
  const Prefs = await import('../utils/stats/prefs.ts');
  const Src = await import('../utils/stats/source.ts');
  const Bk = await import('../utils/stats/backup.ts');

  // ---- schema / migrations
  const db = fakeDb();
  await Schema.migrate(db);
  await Schema.migrate(db); // idempotent
  const ver = await db.all('PRAGMA user_version');
  check('migrate sets user_version', ver[0].user_version === Schema.STATS_VERSION);
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
  check('three tables exist', ['stats', 'stats_daily', 'stats_monthly'].every((t) => tables.includes(t)));

  // ---- day bucketing
  check('dayKey UTC', Rec.dayKey(Date.UTC(2026, 0, 31, 23, 30), 0) === '2026-01-31');
  check('dayKey +120 rolls to next day', Rec.dayKey(Date.UTC(2026, 0, 31, 23, 30), 120) === '2026-02-01');
  check('dayKey -300 stays previous day', Rec.dayKey(Date.UTC(2026, 0, 1, 2, 0), -300) === '2025-12-31');

  // ---- store: idempotent finished record
  const store = Store.createStatsStore(db, () => ({ keepStats: true, mobileLimitMb: null }));
  const rec = { id: 'a', kind: 'torrent', name: 'A', size: 1000, category: 'movies', source: 'x1337', activeSecs: 10, sessionBytes: 1000, uploaded: 5, bytesWifi: 900, bytesMobile: 100, addedAt: S(T0) - 100, finishedAt: S(T0), retries: 0 };
  check('first record inserted', (await store.recordFinished(rec, 0)) === true);
  check('same id again is a no-op', (await store.recordFinished({ ...rec, name: 'changed' }, 0)) === false);
  const rows = await store.listRecords();
  check('one row, original kept', rows.length === 1 && rows[0].name === 'A');
  const daily1 = await store.listDaily();
  check('daily finished counted once', daily1.length === 1 && daily1[0].finished === 1 && daily1[0].day === '2026-11-16');
  await store.addDaily('2026-11-16', { downloaded: 10, uploaded: 1, wifi: 4, mobile: 6, finished: 0, failed: 1, cancelled: 0 });
  await store.addDaily('2026-11-16', { downloaded: 5, uploaded: 0, wifi: 5, mobile: 0, finished: 0, failed: 0, cancelled: 1 });
  const d2 = (await store.listDaily())[0];
  check('daily deltas add up', d2.downloaded === 15 && d2.mobile === 6 && d2.failed === 1 && d2.cancelled === 1 && d2.finished === 1);

  // ---- retention fold
  const old = { ...rec, id: 'old1', finishedAt: S(T0) - 800 * DAYMS / 1000, addedAt: S(T0) - 801 * DAYMS / 1000, sessionBytes: 500, size: 500, retries: 1, activeSecs: 20 };
  const old2 = { ...old, id: 'old2', retries: 0, finishedAt: old.finishedAt + 60 };
  await store.recordFinished(old, 0);
  await store.recordFinished(old2, 0);
  const folded = await store.foldOld(T0);
  check('fold moved two records', folded === 2);
  const left = await store.listRecords();
  check('only the recent record remains', left.length === 1 && left[0].id === 'a');
  const monthlyRows = await store.listMonthly();
  check('folded into one month', monthlyRows.length === 1 && monthlyRows[0].finished === 2 && monthlyRows[0].downloaded === 1000 && monthlyRows[0].retried === 1 && monthlyRows[0].activeSecs === 40);
  check('fold again does nothing', (await store.foldOld(T0)) === 0);
  const rows24 = await store.listRecords();
  check('record just inside 24 months stays', rows24.length === 1);

  // ---- reset
  const dbR = fakeDb();
  await Schema.migrate(dbR);
  const stR = Store.createStatsStore(dbR, () => ({ keepStats: true, mobileLimitMb: null }));
  await stR.recordFinished(rec, 0);
  await stR.reset();
  check('reset empties all tables', (await stR.listRecords()).length === 0 && (await stR.listDaily()).length === 0 && (await stR.listMonthly()).length === 0);

  // ---- recorder: snapshots to items
  const tsnap = (o = {}) => ({ id: 'h1', name: 'Movie', state: 'DOWNLOADING', pausedBy: null, finished: false, progressBytes: 0, totalBytes: 1000, includedBytes: 1000, uploadedBytes: 0, addedAt: S(T0) - 50, error: null, ...o });
  const lsnap = (o = {}) => ({ id: 'd1', urlDisplay: 'https://Example.com/a/file.zip', name: 'file.zip', state: 'downloading', size: 2000, downloaded: 0, addedAt: S(T0) - 50, error: null, stream: null, ...o });
  const items0 = Rec.toItems([tsnap()], [lsnap(), lsnap({ id: 's1', stream: { kind: 'hls', segmentsDone: 0, segmentsTotal: 3 }, urlDisplay: 'https://v.test/m.m3u8' })]);
  check('items: kinds', eq(items0.map((i) => i.kind), ['torrent', 'link', 'stream']));
  check('items: missing 0.26 fields read as 0', items0[0].activeSecs === 0 && items0[0].finishedAt === 0 && items0[0].sessionBytes === 0);
  const itemsErr = Rec.toItems([tsnap({ state: 'ERROR', error: { code: 'INTERNAL', message: 'x' } })], [lsnap({ state: 'error' })]);
  check('items: error flag', itemsErr[0].errored && itemsErr[1].errored);
  const ctx = (now) => ({ now, tz: 0, origin: () => ({ source: null, category: null }) });

  const T = (o) => Rec.toItems([tsnap({ activeSecs: 0, finishedAt: 0, sessionBytes: 0, bytesWifi: 0, bytesMobile: 0, ...o })], []);
  const first = Rec.planWrites(null, T({ sessionBytes: 9999, finishedAt: 5 }), ctx(T0));
  check('first snapshot only sets a baseline', first.finished.length === 0 && first.delta.downloaded === 0 && Object.keys(first.baseline).length === 1);

  let b = first.baseline;
  const p2 = Rec.planWrites(b, T({ sessionBytes: 10000 + 500, uploadedBytes: 20, bytesWifi: 300, bytesMobile: 200, activeSecs: 4 }), ctx(T0 + 1000));
  check('deltas from baseline', p2.delta.downloaded === 501, `got ${p2.delta.downloaded}`);
  check('wifi/mobile/uploaded deltas', p2.delta.wifi === 300 && p2.delta.mobile === 200 && p2.delta.uploaded === 20);
  b = p2.baseline;
  const p3 = Rec.planWrites(b, T({ sessionBytes: 100, uploadedBytes: 5, bytesWifi: 40, bytesMobile: 60, activeSecs: 1 }), ctx(T0 + 2000));
  check('counter reset: delta is the new value, never negative', p3.delta.downloaded === 100 && p3.delta.uploaded === 5 && p3.delta.wifi === 40 && p3.delta.mobile === 60);
  check('no negative anywhere', Object.values(p3.delta).every((v) => v >= 0));
  b = p3.baseline;

  // finished edge
  const fin = T({ sessionBytes: 1000, activeSecs: 30, finishedAt: S(T0) + 5, bytesWifi: 800, bytesMobile: 200, uploadedBytes: 7 });
  const p4 = Rec.planWrites(b, fin, { ...ctx(T0 + 3000), origin: (id) => ({ source: 'tpb', category: 'tv' }) });
  check('finished record emitted on 0 to non-zero', p4.finished.length === 1 && p4.finished[0].id === 'h1' && p4.finished[0].source === 'tpb' && p4.finished[0].category === 'tv' && p4.finished[0].activeSecs === 30 && p4.finished[0].size === 1000);
  check('hasEvents set', p4.hasEvents === true);
  const p5 = Rec.planWrites(p4.baseline, fin, ctx(T0 + 4000));
  check('no second finished record for the same item', p5.finished.length === 0);
  // seeding / pause after finish never re-emits
  const p6 = Rec.planWrites(p5.baseline, T({ sessionBytes: 1000, finishedAt: S(T0) + 5, state: 'PAUSED' }), ctx(T0 + 5000));
  check('pause after finish: no record', p6.finished.length === 0);
  // already-finished item present at first baseline is not emitted
  const pOld = Rec.planWrites(Rec.planWrites(null, fin, ctx(T0)).baseline, fin, ctx(T0 + 1));
  check('item finished before stats existed is not recorded', pOld.finished.length === 0);
  // new item that arrives finished
  const pNew = Rec.planWrites({}, fin, ctx(T0));
  check('new item that arrives finished is recorded', pNew.finished.length === 1);

  // failed, retries, cancelled
  const errItem = (o) => Rec.toItems([tsnap({ state: 'ERROR', error: { code: 'INTERNAL', message: 'x' }, ...o })], []);
  const base0 = Rec.planWrites(null, T({}), ctx(T0)).baseline;
  const e1 = Rec.planWrites(base0, errItem({}), ctx(T0 + 1));
  check('failed counted when entering error', e1.delta.failed === 1 && e1.hasEvents);
  const e2 = Rec.planWrites(e1.baseline, errItem({}), ctx(T0 + 2));
  check('staying in error is not counted again', e2.delta.failed === 0);
  const e3 = Rec.planWrites(e2.baseline, T({}), ctx(T0 + 3));
  check('leaving error without finishing is a retry', e3.baseline.h1.r === 1);
  const e4 = Rec.planWrites(e3.baseline, T({ finishedAt: S(T0), sessionBytes: 10 }), ctx(T0 + 4));
  check('retry count lands on the finished record', e4.finished[0].retries === 1);
  // Only a removal the user made counts as cancelled; an item missing from one list is kept, not counted.
  const c1 = Rec.planWrites(e3.baseline, [], { ...ctx(T0 + 5), removed: new Set(['h1']) });
  check('unfinished item the user removed is cancelled', c1.delta.cancelled === 1 && !('h1' in c1.baseline));
  const c0 = Rec.planWrites(e3.baseline, [], ctx(T0 + 5));
  check('unfinished item missing from a list is not cancelled', c0.delta.cancelled === 0 && !c0.hasEvents);
  check('missing unfinished item keeps its baseline', c0.baseline.h1 && c0.baseline.h1.r === 1);
  const c0b = Rec.planWrites(c0.baseline, T({}), ctx(T0 + 6));
  check('an item that comes back is not counted twice', c0b.delta.downloaded === 0 && c0b.baseline.h1.r === 1);
  const c2 = Rec.planWrites(p4.baseline, [], ctx(T0 + 5));
  check('finished item removed is not cancelled', c2.delta.cancelled === 0);

  // throttle
  check('flush: nothing happens within a minute', Rec.shouldFlush(T0, T0 + 30000, false) === false);
  check('flush: after a minute', Rec.shouldFlush(T0, T0 + 60000, false) === true);
  check('flush: events are immediate', Rec.shouldFlush(T0, T0 + 1, true) === true);
  check('flush: first ever', Rec.shouldFlush(0, T0, false) === true);

  // recorder wiring: keepStats off writes nothing, baseline cleared
  const mkRecorder = async (keep) => {
    const dbx = fakeDb();
    await Schema.migrate(dbx);
    const st = Store.createStatsStore(dbx, () => ({ keepStats: keep, mobileLimitMb: null }));
    let baseline = null;
    let now = T0;
    const r = Rec.createRecorder({
      store: st,
      prefs: () => ({ keepStats: keep, mobileLimitMb: null }),
      baselineIO: { load: () => baseline, save: (x) => { baseline = x; } },
      origin: () => ({ source: null, category: null }),
      now: () => now,
      tz: () => 0,
    });
    return { dbx, st, r, setNow: (n) => { now = n; }, getBaseline: () => baseline };
  };
  const off = await mkRecorder(false);
  await off.r.onSnapshot([tsnap({ activeSecs: 3, sessionBytes: 5 })], []);
  off.setNow(T0 + 120000);
  await off.r.onSnapshot([tsnap({ activeSecs: 9, sessionBytes: 5000, finishedAt: S(T0), bytesWifi: 1 })], []);
  check('keepStats off: no records', (await off.st.listRecords()).length === 0);
  check('keepStats off: no daily', (await off.st.listDaily()).length === 0);
  check('keepStats off: baseline cleared', off.getBaseline() === null);

  const on = await mkRecorder(true);
  await on.r.onSnapshot([tsnap({ sessionBytes: 0 })], []);
  on.setNow(T0 + 10000);
  await on.r.onSnapshot([tsnap({ sessionBytes: 700, bytesWifi: 700 })], []);
  check('throttled: no daily within a minute', (await on.st.listDaily()).length === 0);
  on.setNow(T0 + 70000);
  await on.r.onSnapshot([tsnap({ sessionBytes: 900, bytesWifi: 900 })], []);
  const dd = await on.st.listDaily();
  check('daily written after a minute, with all deltas since baseline', dd.length === 1 && dd[0].downloaded === 900 && dd[0].wifi === 900);
  on.setNow(T0 + 71000);
  await on.r.onSnapshot([tsnap({ sessionBytes: 1000, activeSecs: 20, finishedAt: S(T0) + 71, bytesWifi: 1000, uploadedBytes: 3 })], []);
  const recs = await on.st.listRecords();
  check('finish is written immediately', recs.length === 1 && recs[0].sessionBytes === 1000);
  const dd2 = (await on.st.listDaily())[0];
  check('finish flush also carries pending deltas', dd2.downloaded === 1000 && dd2.finished === 1);
  await on.r.onSnapshot([tsnap({ sessionBytes: 1000, activeSecs: 20, finishedAt: S(T0) + 71, bytesWifi: 1000, uploadedBytes: 3 })], []);
  on.setNow(T0 + 200000);
  await on.r.onSnapshot([tsnap({ sessionBytes: 1000, activeSecs: 20, finishedAt: S(T0) + 71, bytesWifi: 1000, uploadedBytes: 3 })], []);
  check('replayed snapshots do not duplicate', (await on.st.listRecords()).length === 1 && (await on.st.listDaily())[0].finished === 1);

  // ---- origin tags
  check('originKey magnet', Src.originKey('magnet:?xt=urn:btih:' + 'AB'.repeat(20) + '&dn=x') === 'h:' + 'ab'.repeat(20));
  check('originKey url ignores query, case and slash', Src.originKey('https://EXAMPLE.com/a/b/?token=1') === Src.originKey('https://example.com/a/b'));
  const mem = new Map();
  const tags = Src.createOriginTags({ get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) }, 3);
  tags.note('magnet:?xt=urn:btih:' + 'cd'.repeat(20), { source: 'tpb', category: 'movies' });
  tags.note('https://x.test/f.zip', { source: 'share' });
  check('tag lookup by torrent id', eq(tags.lookup('torrent', 'cd'.repeat(20), ''), { source: 'tpb', category: 'movies' }));
  check('tag lookup by link url', tags.lookup('link', 'd1', 'https://x.test/f.zip').source === 'share');
  check('unknown origin is null, not guessed', eq(tags.lookup('torrent', 'ff'.repeat(20), ''), { source: null, category: null }));
  tags.note('https://a.test/1', { source: 'feed' }); tags.note('https://a.test/2', { source: 'feed' });
  check('tags are capped, oldest dropped', tags.lookup('torrent', 'cd'.repeat(20), '').source === null);

  // ---- prefs
  check('prefs default', eq(Prefs.normalizeStatsPrefs(undefined), { keepStats: true, mobileLimitMb: null }));
  check('prefs tolerate junk', eq(Prefs.normalizeStatsPrefs({ keepStats: 'no', mobileLimitMb: -4 }), { keepStats: true, mobileLimitMb: null }));
  check('prefs keep valid', eq(Prefs.normalizeStatsPrefs({ keepStats: false, mobileLimitMb: 5000.7 }), { keepStats: false, mobileLimitMb: 5000 }));

  // ---- insights
  const empty = Ins.computeInsights({ records: [], daily: [], monthly: [], now: T0, tz: 0, mobileLimitMb: null });
  check('empty: hasData false', empty.hasData === false);
  check('empty: nulls and empties', empty.records.biggest === null && empty.records.topDay === null && empty.rhythm === null && empty.topSources.length === 0 && empty.mixByCategory.length === 0 && empty.milestones.length === 0 && empty.streak.current === 0 && empty.streak.longest === 0 && empty.avgSpeed.byNetwork.wifi === null && empty.avgSpeed.byKind.torrent === null && empty.totals.allTime.finished === 0 && empty.mobile.limitBytes === null);

  const mk = (id, o) => ({ id, kind: 'torrent', name: id, size: 1000, category: 'movies', source: 'tpb', activeSecs: 10, sessionBytes: 1000, uploaded: 0, bytesWifi: 1000, bytesMobile: 0, addedAt: 0, finishedAt: 0, retries: 0, ...o });
  // local tz +330 (India): 2026-11-15 20:00 UTC = 2026-11-16 01:30 local
  const fx = [
    mk('r1', { finishedAt: S(Date.UTC(2026, 9, 31, 20, 0)), sessionBytes: 4000, size: 4000, activeSecs: 40, kind: 'link', category: null, source: 'link' }), // Oct 31 20:00 UTC = Nov 1 01:30 local
    mk('r2', { finishedAt: S(Date.UTC(2026, 10, 1, 5, 0)), sessionBytes: 9000, size: 9000, activeSecs: 3, retries: 2, source: 'share', category: 'tv', bytesWifi: 0, bytesMobile: 9000, kind: 'stream' }),
    mk('r3', { finishedAt: S(Date.UTC(2026, 10, 15, 20, 0)), sessionBytes: 500, size: 500, activeSecs: 1 }), // too short for speed
    mk('r4', { finishedAt: S(Date.UTC(2026, 10, 16, 3, 0)), sessionBytes: 2000, size: 2000, activeSecs: 100, source: 'tpb' }),
  ];
  const daily = [
    { day: '2026-10-30', downloaded: 100, uploaded: 10, mobile: 0, wifi: 110, finished: 1, failed: 0, cancelled: 0, activeSecs: 0 },
    { day: '2026-10-31', downloaded: 300, uploaded: 0, mobile: 50, wifi: 250, finished: 1, failed: 1, cancelled: 0, activeSecs: 0 },
    { day: '2026-11-01', downloaded: 9000, uploaded: 0, mobile: 9000, wifi: 0, finished: 2, failed: 0, cancelled: 1, activeSecs: 0 },
    { day: '2026-11-15', downloaded: 500, uploaded: 5, mobile: 0, wifi: 505, finished: 1, failed: 0, cancelled: 0, activeSecs: 0 },
    { day: '2026-11-16', downloaded: 2000, uploaded: 0, mobile: 0, wifi: 2000, finished: 1, failed: 0, cancelled: 0, activeSecs: 0 },
  ];
  const monthly = [{ month: '2024-01', downloaded: 100, uploaded: 0, wifi: 100, mobile: 0, finished: 3, activeSecs: 30, retried: 1 }];
  const ins = Ins.computeInsights({ records: fx, daily, monthly, now: T0, tz: 330, mobileLimitMb: 10 });
  check('has data', ins.hasData);
  check('totals all time from daily', ins.totals.allTime.downloaded === 11900 && ins.totals.allTime.finished === 6 && ins.totals.allTime.failed === 1 && ins.totals.allTime.cancelled === 1 && ins.totals.allTime.uploaded === 15);
  check('totals this month', ins.totals.thisMonth.downloaded === 11500 && ins.totals.thisMonth.finished === 4);
  check('active secs all time includes folded months', ins.totals.allTime.activeSecs === 174, `got ${ins.totals.allTime.activeSecs}`);
  check('mobile used vs limit', ins.mobile.usedBytes === 9000 && ins.mobile.limitBytes === 10 * 1024 * 1024 && ins.mobile.fraction > 0 && ins.mobile.over === false);
  const over = Ins.computeInsights({ records: fx, daily, monthly, now: T0, tz: 330, mobileLimitMb: 0.004 });
  check('mobile over the limit flagged', over.mobile.over === true);
  check('avg speed by kind ignores items under 3 s', ins.avgSpeed.byKind.torrent === 2000 / 100 && ins.avgSpeed.byKind.link === 4000 / 40 && ins.avgSpeed.byKind.stream === 9000 / 3);
  check('avg speed by network (majority network)', ins.avgSpeed.byNetwork.mobile === 3000 && ins.avgSpeed.byNetwork.wifi === (4000 + 2000) / (40 + 100));
  check('records: biggest', ins.records.biggest.id === 'r2');
  check('records: fastest avg', ins.records.fastestAvg.id === 'r2' && ins.records.fastestAvg.bps === 3000);
  check('records: longest', ins.records.longest.id === 'r4' && ins.records.longest.activeSecs === 100);
  check('records: top day', ins.records.topDay.day === '2026-11-01' && ins.records.topDay.downloaded === 9000);
  check('reliability numbers', ins.reliability.retried === 1 + 1 && ins.reliability.firstTry === 3 + 2 && ins.reliability.failed === 1 && ins.reliability.cancelled === 1, JSON.stringify(ins.reliability));
  check('top sources by downloads, unknown excluded', eq(ins.topSources.map((s) => [s.source, s.count]), [['tpb', 2], ['share', 1], ['link', 1]]), JSON.stringify(ins.topSources));
  check('mix by category with unknown', eq(ins.mixByCategory.map((c) => [c.category, c.count]), [['movies', 2], ['tv', 1], ['unknown', 1]]), JSON.stringify(ins.mixByCategory));
  // local tz +330: r1 Sun? 2026-11-01 01:30 local is a Sunday
  check('rhythm weekday/hour in local time', ins.rhythm !== null && ins.rhythm.hours.length === 24 && ins.rhythm.weekdays.length === 7 && ins.rhythm.weekdays[0] === 2 && ins.rhythm.hours[1] === 2, JSON.stringify(ins.rhythm));
  check('rhythm busiest (ties go to the earlier one)', ins.rhythm.busiestWeekday === 0 && ins.rhythm.busiestHour === 1);
  // streak: 10-30,10-31,11-01 then gap then 11-15,11-16 (today) -> current 2, longest 3
  check('streak across month boundary', ins.streak.longest === 3 && ins.streak.current === 2, JSON.stringify(ins.streak));
  const yest = Ins.computeInsights({ records: [], daily: daily.slice(0, 4), monthly: [], now: T0, tz: 0, mobileLimitMb: null });
  check('streak survives until the day ends', yest.streak.current === 1);
  const stale = Ins.computeInsights({ records: [], daily: daily.slice(0, 3), monthly: [], now: T0, tz: 0, mobileLimitMb: null });
  check('streak ends after a missed day', stale.streak.current === 0 && stale.streak.longest === 3);
  check('timezone changes "today"', Ins.computeInsights({ records: [], daily: [{ ...daily[4], day: '2026-11-17' }], monthly: [], now: Date.UTC(2026, 10, 16, 20, 0), tz: 330, mobileLimitMb: null }).streak.current === 1);

  // milestones
  const many = [];
  for (let i = 0; i < 100; i++) many.push(mk('m' + i, { finishedAt: 1000 + i, sessionBytes: 1e10 + 1, size: 1e10 }));
  const mi = Ins.computeInsights({ records: many, daily: [], monthly: [], now: T0, tz: 0, mobileLimitMb: null });
  check('milestones: 1st, 100th, first TB', eq(mi.milestones.map((m) => m.kind), ['first', 'hundredth', 'terabyte']) && mi.milestones[0].name === 'm0' && mi.milestones[1].name === 'm99' && mi.milestones[2].name === 'm99', JSON.stringify(mi.milestones.map((m) => m.name)));
  const mf = Ins.computeInsights({ records: fx.slice(0, 2), daily: [], monthly, now: T0, tz: 0, mobileLimitMb: null });
  check('milestones: no "1st" once older records were folded', !mf.milestones.some((m) => m.kind === 'first'));

  // ---- backup section
  const sec = Bk.buildStatsSection({ records: fx, daily, monthly });
  check('section shape', sec.v === 1 && sec.records.length === 4 && sec.daily.length === 5 && sec.monthly.length === 1);
  const parsed = Bk.parseStatsSection(JSON.parse(JSON.stringify(sec)));
  check('section round trips', eq(parsed, sec));
  check('junk section is dropped', Bk.parseStatsSection({ v: 1, records: [{ nope: 1 }, 5], daily: 'x' }).records.length === 0 && Bk.parseStatsSection(null) === null && Bk.parseStatsSection({ v: 99 }) === null);
  const dbB = fakeDb();
  await Schema.migrate(dbB);
  const stB = Store.createStatsStore(dbB, () => ({ keepStats: true, mobileLimitMb: null }));
  await stB.recordFinished(fx[0], 0);
  const added = await stB.importSection(sec);
  check('restore adds missing, keeps existing', added.records === 3 && (await stB.listRecords()).length === 4 && (await stB.listDaily()).length === 5);
  check('restore twice adds nothing', (await stB.importSection(sec)).records === 0);
  const back = await stB.exportSection();
  check('export section from store', back.records.length === 4 && back.v === 1);

  // ---- backup wiring (optional section, off by default)
  const BE = await import('../utils/backup/export.ts');
  const BM = await import('../utils/backup/migrate.ts');
  const BI = await import('../utils/backup/import.ts');
  const baseDeps = { appVersion: '0.26', now: () => 1, settings: (await import('../modules/maglev-engine/src/MaglevSettings.types.ts')).DEFAULT_SETTINGS, readPref: () => undefined, torrents: [], downloads: [], torrentData: async () => null };
  const without = await BE.buildBackup(baseDeps);
  check('backup has no stats unless asked', !('stats' in without) && !BE.serializeBackup(without).includes('"stats"'));
  const withStats = await BE.buildBackup({ ...baseDeps, stats: sec });
  const reparsed = BM.parseBackup(BE.serializeBackup(withStats));
  check('backup with stats round trips', reparsed.ok && eq(reparsed.backup.stats, sec));
  const reNo = BM.parseBackup(BE.serializeBackup(without));
  check('old backup parses without stats', reNo.ok && !('stats' in reNo.backup));
  let applied = 0;
  const rdeps = { engine: {}, folderExists: () => true, existingHashes: new Set(), existingUrls: [], currentSettings: baseDeps.settings, applySettings() {}, applyPref() {}, applyStats: async () => { applied++; } };
  await BI.restoreBackup(reparsed.backup, new Set(['settings']), rdeps);
  check('stats not restored unless ticked', applied === 0);
  await BI.restoreBackup(reparsed.backup, new Set(['stats']), rdeps);
  check('stats restored when ticked', applied === 1);

  if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
  console.log('\nall stats checks passed');
}
main().catch((e) => { console.error(e); process.exit(1); });
