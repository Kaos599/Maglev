/**
 * Everything the Stats page shows, computed from the stats tables (docs/NATIVE_CONTRACT.md section 34.2).
 * Pure. Every number comes from rows; with nothing recorded the values are null, empty or zero. No estimates, no money.
 */
import { dayKey, dayNumber, localParts, monthOfDay } from './time.ts';
import type { DailyRow, MonthlyRow, StatsKind, StatsRecord } from './types.ts';

/** Items shorter than this are left out of speeds: a 1 second burst says nothing about speed. */
export const MIN_SPEED_SECS = 3;
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
