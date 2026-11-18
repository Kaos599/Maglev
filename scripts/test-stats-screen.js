#!/usr/bin/env node
// Stats screen (NATIVE_CONTRACT 34.2): the pure functions behind the Pixel city and the card kit. Ranges and buckets
// (Monday-start weeks, the first-stats-day bound), busiest bucket, streaks, the usual finish hour, the category rollup
// into Other, and the formatting of sizes, durations and speeds. Plus the wiring of the screen by source.
// Needs Node 22.18+ (runs the TypeScript source directly).
process.removeAllListeners('warning');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let failed = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.error(`  FAIL ${name}${extra ? ` (${extra})` : ''}`); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const GB = 1024 ** 3;
const MBy = 1024 ** 2;

async function main() {
  const T = await import('../utils/stats/time.ts');
  const I = await import('../utils/stats/insights.ts');
  const F = await import('../utils/stats/format.ts');
  const N = (s) => T.dayNumber(s);

  console.log('days');
  check('dayFromNumber round-trips', T.dayFromNumber(N('2026-11-16')) === '2026-11-16' && T.dayFromNumber(N('2024-02-29')) === '2024-02-29');
  check('weekday of 2026-11-16 is Monday', T.weekdayOf(N('2026-11-16')) === 1);
  check('weekday of 1970-01-01 is Thursday', T.weekdayOf(0) === 4);
  check('weekday before the epoch', T.weekdayOf(N('1969-12-28')) === 0);
  check('mondayOf a Sunday is the Monday before', T.dayFromNumber(T.mondayOf(N('2026-11-22'))) === '2026-11-16');
  check('mondayOf a Monday is itself', T.mondayOf(N('2026-11-16')) === N('2026-11-16'));

  console.log('ranges');
  const today = N('2026-11-16');
  const wk = I.rangeOf('week', today);
  check('week starts Monday, 7 days', T.dayFromNumber(wk.start) === '2026-11-16' && wk.end - wk.start === 6);
  const wk2 = I.rangeOf('week', N('2026-11-15'));
  check('a Sunday belongs to the week before', T.dayFromNumber(wk2.start) === '2026-11-09' && T.dayFromNumber(wk2.end) === '2026-11-15');
  const mo = I.rangeOf('month', today);
  check('month is the calendar month', T.dayFromNumber(mo.start) === '2026-11-01' && T.dayFromNumber(mo.end) === '2026-11-30');
  const feb = I.rangeOf('month', N('2024-02-10'));
  check('leap February has 29 days', feb.end - feb.start === 28);
  const yr = I.rangeOf('year', today);
  check('year is Jan 1 to Dec 31', T.dayFromNumber(yr.start) === '2026-01-01' && T.dayFromNumber(yr.end) === '2026-12-31');
  check('step back a month crosses the year', T.dayFromNumber(I.stepRange(I.rangeOf('month', N('2026-01-05')), -1).start) === '2025-12-01');
  check('step forward a week', T.dayFromNumber(I.stepRange(wk2, 1).start) === '2026-11-16');
  check('step back a year', T.dayFromNumber(I.stepRange(yr, -1).start) === '2025-01-01');
  const first = N('2026-10-07');
  check('can step back while the range starts after the first stats day', I.canStepRange(mo, -1, first, today) === true);
  check('cannot step back past the first stats day', I.canStepRange(I.rangeOf('month', first), -1, first, today) === false);
  check('cannot step back with no stats at all', I.canStepRange(wk, -1, null, today) === false);
  check('cannot step forward past today', I.canStepRange(wk, 1, first, today) === false);
  check('can step forward from last week', I.canStepRange(wk2, 1, first, today) === true);
  const sw = I.switchRangeKind(yr, 'month', today, first);
  check('switching kind keeps today when the range holds it', T.dayFromNumber(sw.start) === '2026-11-01');
  const old = I.rangeOf('month', N('2026-10-10'));
  check('switching kind from a past range anchors on its last day', T.dayFromNumber(I.switchRangeKind(old, 'week', today, first).start) === '2026-10-26');
  const early = I.rangeOf('year', N('2026-03-01'));
  const s2 = I.switchRangeKind(I.rangeOf('month', N('2026-01-10')), 'week', today, N('2026-03-04'));
  check('a switch that lands before the first stats day goes to its week', T.dayFromNumber(s2.start) === '2026-03-02', T.dayFromNumber(s2.start));
  check('rangeOf year anchored early is the same year', early.start === yr.start);

  console.log('first stats day');
  check('none with no rows', I.firstStatsDay([]) === null);
  const zero = { downloaded: 0, uploaded: 0, mobile: 0, wifi: 0, finished: 0, failed: 0, cancelled: 0 };
  check('earliest day with anything', I.firstStatsDay([
    { ...zero, day: '2026-10-09', downloaded: 5 },
    { ...zero, day: '2026-10-01' },
    { ...zero, day: '2026-10-05', failed: 1 },
  ]) === N('2026-10-05'));

  console.log('buckets');
  const daily = [
    { ...zero, day: '2026-11-16', downloaded: 2 * GB, finished: 1 },
    { ...zero, day: '2026-11-15', downloaded: 9 * GB, finished: 3, failed: 1 },
    { ...zero, day: '2026-11-14', downloaded: 1 * GB, finished: 1, cancelled: 2 },
    { ...zero, day: '2026-11-10', downloaded: 4 * GB, finished: 0 },
    { ...zero, day: '2026-01-01', downloaded: 1 * GB, finished: 1 },
    { ...zero, day: '2025-12-31', downloaded: 7 * GB, finished: 1 },
  ];
  const bw = I.bucketsFor(wk2, daily, today);
  check('week: 7 day buckets', bw.length === 7 && bw.every((b) => b.noun === 'day' && b.start === b.end));
  check('week: sums per day', bw[6].downloaded === 9 * GB && bw[6].finished === 3 && bw[6].failed === 1 && bw[5].cancelled === 2);
  check('week: weekend flags Sat and Sun', bw[5].weekend && bw[6].weekend && !bw[0].weekend);
  check('week: labels are days', bw[1].label === 'Tue, Nov 10', bw[1].label);
  const bnow = I.bucketsFor(wk, daily, today);
  check('this week: today is current and labelled Today', bnow[0].current && bnow[0].label === 'Today');
  check('this week: days after today are future', bnow.slice(1).every((b) => b.future) && !bnow[0].future);
  const bm = I.bucketsFor(mo, daily, today);
  check('month: one bucket per day', bm.length === 30);
  const by = I.bucketsFor(yr, daily, today);
  check('year: weeks start Monday', by.every((b) => T.weekdayOf(b.start) === 1 || b.start === yr.start));
  check('year: first week is clipped to Jan 1', by[0].start === yr.start && T.dayFromNumber(by[0].end) === '2026-01-04');
  check('year: last week is clipped to Dec 31', by[by.length - 1].end === yr.end);
  check('year: 53 buckets in 2026', by.length === 53, String(by.length));
  check('year: a week holds only its year', by[0].downloaded === 1 * GB);
  const cur = by.findIndex((b) => b.current);
  check('year: this week labelled This week, last week Last week', by[cur].label === 'This week' && by[cur - 1].label === 'Last week');
  check('year: an older week is a span', by[cur - 2].label === 'Nov 2–8', by[cur - 2].label);
  check('span across months', F.spanLabel(N('2026-10-26'), N('2026-11-01')) === 'Oct 26–Nov 1');
  check('year: week buckets sum their days', by[cur - 1].downloaded === 14 * GB && by[cur - 1].finished === 4);

  console.log('busiest and bounds');
  check('busiest is the biggest download', I.busiestBucket(bw) === 6);
  check('busiest: none when nothing downloaded', I.busiestBucket(bw.map((b) => ({ ...b, downloaded: 0 }))) === -1);
  check('busiest: first of a tie', I.busiestBucket([{ downloaded: 3 }, { downloaded: 5 }, { downloaded: 5 }]) === 1);
  check('first bucket index stops at the first stats day', I.firstBucketIndex(bm, N('2026-11-10')) === 9);
  check('first bucket index is 0 with an earlier first day', I.firstBucketIndex(bm, N('2026-01-01')) === 0);
  check('first bucket index for weeks takes the week that holds it', I.firstBucketIndex(by, N('2026-11-10')) === cur - 1);

  console.log('streaks');
  const sd = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-14', '2026-11-15', '2026-11-16'].map((day) => ({ ...zero, day, finished: 1 }));
  const st = I.longestStreakIn(sd, mo, today);
  check('longest streak in range', st.days === 3 && T.dayFromNumber(st.from) === '2026-11-01' && T.dayFromNumber(st.to) === '2026-11-03');
  const stw = I.longestStreakIn(sd, wk2, today);
  check('streak clipped to the range', stw.days === 2 && T.dayFromNumber(stw.from) === '2026-11-14');
  check('no streak: zero days, no dates', eq(I.longestStreakIn([], mo, today), { days: 0, from: null, to: null }));
  check('a tie keeps the earlier run', I.longestStreakIn(sd.filter((d) => d.day !== '2026-11-16'), mo, today).from === N('2026-11-01'));

  console.log('finish hours');
  const at = (day, h) => Math.floor(Date.UTC(...day.split('-').map((x, i) => (i === 1 ? +x - 1 : +x)), h, 30) / 1000);
  const rec = (id, o) => ({ id, kind: 'torrent', name: id, size: GB, category: null, source: null, activeSecs: 100, sessionBytes: GB, uploaded: 0, bytesWifi: GB, bytesMobile: 0, addedAt: 0, finishedAt: at('2026-11-16', 12), retries: 0, ...o });
  const recs = [
    rec('a', { finishedAt: at('2026-11-16', 22) }),
    rec('b', { finishedAt: at('2026-11-15', 22) }),
    rec('c', { finishedAt: at('2026-11-14', 9) }),
    rec('d', { finishedAt: at('2026-10-14', 9) }),
  ];
  const fh = I.finishHours(recs, mo, 0);
  check('hours counted in the range only', fh.hours[22] === 2 && fh.hours[9] === 1 && fh.hours.reduce((a, b) => a + b, 0) === 3);
  check('peak is the hour most finished', fh.peak === 22);
  check('no records: no peak', I.finishHours([], mo, 0).peak === null);
  check('tz moves the hour', I.finishHours([rec('x', { finishedAt: at('2026-11-16', 22) })], mo, 120).peak === 0);

  console.log('categories');
  const cat = (id, category, gb) => rec(id, { category, sessionBytes: gb * GB });
  const roll = I.categoryRollup([cat('1', 'movies', 32), cat('2', 'tv', 22), cat('3', 'apps', 16), cat('4', 'anime', 12), cat('5', 'books', 8), cat('6', null, 6), cat('7', 'other', 4)]);
  check('top three named categories', eq(roll.top.map((r) => r.key), ['movies', 'tv', 'apps']));
  check('labels are plain', eq(roll.top.map((r) => r.label), ['Movies', 'TV', 'Apps']));
  check('Other is everything else plus unsorted', roll.other && roll.other.bytes === 30 * GB && roll.other.label === 'Other');
  check('percentages add to 100', roll.top.reduce((a, r) => a + r.pct, 0) + roll.other.pct === 100);
  check('headline share', roll.top[0].pct === 32);
  check('the full split keeps every category and Unsorted', roll.all.length === 6 && roll.all[roll.all.length - 1].label === 'Unsorted' && roll.all[roll.all.length - 1].bytes === 10 * GB);
  const two = I.categoryRollup([cat('1', 'movies', 3), cat('2', 'tv', 1)]);
  check('no Other row when nothing is left over', two.other === null && two.top.length === 2);
  check('empty rollup', eq(I.categoryRollup([]), { top: [], other: null, all: [], total: 0 }));
  check('only unsorted: no headline, Other holds it', I.categoryRollup([cat('1', null, 2)]).top.length === 0 && I.categoryRollup([cat('1', null, 2)]).other.pct === 100);
  check('largest remainder fills exactly', eq(I.largestRemainder([1, 1, 1], 100), [34, 33, 33]));
  check('block cells fill the bar', I.largestRemainder([32, 22, 16, 30], 56).reduce((a, b) => a + b, 0) === 56);
  check('largest remainder of nothing', eq(I.largestRemainder([0, 0], 56), [0, 0]));

  console.log('range stats');
  const rsDaily = [
    { ...zero, day: '2026-11-14', downloaded: 3 * GB, uploaded: GB, mobile: 200 * MBy, wifi: 3 * GB, finished: 2, failed: 1, cancelled: 0 },
    { ...zero, day: '2026-11-15', downloaded: 5 * GB, uploaded: 0, mobile: 0, wifi: 5 * GB, finished: 1, failed: 0, cancelled: 1 },
    { ...zero, day: '2026-10-01', downloaded: 50 * GB, finished: 4 },
  ];
  const rsRecs = [
    rec('big', { size: 4 * GB, sessionBytes: 4 * GB, activeSecs: 400, finishedAt: at('2026-11-15', 21), category: 'movies' }),
    rec('fast', { size: GB, sessionBytes: GB, activeSecs: 10, finishedAt: at('2026-11-14', 21), category: 'tv' }),
    rec('tiny', { size: 10, sessionBytes: 10, activeSecs: 1, finishedAt: at('2026-11-14', 8) }),
    rec('outside', { size: 40 * GB, sessionBytes: 40 * GB, activeSecs: 9000, finishedAt: at('2026-10-01', 8) }),
  ];
  const R = I.rangeStats({ records: rsRecs, daily: rsDaily, now: Date.UTC(2026, 10, 16, 12), tz: 0 }, wk2);
  check('totals from the daily rows in range', R.downloaded === 8 * GB && R.uploaded === GB && R.mobile === 200 * MBy && R.finished === 3 && R.failed === 1 && R.cancelled === 1);
  check('time spent from records in range', R.activeSecs === 411);
  check('average speed is the range\u2019s downloaded bytes / its active seconds (0.27, from stats_daily)', R.avgBps === (8 * GB) / 411);
  check('biggest in range', R.biggest.name === 'big' && R.biggest.size === 4 * GB);
  check('quickest in range', R.quickest.name === 'fast');
  check('longest in range', R.longest.name === 'big' && R.longest.activeSecs === 400);
  check('busiest day in range', R.busiestDay.day === N('2026-11-15') && R.busiestDay.downloaded === 5 * GB);
  check('usual finish hour', R.peakHour === 21);
  check('not empty', R.empty === false);
  check('past range does not include today', R.includesToday === false);
  check('known days run from the first stats day to the range end', R.knownDays.length === 7 && R.knownDays[5].finished === 2);
  const E = I.rangeStats({ records: [], daily: [], now: Date.UTC(2026, 10, 16, 12), tz: 0 }, wk);
  check('empty range: nulls, no fabricated values', E.empty && E.avgBps === null && E.biggest === null && E.busiestDay === null && E.peakHour === null && E.knownDays.length === 0);
  const day1 = I.rangeStats({ records: [], daily: [{ ...zero, day: '2026-11-15', downloaded: 1 }], now: Date.UTC(2026, 10, 16, 12), tz: 0 }, wk);
  check('days since stats began counts from the first day', day1.sinceFirst === 2 && day1.includesToday);
  check('most in one range looks back at earlier ranges', I.mostInOneRange(rsRecs, I.rangeOf('month', today), 0, N('2026-10-01')) === 9000);
  check('most in one range is 0 without stats', I.mostInOneRange([], mo, 0, null) === 0);

  console.log('format');
  check('size 0', F.fmtSize(0) === '0 B');
  check('size MB', F.fmtSize(212 * MBy) === '212 MB');
  check('size small GB has a decimal', F.fmtSize(1.8 * GB) === '1.8 GB');
  check('size big GB is whole', F.fmtSize(412.4 * GB) === '412 GB');
  check('size TB has two decimals', F.fmtSize(1.77 * 1024 * GB) === '1.77 TB');
  check('size parts split number and unit', eq(F.sizeParts(1.8 * GB), { n: '1.8', unit: 'GB' }));
  check('size KB', F.fmtSize(4096) === '4 KB');
  check('size bytes', F.fmtSize(12) === '12 B');
  check('size of junk is 0 B', F.fmtSize(NaN) === '0 B' && F.fmtSize(-5) === '0 B');
  check('duration seconds', F.fmtDuration(42) === '42 s');
  check('duration minutes', F.fmtDuration(150) === '3 min');
  check('duration hours and minutes', F.fmtDuration(2 * 3600 + 5 * 60) === '2 h 5 min');
  check('duration whole hours', F.fmtDuration(3600) === '1 h');
  check('duration over 10 h is hours only', F.fmtDuration(37 * 3600 + 1200) === '37 h');
  check('duration parts', eq(F.durationParts(2 * 3600 + 5 * 60), [{ n: '2', unit: 'h' }, { n: '5', unit: 'min' }]));
  check('duration parts of 0 is 0 min', eq(F.durationParts(0), [{ n: '0', unit: 'min' }]));
  check('took: minutes and seconds', F.fmtTook(161) === '2 min 41 s');
  check('took: whole minutes', F.fmtTook(120) === '2 min');
  check('took: seconds', F.fmtTook(9) === '9 s');
  check('took: hours and minutes', F.fmtTook(3 * 3600 + 7 * 60 + 5) === '3 h 7 min');
  check('speed MB/s', F.fmtSpeed(13.9 * MBy) === '13.9 MB/s');
  check('speed KB/s below 1 MB/s', F.fmtSpeed(412 * 1024) === '412 KB/s');
  check('speed parts', eq(F.speedParts(3.2 * MBy), { n: '3.2', unit: 'MB/s' }));
  check('hour', F.fmtHour(7) === '07:00' && F.fmtHour(22) === '22:00');
  check('days', F.fmtDays(1) === '1 day' && F.fmtDays(4) === '4 days');
  check('day label', F.dayLabel(N('2026-11-16')) === 'Mon, Nov 16');
  check('short date', F.shortDate(N('2026-06-14')) === 'Jun 14');
  check('crate unit keeps 24 crates or fewer', F.crateUnit(3) === 1 && F.crateUnit(25) === 2 && F.crateUnit(400) === 20 && F.crateUnit(30000) === 1000);
  check('gauge max', F.gaugeMax(3) === 5 && F.gaugeMax(11) === 20 && F.gaugeMax(900) === 400);

  console.log('labels');
  check('title: year', F.rangeTitle(yr, today) === '2026');
  check('title: month', F.rangeTitle(mo, today) === 'November 2026');
  check('title: this week', F.rangeTitle(wk, today) === 'This week');
  check('title: last week', F.rangeTitle(wk2, today) === 'Last week');
  check('title: older week', F.rangeTitle(I.rangeOf('week', N('2026-11-03')), today) === 'Nov 2–8');
  check('caption: this year', F.rangeCaption(yr, today) === 'downloaded this year');
  check('caption: past year', F.rangeCaption(I.stepRange(yr, -1), today) === 'downloaded in 2025');
  check('caption: this week so far', F.rangeCaption(wk, today) === 'downloaded this week so far');
  check('caption: last week', F.rangeCaption(wk2, today) === 'downloaded last week');
  check('caption: past month this year', F.rangeCaption(I.rangeOf('month', N('2026-10-03')), today) === 'downloaded in October');
  check('caption: past month last year', F.rangeCaption(I.rangeOf('month', N('2025-10-03')), today) === 'downloaded in October 2025');
  check('period phrase', F.periodPhrase(mo, today) === 'this month' && F.periodPhrase(I.rangeOf('week', N('2026-11-03')), today) === 'that week');
  check('category label', F.categoryLabel('tv') === 'TV' && F.categoryLabel('movies') === 'Movies');
  check('source label groups search providers', F.sourceLabel('x1337') === 'search' && F.sourceLabel('link') === 'links' && F.sourceLabel('share') === 'shared to Maglev');
  check('readout of a bucket', F.bucketReadout({ downloaded: 9 * GB, finished: 3, failed: 1, cancelled: 0, future: false }) === '9.0 GB · 3 finished · 1 failed');
  check('readout of an empty bucket', F.bucketReadout({ downloaded: 0, finished: 0, failed: 0, cancelled: 0, future: false }) === 'Nothing downloaded');
  check('readout of a future bucket', F.bucketReadout({ downloaded: 0, finished: 0, failed: 0, cancelled: 0, future: true }) === 'Not here yet');

  console.log('timing');
  check('done lead with timing', F.doneLead(161, 1700000000) === 'Done in 2 min 41 s');
  check('done lead without timing (before 0.26)', F.doneLead(0, 0) === 'Done' && F.doneLead(undefined, undefined) === 'Done' && F.doneLead(120, 0) === 'Done');
  const NOW = Date.UTC(2026, 10, 16, 14, 32);
  check('when: today', F.whenLabel(Date.UTC(2026, 10, 16, 9, 5) / 1000, NOW, 0) === 'Today 09:05');
  check('when: yesterday', F.whenLabel(Date.UTC(2026, 10, 15, 22, 3) / 1000, NOW, 0) === 'Yesterday 22:03');
  check('when: older', F.whenLabel(Date.UTC(2026, 10, 12, 7, 0) / 1000, NOW, 0) === 'Nov 12 07:00');
  const added = Date.UTC(2026, 10, 15, 22, 3) / 1000;
  const tv = F.timingView({ activeSecs: 2466, finishedAt: added + 2640, addedAt: added, sessionBytes: 2466 * 3.2 * MBy, bytesWifi: 7 * GB, bytesMobile: 212 * MBy, seedingSecs: 3600, uploaded: 2 * GB }, NOW, 0);
  check('timing: took and average', tv.known && tv.tookLabel === 'Took' && tv.took === '41 min 6 s' && tv.avg === '3.2 MB/s');
  check('timing: the two parts add up', tv.span.total === 2640 && tv.span.downloading + tv.span.waiting === 2640 && tv.span.waiting === 174);
  check('timing: added and finished', tv.added === 'Yesterday 22:03' && tv.finished === 'Yesterday 22:47');
  check('timing: network and seeding', tv.network.mobile === 212 * MBy && tv.seeding === '1 h' && tv.uploaded === '2.0 GB');
  const run = F.timingView({ activeSecs: 334, finishedAt: 0, addedAt: added, sessionBytes: 334 * 13.9 * MBy }, NOW, 0);
  check('timing while downloading', run.tookLabel === 'Downloading for' && run.took === '5 min 34 s' && run.finished === null && run.span === null);
  const pre = F.timingView({ activeSecs: 0, finishedAt: 0 }, NOW, 0);
  check('timing before 0.26 is unknown, never made up', !pre.known && pre.took === null && pre.avg === null && pre.network === null);
  check('average shown for a 2 s download (bytes / time)', F.timingView({ activeSecs: 2, finishedAt: added + 2, sessionBytes: 10 * MBy }, NOW, 0).avg === '5.0 MB/s');
  check('no average without bytes or time', F.timingView({ activeSecs: 0, sessionBytes: 5 * MBy }, NOW, 0).avg === null && F.timingView({ activeSecs: 4, sessionBytes: 0 }, NOW, 0).avg === null);

  console.log('phone fixes');
  // 1. A 10 MB link download that took 2 s: Average speed is 5 MB/s, not "—".
  const quick = rec('quick', { kind: 'link', size: 10 * MBy, sessionBytes: 10 * MBy, activeSecs: 2, finishedAt: at('2026-11-16', 11) });
  const RQ = I.rangeStats({ records: [quick], daily: [{ ...zero, day: '2026-11-16', downloaded: 10 * MBy, finished: 1 }], now: Date.UTC(2026, 10, 16, 12), tz: 0 }, wk);
  check('average speed of a 2 s, 10 MB download is 5 MB/s', RQ.avgBps === 5 * MBy && F.fmtSpeed(RQ.avgBps) === '5.0 MB/s');
  check('the 2 s download is the quickest record', RQ.quickest && RQ.quickest.name === 'quick');
  // 2. A download already holding its bytes when stats first looked still counts them when it finishes.
  const Rc = await import('../utils/stats/recorder.ts');
  const ctx = { now: Date.UTC(2026, 10, 16, 11), tz: 0, origin: () => ({ source: null, category: null }) };
  const item = (o) => ({ id: 'L1', kind: 'link', name: 'six.bin', size: 6 * MBy, urlDisplay: '', errored: false, activeSecs: 1, finishedAt: 0, sessionBytes: 6 * MBy, uploaded: 0, bytesWifi: 6 * MBy, bytesMobile: 0, addedAt: 1, ...o });
  const look = Rc.planWrites(null, [item()], ctx);
  const fin = Rc.planWrites(look.baseline, [item({ finishedAt: 1763290000 })], ctx);
  check('bytes seen at the first look are counted when it finishes', fin.finished.length === 1 && fin.delta.downloaded === 6 * MBy && fin.delta.wifi === 6 * MBy);
  const a1 = Rc.planWrites({}, [item({ sessionBytes: 2 * MBy, bytesWifi: 2 * MBy })], ctx);
  const a2 = Rc.planWrites(a1.baseline, [item({ sessionBytes: 6 * MBy, bytesWifi: 6 * MBy, finishedAt: 1763290000 })], ctx);
  check('bytes counted along the way are not counted twice', a1.delta.downloaded + a2.delta.downloaded === 6 * MBy);
  const legacy = { L1: { d: 6 * MBy, u: 0, w: 6 * MBy, m: 0, fin: 0, err: 0, r: 0 } };
  check('an older baseline entry is trusted as counted', Rc.planWrites(legacy, [item({ finishedAt: 1763290000 })], ctx).delta.downloaded === 0);

  console.log('wiring');
  const screen = read('app/stats.tsx');
  const layout = read('app/_layout.tsx');
  const settings = read('app/(tabs)/settings.tsx');
  check('stats route is declared inside a guard', /Stack\.Screen name="stats"/.test(layout));
  check('Settings has a Stats row', /title: 'Stats'|title="Stats"/.test(settings) && /\/stats/.test(settings));
  check('the screen reads the stats store', /getStatsStore/.test(screen) && /rangeStats/.test(screen));
  check('the screen respects Keep stats', /keepStats/.test(screen) && /setStatsPrefs/.test(screen));
  const all = ['app/stats.tsx', ...fs.readdirSync(path.join(root, 'components/stats')).map((f) => `components/stats/${f}`)].map(read).join('\n');
  check('no hex colours in the stats UI', !/#[0-9a-fA-F]{3,8}\b/.test(all));
  check('no system monospace', !/fontFamily:\s*'monospace'/.test(all));
  check('reduce motion respected', /useReduceMotion|useMotion/.test(all));
  check('records sheet offers Show this day', /Show this day/.test(all));
  const detail = read('app/torrent/[id].tsx');
  // NATIVE_CONTRACT 41.2: the torrent page draws its Detailed numbers (boxes and Timing row) through TorrentStats.
  check('detail shows the timing row', /<TorrentStats/.test(detail) && /<TimingRow/.test(read('components/detail/TorrentStats.tsx')));
  check('transfers rows say Done in', /doneLead/.test(read('components/transfers/model.ts')) && /doneLead/.test(read('utils/downloadCopy.ts')));
  const city = read('components/stats/PixelCity.tsx');
  check('city pan activates on a small horizontal move and fails on vertical', /activeOffsetX:\s*\[-8, 8\]/.test(city) && /failOffsetY:\s*\[-12, 12\]/.test(city) && /onUpdate/.test(city));
  check('city answers a plain tap too', /useTapGesture/.test(city));
  check('the busiest or current building is filled like the rest', !/if \(!b\.current\)/.test(city));
  const kit = read('components/stats/StatsKit.tsx');
  check('Finished keeps a sub-line when nothing failed', /none failed/.test(kit));
  const dsheet = read('components/transfers/DownloadStats.tsx');
  check('link download page shows the timing row', /TimingRow/.test(dsheet));
  check('no pink in categories', !/accents\.pink|\bpink\b/.test(all));
  // The global `router` from expo-router throws "unavailable before the first render has finished" while its
  // bridge is unbound (seen on a cold start: Settings > Stats crashed). Screens use the useRouter() hook instead.
  const walkTsx = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walkTsx(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []);
  const globalRouter = ['app', 'components'].flatMap(walkTsx)
    .filter((f) => /import\s*\{[^}]*\brouter\b[^}]*\}\s*from\s*['"]expo-router['"]/.test(read(f)));
  check('no screen imports the global expo-router router (use useRouter)', globalRouter.length === 0, globalRouter.join(', '));

  // 2026-11-19 user report: picking an earlier day snapped back to today about a second later, because live counts
  // refresh the buckets while something downloads. The pick is redone only when the range changes.
  {
    const scr = fs.readFileSync(path.join(__dirname, '..', 'app', 'stats.tsx'), 'utf8');
    check('the day pick survives live refreshes (keyed on the shown range)', /pickedFor\.current === key && d == null/.test(scr) && /\[buckets, busiest, inert, shown\]/.test(scr));
    const city = fs.readFileSync(path.join(__dirname, '..', 'components', 'stats', 'PixelCity.tsx'), 'utf8');
    check('the building outline follows the selected day, not only today', /i === \(selected >= 0 \? selected/.test(city) && /live, selected\]\);/.test(city));
  }

  if (failed) {
    console.error(`\n${failed} failed`);
    process.exit(1);
  }
  console.log('\nall stats screen checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
