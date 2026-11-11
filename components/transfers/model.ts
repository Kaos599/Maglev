import type { TorrentTelemetry } from 'maglev-engine';
import type { SortKey, TransferSort } from '../../utils/prefs/transfers';

export type TransferFilter = 'all' | 'downloading' | 'seeding' | 'paused' | 'done' | 'errors';

export const FILTERS: readonly { id: TransferFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'downloading', label: 'Downloading' },
  { id: 'seeding', label: 'Seeding' },
  { id: 'paused', label: 'Paused' },
  { id: 'done', label: 'Done' },
  { id: 'errors', label: 'Errors' },
];

export const SORT_LABELS: Record<SortKey, string> = {
  name: 'Name',
  progress: 'Progress',
  downSpeed: 'Download speed',
  upSpeed: 'Upload speed',
  eta: 'ETA',
  size: 'Size',
  added: 'Date added',
  ratio: 'Ratio',
};

/** Paused with `seed_limit` means the torrent finished seeding, so it counts as Done. */
export function matchesFilter(t: TorrentTelemetry, f: TransferFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'downloading':
      return t.state === 'DOWNLOADING' || t.state === 'QUEUED' || t.state === 'INITIALIZING' || t.state === 'CHECKING';
    case 'seeding':
      return t.state === 'SEEDING';
    case 'paused':
      return t.state === 'PAUSED' && t.pausedBy !== 'seed_limit';
    case 'done':
      return t.state === 'COMPLETED' || (t.state === 'PAUSED' && t.pausedBy === 'seed_limit');
    case 'errors':
      return t.state === 'ERROR';
  }
}

export function countByFilter(list: readonly TorrentTelemetry[]): Record<TransferFilter, number> {
  const out: Record<TransferFilter, number> = { all: list.length, downloading: 0, seeding: 0, paused: 0, done: 0, errors: 0 };
  for (const t of list) {
    for (const f of FILTERS) if (f.id !== 'all' && matchesFilter(t, f.id)) out[f.id] += 1;
  }
  return out;
}

function value(t: TorrentTelemetry, key: SortKey): number {
  switch (key) {
    case 'progress':
      return t.progressPercent;
    case 'downSpeed':
      return t.downloadSpeedBytes;
    case 'upSpeed':
      return t.uploadSpeedBytes;
    case 'eta':
      // Unknown ETA sorts last in ascending order.
      return t.etaSeconds > 0 && Number.isFinite(t.etaSeconds) ? t.etaSeconds : Number.MAX_SAFE_INTEGER;
    case 'size':
      return t.totalSizeBytes;
    case 'added':
      return t.addedAt ?? 0;
    case 'ratio':
      return t.ratio;
    default:
      return 0;
  }
}

export function sortTorrents<T extends TorrentTelemetry>(list: readonly T[], sort: TransferSort): T[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    const cmp =
      sort.key === 'name'
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
        : value(a, sort.key) - value(b, sort.key);
    return cmp !== 0 ? cmp * mul : a.id.localeCompare(b.id);
  });
}

/** Lowercase info-hash of a magnet link, or null. */
export function magnetHash(magnet: string): string | null {
  const m = /xt=urn(?:%3A|:)btih(?:%3A|:)([a-zA-Z0-9]+)/i.exec(magnet);
  return m ? m[1].toLowerCase() : null;
}
