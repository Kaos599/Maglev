/**
 * What a download card says and offers, per state (STATE_MACHINES_AND_SCREENS SM-30 "Copy").
 * Pure: no React, so `scripts/test-url-download.js` runs it directly.
 */
import type { DownloadSnapshot } from 'maglev-engine';
import { formatBytes, formatCompactAmount, formatSpeed } from '../constants/format.ts';
import { formatEta, smoothRate } from './rates.ts';
import { doneLead } from './stats/format.ts';
import { reasonFor, wifiOverrideAllowed, type BlockContext } from './blocks/reasons.ts';
import { QUIET_MS } from '../components/transfers/flowClock.ts';

export type DownloadTone = 'muted' | 'accent' | 'danger' | 'download';
export type DownloadActionKind =
  | 'pause'
  | 'resume'
  | 'resumeAnyway'
  | 'retry'
  | 'restart'
  | 'newLink'
  | 'allowDevice'
  | 'remove'
  | 'open'
  | 'pickFolder'
  | 'openNetworkSettings'
  | 'freeSpace';

export interface DownloadAction {
  kind: DownloadActionKind;
  /** Icon name from the generated Pixelarticons set. */
  icon: 'pause' | 'play' | 'retry' | 'link' | 'trash' | 'folder' | 'settings' | 'external';
  label: string;
  /** The settings screen a settings action opens, when it is not the default for its kind. */
  route?: string;
}

/** The card line: short, so the percent and amount stay readable. */
const FOLDER_GONE_CARD = 'Folder not available';
const FOLDER_GONE_TEXT = "The folder isn't available. Is the SD card in?";
const TOO_BIG_TEXT = "This file is bigger than the card's format allows (4 GB). Use phone storage.";
const LOCAL_BLOCKED_TEXT = 'A redirect tried to send Maglev to a device on your network, so it stopped.';
const LAN_ADDRESS_TEXT = 'This address points to a device on your network.';
const LAN_ADDRESS_BODY = "If it's your own server, allow this device. Only do this for devices you trust.";
const POLICY_BLOCKED_TEXT = 'Blocked by your Wi-Fi-only or VPN setting.';
const PERMISSION_TEXT = "Maglev can't write to that folder.";
export const WIFI_ANYWAY_NOTE = 'Just this one. Wi-Fi only stays on.';
const NOT_A_FILE_BODY =
  'This is a web page, not a file. On the page, long-press the download button, tap Copy link address, then paste it here.';
const STALLED_TEXT = 'Waiting for the server';
const CONNECTING_SERVER_TEXT = 'Connecting to the server';
const STALLED_ERROR_TEXT = 'The server stopped sending data.';
const AUTH_REQUIRED_TEXT = 'This link needs you to sign in again. Paste the link again.';
const NO_APP_TEXT = 'No app on this phone can open this file.';
const PROBE_BLOCKED_BODY =
  'Your network settings block downloads right now. Open settings to change that, or add it anyway and it starts when downloads are allowed.';
const AUTH_BODY =
  'This site wants you to sign in. Sign in on the site in your browser, copy the download link again, and paste it here.';
/** A 403 with no sign-in details (NATIVE_CONTRACT 17, LINK_REFUSED): the site refused the link itself. */
const LINK_REFUSED_TEXT = 'The site refused this link. Open its page again, then retry.';
const LINK_REFUSED_PROBE_BODY =
  "The site refused this link. Open the page in Maglev's browser and start the download from there, or paste a fresh link.";

/** The phone has no usable network (Kotlin's `offline` block, NATIVE_CONTRACT 35.4). */
function isOffline(ctx: BlockContext): boolean {
  return !!ctx.blocks?.some((b) => b.tag === 'offline');
}

/** Reasons the engine clears by itself. The card offers no Resume for them. */
export function isGovernancePause(pausedBy: string | null | undefined): boolean {
  return !!pausedBy && pausedBy !== 'user' && pausedBy !== 'storage_full' && pausedBy !== 'storage_unavailable';
}

type ErrorKind =
  | 'fileChanged'
  | 'notAFile'
  | 'checksum'
  | 'permission'
  | 'folderGone'
  | 'tooBig'
  | 'localBlocked'
  | 'lanAddress'
  | 'policyBlocked'
  | 'httpGone'
  | 'authRequired'
  | 'linkRefused'
  | 'stalled'
  | 'network'
  | 'other';

/** True for a 4xx that a second try will not change (not "request timeout" or "too many requests"). */
function isFinal4xx(status: number | null | undefined): boolean {
  const st = status ?? 0;
  return st >= 400 && st < 500 && st !== 408 && st !== 429;
}

/** Sorts an engine error code into what the card does about it. Unknown codes land in `other`. */
function errorKind(code: string | undefined, httpStatus?: number | null): ErrorKind {
  const c = (code ?? '').toUpperCase();
  if (c === 'FILE_CHANGED') return 'fileChanged';
  if (c === 'NOT_A_FILE') return 'notAFile';
  if (c === 'CHECKSUM_MISMATCH') return 'checksum';
  if (c === 'PERMISSION' || c === 'EACCES') return 'permission';
  if (c === 'HTTP_STATUS') return isFinal4xx(httpStatus) ? 'httpGone' : 'network';
  if (c === 'NETWORK') return 'network';
  // Exact codes from native/maglev-core (http_dl, NATIVE_CONTRACT §17).
  if (c === 'FILE_TOO_LARGE') return 'tooBig';
  if (c === 'STORAGE_UNAVAILABLE') return 'folderGone';
  if (c === 'LOCAL_REDIRECT') return 'localBlocked';
  if (c === 'LAN_ADDRESS') return 'lanAddress';
  if (c === 'BLOCKED') return 'policyBlocked';
  if (c === 'AUTH_REQUIRED') return 'authRequired';
  if (c === 'LINK_REFUSED') return 'linkRefused';
  if (c === 'STALLED') return 'stalled';
  return 'other';
}

/** True when the server has not said how big the file is, so a percentage would be a guess. */
export function isSizeUnknown(d: DownloadSnapshot): boolean {
  return d.state !== 'finished' && (!d.size || d.size <= 0);
}

/** Bar mode: indeterminate while resolving, finishing, or downloading a file of unknown size. */
export function isIndeterminate(d: DownloadSnapshot): boolean {
  return d.state === 'resolving' || d.state === 'verifying' || (d.state === 'downloading' && isSizeUnknown(d));
}

/** Screen-reader progress: a percentage when the size is known, bytes received when it is not. */
export function downloadProgressLabel(d: DownloadSnapshot): string {
  // A finished file is known by its size, or by the bytes it has when the server never said.
  if (d.state === 'finished') {
    const known = d.size && d.size > 0 ? d.size : d.downloaded;
    return known > 0 ? `done, ${formatBytes(known)}` : 'done';
  }
  if (isSizeUnknown(d)) return d.downloaded > 0 ? `${formatBytes(d.downloaded)} so far` : 'size unknown';
  return `${Math.round(downloadProgress(d) * 100)} percent`;
}

/** 0 to 1. Unknown size reads as 0; check `isSizeUnknown` and show an indeterminate bar instead. */
export function downloadProgress(d: DownloadSnapshot): number {
  if (d.state === 'finished') return 1;
  if (!d.size || d.size <= 0) return 0;
  return Math.min(1, Math.max(0, d.downloaded / d.size));
}

export type DownloadSlot = 'speed' | 'size' | 'amount';

/** One status line, same rule as a torrent card: left is one phrase then the percent, right is one value. */
export interface DownloadStatus {
  /** Whole status for screen readers, with the amount the card may not show. */
  text: string;
  /** Left phrase: time left, "Downloading", a pause reason, an error. Ellipsizes. */
  lead: string;
  /** Percent after the phrase ("34%"), shown as its own non-shrinking text. Absent when done or unknown. */
  pct?: string;
  /** Right side: speed while data flows, else the amount, else the size, else "—". */
  value?: string;
  /** While data flows: the amount, drawn in the normal telemetry colour before the speed in `value` (NATIVE_CONTRACT 43.3). */
  amount?: string;
  slot?: DownloadSlot;
  tone: DownloadTone;
}

function mk(lead: string, tone: DownloadTone, pct: number | null, value?: string, slot?: DownloadSlot, extra?: string | null, amount?: string, spokenAmount?: string): DownloadStatus {
  const left = pct == null ? lead : `${lead} · ${pct}%`;
  const head = [left, amount ? spokenAmount ?? amount : null, value].filter(Boolean).join(' · ');
  return { text: extra ? `${head}. ${extra}` : head, lead, pct: pct == null ? undefined : `${pct}%`, value, amount, slot, tone };
}

/** What a downloading link is doing, for the card and the page. Same words as `torrentSituation`. */
export type LinkSituation = 'flowing' | 'connecting' | 'waiting' | 'quiet';

/**
 * NATIVE_CONTRACT 43.3. Waiting: the engine's `stalled` flag, or some downloaded and no data for QUIET_MS.
 * Connecting: nothing downloaded and not flowing. Null when the download is not downloading.
 */
export function linkSituation(
  d: Pick<DownloadSnapshot, 'state' | 'downBps' | 'downloaded' | 'stalled'>,
  opts: { speedHold?: boolean; quietMs?: number } = {},
): LinkSituation | null {
  if (d.state !== 'downloading') return null;
  if (d.stalled) return 'waiting';
  if (d.downBps > 0 || opts.speedHold) return 'flowing';
  if (!(d.downloaded > 0)) return 'connecting';
  return (opts.quietMs ?? 0) >= QUIET_MS ? 'waiting' : 'quiet';
}

/** Whole percent, or null when the size is unknown. */
function wholePercent(d: DownloadSnapshot): number | null {
  if (!(d.size && d.size > 0)) return null;
  // Only done items say 100%, and they show no percent at all.
  return Math.min(99, Math.round(downloadProgress(d) * 100));
}

/** Percent once something has arrived and the size is known. */
function startedPct(d: DownloadSnapshot): number | null {
  return d.downloaded > 0 ? wholePercent(d) : null;
}

/** "412 MB of 1.2 GB" once something has arrived (just "412 MB" with no known size), else the size, else "—". */
function amountOrSize(d: DownloadSnapshot, shortOpt: boolean | ((fullChars: number) => boolean) = false, extraChars = 0, compact = false): { value: string; slot: DownloadSlot; full?: string } {
  if (d.size && d.size > 0) {
    const size = `${d.stream ? '~' : ''}${formatBytes(d.size)}`;
    if (d.downloaded <= 0) return { value: size, slot: 'size' };
    const full = `${formatBytes(d.downloaded)} of ${size}`;
    // `extraChars` is what sits beside the amount on the right (" · 8.4 MB/s"), so the narrow-card test sees the whole text.
    const short = typeof shortOpt === 'function' ? shortOpt(full.length + extraChars) : shortOpt;
    if (!short) return { value: full, slot: 'amount' };
    // NATIVE_CONTRACT 45.2 (and 43.3): while data flows, "134/587 MB" first; the amount alone only when that does not fit either.
    if (compact) {
      const text = formatCompactAmount(d.downloaded, d.size, d.stream ? '~' : '');
      if (typeof shortOpt === 'function' && !shortOpt(text.length + extraChars)) return { value: text, slot: 'amount', full };
    }
    return { value: formatBytes(d.downloaded), slot: 'amount', full };
  }
  // Unknown total: only what has arrived.
  return d.downloaded > 0 ? { value: formatBytes(d.downloaded), slot: 'amount' } : { value: '—', slot: 'size' };
}

/** The status under the bar. `etaLabel` is the stable label from `formatEta`. */
export function downloadStatus(
  d: DownloadSnapshot,
  etaLabel?: string,
  ctx: BlockContext = {},
  opts: { speedHold?: boolean; shortAmount?: boolean | ((fullChars: number) => boolean); quietMs?: number } = {},
): DownloadStatus {
  const right = amountOrSize(d, opts.shortAmount);
  const held = (lead: string, tone: DownloadTone, note?: string) => mk(lead, tone, startedPct(d), right.value, right.slot, [right.full, note].filter(Boolean).join('. ') || null);
  switch (d.state) {
    case 'resolving':
      return mk('Getting info', 'muted', null, '—', 'size');
    case 'queued':
      return held(reasonFor('queued', ctx)!.short, 'muted');
    case 'downloading': {
      const situation = linkSituation(d, opts);
      // No network: say so rather than blame the server. Data that still arrives wins (the tag can lag the network).
      if (situation !== 'flowing' && isOffline(ctx)) return held(reasonFor('offline')!.short, 'muted');
      if (situation === 'waiting') return held(STALLED_TEXT, 'muted');
      if (situation === 'connecting') return mk(CONNECTING_SERVER_TEXT, 'muted', null, right.value, right.slot, right.full);
      const flowing = situation === 'flowing';
      const eta = etaLabel ?? formatEta(d.eta, null);
      const hasEta = !isSizeUnknown(d) && d.eta >= 0 && eta !== '—';
      const lead = hasEta ? `${eta} left` : 'Downloading';
      const pct = hasEta || flowing ? wholePercent(d) : startedPct(d);
      if (flowing) {
        // Right side: the amount in the telemetry colour, then the speed (NATIVE_CONTRACT 43.3).
        const speed = d.downBps > 0 ? formatSpeed(d.downBps) : '—';
        const amt = amountOrSize(d, opts.shortAmount, speed.length + 3, true);
        const full = amountOrSize(d);
        const hasAmount = amt.slot === 'amount';
        return mk(lead, 'download', pct, speed, 'speed', null, hasAmount ? amt.value : undefined, hasAmount ? full.value : undefined);
      }
      return mk(lead, 'download', pct, right.value, right.slot, right.full);
    }
    case 'paused': {
      // Same as a torrent: danger, with the card's button ("Free up space") as the way out (docs/contracts-0.19/play-and-storage.md section 2).
      if (d.pausedBy === 'storage_full') return held(reasonFor('storage_full')!.short, 'danger');
      if (d.pausedBy === 'storage_unavailable') return held(FOLDER_GONE_CARD, 'danger', FOLDER_GONE_TEXT);
      return held(reasonFor(d.pausedBy, ctx)?.short ?? 'Paused', 'muted');
    }
    case 'verifying':
      return mk('Finishing', 'muted', null, d.size && d.size > 0 ? formatBytes(d.size) : '—', 'size');
    case 'finished':
      return d.size ? mk(doneLead(d.activeSecs, d.finishedAt), 'accent', null, formatBytes(d.size), 'size') : mk(doneLead(d.activeSecs, d.finishedAt), 'accent', null);
    case 'needs_link':
      return held(
        d.error?.code === 'AUTH_REQUIRED'
          ? 'Needs sign-in · Paste new link'
          : d.error?.code === 'LINK_REFUSED'
            ? 'Site refused · Paste new link'
            : 'Link expired · Paste new link',
        'danger',
      );
    case 'error':
      // The folder message is long; the card says it short and the full text stays for screen readers and the sheet.
      if (errorKind(d.error?.code, d.error?.httpStatus) === 'folderGone') return held(FOLDER_GONE_CARD, 'danger', FOLDER_GONE_TEXT);
      return held(errorLine(d), 'danger');
    default:
      return mk('Getting info', 'muted', null, '—', 'size');
  }
}

/**
 * Total speed of the running link downloads, each smoothed like a torrent's (utils/rates smoothRate)
 * so the header does not jump. `memo` carries each row's last value and is pruned of rows that left.
 */
export function smoothDownloadsSpeed(
  list: readonly DownloadSnapshot[],
  memo: Map<string, { down: number; up: number; at: number }>,
  now: number,
): number {
  let total = 0;
  const live = new Set<string>();
  for (const d of list) {
    if (d.state !== 'downloading') continue;
    live.add(d.id);
    const prev = memo.get(d.id);
    const sd = smoothRate(prev ? prev.down : null, d.downBps, prev ? now - prev.at : 0);
    memo.set(d.id, { down: sd, up: 0, at: now });
    total += sd;
  }
  for (const id of [...memo.keys()]) if (!live.has(id)) memo.delete(id);
  return total;
}

function errorLine(d: DownloadSnapshot): string {
  switch (errorKind(d.error?.code, d.error?.httpStatus)) {
    case 'fileChanged':
      return 'The file changed on the server · Restart';
    case 'notAFile':
      return 'This link opens a web page, not a file';
    case 'checksum':
      return "File doesn't match the checksum";
    case 'permission':
      return PERMISSION_TEXT;
    case 'folderGone':
      return FOLDER_GONE_TEXT;
    case 'tooBig':
      return TOO_BIG_TEXT;
    case 'localBlocked':
      return LOCAL_BLOCKED_TEXT;
    case 'lanAddress':
      return LAN_ADDRESS_TEXT;
    case 'policyBlocked':
      return POLICY_BLOCKED_TEXT;
    case 'authRequired':
      return AUTH_REQUIRED_TEXT;
    case 'linkRefused':
      return LINK_REFUSED_TEXT;
    case 'stalled':
      return STALLED_ERROR_TEXT;
    default:
      return d.error?.message || 'Something went wrong';
  }
}

/** A longer line the sheet shows (the card line is one row and may be cut). Null when there is none. */
export function downloadCaption(d: DownloadSnapshot, ctx: BlockContext = {}): string | null {
  if (d.state === 'downloading' && d.stalled) {
    if (!isOffline(ctx)) return STALLED_TEXT;
    const r = reasonFor('offline')!;
    return `${r.title}. ${r.body}`;
  }
  if (d.state === 'paused' && d.pausedBy === 'storage_unavailable') return FOLDER_GONE_TEXT;
  if (d.state === 'needs_link' && d.error?.code === 'AUTH_REQUIRED') return AUTH_BODY;
  if (d.state === 'needs_link' && d.error?.code === 'LINK_REFUSED') return LINK_REFUSED_TEXT;
  if (d.state === 'error') {
    const k = errorKind(d.error?.code, d.error?.httpStatus);
    if (k === 'lanAddress') return `${LAN_ADDRESS_TEXT} ${LAN_ADDRESS_BODY}`;
    if (k === 'notAFile') return NOT_A_FILE_BODY;
    if (k === 'permission' || k === 'folderGone' || k === 'tooBig' || k === 'localBlocked' || k === 'policyBlocked' || k === 'authRequired' || k === 'linkRefused' || k === 'stalled') return errorLine(d);
  }
  return null;
}

const A = {
  pause: { kind: 'pause', icon: 'pause', label: 'Pause' },
  resume: { kind: 'resume', icon: 'play', label: 'Resume' },
  resumeAnyway: { kind: 'resumeAnyway', icon: 'play', label: 'Resume anyway' },
  resumeMobile: { kind: 'resumeAnyway', icon: 'play', label: 'Download now on mobile data' },
  retry: { kind: 'retry', icon: 'retry', label: 'Retry' },
  restart: { kind: 'restart', icon: 'retry', label: 'Restart' },
  allowDevice: { kind: 'allowDevice', icon: 'link', label: 'Allow this device' },
  open: { kind: 'open', icon: 'external', label: 'Open' },
  newLink: { kind: 'newLink', icon: 'link', label: 'Paste new link' },
  remove: { kind: 'remove', icon: 'trash', label: 'Remove' },
  pickFolder: { kind: 'pickFolder', icon: 'folder', label: 'Pick folder again' },
  openSettings: { kind: 'openNetworkSettings', icon: 'settings', label: 'Open settings' },
  freeSpace: { kind: 'freeSpace', icon: 'trash', label: 'Free up space' },
} as const satisfies Record<string, DownloadAction>;

/** Every action that makes sense now, the most useful first. The card shows the first; the sheet shows all. */
export function downloadActions(d: DownloadSnapshot, ctx: BlockContext = {}): DownloadAction[] {
  switch (d.state) {
    case 'downloading':
    case 'queued':
      return [A.pause];
    case 'paused': {
      if (d.pausedBy === 'storage_unavailable') return [A.pickFolder];
      if (d.pausedBy === 'storage_full') return [A.freeSpace];
      if (d.pausedBy === 'fgs_timeout') return [A.resume];
      if (isGovernancePause(d.pausedBy)) {
        // The table decides: a rule that allows an override offers it, then the setting that holds it (NATIVE_CONTRACT 35.2).
        const reason = reasonFor(d.pausedBy, ctx);
        const out: DownloadAction[] = [];
        if (reason?.override && (d.pausedBy !== 'wifi_only' || wifiOverrideAllowed(ctx?.blocks))) out.push(d.pausedBy === 'wifi_only' ? A.resumeMobile : A.resumeAnyway);
        if (reason?.setting) out.push({ kind: 'openNetworkSettings', icon: 'settings', label: 'Change in Settings', route: reason.setting.route });
        return out;
      }
      return [A.resume];
    }
    case 'needs_link':
      return [A.newLink];
    case 'finished':
      return [A.open];
    case 'error':
      switch (errorKind(d.error?.code, d.error?.httpStatus)) {
        case 'fileChanged':
          return [A.restart];
        // These will not change on a second try, so no Retry.
        case 'notAFile':
        case 'checksum':
        case 'localBlocked':
        case 'httpGone':
          return [A.remove];
        case 'authRequired':
        case 'linkRefused':
          return [A.newLink];
        case 'lanAddress':
          return [A.allowDevice, A.remove];
        case 'permission':
          return [A.pickFolder, A.retry];
        case 'folderGone':
        case 'tooBig':
          return [A.pickFolder];
        case 'policyBlocked':
          return [A.openSettings, A.retry];
        default:
          return [A.retry];
      }
    default:
      return [];
  }
}

/** True when the sheet should ask for a new link (the link expired, or the site wants a sign-in again). */
export function needsNewLink(d: DownloadSnapshot): boolean {
  return d.state === 'needs_link' || (d.state === 'error' && ['authRequired', 'linkRefused'].includes(errorKind(d.error?.code, d.error?.httpStatus)));
}

/** What to tell the user when "Allow this device" fails. */
export function allowDeviceFailureText(code: string | undefined, message?: string): string {
  const c = (code ?? '').toUpperCase();
  if (c === 'NETWORK') return "Couldn't find that device. Check the address and your connection.";
  if (c === 'INVALID_STATE') return "This download doesn't need that anymore.";
  return message || "Couldn't allow that device.";
}

/** What to tell the user when Open fails. */
export function openFailureText(code: string | undefined, message?: string): string {
  if ((code ?? '').toUpperCase() === 'NO_APP') return NO_APP_TEXT;
  return message || "Couldn't open that file.";
}

/** The card's one button, or null when nothing can be done now. */
export function downloadAction(d: DownloadSnapshot, ctx: BlockContext = {}): DownloadAction | null {
  return downloadActions(d, ctx)[0] ?? null;
}

/** Where the settings-style actions go. Null for the ones the engine or the sheet handles. */
export function actionRoute(kind: DownloadActionKind, route?: string | null): string | null {
  if (kind === 'pickFolder') return '/settings/storage';
  if (kind === 'openNetworkSettings') return route || '/settings/network';
  if (kind === 'freeSpace') return '/free-space';
  return null;
}

/** What the add screen says when checking a link fails, and what its main button does. */
export function probeErrorView(
  code: string | undefined,
  message: string | undefined,
  httpStatus?: number | null,
): { body: string; primary: 'pasteAnother' | 'retry' | 'blocked' | 'allowDevice' } {
  const k = (code ?? '').toUpperCase();
  // Trying again fails the same way; the user can change the setting or add it now and let it wait.
  if (k === 'LAN_ADDRESS') return { body: `${LAN_ADDRESS_TEXT} ${LAN_ADDRESS_BODY}`, primary: 'allowDevice' };
  if (k === 'BLOCKED') return { body: PROBE_BLOCKED_BODY, primary: 'blocked' };
  if (k === 'NOT_A_FILE') return { body: NOT_A_FILE_BODY, primary: 'pasteAnother' };
  if (k === 'AUTH_REQUIRED') return { body: AUTH_BODY, primary: 'pasteAnother' };
  if (k === 'LINK_REFUSED') return { body: LINK_REFUSED_PROBE_BODY, primary: 'pasteAnother' };
  const body = message || 'Something went wrong.';
  // A missing file will not appear on a second try; a network drop or a busy server might.
  if (k === 'HTTP_STATUS' && isFinal4xx(httpStatus)) return { body, primary: 'pasteAnother' };
  return { body, primary: 'retry' };
}

/** Sheet copy for removing a download. A finished one can keep its file; an unfinished one has only a partial file. */
export function removeCopy(d: DownloadSnapshot): { keepLabel: string; deleteLabel: string; subtitle: string } {
  if (d.state === 'finished') {
    return {
      keepLabel: 'Remove (keep file)',
      deleteLabel: 'Remove and delete file',
      subtitle: 'The file can stay on your device or be deleted too.',
    };
  }
  return {
    keepLabel: 'Remove (keep partial file)',
    deleteLabel: 'Remove and delete partial file',
    subtitle: 'The part that was downloaded can stay on your device or be deleted too.',
  };
}

/** What to tell the user when no file manager opens the folder. */
export const OPEN_FOLDER_FAILED_TEXT = "Couldn't open the folder.";

/** What to tell the user when the share sheet can't open for a finished download. */
export const SHARE_FAILED_TEXT = "Couldn't share this file.";

/** NATIVE_CONTRACT 40.2: what the page says when a tap copies the link. */
export const LINK_COPIED_TEXT = 'Link copied';
/** NATIVE_CONTRACT 40.2: the one-line hint under the progress card while a download that can't resume is running. */
export const CANT_RESUME_HINT = "This server can't resume. Pausing starts over.";

/**
 * NATIVE_CONTRACT 40.2: the "Why it stopped" block of a download that needs a new link. The title is short; the text is the
 * existing sign-in copy, or the engine's own message when it gave one.
 */
export function linkProblem(d: DownloadSnapshot): { title: string; body: string } {
  if (d.error?.code === 'AUTH_REQUIRED') return { title: 'Needs sign-in', body: AUTH_BODY };
  if (d.error?.code === 'LINK_REFUSED') return { title: 'Site refused', body: LINK_REFUSED_TEXT };
  return { title: 'Link expired', body: d.error?.message || 'The server no longer accepts this link.' };
}

/** The host of a download's address and nothing after it: never the path, a query or anything more (40.2 Source). */
export function sourceHost(urlDisplay: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(urlDisplay.trim());
  const host = m ? m[1] : urlDisplay.trim().split(/[/?#]/)[0];
  return host.replace(/^[^@]*@/, '');
}

// ---- NATIVE_CONTRACT 43.4 / 43.5: "Why it hasn't started" and "Why it stopped" ----

export const whyCopy = {
  connectingTitle: "Why it hasn't started",
  waitingTitle: 'Why it stopped',
  torrentConnecting: 'Maglev knows who has this and is connecting to them. Popular torrents usually start within a minute.',
  torrentNoPeers: 'No one sharing this has been found yet. Maglev keeps asking trackers and other peers.',
  torrentWaiting: (quiet: string) => `No data for ${quiet}. The peers it had stopped sending. Maglev keeps looking.`,
  stopsWaiting: (limit: string) => ` After ${limit} with no one sharing, it stops waiting.`,
  /** 45.1: a torrent that has no file list yet. */
  resolvingSentence: "Maglev needs this torrent's file list from someone who has it.",
  resolvingNoPeers: ' No one sharing it has been found yet.',
  resolvingAsking: (n: number) => ` Asking the ${n} it found.`,
  askTrackers: 'Ask trackers again',
  askedWait: (secs: number) => `Asked · try again in ${secs} s`,
  linkConnecting: (host: string) => `Waiting for ${host} to send the file.`,
  linkWaiting: (host: string) => `${host} stopped sending. Maglev retries by itself.`,
  none: ', none sending',
  labels: { found: 'Peers found', connected: 'Connected', trackers: 'Trackers replied', trying: 'Trying for', lastData: 'Last data', server: 'Server' },
} as const;

/** The block's content. The screen draws it; `askTrackers` says whether the "Ask trackers again" button belongs. */
export interface WhyModel {
  kind: 'connecting' | 'waiting' | 'resolving';
  title: string;
  sentence: string;
  /** A second, muted line (the link page's "can't resume" hint). */
  note?: string;
  stats: { label: string; value: string }[];
  askTrackers: boolean;
}

/** "12 s", "4 min", "1 h 5 min": a span in plain words. */
export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const rest = m % 60;
  return rest ? `${Math.floor(m / 60)} h ${rest} min` : `${Math.floor(m / 60)} h`;
}

/** "m:ss". */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The "Stop waiting for peers after" setting as words ("10 min", "1 hour"), or null when it is Never. */
export function peerLimitText(mins: number): string | null {
  if (!(mins > 0)) return null;
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return `${h} ${h === 1 ? 'hour' : 'hours'}`;
}

export interface TorrentWhyInput {
  situation: 'connecting' | 'waiting';
  peersTotal: number;
  peersConnected: number;
  trackers: readonly { status: string }[];
  peers: readonly { downBps: number }[];
  quietMs: number;
  /** Ms since data last arrived, or null when not seen this session. */
  lastDataAgoMs: number | null;
  /** "Stop waiting for peers after", minutes. 0 = never. */
  peerTimeoutMins: number;
}

/** 43.4: the torrent page's block. */
export function torrentWhy(i: TorrentWhyInput): WhyModel {
  const L = whyCopy.labels;
  if (i.situation === 'connecting') {
    const stats: { label: string; value: string }[] = [
      { label: L.found, value: String(i.peersTotal) },
      { label: L.connected, value: String(i.peersConnected) },
    ];
    if (i.trackers.length > 0) stats.push({ label: L.trackers, value: `${i.trackers.filter((t) => t.status === 'working').length} of ${i.trackers.length}` });
    stats.push({ label: L.trying, value: formatClock(i.quietMs) });
    return {
      kind: 'connecting',
      title: whyCopy.connectingTitle,
      sentence: i.peersTotal === 0 ? whyCopy.torrentNoPeers : whyCopy.torrentConnecting,
      stats,
      askTrackers: true,
    };
  }
  const limit = peerLimitText(i.peerTimeoutMins);
  const sending = i.peers.some((p) => p.downBps > 0);
  return {
    kind: 'waiting',
    title: whyCopy.waitingTitle,
    sentence: whyCopy.torrentWaiting(formatSpan(i.quietMs)) + (limit ? whyCopy.stopsWaiting(limit) : ''),
    stats: [
      { label: L.found, value: String(i.peersTotal) },
      { label: L.connected, value: `${i.peersConnected}${sending ? '' : whyCopy.none}` },
      { label: L.lastData, value: i.lastDataAgoMs == null ? '—' : `${formatSpan(i.lastDataAgoMs)} ago` },
    ],
    askTrackers: true,
  };
}

export interface TorrentResolvingWhyInput {
  peersTotal: number;
  trackers: readonly { status: string }[];
  /** Whole seconds the engine has been looking for the file list. */
  resolvingSecs: number;
}

/**
 * 45.1: the block for a torrent in INITIALIZING (no file list yet). No button: the engine refuses `reannounce`
 * until the torrent is downloading or seeding (engine.rs `reannounce`, UNSUPPORTED), so offering it would only fail.
 */
export function torrentResolvingWhy(i: TorrentResolvingWhyInput): WhyModel {
  const L = whyCopy.labels;
  const stats: { label: string; value: string }[] = [{ label: L.found, value: String(i.peersTotal) }];
  if (i.trackers.length > 0) stats.push({ label: L.trackers, value: `${i.trackers.filter((t) => t.status === 'working').length} of ${i.trackers.length}` });
  stats.push({ label: L.trying, value: formatClock(i.resolvingSecs * 1000) });
  return {
    kind: 'resolving',
    title: whyCopy.connectingTitle,
    sentence: whyCopy.resolvingSentence + (i.peersTotal > 0 ? whyCopy.resolvingAsking(i.peersTotal) : whyCopy.resolvingNoPeers),
    stats,
    askTrackers: false,
  };
}

export interface LinkWhyInput {
  situation: 'connecting' | 'waiting';
  host: string;
  resumable: boolean;
  quietMs: number;
  lastDataAgoMs: number | null;
}

/** 43.5: the link page's block. No button. */
export function linkWhy(i: LinkWhyInput): WhyModel {
  const L = whyCopy.labels;
  if (i.situation === 'connecting') {
    return {
      kind: 'connecting',
      title: whyCopy.connectingTitle,
      sentence: whyCopy.linkConnecting(i.host),
      stats: [{ label: L.server, value: i.host }, { label: L.trying, value: formatClock(i.quietMs) }],
      askTrackers: false,
    };
  }
  return {
    kind: 'waiting',
    title: whyCopy.waitingTitle,
    sentence: whyCopy.linkWaiting(i.host),
    note: i.resumable ? undefined : CANT_RESUME_HINT,
    stats: [{ label: L.server, value: i.host }, { label: L.lastData, value: i.lastDataAgoMs == null ? '—' : `${formatSpan(i.lastDataAgoMs)} ago` }],
    askTrackers: false,
  };
}
