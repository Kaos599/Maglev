/** Local-day bucketing for stats. `tz` is minutes east of UTC; omitted means the phone's own zone at that moment. */

const tzOf = (ms: number, tz?: number): number => (typeof tz === 'number' ? tz : -new Date(ms).getTimezoneOffset());

const p2 = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a timestamp (ms), YYYY-MM-DD. */
export function dayKey(ms: number, tz?: number): string {
  const d = new Date(ms + tzOf(ms, tz) * 60_000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

export const monthOfDay = (day: string): string => day.slice(0, 7);

/** Days since the epoch for a YYYY-MM-DD key (calendar arithmetic, no zones). */
export function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Local weekday (0 = Sunday) and hour (0 to 23) of a timestamp (ms). */
export function localParts(ms: number, tz?: number): { weekday: number; hour: number } {
  const d = new Date(ms + tzOf(ms, tz) * 60_000);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours() };
}

/** The YYYY-MM-DD key of a day number (the inverse of `dayNumber`). */
export function dayFromNumber(n: number): string {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** Weekday of a day number, 0 = Sunday. Day 0 (1970-01-01) was a Thursday. */
export const weekdayOf = (n: number): number => (((n + 4) % 7) + 7) % 7;

/** The Monday on or before a day number. Stats weeks start on Monday. */
export const mondayOf = (n: number): number => n - ((weekdayOf(n) + 6) % 7);

/** Calendar parts of a day number: full year, month 0 to 11, day of month. */
export function partsOf(n: number): { y: number; m: number; d: number } {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/** Day number of a calendar date (month 0 to 11; overflow rolls over like Date). */
export const dayOfDate = (y: number, m: number, d: number): number => Math.round(Date.UTC(y, m, d) / 86_400_000);
