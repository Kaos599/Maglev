/**
 * Free up space (docs/contracts-0.19/play-and-storage.md sections 2 and 3). Pure: no React, no react-native.
 * The reserve math mirrors native/maglev-core/src/storage_guard.rs and StorageGuard.kt (shared vectors).
 */

export const RESERVE_FLOOR_BYTES = 500 * 1024 * 1024;
export const RESERVE_HYSTERESIS_BYTES = 200 * 1024 * 1024;

/** `max(500 MiB, 2% of the volume)`. An unknown size (0) gives the floor. */
export function reserveBytes(total: number): number {
  return Math.max(RESERVE_FLOOR_BYTES, Math.floor(total / 50));
}

/** Not blocked: block under the reserve. Blocked: stay blocked until the reserve plus 200 MiB is free. */
export function nextBlocked(blocked: boolean, free: number, total: number): boolean {
  const r = reserveBytes(total);
  return blocked ? free < r + RESERVE_HYSTERESIS_BYTES : free < r;
}

export interface FinishedRow {
  key: string;
  kind: 'torrent' | 'download';
  id: string;
  name: string;
  /** Bytes the engine reported, or null when it did not. Never a made-up number. */
  size: number | null;
}

interface TorrentLike {
  id: string;
  name: string;
  state: string;
  finished?: boolean;
  includedBytes?: number;
  totalSizeBytes: number;
}
interface DownloadLike {
  id: string;
  name: string;
  state: string;
  size: number | null;
}

const known = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null);

/** Finished torrents and finished link downloads, largest first. Unknown sizes go last, by name. */
export function buildFinishedRows(torrents: readonly TorrentLike[], downloads: readonly DownloadLike[]): FinishedRow[] {
  const rows: FinishedRow[] = [];
  for (const t of torrents) {
    if (!(t.finished || t.state === 'COMPLETED' || t.state === 'SEEDING')) continue;
    rows.push({ key: `t:${t.id}`, kind: 'torrent', id: t.id, name: t.name, size: known(t.includedBytes) ?? known(t.totalSizeBytes) });
  }
  for (const d of downloads) {
    if (d.state !== 'finished') continue;
    rows.push({ key: `d:${d.id}`, kind: 'download', id: d.id, name: d.name, size: known(d.size) });
  }
  return rows.sort((a, b) => {
    if (a.size === null && b.size === null) return a.name.localeCompare(b.name);
    if (a.size === null) return 1;
    if (b.size === null) return -1;
    return b.size - a.size || a.name.localeCompare(b.name);
  });
}

/** Known bytes of the selected ids (a row's id; torrent and download ids never collide). */
export function selectedBytes(rows: readonly FinishedRow[], ids: ReadonlySet<string>): number {
  return rows.reduce((n, r) => (ids.has(r.id) ? n + (r.size ?? 0) : n), 0);
}

/** Free bytes writes can use (the smaller of the folder and a staged target), or null when the engine did not say. */
export function usableFree(fs: { freeBytes: number; targetFreeBytes?: number | null } | null | undefined): number | null {
  if (!fs || typeof fs.freeBytes !== 'number' || !Number.isFinite(fs.freeBytes) || fs.freeBytes < 0) return null;
  const t = fs.targetFreeBytes;
  return typeof t === 'number' && Number.isFinite(t) && t >= 0 ? Math.min(fs.freeBytes, t) : fs.freeBytes;
}
