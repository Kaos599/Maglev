/**
 * Last-known Transfers list (docs/UI_SPEC_PHASE2.md S10.3). Written while the
 * app runs and read at boot so the list paints before the engine answers.
 * Only facts the engine reported are stored; speeds and peers are never cached.
 */
import type { TorrentState, TorrentTelemetry, PausedBy } from 'maglev-engine';
import { kvGet, kvSet } from './prefs/kv';

export interface CachedTorrent {
  id: string;
  name: string;
  state: TorrentState;
  pausedBy: PausedBy | null;
  progressPercent: number;
  downloadedBytes: number;
  uploadedBytes: number;
  totalSizeBytes: number;
  ratio: number;
  finished: boolean;
  addedAt: number | null;
}

const KEY = 'maglev.transfers.cache.v1';
const STATES: readonly string[] = ['INITIALIZING', 'QUEUED', 'DOWNLOADING', 'SEEDING', 'PAUSED', 'CHECKING', 'ERROR', 'COMPLETED', 'MOVING'];

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export function toCached(t: TorrentTelemetry): CachedTorrent {
  return {
    id: t.id,
    name: t.name,
    state: t.state,
    pausedBy: t.pausedBy ?? null,
    progressPercent: t.progressPercent,
    downloadedBytes: t.downloadedBytes,
    uploadedBytes: t.uploadedBytes,
    totalSizeBytes: t.totalSizeBytes,
    ratio: t.ratio,
    finished: t.finished === true,
    addedAt: t.addedAt ?? null,
  };
}

export function parseCache(raw: string | null): CachedTorrent[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: CachedTorrent[] = [];
    const seen = new Set<string>();
    for (const e of arr) {
      if (!e || typeof e.id !== 'string' || !e.id || seen.has(e.id) || typeof e.name !== 'string' || !STATES.includes(e.state)) continue;
      seen.add(e.id);
      out.push({
        id: e.id,
        name: e.name,
        state: e.state,
        pausedBy: typeof e.pausedBy === 'string' ? e.pausedBy : null,
        progressPercent: Math.min(100, num(e.progressPercent)),
        downloadedBytes: num(e.downloadedBytes),
        uploadedBytes: num(e.uploadedBytes),
        totalSizeBytes: num(e.totalSizeBytes),
        ratio: num(e.ratio),
        finished: e.finished === true,
        addedAt: typeof e.addedAt === 'number' ? e.addedAt : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** A cached row as a telemetry row. Rates are zero and the time left is unknown. */
export function fromCached(c: CachedTorrent): TorrentTelemetry {
  return {
    id: c.id,
    name: c.name,
    state: c.state,
    pausedBy: c.pausedBy,
    finished: c.finished,
    downloadSpeedBytes: 0,
    uploadSpeedBytes: 0,
    progressPercent: c.progressPercent,
    downloadedBytes: c.downloadedBytes,
    uploadedBytes: c.uploadedBytes,
    totalSizeBytes: c.totalSizeBytes,
    etaSeconds: -1,
    peersConnected: 0,
    peersTotal: 0,
    seedsConnected: 0,
    ratio: c.ratio,
    addedAt: c.addedAt ?? undefined,
  };
}

export function loadTransferCache(): CachedTorrent[] {
  return parseCache(kvGet(KEY));
}

/**
 * The saved list, or null when no list was ever saved (first launch, or the cache is unreadable).
 * A saved empty list is `[]`: the engine had no torrents last time, which is a fact worth showing.
 */
export function readTransferCache(): CachedTorrent[] | null {
  const raw = kvGet(KEY);
  if (raw === null) return null;
  try {
    if (!Array.isArray(JSON.parse(raw))) return null;
  } catch {
    return null;
  }
  return parseCache(raw);
}

export function saveTransferCache(list: readonly TorrentTelemetry[]): void {
  try {
    kvSet(KEY, JSON.stringify(list.map(toCached)));
  } catch {
    // the cache is an optimisation only
  }
}
