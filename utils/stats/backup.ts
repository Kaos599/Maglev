/**
 * Stats in a backup file: an optional section, only when the user ticks it (docs/NATIVE_CONTRACT.md section 34.2).
 * Pure. Reading is strict: anything that is not a well-formed row is dropped.
 */
import { isPlainObject } from '../backup/format.ts';
import type { DailyRow, MonthlyRow, StatsRecord } from './types.ts';
import type { StatsSection } from './store.ts';

export type { StatsSection } from './store.ts';

export function buildStatsSection(rows: { records: readonly StatsRecord[]; daily: readonly DailyRow[]; monthly: readonly MonthlyRow[] }): StatsSection {
  return { v: 1, records: rows.records.map((r) => ({ ...r })), daily: rows.daily.map((d) => ({ ...d })), monthly: rows.monthly.map((m) => ({ ...m })) };
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const KINDS = new Set(['torrent', 'link', 'stream']);

function record(raw: unknown): StatsRecord | null {
  if (!isPlainObject(raw)) return null;
  const id = text(raw.id);
  const finishedAt = count(raw.finishedAt);
  if (!id || finishedAt === null || finishedAt === 0 || !KINDS.has(raw.kind as string)) return null;
  return {
    id, kind: raw.kind as StatsRecord['kind'], name: typeof raw.name === 'string' ? raw.name : '', size: count(raw.size) ?? 0,
    category: text(raw.category), source: text(raw.source), activeSecs: count(raw.activeSecs) ?? 0, sessionBytes: count(raw.sessionBytes) ?? 0,
    uploaded: count(raw.uploaded) ?? 0, bytesWifi: count(raw.bytesWifi) ?? 0, bytesMobile: count(raw.bytesMobile) ?? 0,
    addedAt: count(raw.addedAt) ?? 0, finishedAt, retries: count(raw.retries) ?? 0,
  };
}

function daily(raw: unknown): DailyRow | null {
  if (!isPlainObject(raw)) return null;
  const day = text(raw.day);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    day, downloaded: count(raw.downloaded) ?? 0, uploaded: count(raw.uploaded) ?? 0, mobile: count(raw.mobile) ?? 0, wifi: count(raw.wifi) ?? 0,
    finished: count(raw.finished) ?? 0, failed: count(raw.failed) ?? 0, cancelled: count(raw.cancelled) ?? 0, activeSecs: count(raw.activeSecs) ?? 0,
  };
}

function monthly(raw: unknown): MonthlyRow | null {
  if (!isPlainObject(raw)) return null;
  const month = text(raw.month);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return null;
  return {
    month, downloaded: count(raw.downloaded) ?? 0, uploaded: count(raw.uploaded) ?? 0, wifi: count(raw.wifi) ?? 0, mobile: count(raw.mobile) ?? 0,
    finished: count(raw.finished) ?? 0, activeSecs: count(raw.activeSecs) ?? 0, retried: count(raw.retried) ?? 0,
  };
}

/** Null when the value is not a stats section this app can read (missing, or a newer version). */
export function parseStatsSection(raw: unknown): StatsSection | null {
  if (!isPlainObject(raw) || raw.v !== 1) return null;
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    v: 1,
    records: list(raw.records).flatMap((r) => record(r) ?? []),
    daily: list(raw.daily).flatMap((d) => daily(d) ?? []),
    monthly: list(raw.monthly).flatMap((m) => monthly(m) ?? []),
  };
}
