/**
 * Stats store over an injected database (docs/NATIVE_CONTRACT.md section 34.2). No React and no native imports.
 */
import { type StatsDb } from './schema.ts';
import { dayKey } from './time.ts';
import type { DailyRow, DayCounts, MonthlyRow, StatsRecord } from './types.ts';
import type { StatsPrefs } from './prefs.ts';

const RETENTION_MONTHS = 24;
const CHUNK = 300;

type RecRow = {
  id: string; kind: string; name: string; size: number; category: string | null; source: string | null;
  active_secs: number; session_bytes: number; uploaded: number; bytes_wifi: number; bytes_mobile: number;
  added_at: number; finished_at: number; retries: number;
};
type DayRow = { day: string; downloaded: number; uploaded: number; mobile: number; wifi: number; finished: number; failed: number; cancelled: number; active_secs?: number };
type MonRow = { month: string; downloaded: number; uploaded: number; wifi: number; mobile: number; finished: number; active_secs: number; retried: number };

const toRecord = (r: RecRow): StatsRecord => ({
  id: String(r.id), kind: r.kind as StatsRecord['kind'], name: String(r.name ?? ''), size: Number(r.size),
  category: r.category ?? null, source: r.source ?? null, activeSecs: Number(r.active_secs), sessionBytes: Number(r.session_bytes),
  uploaded: Number(r.uploaded), bytesWifi: Number(r.bytes_wifi), bytesMobile: Number(r.bytes_mobile),
  addedAt: Number(r.added_at), finishedAt: Number(r.finished_at), retries: Number(r.retries),
});
const toDaily = (r: DayRow): DailyRow => ({
  day: String(r.day), downloaded: Number(r.downloaded), uploaded: Number(r.uploaded), mobile: Number(r.mobile),
  wifi: Number(r.wifi), finished: Number(r.finished), failed: Number(r.failed), cancelled: Number(r.cancelled), activeSecs: Number(r.active_secs ?? 0),
});
const toMonthly = (r: MonRow): MonthlyRow => ({
  month: String(r.month), downloaded: Number(r.downloaded), uploaded: Number(r.uploaded), wifi: Number(r.wifi),
  mobile: Number(r.mobile), finished: Number(r.finished), activeSecs: Number(r.active_secs), retried: Number(r.retried),
});

export interface StatsSection {
  v: 1;
  records: StatsRecord[];
  daily: DailyRow[];
  monthly: MonthlyRow[];
}

export function createStatsStore(db: StatsDb, _prefs: () => StatsPrefs) {
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = () => {
    version++;
    listeners.forEach((l) => l());
  };

  async function addDaily(day: string, d: Partial<DayCounts>): Promise<void> {
    const v = { downloaded: 0, uploaded: 0, mobile: 0, wifi: 0, finished: 0, failed: 0, cancelled: 0, activeSecs: 0, ...d };
    await db.run(
      `INSERT INTO stats_daily (day, downloaded, uploaded, mobile, wifi, finished, failed, cancelled, active_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET downloaded = downloaded + excluded.downloaded, uploaded = uploaded + excluded.uploaded,
         mobile = mobile + excluded.mobile, wifi = wifi + excluded.wifi, finished = finished + excluded.finished,
         failed = failed + excluded.failed, cancelled = cancelled + excluded.cancelled, active_secs = active_secs + excluded.active_secs`,
      [day, v.downloaded, v.uploaded, v.mobile, v.wifi, v.finished, v.failed, v.cancelled, Math.max(0, Math.floor(v.activeSecs))],
    );
    notify();
  }

  /** Inserts the record once per id. Returns true when it was new (and counted in that day's finished). */
  async function recordFinished(r: StatsRecord, tz?: number): Promise<boolean> {
    const res = await db.run(
      `INSERT OR IGNORE INTO stats (id, kind, name, size, category, source, active_secs, session_bytes, uploaded, bytes_wifi, bytes_mobile, added_at, finished_at, retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.kind, r.name, r.size, r.category, r.source, r.activeSecs, r.sessionBytes, r.uploaded, r.bytesWifi, r.bytesMobile, r.addedAt, r.finishedAt, r.retries],
    );
    if (res.changes === 0) return false;
    await addDaily(dayKey(r.finishedAt * 1000, tz), { finished: 1 });
    return true;
  }

  const listRecords = async (): Promise<StatsRecord[]> => (await db.all<RecRow>('SELECT * FROM stats ORDER BY finished_at, id')).map(toRecord);
  const listDaily = async (): Promise<DailyRow[]> => (await db.all<DayRow>('SELECT * FROM stats_daily ORDER BY day')).map(toDaily);
  const listMonthly = async (): Promise<MonthlyRow[]> => (await db.all<MonRow>('SELECT * FROM stats_monthly ORDER BY month')).map(toMonthly);

  /** Folds detailed records older than 24 months into stats_monthly. Returns how many were folded. */
  async function foldOld(now: number, tz?: number): Promise<number> {
    const cut = new Date(now);
    cut.setUTCMonth(cut.getUTCMonth() - RETENTION_MONTHS);
    const cutoff = Math.floor(cut.getTime() / 1000);
    const old = (await db.all<RecRow>('SELECT * FROM stats WHERE finished_at < ? ORDER BY finished_at', [cutoff])).map(toRecord);
    if (old.length === 0) return 0;
    const months = new Map<string, MonthlyRow>();
    for (const r of old) {
      const month = dayKey(r.finishedAt * 1000, tz).slice(0, 7);
      const m = months.get(month) ?? { month, downloaded: 0, uploaded: 0, wifi: 0, mobile: 0, finished: 0, activeSecs: 0, retried: 0 };
      m.downloaded += r.sessionBytes;
      m.uploaded += r.uploaded;
      m.wifi += r.bytesWifi;
      m.mobile += r.bytesMobile;
      m.finished += 1;
      m.activeSecs += r.activeSecs;
      if (r.retries > 0) m.retried += 1;
      months.set(month, m);
    }
    await db.exec('BEGIN');
    try {
      for (const m of months.values()) {
        await db.run(
          `INSERT INTO stats_monthly (month, downloaded, uploaded, wifi, mobile, finished, active_secs, retried) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(month) DO UPDATE SET downloaded = downloaded + excluded.downloaded, uploaded = uploaded + excluded.uploaded,
             wifi = wifi + excluded.wifi, mobile = mobile + excluded.mobile, finished = finished + excluded.finished,
             active_secs = active_secs + excluded.active_secs, retried = retried + excluded.retried`,
          [m.month, m.downloaded, m.uploaded, m.wifi, m.mobile, m.finished, m.activeSecs, m.retried],
        );
      }
      for (let i = 0; i < old.length; i += CHUNK) {
        const ids = old.slice(i, i + CHUNK).map((r) => r.id);
        await db.run(`DELETE FROM stats WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      }
      await db.exec('COMMIT');
    } catch (e) {
      try {
        await db.exec('ROLLBACK');
      } catch {
        // nothing to roll back
      }
      throw e;
    }
    notify();
    return old.length;
  }

  async function reset(): Promise<void> {
    for (const t of ['stats', 'stats_daily', 'stats_monthly']) await db.run(`DELETE FROM ${t}`);
    notify();
  }

  async function exportSection(): Promise<StatsSection> {
    return { v: 1, records: await listRecords(), daily: await listDaily(), monthly: await listMonthly() };
  }

  /** Adds what this phone does not have. Existing records, days and months are never changed. */
  async function importSection(s: StatsSection): Promise<{ records: number; daily: number; monthly: number }> {
    const out = { records: 0, daily: 0, monthly: 0 };
    for (const r of s.records) {
      const res = await db.run(
        `INSERT OR IGNORE INTO stats (id, kind, name, size, category, source, active_secs, session_bytes, uploaded, bytes_wifi, bytes_mobile, added_at, finished_at, retries)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.id, r.kind, r.name, r.size, r.category, r.source, r.activeSecs, r.sessionBytes, r.uploaded, r.bytesWifi, r.bytesMobile, r.addedAt, r.finishedAt, r.retries],
      );
      out.records += res.changes;
    }
    for (const d of s.daily) {
      const res = await db.run(
        'INSERT OR IGNORE INTO stats_daily (day, downloaded, uploaded, mobile, wifi, finished, failed, cancelled, active_secs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [d.day, d.downloaded, d.uploaded, d.mobile, d.wifi, d.finished, d.failed, d.cancelled, d.activeSecs ?? 0],
      );
      out.daily += res.changes;
    }
    for (const m of s.monthly) {
      const res = await db.run(
        'INSERT OR IGNORE INTO stats_monthly (month, downloaded, uploaded, wifi, mobile, finished, active_secs, retried) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [m.month, m.downloaded, m.uploaded, m.wifi, m.mobile, m.finished, m.activeSecs, m.retried],
      );
      out.monthly += res.changes;
    }
    notify();
    return out;
  }

  return {
    addDaily,
    recordFinished,
    listRecords,
    listDaily,
    listMonthly,
    foldOld,
    reset,
    exportSection,
    importSection,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getVersion: () => version,
  };
}

export type StatsStore = ReturnType<typeof createStatsStore>;
