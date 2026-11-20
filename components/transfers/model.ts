import type { DownloadSnapshot, TorrentTelemetry } from 'maglev-engine';
import type { SortKey, TransferSort } from '../../utils/prefs/transfers';
import { formatBytes, formatCompactAmount, formatSpeed } from '../../constants/format.ts';
import { resolvingLine } from '../detail/fileHealthMachine.ts';
import { reasonFor, wifiOverrideAllowed, type BlockContext } from '../../utils/blocks/reasons.ts';
import { downloadProgress } from '../../utils/downloadCopy.ts';
import { doneLead } from '../../utils/stats/format.ts';
import { QUIET_MS } from './flowClock.ts';

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

export type StatusTone = 'muted' | 'accent' | 'danger' | 'download';
export type StatusSlot = 'speed' | 'upload' | 'size' | 'amount';

/**
 * One status line (owner rule 2026-11-18). Left: one phrase for what is happening ("12 min left", "Downloading",
 * "Paused", "Checking files") and, last, the percent while the file is not done. Never an amount, never a trailing "…".
 * Right: exactly one value, in order: speed while data flows, else the amount ("320 MB of 2.1 GB"), else the size, else "—".
 */
export interface TorrentStatus {
  /** Whole status for screen readers, with the amount the card may not show. */
  text: string;
  /** Left phrase. Ellipsizes when long. */
  lead: string;
  /** Percent shown after the phrase ("15%"). Its own non-shrinking text, so it stays visible. Absent when done or unknown. */
  pct?: string;
  /** Right side, a number in a fixed-width slot (speed, amount or size). */
  value?: string;
  /** While data flows: the amount ("320 MB of 2.1 GB"), drawn in the normal telemetry colour before the speed in `value`. */
  amount?: string;
  slot?: StatusSlot;
  tone: StatusTone;
}

type StatusRow = Pick<
  TorrentTelemetry,
  | 'state' | 'pausedBy' | 'error' | 'downloadSpeedBytes' | 'uploadSpeedBytes' | 'downloadedBytes' | 'totalSizeBytes'
  | 'includedBytes' | 'progressPercent' | 'etaSeconds' | 'moveProgress' | 'resolvingSecs' | 'peersTotal'
> & Partial<Pick<TorrentTelemetry, 'activeSecs' | 'finishedAt' | 'finished' | 'health'>> & { lastKnown?: boolean };

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

/** Every byte of the target is here (NATIVE_CONTRACT 47.3). The engine's `finished` flag counts too. */
function isFinished(t: Pick<TorrentTelemetry, 'includedBytes' | 'totalSizeBytes' | 'downloadedBytes'> & { finished?: boolean }): boolean {
  const target = targetBytes(t);
  return t.finished === true || (target > 0 && t.downloadedBytes >= target);
}

/**
 * Whole percent, or null when the size is unknown. An unfinished torrent never rounds up to 100 (cap 99);
 * one the engine says is finished is 100 (NATIVE_CONTRACT 47.3), and the card shows no percent for it.
 */
function wholePercent(t: Pick<TorrentTelemetry, 'includedBytes' | 'totalSizeBytes' | 'downloadedBytes' | 'progressPercent'> & { finished?: boolean }): number | null {
  if (!(targetBytes(t) > 0)) return null;
  // Only the engine's own finished flag says 100. Full bytes alone can be the last second before it flips.
  if (t.finished === true) return 100;
  return Math.min(99, Math.round(torrentProgressPercent(t)));
}

/** The card line for a hold: the table's short line, or plain "Paused". */
function pausedReason(pausedBy: string | null | undefined, ctx: BlockContext): string {
  return reasonFor(pausedBy, ctx)?.short ?? 'Paused';
}

/** Percent once something has downloaded and the size is known. */
function startedPct(t: StatusRow): number | null {
  return t.downloadedBytes > 0 ? wholePercent(t) : null;
}

/** Presentation choices the card makes: the speed hold (see speedHold.ts) and a large font. */
export interface StatusOpts {
  /** Data flowed within the last few seconds: keep the speed slot even at 0. */
  speedHold?: boolean;
  /** The amount shortens to what is downloaded. A function gets the full amount's length, for a narrow card. */
  shortAmount?: boolean | ((fullChars: number) => boolean);
  /** NATIVE_CONTRACT 43.1: how long the current run of 0 speed has lasted (ms), from the flow clock. */
  quietMs?: number;
}

/**
 * Right side when no data flows: the amount once something has downloaded, else the size, else "—".
 * An unknown total shows only what is downloaded. `full` is the longer amount when `short` cut it.
 */
function amountOrSize(t: StatusRow, shortOpt: StatusOpts['shortAmount'] = false, extraChars = 0, compact = false): { value: string; slot: StatusSlot; full?: string } {
  const target = targetBytes(t);
  if (t.downloadedBytes > 0 && target > 0) {
    const full = `${formatBytes(t.downloadedBytes)} of ${formatBytes(target)}`;
    // `extraChars` is what sits beside the amount on the right (" · 2.1 MB/s"), so the narrow-card test sees the whole text.
    const short = typeof shortOpt === 'function' ? shortOpt(full.length + extraChars) : shortOpt;
    if (!short) return { value: full, slot: 'amount' };
    // NATIVE_CONTRACT 45.2: while data flows, "134/587 MB" first; the amount alone only when that does not fit either.
    if (compact) {
      const text = formatCompactAmount(t.downloadedBytes, target);
      if (typeof shortOpt === 'function' && !shortOpt(text.length + extraChars)) return { value: text, slot: 'amount', full };
    }
    return { value: formatBytes(t.downloadedBytes), slot: 'amount', full };
  }
  if (t.downloadedBytes > 0) return { value: formatBytes(t.downloadedBytes), slot: 'amount' };
  return { value: t.totalSizeBytes > 0 ? formatBytes(t.totalSizeBytes) : '—', slot: 'size' };
}

function line(lead: string, tone: StatusTone, pct: number | null, value?: string, slot?: StatusSlot, extra?: string | null, amount?: string, spokenAmount?: string): TorrentStatus {
  const left = pct == null ? lead : `${lead} · ${pct}%`;
  const head = [left, amount ? spokenAmount ?? amount : null, value].filter(Boolean).join(' · ');
  return { text: extra ? `${head}. ${extra}` : head, lead, pct: pct == null ? undefined : `${pct}%`, value, amount, slot, tone };
}

const CONNECTING_TEXT = 'Connecting to peers';
const WAITING_TEXT = 'Waiting for peers';

/** What a downloading torrent is doing, for the card and the page: data flowing, connecting, waiting, or neither yet. */
export type TorrentSituation = 'flowing' | 'connecting' | 'waiting' | 'quiet';

/**
 * NATIVE_CONTRACT 43.2. Flowing: speed above 0 or inside the 5 s hold. Connecting: nothing downloaded and not flowing.
 * Waiting: some downloaded and no data for QUIET_MS. Quiet: some downloaded, no data for less than QUIET_MS.
 * Null when the torrent is not downloading, the numbers are the saved ones, or the offline block already says why.
 */
export function torrentSituation(
  t: Pick<TorrentTelemetry, 'state' | 'downloadSpeedBytes' | 'downloadedBytes'> & { lastKnown?: boolean },
  opts: Pick<StatusOpts, 'speedHold' | 'quietMs'> = {},
  ctx: BlockContext = {},
): TorrentSituation | null {
  if (t.state !== 'DOWNLOADING' || t.lastKnown) return null;
  if (ctx.blocks?.some((b) => b.tag === 'offline')) return null;
  if (t.downloadSpeedBytes > 0 || opts.speedHold) return 'flowing';
  if (!(t.downloadedBytes > 0)) return 'connecting';
  return (opts.quietMs ?? 0) >= QUIET_MS ? 'waiting' : 'quiet';
}

/** The status under the bar. `etaLabel` is the hysteresis-stable time left. */
export function torrentStatus(t: StatusRow, etaLabel: string, ctx: BlockContext = {}, opts: StatusOpts = {}): TorrentStatus {
  const total = t.totalSizeBytes > 0 ? formatBytes(t.totalSizeBytes) : '—';
  const right = amountOrSize(t, opts.shortAmount);
  const held = (lead: string, tone: StatusTone) => line(lead, tone, startedPct(t), right.value, right.slot, right.full);
  switch (t.state) {
    case 'DOWNLOADING': {
      // Torrents never carry `offline`: the engine's block list is how a stalled torrent says why (NATIVE_CONTRACT 35.4).
      if (!t.lastKnown && ctx.blocks?.some((b) => b.tag === 'offline')) return held(reasonFor('offline')!.short, 'muted');
      const situation = torrentSituation(t, opts, ctx);
      const flowing = situation === 'flowing';
      if (situation === 'connecting') {
        const lead = t.peersTotal > 0 ? `${CONNECTING_TEXT} · ${t.peersTotal} found` : CONNECTING_TEXT;
        return line(lead, 'muted', null, right.value, right.slot, right.full);
      }
      if (situation === 'waiting') return line(WAITING_TEXT, 'muted', startedPct(t), right.value, right.slot, right.full);
      const hasEta = !t.lastKnown && t.etaSeconds >= 0 && etaLabel !== '—';
      const pct = hasEta || flowing ? wholePercent(t) : startedPct(t);
      const lead = hasEta ? `${etaLabel} left` : 'Downloading';
      if (flowing) {
        // Right side: the amount in the telemetry colour, then the speed (NATIVE_CONTRACT 43.2).
        const speed = t.downloadSpeedBytes > 0 ? formatSpeed(t.downloadSpeedBytes) : '—';
        const amt = amountOrSize(t, opts.shortAmount, speed.length + 3, true);
        const full = amountOrSize(t);
        const hasAmount = amt.slot === 'amount';
        return line(lead, 'download', pct, speed, 'speed', null, hasAmount ? amt.value : undefined, hasAmount ? full.value : undefined);
      }
      return line(lead, 'download', pct, right.value, right.slot, right.full);
    }
    case 'SEEDING':
      return line('Done · Seeding', 'accent', null, `↑ ${t.lastKnown ? '—' : formatSpeed(t.uploadSpeedBytes)}`, 'upload');
    case 'PAUSED':
      if (t.pausedBy === 'seed_metered') return line(`Done · ${pausedReason(t.pausedBy, ctx)}`, 'accent', null, total, 'size');
      if (t.pausedBy === 'seed_limit') return line(doneLead(t.activeSecs, t.finishedAt), 'accent', null, total, 'size');
      // NATIVE_CONTRACT 47.3: a finished torrent never reads 99%. "Done · {reason}", no percent, the size on the right.
      if (t.pausedBy !== 'storage_full' && isFinished(t)) {
        const fileTag = t.health === 'files_changed' || t.health === 'files_missing' ? t.health : null;
        return line(`Done · ${pausedReason(fileTag ?? t.pausedBy, ctx)}`, 'muted', null, total, 'size');
      }
      // Storage full: the card's button ("Free up space") is the way out (docs/contracts-0.19/play-and-storage.md section 2).
      if (t.pausedBy === 'storage_full') return held(pausedReason(t.pausedBy, ctx), 'danger');
      return held(pausedReason(t.pausedBy, ctx), 'muted');
    case 'COMPLETED':
      return line(doneLead(t.activeSecs, t.finishedAt), 'accent', null, total, 'size');
    case 'MOVING':
      return line('Moving files', 'accent', t.moveProgress != null ? Math.round(t.moveProgress * 100) : null, total, 'size');
    case 'ERROR':
      return held(t.error?.message ? t.error.message : 'Something went wrong', 'danger');
    case 'QUEUED':
      return held(reasonFor('queued', ctx)!.short, 'muted');
    case 'CHECKING':
      return line('Checking files', 'muted', t.progressPercent > 0 ? Math.min(99, Math.round(t.progressPercent)) : null, total, 'size');
    case 'INITIALIZING':
      if (t.resolvingSecs != null) return line(resolvingLine(t.peersTotal, t.resolvingSecs).replace(/…$/, ''), 'muted', null, '—', 'size');
      return line('Getting info', 'muted', null, '—', 'size');
    default:
      return line('Getting info', 'muted', null, '—', 'size');
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

/** Whether one tap may override the rule for this torrent only. The table decides (NATIVE_CONTRACT 35.2). */
export function canResumeAnyway(pausedBy: string | null | undefined, ctx: BlockContext = {}): boolean {
  if (pausedBy === 'wifi_only' && !wifiOverrideAllowed(ctx.blocks)) return false;
  return !!reasonFor(pausedBy, ctx)?.override;
}

/** Wi-Fi only is the one with a different name: it means "use mobile data now". */
export function resumeAnywayLabel(pausedBy: string | null | undefined): string {
  return pausedBy === 'wifi_only' ? 'Download now on mobile data' : 'Resume anyway';
}

// ---- Torrent card button ----

/** Holds with no Resume: the rule would pause the torrent again at once. */
const GOVERNANCE_HOLDS: ReadonlySet<string> = new Set(['wifi_only', 'vpn_required', 'network_unvalidated', 'seed_metered']);

export type TorrentCardActionKind = 'pause' | 'resume' | 'keepTrying' | 'open' | 'resumeAnyway' | 'freeSpace' | 'setting';
export interface TorrentCardAction {
  icon: 'pause' | 'play' | 'retry' | 'external' | 'speed-limit' | 'trash' | 'settings';
  label: string;
  kind: TorrentCardActionKind;
  /** The settings screen a `setting` action opens. */
  route?: string;
}

/** True when a file health tag holds the torrent (`files_changed` or `files_missing`). Resume is not offered; Recheck on the page is. */
export function isHeldByFiles(t: { pausedBy?: string | null; health?: string | null }): boolean {
  const tags = ['files_changed', 'files_missing'];
  return (!!t.health && tags.includes(t.health)) || (!!t.pausedBy && tags.includes(t.pausedBy));
}

/** The card's one button, or null when nothing can be done from the list. */
export function torrentCardAction(t: Pick<TorrentTelemetry, 'state' | 'pausedBy'> & Partial<Pick<TorrentTelemetry, 'health'>>, ctx: BlockContext = {}): TorrentCardAction | null {
  switch (t.state) {
    case 'DOWNLOADING':
    case 'SEEDING':
      return { icon: 'pause', label: 'Pause', kind: 'pause' };
    case 'PAUSED': {
      const by = t.pausedBy;
      // NATIVE_CONTRACT 47.4: a file health tag needs Recheck, never Resume, even when the user paused it first.
      if (isHeldByFiles(t)) return null;
      if (by === 'no_peers') return { icon: 'retry', label: 'Keep trying', kind: 'keepTrying' };
      // Finished by the seed limit: the button opens the file. Seed again lives in the detail screen.
      if (by === 'seed_limit') return { icon: 'external', label: 'Open', kind: 'open' };
      // Storage full: the card's button opens the list of finished downloads to remove (play-and-storage section 3).
      if (by === 'storage_full') return { icon: 'trash', label: 'Free up space', kind: 'freeSpace' };
      if (by === 'files_missing' || by === 'files_changed' || by === 'storage_unavailable') return null;
      if (canResumeAnyway(by, ctx)) return { icon: 'play', label: resumeAnywayLabel(by), kind: 'resumeAnyway' };
      // Android stopped the app in the background: a plain Resume starts it again.
      if (by === 'fgs_timeout') return { icon: 'play', label: 'Resume', kind: 'resume' };
      // A rule that Resume would only trip again: the card points at the setting that holds it, or waits for it to clear.
      if (by && GOVERNANCE_HOLDS.has(by)) {
        const setting = reasonFor(by, ctx)?.setting;
        return setting ? { icon: 'settings', label: 'Change in Settings', kind: 'setting', route: setting.route } : null;
      }
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
