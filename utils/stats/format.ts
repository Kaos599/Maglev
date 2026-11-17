/**
 * Words and numbers for the Stats screen (docs/NATIVE_CONTRACT.md section 34.2). Pure. Sizes are binary (1 GB = 1024 MB),
 * the same as the rest of the app. Unknown stays unknown: callers show "—" for null.
 */
import { CATEGORY_LABELS, dayLabelOf, rangeHolds, shortDateOf, spanLabelOf, type Bucket, type StatsRange } from './insights.ts';
import { mondayOf, partsOf } from './time.ts';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

export interface Parts {
  n: string;
  unit: string;
}

/** "212 MB", "1.8 GB", "412 GB", "1.77 TB". */
export function sizeParts(bytes: number): Parts {
  const b = typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b >= TB) return { n: (b / TB).toFixed(2), unit: 'TB' };
  if (b >= 10 * GB) return { n: String(Math.round(b / GB)), unit: 'GB' };
  if (b >= GB) return { n: (b / GB).toFixed(1), unit: 'GB' };
  if (b >= MB) return { n: String(Math.round(b / MB)), unit: 'MB' };
  if (b >= KB) return { n: String(Math.round(b / KB)), unit: 'KB' };
  return { n: String(Math.round(b)), unit: 'B' };
}
export const fmtSize = (bytes: number): string => {
  const p = sizeParts(bytes);
  return `${p.n} ${p.unit}`;
};

/** Coarse time for totals: "42 s", "3 min", "2 h 5 min", "37 h". */
export function durationParts(secs: number): Parts[] {
  const s = Number.isFinite(secs) && secs > 0 ? secs : 0;
  if (s <= 0) return [{ n: '0', unit: 'min' }];
  if (s >= 36000) return [{ n: String(Math.round(s / 3600)), unit: 'h' }];
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? [{ n: String(h), unit: 'h' }, { n: String(m), unit: 'min' }] : [{ n: String(h), unit: 'h' }];
  }
  if (s >= 60) return [{ n: String(Math.round(s / 60)), unit: 'min' }];
  return [{ n: String(Math.round(s)), unit: 's' }];
}
export const fmtDuration = (secs: number): string => durationParts(secs).map((p) => `${p.n} ${p.unit}`).join(' ');

/** One download's time: "9 s", "2 min 41 s", "3 h 7 min". */
export function fmtTook(secs: number): string {
  const s = Math.max(0, Math.round(Number.isFinite(secs) ? secs : 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "13.9 MB/s"; under 1 MB/s, "412 KB/s". */
export function speedParts(bps: number): Parts {
  const b = Number.isFinite(bps) && bps > 0 ? bps : 0;
  if (b >= MB) return { n: (b / MB).toFixed(1), unit: 'MB/s' };
  return { n: String(Math.round(b / KB)), unit: 'KB/s' };
}
export const fmtSpeed = (bps: number): string => {
  const p = speedParts(bps);
  return `${p.n} ${p.unit}`;
};

export const fmtHour = (h: number): string => `${String(h).padStart(2, '0')}:00`;
export const fmtDays = (n: number): string => `${n} ${n === 1 ? 'day' : 'days'}`;
export const fmtCount = (n: number): string => Math.round(n).toLocaleString('en-US');
export const dayLabel = dayLabelOf;
export const shortDate = shortDateOf;
export const spanLabel = spanLabelOf;

/** One crate stands for this many finished downloads, so a picture never carries more than `cap` crates (24 by default). */
export function crateUnit(finished: number, cap = 24): number {
  return [1, 2, 5, 10, 20, 50, 100, 200, 500].find((n) => Math.ceil(finished / n) <= cap) ?? 1000;
}

/** The speedometer's top, in MB/s. */
export function gaugeMax(mbps: number): number {
  return [5, 10, 20, 40, 60, 100, 200].find((n) => mbps <= n) ?? 400;
}

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const weekName = (r: StatsRange, today: number): string => {
  const mon = mondayOf(today);
  if (r.start === mon) return 'This week';
  if (r.start === mon - 7) return 'Last week';
  return spanLabelOf(r.start, r.end);
};

/** The label between the range arrows: "2026", "November 2026", "This week", "Nov 2–8". */
export function rangeTitle(r: StatsRange, today: number): string {
  const p = partsOf(r.start);
  if (r.kind === 'year') return String(p.y);
  if (r.kind === 'month') return `${MONTH_FULL[p.m]} ${p.y}`;
  return weekName(r, today);
}

/** "this year", "in 2025", "this month", "in October", "in October 2025", "this week", "last week", "that week". */
export function periodPhrase(r: StatsRange, today: number): string {
  const now = rangeHolds(r, today);
  const p = partsOf(r.start);
  if (r.kind === 'year') return now ? 'this year' : `in ${p.y}`;
  if (r.kind === 'month') return now ? 'this month' : `in ${MONTH_FULL[p.m]}${p.y === partsOf(today).y ? '' : ` ${p.y}`}`;
  if (now) return 'this week';
  return r.start === mondayOf(today) - 7 ? 'last week' : 'that week';
}

/** The line under the big total. */
export function rangeCaption(r: StatsRange, today: number): string {
  const p = periodPhrase(r, today);
  return r.kind === 'week' && p === 'this week' ? 'downloaded this week so far' : `downloaded ${p}`;
}

/** The sheet's "Period" row: "November", "2026", "This week". */
export function periodName(r: StatsRange, today: number): string {
  const p = partsOf(r.start);
  if (r.kind === 'year') return String(p.y);
  if (r.kind === 'month') return `${MONTH_FULL[p.m]}${p.y === partsOf(today).y ? '' : ` ${p.y}`}`;
  return weekName(r, today);
}

export const categoryLabel = (key: string): string => CATEGORY_LABELS[key] ?? (key === 'other' ? 'Other' : 'Unsorted');

const SOURCE_WORDS: Record<string, string> = { link: 'links', share: 'shared to Maglev', feed: 'feeds', watch: 'watched pages', search: 'search' };
/** Where an item came from, in plain words. Every search provider reads "search". */
export const sourceLabel = (s: string): string => SOURCE_WORDS[s] ?? 'search';

/** The second line of the city readout. */
export function bucketReadout(b: Pick<Bucket, 'downloaded' | 'finished' | 'failed' | 'cancelled' | 'future'>): string {
  if (b.future) return 'Not here yet';
  if (!(b.downloaded > 0) && !(b.finished > 0)) return 'Nothing downloaded';
  const parts = [fmtSize(b.downloaded), `${b.finished} finished`];
  if (b.failed) parts.push(`${b.failed} failed`);
  if (b.cancelled) parts.push(`${b.cancelled} cancelled`);
  return parts.join(' · ');
}

/** A finished row's status lead: "Done in 2 min 41 s" when the engine timed it (NATIVE_CONTRACT 34.1), else "Done". */
export const doneLead = (activeSecs?: number, finishedAt?: number): string =>
  (finishedAt ?? 0) > 0 && (activeSecs ?? 0) > 0 ? `Done in ${fmtTook(activeSecs!)}` : 'Done';

/** "Today 14:05", "Yesterday 22:03", "Nov 14 22:03". `tz` minutes east of UTC; omitted means the phone's zone. */
export function whenLabel(unixSecs: number, nowMs: number, tz?: number): string {
  const ms = unixSecs * 1000;
  const off = (t: number) => (typeof tz === 'number' ? tz : -new Date(t).getTimezoneOffset()) * 60_000;
  const d = new Date(ms + off(ms));
  const day = Math.floor((ms + off(ms)) / 86_400_000);
  const today = Math.floor((nowMs + off(nowMs)) / 86_400_000);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (day === today) return `Today ${hm}`;
  if (day === today - 1) return `Yesterday ${hm}`;
  return `${shortDateOf(day)} ${hm}`;
}

export interface TimingInput {
  activeSecs?: number;
  finishedAt?: number;
  addedAt?: number;
  sessionBytes?: number;
  bytesWifi?: number;
  bytesMobile?: number;
  /** Torrents only. */
  seedingSecs?: number;
  uploaded?: number;
}

/**
 * What the detail screen's timing row and sheet show (NATIVE_CONTRACT 34.1). Null means unknown ("—"); an item from before
 * 0.26 has no timing at all. The two parts of the strip add up to the time from added to finished.
 */
export function timingView(t: TimingInput, nowMs: number, tz?: number) {
  const active = t.activeSecs ?? 0;
  const done = (t.finishedAt ?? 0) > 0;
  const known = active > 0 || done;
  const avg = active > 0 && (t.sessionBytes ?? 0) > 0 ? (t.sessionBytes ?? 0) / active : null;
  const span = done && (t.addedAt ?? 0) > 0 ? Math.max(active, t.finishedAt! - t.addedAt!) : null;
  const wifi = t.bytesWifi ?? 0;
  const mobile = t.bytesMobile ?? 0;
  return {
    known,
    tookLabel: done ? 'Took' : 'Downloading for',
    took: active > 0 ? fmtTook(active) : null,
    avg: avg != null ? fmtSpeed(avg) : null,
    added: (t.addedAt ?? 0) > 0 ? whenLabel(t.addedAt!, nowMs, tz) : null,
    finished: done ? whenLabel(t.finishedAt!, nowMs, tz) : null,
    span: span != null ? { total: span, downloading: active, waiting: Math.max(0, span - active) } : null,
    network: wifi + mobile > 0 ? { wifi, mobile } : null,
    seeding: (t.seedingSecs ?? 0) > 0 ? fmtTook(t.seedingSecs!) : null,
    uploaded: t.uploaded != null && t.uploaded > 0 ? fmtSize(t.uploaded) : null,
  };
}
