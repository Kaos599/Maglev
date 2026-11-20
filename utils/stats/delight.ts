/**
 * The 0.27 delight pass, as pure rules: the one-sentence summary, "vs last week", thin-data mode, today's live figures, the
 * streak card's flag and the fire it draws. No React. Every figure comes from stats rows; unknown stays unknown.
 */
import { fmtSize, periodPhrase } from './format.ts';
import { rangeHolds, type RangeStats, type StatsRange } from './insights.ts';
import { dayNumber } from './time.ts';
import type { DailyRow } from './types.ts';
import { zeroDay } from './types.ts';
import type { LiveCounts } from './recorder.ts';

/**
 * The "Longest streak" card. The owner has not decided, so it is built and switched off: one constant, default false.
 * Turning it on needs nothing else.
 */
export const SHOW_STREAK_CARD = false;

/** Fire stages: 0 ember (no streak, or a broken one), 1 flame (a streak has started), 2 full fire (a week or more). */
export type FireStage = 0 | 1 | 2;
export const fireStage = (streakDays: number): FireStage => (streakDays >= 7 ? 2 : streakDays >= 1 ? 1 : 0);

/** Stats younger than this many days (counting both ends) are "thin": Habits and Records fold into one quiet line. */
const THIN_DAYS = 7;
/** "Downloads usually finish" is shown only once this many finishes back it. */
const MIN_FINISHED_FOR_HOUR = 5;

/** True while stats exist but are under a week old. With no stats at all the empty state covers it. */
export function isThinData(firstDay: number | null, today: number): boolean {
  return firstDay != null && today >= firstDay && today - firstDay + 1 < THIN_DAYS;
}

/** True when the finish-hour counts add up to enough downloads to say "usually". */
export const hourReady = (hours: readonly number[]): boolean => hours.reduce((a, b) => a + b, 0) >= MIN_FINISHED_FOR_HOUR;

export interface Summary {
  /** The size, shown big ("575 MB"). */
  lead: string;
  /** The rest of the sentence, starting with a space (" this week. Today is the busiest day so far."). */
  rest: string;
}

/** One plain sentence about the selected range, or null when nothing was downloaded. */
export function summarySentence(stats: RangeStats, range: StatsRange, today: number): Summary | null {
  if (stats.empty) return null;
  let rest = ` ${periodPhrase(range, today)}.`;
  if (stats.includesToday && stats.busiestDay?.day === today && stats.knownDays.length >= 2) rest += ' Today is the busiest day so far.';
  else if (stats.finished > 0) rest += ` ${stats.finished} ${stats.finished === 1 ? 'download' : 'downloads'} finished.`;
  return { lead: fmtSize(stats.downloaded), rest };
}

export interface VsLast {
  dir: 'up' | 'down' | 'same';
  /** Bytes, never negative. */
  bytes: number;
  text: string;
}

const sumDays = (daily: readonly DailyRow[], from: number, to: number): number => {
  let t = 0;
  for (const d of daily) {
    const n = dayNumber(d.day);
    if (n >= from && n <= to) t += d.downloaded;
  }
  return t;
};

/**
 * This week against the one before. While the week is open it compares the same days of last week ("so far"), never a partial week
 * against a whole one. Null unless a previous week with data exists, and only for week ranges.
 */
export function vsLastWeek(daily: readonly DailyRow[], range: StatsRange, today: number): VsLast | null {
  if (range.kind !== 'week') return null;
  const prevStart = range.start - 7;
  if (sumDays(daily, prevStart, prevStart + 6) <= 0) return null;
  const open = rangeHolds(range, today);
  const span = open ? today - range.start : 6;
  const now = sumDays(daily, range.start, range.start + span);
  const before = sumDays(daily, prevStart, prevStart + span);
  const tail = open ? 'last week so far' : 'the week before';
  const diff = now - before;
  if (diff === 0) return { dir: 'same', bytes: 0, text: `Same as ${tail}` };
  const bytes = Math.abs(diff);
  return { dir: diff > 0 ? 'up' : 'down', bytes, text: `${fmtSize(bytes)} ${diff > 0 ? 'more' : 'less'} than ${tail}` };
}

/** Adds what the recorder has counted but not written yet to the stored rows, so today moves while a download runs. */
export function mergeLive(daily: readonly DailyRow[], live: LiveCounts): DailyRow[] {
  const keys = Object.keys(live.days);
  if (keys.length === 0) return daily as DailyRow[];
  const by = new Map(daily.map((d) => [d.day, { ...d }]));
  for (const day of keys) {
    const row = by.get(day) ?? { day, ...zeroDay() };
    for (const [k, v] of Object.entries(live.days[day])) {
      if (typeof v === 'number' && k in row) (row as unknown as Record<string, number>)[k] = (Number((row as unknown as Record<string, number>)[k]) || 0) + v;
    }
    by.set(day, row);
  }
  return [...by.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
