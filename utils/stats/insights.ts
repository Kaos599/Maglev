/**
 * Everything the Stats page shows, computed from the stats tables (docs/NATIVE_CONTRACT.md section 34.2).
 * Pure. Every number comes from rows; with nothing recorded the values are null, empty or zero. No estimates, no money.
 */
import { dayKey, dayNumber, dayOfDate, localParts, mondayOf, monthOfDay, partsOf, weekdayOf } from './time.ts';
import type { DailyRow, MonthlyRow, StatsKind, StatsRecord } from './types.ts';

/** Items shorter than this are left out of speeds: a 1 second burst says nothing about speed. */
const MIN_SPEED_SECS = 3;
export const MB = 1024 * 1024;
export const TB = 1e12;

export interface InsightsInput {
  records: readonly StatsRecord[];
  daily: readonly DailyRow[];
  monthly: readonly MonthlyRow[];
  /** Milliseconds. */
  now: number;
  /** Minutes east of UTC. Omitted: the phone's zone. */
  tz?: number;
  mobileLimitMb: number | null;
}

export interface Totals {
  downloaded: number;
  uploaded: number;
  wifi: number;
  mobile: number;
  finished: number;
  failed: number;
  cancelled: number;
  /** Seconds spent downloading, from finished items. */
  activeSecs: number;
}

export interface MobileUse {
  usedBytes: number;
  limitBytes: number | null;
  /** used / limit, can pass 1. Null with no limit. */
  fraction: number | null;
  over: boolean;
}

/** Bytes per second. */
export interface AvgSpeed {
  byKind: Record<StatsKind, number | null>;
  /** An item counts as Wi-Fi or mobile by whichever carried more of its bytes. */
  byNetwork: { wifi: number | null; mobile: number | null };
}

export interface RecordHolder {
  id: string;
  name: string;
  kind: StatsKind;
  finishedAt: number;
}
export interface Records {
  biggest: (RecordHolder & { size: number }) | null;
  fastestAvg: (RecordHolder & { bps: number }) | null;
  longest: (RecordHolder & { activeSecs: number }) | null;
  topDay: { day: string; downloaded: number } | null;
}

export interface Reliability {
  firstTry: number;
  retried: number;
  failed: number;
  cancelled: number;
}

export interface SourceCount {
  source: string;
  count: number;
  bytes: number;
}
export interface CategoryCount {
  /** 'unknown' when the add did not say. */
  category: string;
  count: number;
  bytes: number;
}

export interface Rhythm {
  /** Finished items per weekday, index 0 = Sunday. */
  weekdays: number[];
  /** Finished items per hour of the day, 0 to 23. */
  hours: number[];
  busiestWeekday: number;
  busiestHour: number;
}

export interface Streak {
  /** Days in a row with a finish, up to today (or yesterday while today is still open). */
  current: number;
  longest: number;
}

export interface Milestone {
  kind: 'first' | 'hundredth' | 'terabyte';
  name: string;
  finishedAt: number;
}

export interface Insights {
  hasData: boolean;
  totals: { allTime: Totals; thisMonth: Totals };
  mobile: MobileUse;
  avgSpeed: AvgSpeed;
  records: Records;
  reliability: Reliability;
  topSources: SourceCount[];
  mixByCategory: CategoryCount[];
  rhythm: Rhythm | null;
  streak: Streak;
  milestones: Milestone[];
}

const emptyTotals = (): Totals => ({ downloaded: 0, uploaded: 0, wifi: 0, mobile: 0, finished: 0, failed: 0, cancelled: 0, activeSecs: 0 });
const holder = (r: StatsRecord): RecordHolder => ({ id: r.id, name: r.name, kind: r.kind, finishedAt: r.finishedAt });
const speedOk = (r: StatsRecord) => r.activeSecs >= MIN_SPEED_SECS && r.sessionBytes > 0;
const ratio = (bytes: number, secs: number): number | null => (secs > 0 ? bytes / secs : null);

function sumDaily(rows: readonly DailyRow[], into: Totals): Totals {
  for (const d of rows) {
    into.downloaded += d.downloaded;
    into.uploaded += d.uploaded;
    into.wifi += d.wifi;
    into.mobile += d.mobile;
    into.finished += d.finished;
    into.failed += d.failed;
    into.cancelled += d.cancelled;
  }
  return into;
}

function computeStreak(daily: readonly DailyRow[], today: string): Streak {
  const days = [...new Set(daily.filter((d) => d.finished > 0).map((d) => dayNumber(d.day)))].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const set = new Set(days);
  const t = dayNumber(today);
  let cursor = set.has(t) ? t : set.has(t - 1) ? t - 1 : null;
  let current = 0;
  while (cursor !== null && set.has(cursor)) {
    current++;
    cursor--;
  }
  return { current, longest };
}

function groupBy<K extends string>(records: readonly StatsRecord[], keyOf: (r: StatsRecord) => K | null): { key: K; count: number; bytes: number }[] {
  const m = new Map<K, { key: K; count: number; bytes: number }>();
  for (const r of records) {
    const k = keyOf(r);
    if (k === null) continue;
    const e = m.get(k) ?? { key: k, count: 0, bytes: 0 };
    e.count += 1;
    e.bytes += r.sessionBytes;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes || (a.key < b.key ? -1 : 1));
}

export function computeInsights(input: InsightsInput): Insights {
  const { records, daily, monthly, now, tz } = input;
  const today = dayKey(now, tz);
  const thisMonth = monthOfDay(today);

  const allTime = sumDaily(daily, emptyTotals());
  allTime.activeSecs = records.reduce((s, r) => s + r.activeSecs, 0) + monthly.reduce((s, m) => s + m.activeSecs, 0);
  const month = sumDaily(daily.filter((d) => monthOfDay(d.day) === thisMonth), emptyTotals());
  month.activeSecs = records.filter((r) => monthOfDay(dayKey(r.finishedAt * 1000, tz)) === thisMonth).reduce((s, r) => s + r.activeSecs, 0);

  const limitBytes = input.mobileLimitMb != null && input.mobileLimitMb > 0 ? Math.floor(input.mobileLimitMb * MB) : null;
  const mobile: MobileUse = {
    usedBytes: month.mobile,
    limitBytes,
    fraction: limitBytes ? month.mobile / limitBytes : null,
    over: limitBytes != null && month.mobile > limitBytes,
  };

  const timed = records.filter(speedOk);
  const kinds: StatsKind[] = ['torrent', 'link', 'stream'];
  const byKind = {} as Record<StatsKind, number | null>;
  for (const k of kinds) {
    const rs = timed.filter((r) => r.kind === k);
    byKind[k] = ratio(rs.reduce((s, r) => s + r.sessionBytes, 0), rs.reduce((s, r) => s + r.activeSecs, 0));
  }
  const mostlyMobile = (r: StatsRecord) => r.bytesMobile > r.bytesWifi;
  const net = (rs: StatsRecord[]) => ratio(rs.reduce((s, r) => s + r.sessionBytes, 0), rs.reduce((s, r) => s + r.activeSecs, 0));
  const avgSpeed: AvgSpeed = {
    byKind,
    byNetwork: {
      wifi: net(timed.filter((r) => r.bytesWifi + r.bytesMobile > 0 && !mostlyMobile(r))),
      mobile: net(timed.filter((r) => r.bytesWifi + r.bytesMobile > 0 && mostlyMobile(r))),
    },
  };

  const best = <T>(rs: readonly StatsRecord[], score: (r: StatsRecord) => number, make: (r: StatsRecord, s: number) => T): T | null => {
    let top: StatsRecord | null = null;
    let topScore = 0;
    for (const r of rs) {
      const s = score(r);
      if (s > topScore) {
        top = r;
        topScore = s;
      }
    }
    return top ? make(top, topScore) : null;
  };
  const topDayRow = daily.reduce<DailyRow | null>((t, d) => (d.downloaded > 0 && (!t || d.downloaded > t.downloaded) ? d : t), null);
  const recordsOut: Records = {
    biggest: best(records, (r) => r.size, (r, s) => ({ ...holder(r), size: s })),
    fastestAvg: best(timed, (r) => r.sessionBytes / r.activeSecs, (r, s) => ({ ...holder(r), bps: s })),
    longest: best(records, (r) => r.activeSecs, (r, s) => ({ ...holder(r), activeSecs: s })),
    topDay: topDayRow ? { day: topDayRow.day, downloaded: topDayRow.downloaded } : null,
  };

  const retriedRecords = records.filter((r) => r.retries > 0).length;
  const retriedFolded = monthly.reduce((s, m) => s + m.retried, 0);
  const finishedFolded = monthly.reduce((s, m) => s + m.finished, 0);
  const retried = retriedRecords + retriedFolded;
  const reliability: Reliability = {
    firstTry: records.length + finishedFolded - retried,
    retried,
    failed: allTime.failed,
    cancelled: allTime.cancelled,
  };

  const topSources = groupBy(records, (r) => r.source || null)
    .slice(0, 5)
    .map((e) => ({ source: e.key, count: e.count, bytes: e.bytes }));
  const mixByCategory = groupBy(records, (r) => r.category || 'unknown').map((e) => ({ category: e.key, count: e.count, bytes: e.bytes }));

  let rhythm: Rhythm | null = null;
  if (records.length > 0) {
    const weekdays = new Array<number>(7).fill(0);
    const hours = new Array<number>(24).fill(0);
    for (const r of records) {
      const p = localParts(r.finishedAt * 1000, tz);
      weekdays[p.weekday]++;
      hours[p.hour]++;
    }
    rhythm = { weekdays, hours, busiestWeekday: weekdays.indexOf(Math.max(...weekdays)), busiestHour: hours.indexOf(Math.max(...hours)) };
  }

  const milestones: Milestone[] = [];
  const ordered = [...records].sort((a, b) => a.finishedAt - b.finishedAt || (a.id < b.id ? -1 : 1));
  const before = finishedFolded;
  let bytes = monthly.reduce((s, m) => s + m.downloaded, 0);
  let tb: StatsRecord | null = null;
  ordered.forEach((r, i) => {
    bytes += r.sessionBytes;
    if (!tb && bytes >= TB) tb = r;
    const count = before + i + 1;
    if (count === 1) milestones.push({ kind: 'first', name: r.name, finishedAt: r.finishedAt });
    if (count === 100) milestones.push({ kind: 'hundredth', name: r.name, finishedAt: r.finishedAt });
  });
  if (tb) milestones.push({ kind: 'terabyte', name: (tb as StatsRecord).name, finishedAt: (tb as StatsRecord).finishedAt });

  return {
    hasData: allTime.finished > 0 || allTime.downloaded > 0 || records.length > 0,
    totals: { allTime, thisMonth: month },
    mobile,
    avgSpeed,
    records: recordsOut,
    reliability,
    topSources,
    mixByCategory,
    rhythm,
    streak: computeStreak(daily, today),
    milestones,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The Stats screen: one range at a time (week, month or year), split into buckets for the Pixel city.                  */
/* Days are day numbers (days since the epoch, see time.ts). Weeks start on Monday.                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RangeKind = 'week' | 'month' | 'year';

/** Inclusive day numbers. */
export interface StatsRange {
  kind: RangeKind;
  start: number;
  end: number;
}

/** The week (Monday start), calendar month or calendar year that holds `anchor`. */
export function rangeOf(kind: RangeKind, anchor: number): StatsRange {
  if (kind === 'week') {
    const start = mondayOf(anchor);
    return { kind, start, end: start + 6 };
  }
  const { y, m } = partsOf(anchor);
  if (kind === 'month') return { kind, start: dayOfDate(y, m, 1), end: dayOfDate(y, m + 1, 0) };
  return { kind, start: dayOfDate(y, 0, 1), end: dayOfDate(y, 11, 31) };
}

/** The range before (-1) or after (1) this one, of the same kind. */
export const stepRange = (r: StatsRange, dir: 1 | -1): StatsRange => rangeOf(r.kind, dir < 0 ? r.start - 1 : r.end + 1);

/** Back stops at the range that holds the first stats day; forward stops at the range that holds today. */
export function canStepRange(r: StatsRange, dir: 1 | -1, firstDay: number | null, today: number): boolean {
  if (dir > 0) return r.end < today;
  return firstDay != null && r.start > firstDay;
}

export const rangeHolds = (r: StatsRange, day: number): boolean => day >= r.start && day <= r.end;

/** Changing Week / Month / Year keeps today when the range holds it, else the range's last day; never before the first stats day. */
export function switchRangeKind(r: StatsRange, kind: RangeKind, today: number, firstDay: number | null): StatsRange {
  const anchor = rangeHolds(r, today) ? today : Math.min(r.end, today);
  const next = rangeOf(kind, anchor);
  if (firstDay != null && next.end < firstDay) return rangeOf('week', firstDay);
  return next;
}

const hasActivity = (d: DailyRow) => d.downloaded > 0 || d.uploaded > 0 || d.finished > 0 || d.failed > 0 || d.cancelled > 0;

/** The first day with anything in stats_daily: the earliest the arrows go. Null with no stats yet. */
export function firstStatsDay(daily: readonly DailyRow[]): number | null {
  let first: number | null = null;
  for (const d of daily) {
    if (!hasActivity(d)) continue;
    const n = dayNumber(d.day);
    if (first === null || n < first) first = n;
  }
  return first;
}

export interface Bucket {
  /** Inclusive day numbers, clipped to the range. */
  start: number;
  end: number;
  noun: 'day' | 'week';
  downloaded: number;
  finished: number;
  failed: number;
  cancelled: number;
  /** Starts after today. */
  future: boolean;
  /** Holds today. */
  current: boolean;
  /** A day bucket on Saturday or Sunday. */
  weekend: boolean;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Nov 16". */
export function shortDateOf(n: number): string {
  const p = partsOf(n);
  return `${MONTHS[p.m]} ${p.d}`;
}
/** "Mon, Nov 16". */
export const dayLabelOf = (n: number): string => `${WEEKDAYS[weekdayOf(n)]}, ${shortDateOf(n)}`;
/** "Nov 2–8", or "Oct 26–Nov 1" across a month. */
export function spanLabelOf(a: number, b: number): string {
  const x = partsOf(a);
  const z = partsOf(b);
  return `${MONTHS[x.m]} ${x.d}–${x.m === z.m ? '' : `${MONTHS[z.m]} `}${z.d}`;
}

function dailyIndex(daily: readonly DailyRow[]): Map<number, DailyRow> {
  const m = new Map<number, DailyRow>();
  for (const d of daily) m.set(dayNumber(d.day), d);
  return m;
}

/** One bucket per day for a week or month; one per Monday-start week (clipped to the year) for a year. */
export function bucketsFor(r: StatsRange, daily: readonly DailyRow[], today: number): Bucket[] {
  const idx = dailyIndex(daily);
  const thisMon = mondayOf(today);
  const spans: [number, number][] = [];
  if (r.kind === 'year') {
    for (let mon = mondayOf(r.start); mon <= r.end; mon += 7) spans.push([Math.max(mon, r.start), Math.min(mon + 6, r.end)]);
  } else {
    for (let d = r.start; d <= r.end; d++) spans.push([d, d]);
  }
  return spans.map(([start, end]) => {
    const b: Bucket = {
      start, end, noun: r.kind === 'year' ? 'week' : 'day', downloaded: 0, finished: 0, failed: 0, cancelled: 0,
      future: start > today, current: today >= start && today <= end, weekend: false, label: '',
    };
    for (let d = start; d <= end; d++) {
      const row = idx.get(d);
      if (!row) continue;
      b.downloaded += row.downloaded;
      b.finished += row.finished;
      b.failed += row.failed;
      b.cancelled += row.cancelled;
    }
    const wd = weekdayOf(start);
    b.weekend = b.noun === 'day' && (wd === 0 || wd === 6);
    if (b.noun === 'week') {
      const mon = mondayOf(start);
      b.label = mon === thisMon ? 'This week' : mon === thisMon - 7 ? 'Last week' : spanLabelOf(start, end);
    } else b.label = b.current ? 'Today' : dayLabelOf(start);
    return b;
  });
}

/** The bucket with the most downloaded (the first of a tie), or -1 when nothing was downloaded. */
export function busiestBucket(buckets: readonly { downloaded: number }[]): number {
  let best = -1;
  for (let i = 0; i < buckets.length; i++) if (buckets[i].downloaded > 0 && (best < 0 || buckets[i].downloaded > buckets[best].downloaded)) best = i;
  return best;
}

/** The first bucket the steppers may reach: the one that holds the first stats day (0 when it is earlier). */
export function firstBucketIndex(buckets: readonly { end: number }[], firstDay: number | null): number {
  if (firstDay == null) return 0;
  const i = buckets.findIndex((b) => b.end >= firstDay);
  return i < 0 ? Math.max(0, buckets.length - 1) : i;
}

/** The longest run of days with a finish inside the range (up to today). The earlier run wins a tie. */
export function longestStreakIn(daily: readonly DailyRow[], r: StatsRange, today: number): { days: number; from: number | null; to: number | null } {
  const idx = dailyIndex(daily);
  let best = 0;
  let from: number | null = null;
  let to: number | null = null;
  let run = 0;
  let runFrom = 0;
  for (let d = r.start; d <= Math.min(r.end, today); d++) {
    if ((idx.get(d)?.finished ?? 0) > 0) {
      if (run === 0) runFrom = d;
      run++;
      if (run > best) {
        best = run;
        from = runFrom;
        to = d;
      }
    } else run = 0;
  }
  return { days: best, from, to };
}

const finishDay = (r: StatsRecord, tz?: number) => dayNumber(dayKey(r.finishedAt * 1000, tz));
const recordsIn = (records: readonly StatsRecord[], r: StatsRange, tz?: number) => records.filter((x) => x.finishedAt > 0 && rangeHolds(r, finishDay(x, tz)));

/**
 * Seconds spent downloading in a range (NATIVE_CONTRACT 34.3, 0.27). Each day's figure comes from stats_daily, which counts live;
 * each day counts the larger of that and the time of the items that finished that day (covers time in the background and days
 * before 0.27). No backfill beyond that.
 */
function activeSecsIn(daily: readonly DailyRow[], records: readonly StatsRecord[], r: StatsRange, tz?: number): number {
  const stored = new Map<number, number>();
  for (const d of daily) {
    const n = dayNumber(d.day);
    const v = Number(d.activeSecs);
    if (rangeHolds(r, n) && Number.isFinite(v) && v > 0) stored.set(n, (stored.get(n) ?? 0) + v);
  }
  // Per day, the larger of the live count and the finished items' own time: the live count can miss time while the app was
  // in the background, and a finished item's time is measured by the engine, so the larger is the honest floor.
  const finished = new Map<number, number>();
  for (const x of recordsIn(records, r, tz)) {
    const n = finishDay(x, tz);
    finished.set(n, (finished.get(n) ?? 0) + (Number.isFinite(x.activeSecs) && x.activeSecs > 0 ? x.activeSecs : 0));
  }
  let total = 0;
  for (const n of new Set([...stored.keys(), ...finished.keys()])) total += Math.max(stored.get(n) ?? 0, finished.get(n) ?? 0);
  return total;
}

/** Finished items per local hour inside the range, and the hour most finished in (null with none). */
export function finishHours(records: readonly StatsRecord[], r: StatsRange, tz?: number): { hours: number[]; peak: number | null } {
  const hours = new Array<number>(24).fill(0);
  for (const x of recordsIn(records, r, tz)) hours[localParts(x.finishedAt * 1000, tz).hour]++;
  const max = Math.max(...hours);
  return { hours, peak: max > 0 ? hours.indexOf(max) : null };
}

/** Splits `total` whole units by weight (largest remainder; ties go to the earlier entry). */
export function largestRemainder(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(sum > 0)) return weights.map(() => 0);
  const raw = weights.map((w) => (Math.max(0, w) / sum) * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => [x - out[i], i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

export interface CategorySlice {
  key: string;
  label: string;
  bytes: number;
  /** Whole percent of the range's bytes; the rows shown add to 100. */
  pct: number;
}

/** Search categories with a name of their own. Anything else ('other', 'all', none) is Unsorted. */
export const CATEGORY_LABELS: Record<string, string> = {
  movies: 'Movies', tv: 'TV', anime: 'Anime', music: 'Music', apps: 'Apps', games: 'Games', books: 'Books', adult: 'Adult',
};
const UNSORTED = 'unsorted';

/**
 * What you download, by bytes: the top three named categories, then Other (every other category plus Unsorted).
 * `all` is the full split for the sheet: every named category by size, then Unsorted.
 */
export function categoryRollup(records: readonly StatsRecord[]): { top: CategorySlice[]; other: CategorySlice | null; all: CategorySlice[]; total: number } {
  const by = new Map<string, number>();
  for (const r of records) {
    const k = r.category && CATEGORY_LABELS[r.category] ? r.category : UNSORTED;
    by.set(k, (by.get(k) ?? 0) + Math.max(0, r.sessionBytes));
  }
  const total = [...by.values()].reduce((a, b) => a + b, 0);
  if (!(total > 0)) return { top: [], other: null, all: [], total: 0 };
  const named = [...by.entries()].filter(([k, b]) => k !== UNSORTED && b > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const unsorted = by.get(UNSORTED) ?? 0;
  const top = named.slice(0, 3);
  const otherBytes = named.slice(3).reduce((a, [, b]) => a + b, 0) + unsorted;
  const rows = [...top.map(([k, b]) => ({ key: k, label: CATEGORY_LABELS[k], bytes: b }))];
  if (otherBytes > 0) rows.push({ key: 'other', label: 'Other', bytes: otherBytes });
  const pcts = largestRemainder(rows.map((x) => x.bytes), 100);
  const slices = rows.map((x, i) => ({ ...x, pct: pcts[i] }));
  const allRows = [...named.map(([k, b]) => ({ key: k, label: CATEGORY_LABELS[k], bytes: b }))];
  if (unsorted > 0) allRows.push({ key: UNSORTED, label: 'Unsorted', bytes: unsorted });
  const allPcts = largestRemainder(allRows.map((x) => x.bytes), 100);
  return {
    top: slices.filter((x) => x.key !== 'other'),
    other: slices.find((x) => x.key === 'other') ?? null,
    all: allRows.map((x, i) => ({ ...x, pct: allPcts[i] })),
    total,
  };
}

export interface RecordAt {
  name: string;
  day: number;
}

export interface RangeStats {
  downloaded: number;
  uploaded: number;
  mobile: number;
  wifi: number;
  finished: number;
  failed: number;
  cancelled: number;
  /** Seconds spent downloading in the range, from stats_daily (live), else from the items that finished that day (before 0.27). */
  activeSecs: number;
  /** Bytes per second: the range's downloaded bytes / its active seconds; null when either is 0. */
  avgBps: number | null;
  biggest: (RecordAt & { size: number }) | null;
  quickest: (RecordAt & { bps: number }) | null;
  longest: (RecordAt & { activeSecs: number }) | null;
  busiestDay: { day: number; downloaded: number; finished: number } | null;
  streak: { days: number; from: number | null; to: number | null };
  /** Days in a row with a finish, up to today (all stats, not just this range). */
  currentStreak: number;
  includesToday: boolean;
  /** Days of the range from the first stats day up to today, with their finishes. */
  knownDays: { day: number; finished: number }[];
  /** Days since stats began, counting both ends; 0 with no stats. */
  sinceFirst: number;
  firstDay: number | null;
  hours: number[];
  peakHour: number | null;
  categories: ReturnType<typeof categoryRollup>;
  /** Where finished items came from, by count, as whole percents adding to 100. */
  sources: { source: string; pct: number }[];
  empty: boolean;
}

/** Groups a search provider id under 'search'; keeps 'link', 'share', 'feed' and 'watch'. */
const sourceGroup = (s: string | null): string | null => (s == null ? null : ['link', 'share', 'feed', 'watch'].includes(s) ? s : 'search');

/** Everything the kit shows for one range. Pure; every figure comes from rows. */
export function rangeStats(input: Pick<InsightsInput, 'records' | 'daily' | 'now' | 'tz'>, r: StatsRange): RangeStats {
  const { records, daily, now, tz } = input;
  const today = dayNumber(dayKey(now, tz));
  const firstDay = firstStatsDay(daily);
  const t = emptyTotals();
  const inDays = daily.filter((d) => rangeHolds(r, dayNumber(d.day)));
  sumDaily(inDays, t);
  const recs = recordsIn(records, r, tz);
  const activeSecs = activeSecsIn(daily, records, r, tz);
  // Average speed is what the range downloaded over the time it spent downloading, so it moves while a download runs ("—" when either is 0).
  const timed = recs.filter((x) => x.activeSecs > 0 && x.sessionBytes > 0);
  const avgBps = ratio(t.downloaded, activeSecs);
  const top = <T>(rs: readonly StatsRecord[], score: (x: StatsRecord) => number, make: (x: StatsRecord, s: number) => T): T | null => {
    let best: StatsRecord | null = null;
    let bs = 0;
    for (const x of rs) {
      const s = score(x);
      if (s > bs) {
        best = x;
        bs = s;
      }
    }
    return best ? make(best, bs) : null;
  };
  const at = (x: StatsRecord): RecordAt => ({ name: x.name, day: finishDay(x, tz) });
  const busy = inDays.reduce<DailyRow | null>((b, d) => (d.downloaded > 0 && (!b || d.downloaded > b.downloaded) ? d : b), null);
  const knownDays: { day: number; finished: number }[] = [];
  if (firstDay != null) {
    const idx = dailyIndex(daily);
    for (let d = Math.max(r.start, firstDay); d <= Math.min(r.end, today); d++) knownDays.push({ day: d, finished: idx.get(d)?.finished ?? 0 });
  }
  const fh = finishHours(records, r, tz);
  const srcCounts = new Map<string, number>();
  for (const x of recs) {
    const g = sourceGroup(x.source);
    if (g) srcCounts.set(g, (srcCounts.get(g) ?? 0) + 1);
  }
  const srcRows = [...srcCounts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const srcPct = largestRemainder(srcRows.map(([, c]) => c), 100);
  return {
    downloaded: t.downloaded,
    uploaded: t.uploaded,
    mobile: t.mobile,
    wifi: t.wifi,
    finished: t.finished,
    failed: t.failed,
    cancelled: t.cancelled,
    activeSecs,
    avgBps,
    biggest: top(recs, (x) => x.size, (x, s) => ({ ...at(x), size: s })),
    quickest: top(timed, (x) => x.sessionBytes / x.activeSecs, (x, s) => ({ ...at(x), bps: s })),
    longest: top(recs, (x) => x.activeSecs, (x, s) => ({ ...at(x), activeSecs: s })),
    busiestDay: busy ? { day: dayNumber(busy.day), downloaded: busy.downloaded, finished: busy.finished } : null,
    streak: longestStreakIn(daily, r, today),
    currentStreak: computeStreak(daily, dayKey(now, tz)).current,
    includesToday: rangeHolds(r, today),
    knownDays,
    sinceFirst: firstDay != null && today >= firstDay ? today - firstDay + 1 : 0,
    firstDay,
    hours: fh.hours,
    peakHour: fh.peak,
    categories: categoryRollup(recs),
    sources: srcRows.map(([source], i) => ({ source, pct: srcPct[i] })),
    empty: t.downloaded <= 0 && t.finished <= 0 && recs.length === 0,
  };
}

/** The most time spent downloading in one range of this kind, looking back up to 12 ranges (not before the first stats day). */
export function mostInOneRange(records: readonly StatsRecord[], r: StatsRange, tz: number | undefined, firstDay: number | null, daily: readonly DailyRow[] = []): number {
  if (firstDay == null) return 0;
  let best = 0;
  let cur = r;
  for (let i = 0; i < 12 && cur.end >= firstDay; i++) {
    best = Math.max(best, activeSecsIn(daily, records, cur, tz));
    cur = stepRange(cur, -1);
  }
  return best;
}
