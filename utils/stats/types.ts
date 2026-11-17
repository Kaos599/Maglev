/** Row shapes of the local stats tables (docs/NATIVE_CONTRACT.md section 34.2). Times are unix seconds, sizes are bytes. */

export type StatsKind = 'torrent' | 'link' | 'stream';

/** One finished item. Written once per id. */
export interface StatsRecord {
  id: string;
  kind: StatsKind;
  name: string;
  size: number;
  category: string | null;
  /** Search provider id, or 'link' | 'share' | 'feed' | 'watch'. Null when the add did not say. */
  source: string | null;
  activeSecs: number;
  sessionBytes: number;
  uploaded: number;
  bytesWifi: number;
  bytesMobile: number;
  addedAt: number;
  finishedAt: number;
  retries: number;
}

export interface DayCounts {
  downloaded: number;
  uploaded: number;
  mobile: number;
  wifi: number;
  finished: number;
  failed: number;
  cancelled: number;
  /** Seconds that day while anything was Downloading, wall-clock (NATIVE_CONTRACT 34.3, 0.27). Days before 0.27 read 0. */
  activeSecs: number;
}

/** `day` is the local calendar day, YYYY-MM-DD. */
export interface DailyRow extends DayCounts {
  day: string;
}

/** Detailed records older than 24 months, folded. `month` is YYYY-MM. */
export interface MonthlyRow {
  month: string;
  downloaded: number;
  uploaded: number;
  wifi: number;
  mobile: number;
  finished: number;
  activeSecs: number;
  retried: number;
}

export const zeroDay = (): DayCounts => ({ downloaded: 0, uploaded: 0, mobile: 0, wifi: 0, finished: 0, failed: 0, cancelled: 0, activeSecs: 0 });
