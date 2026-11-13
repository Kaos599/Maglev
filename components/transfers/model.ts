import type { DownloadSnapshot, TorrentTelemetry } from 'maglev-engine';
import type { SortKey, TransferSort } from '../../utils/prefs/transfers';
import { formatBytes, formatSpeed } from '../../constants/format.ts';
import { healthLabel, resolvingLine } from '../detail/fileHealthMachine.ts';
import { downloadProgress } from '../../utils/downloadCopy.ts';

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

/** Done means the files are all here: completed, seeding, finished seeding (`seed_limit`) or seeding that waits for Wi-Fi (`seed_metered`). */
export function matchesFilter(t: TorrentTelemetry, f: TransferFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'downloading':
      return t.state === 'DOWNLOADING' || t.state === 'QUEUED' || t.state === 'INITIALIZING' || t.state === 'CHECKING';
    case 'seeding':
      return t.state === 'SEEDING';
    case 'paused':
      return t.state === 'PAUSED' && t.pausedBy !== 'seed_limit' && t.pausedBy !== 'seed_metered';
    case 'done':
      return t.state === 'COMPLETED' || t.state === 'SEEDING' || (t.state === 'PAUSED' && (t.pausedBy === 'seed_limit' || t.pausedBy === 'seed_metered'));
    case 'errors':
      return t.state === 'ERROR';
  }
}

/** Link downloads in the matching state. There is no "seeding" for a link, and a link that needs a new link is an error. */
export function downloadMatchesFilter(d: DownloadSnapshot, f: TransferFilter): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'downloading':
      return d.state === 'resolving' || d.state === 'queued' || d.state === 'downloading' || d.state === 'verifying';
    case 'seeding':
      return false;
    case 'paused':
      return d.state === 'paused';
    case 'done':
      return d.state === 'finished';
    case 'errors':
      return d.state === 'error' || d.state === 'needs_link';
  }
}

/** Counts torrents and link downloads together, with the same rule as the list. */
export function countByFilter(
  list: readonly TorrentTelemetry[],
  downloads: readonly DownloadSnapshot[] = [],
): Record<TransferFilter, number> {
  const out: Record<TransferFilter, number> = { all: list.length + downloads.length, downloading: 0, seeding: 0, paused: 0, done: 0, errors: 0 };
  for (const t of list) {
    for (const f of FILTERS) if (f.id !== 'all' && matchesFilter(t, f.id)) out[f.id] += 1;
  }
  for (const d of downloads) {
    for (const f of FILTERS) if (f.id !== 'all' && downloadMatchesFilter(d, f.id)) out[f.id] += 1;
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

// ---- Card status line (TransferCard) ----

export type StatusTone = 'muted' | 'accent' | 'danger';
export type StatusSlot = 'speed' | 'upload' | 'size';

export interface TorrentStatus {
  /** Whole status for screen readers. */
  text: string;
  /** Left part of line one: what is happening ("1 min left", "Seeding", "Paused: waiting for Wi-Fi"). */
  lead: string;
  /** Right part of line one, a number in a fixed-width slot (speed or size). */
  value?: string;
  slot?: StatusSlot;
  /** Line two: how far it got ("412 MB of 1.2 GB · 34%"). Absent when there is nothing to say yet. */
  sub?: string;
  tone: StatusTone;
}

type StatusRow = Pick<
  TorrentTelemetry,
  | 'state' | 'pausedBy' | 'error' | 'downloadSpeedBytes' | 'uploadSpeedBytes' | 'downloadedBytes' | 'totalSizeBytes'
  | 'includedBytes' | 'progressPercent' | 'etaSeconds' | 'moveProgress' | 'resolvingSecs' | 'peersTotal'
> & { lastKnown?: boolean };

/** What the torrent is working toward: the files the user kept, or everything when none were deselected. */
function targetBytes(t: Pick<TorrentTelemetry, 'includedBytes' | 'totalSizeBytes'>): number {
  return t.includedBytes && t.includedBytes > 0 ? t.includedBytes : t.totalSizeBytes;
}

/** 0 to 100 against the files the user kept. Falls back to the engine's number when no size is known. */
export function torrentProgressPercent(t: Pick<TorrentTelemetry, 'includedBytes' | 'totalSizeBytes' | 'downloadedBytes' | 'progressPercent'>): number {
  const target = targetBytes(t);
  if (target > 0) return Math.min(100, Math.max(0, (t.downloadedBytes / target) * 100));
  return Math.min(100, Math.max(0, t.progressPercent || 0));
}

/** "412 MB of 1.2 GB · 34%", or null when the size is unknown. A percent never rounds up to 100 before it is done. */
export function torrentProgressText(t: Pick<TorrentTelemetry, 'includedBytes' | 'totalSizeBytes' | 'downloadedBytes' | 'progressPercent'>): string | null {
  const target = targetBytes(t);
  if (!(target > 0)) return null;
  const raw = torrentProgressPercent(t);
  const pct = raw >= 100 ? 100 : Math.min(99, Math.round(raw));
  return `${formatBytes(t.downloadedBytes)} of ${formatBytes(target)} · ${pct}%`;
}

function pausedReason(pausedBy: string | null | undefined): string {
  switch (pausedBy) {
    case 'wifi_only':
      return 'Paused: waiting for Wi-Fi';
    case 'battery':
      return 'Paused: battery is low';
    case 'charging_only':
      return 'Paused: waiting for charger';
    case 'fgs_timeout':
      return 'Paused: stopped in background';
    case 'schedule':
      return 'Paused: by schedule';
    default:
      return healthLabel(pausedBy) ?? 'Paused';
  }
}

function line(lead: string, tone: StatusTone, value?: string, slot?: StatusSlot, sub?: string | null): TorrentStatus {
  const head = value ? `${lead} · ${value}` : lead;
  return { text: sub ? `${head}. ${sub}` : head, lead, value, slot, sub: sub ?? undefined, tone };
}

/** The status under the bar. `etaLabel` is the hysteresis-stable time left. */
export function torrentStatus(t: StatusRow, etaLabel: string): TorrentStatus {
  const total = t.totalSizeBytes > 0 ? formatBytes(t.totalSizeBytes) : '—';
  const progress = torrentProgressText(t);
  const started = t.downloadedBytes > 0 ? progress : null;
  switch (t.state) {
    case 'DOWNLOADING': {
      const speed = t.lastKnown || t.downloadSpeedBytes <= 0 ? '—' : formatSpeed(t.downloadSpeedBytes);
      if (!t.lastKnown && t.etaSeconds >= 0 && etaLabel !== '—') return line(`${etaLabel} left`, 'muted', speed, 'speed', progress);
      return line('Downloading', 'muted', speed, 'speed', progress);
    }
    case 'SEEDING':
      return line('Done · Seeding', 'accent', `↑ ${t.lastKnown ? '—' : formatSpeed(t.uploadSpeedBytes)}`, 'upload');
    case 'PAUSED':
      if (t.pausedBy === 'seed_metered') return line('Done · Seeding waits for Wi-Fi', 'accent', total, 'size');
      if (t.pausedBy === 'seed_limit') return line('Done', 'accent', total, 'size');
      return line(pausedReason(t.pausedBy), 'muted', undefined, undefined, started);
    case 'COMPLETED':
      return line('Done', 'accent', total, 'size');
    case 'MOVING':
      return line(t.moveProgress != null ? `Moving files… ${Math.round(t.moveProgress * 100)}%` : 'Moving files…', 'accent');
    case 'ERROR':
      return line(t.error?.message ? t.error.message : 'Something went wrong', 'danger', undefined, undefined, started);
    case 'QUEUED':
      return line('Queued', 'muted', undefined, undefined, started);
    case 'CHECKING':
      return line('Checking files…', 'muted');
    case 'INITIALIZING':
      if (t.resolvingSecs != null) return line(resolvingLine(t.peersTotal, t.resolvingSecs), 'muted');
      return line('Getting info…', 'muted');
    default:
      return line('Getting info…', 'muted');
  }
}

/** Ids of everything that is done: completed, seeding and finished-seeding torrents, and finished link downloads. */
export function finishedTransfers(
  list: readonly TorrentTelemetry[],
  downloads: readonly DownloadSnapshot[] = [],
): { torrents: string[]; downloads: string[] } {
  return {
    torrents: list.filter((t) => matchesFilter(t, 'done')).map((t) => t.id),
    downloads: downloads.filter((d) => downloadMatchesFilter(d, 'done')).map((d) => d.id),
  };
}

/** Sheet copy for "Clear finished". Files always stay on the device. */
export function clearFinishedCopy(count: number): { title: string; body: string; confirm: string } {
  return {
    title: `Clear ${count} finished ${count === 1 ? 'transfer' : 'transfers'}?`,
    body: 'Anything still seeding stops. They leave this list. The files stay on your device.',
    confirm: 'Clear',
  };
}

// ---- Resume anyway ----

/** Pauses a rule caused. One tap can override them for this torrent only. */
const RULE_PAUSES: readonly string[] = ['wifi_only', 'battery', 'charging_only', 'schedule'];

export function canResumeAnyway(pausedBy: string | null | undefined): boolean {
  return !!pausedBy && RULE_PAUSES.includes(pausedBy);
}

/** Wi-Fi only is the one with a different name: it means "use mobile data now". */
export function resumeAnywayLabel(pausedBy: string | null | undefined): string {
  return pausedBy === 'wifi_only' ? 'Download now on mobile data' : 'Resume anyway';
}

// ---- Torrent card button ----

export type TorrentCardActionKind = 'pause' | 'resume' | 'keepTrying' | 'open' | 'resumeAnyway';
export interface TorrentCardAction {
  icon: 'pause' | 'play' | 'retry' | 'external' | 'speed-limit';
  label: string;
  kind: TorrentCardActionKind;
}

/** The card's one button, or null when nothing can be done from the list. */
export function torrentCardAction(t: Pick<TorrentTelemetry, 'state' | 'pausedBy'>): TorrentCardAction | null {
  switch (t.state) {
    case 'DOWNLOADING':
    case 'SEEDING':
      return { icon: 'pause', label: 'Pause', kind: 'pause' };
    case 'PAUSED': {
      const by = t.pausedBy;
      if (by === 'no_peers') return { icon: 'retry', label: 'Keep trying', kind: 'keepTrying' };
      // Finished by the seed limit: the button opens the file. Seed again lives in the detail screen.
      if (by === 'seed_limit') return { icon: 'external', label: 'Open', kind: 'open' };
      if (by === 'files_missing' || by === 'files_changed' || by === 'storage_full' || by === 'storage_unavailable') return null;
      if (canResumeAnyway(by)) return { icon: 'play', label: resumeAnywayLabel(by), kind: 'resumeAnyway' };
      // Waiting on something that clears by itself (or seeding that waits for Wi-Fi).
      if (by === 'fgs_timeout' || by === 'seed_metered') return null;
      return { icon: 'play', label: 'Resume', kind: 'resume' };
    }
    case 'ERROR':
      return { icon: 'retry', label: 'Retry', kind: 'resume' };
    default:
      return null;
  }
}

// ---- One list ----

export type TransferItem<T extends TorrentTelemetry = TorrentTelemetry> =
  | { kind: 'torrent'; key: string; torrent: T }
  | { kind: 'download'; key: string; download: DownloadSnapshot };

function downloadValue(d: DownloadSnapshot, key: SortKey): number {
  switch (key) {
    case 'progress':
      return downloadProgress(d) * 100;
    case 'downSpeed':
      return d.downBps;
    case 'upSpeed':
      return 0;
    case 'eta':
      return d.eta > 0 && Number.isFinite(d.eta) ? d.eta : Number.MAX_SAFE_INTEGER;
    case 'size':
      return d.size ?? 0;
    case 'added':
      return d.addedAt ?? 0;
    default:
      return 0;
  }
}

/** Torrents and link downloads in one list, ordered by the current sort. Keys are `t:<id>` and `d:<id>`. */
export function mergeTransfers<T extends TorrentTelemetry>(
  torrents: readonly T[],
  downloads: readonly DownloadSnapshot[],
  sort: TransferSort,
): TransferItem<T>[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  const items: TransferItem<T>[] = [
    ...torrents.map((torrent): TransferItem<T> => ({ kind: 'torrent', key: `t:${torrent.id}`, torrent })),
    ...downloads.map((download): TransferItem<T> => ({ kind: 'download', key: `d:${download.id}`, download })),
  ];
  const nameOf = (i: TransferItem<T>) => (i.kind === 'torrent' ? i.torrent.name : i.download.name);
  const valueOf = (i: TransferItem<T>) => (i.kind === 'torrent' ? value(i.torrent, sort.key) : downloadValue(i.download, sort.key));
  return items.sort((a, b) => {
    const cmp =
      sort.key === 'name'
        ? nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true })
        : valueOf(a) - valueOf(b);
    return cmp !== 0 ? cmp * mul : a.key.localeCompare(b.key);
  });
}
