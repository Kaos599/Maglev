/**
 * What a download card says and offers, per state (STATE_MACHINES_AND_SCREENS SM-30 "Copy").
 * Pure: no React, so `scripts/test-url-download.js` runs it directly.
 */
import type { DownloadSnapshot } from 'maglev-engine';
import { formatBytes, formatSpeed } from '../constants/format.ts';
import { formatEta } from './rates.ts';

export type DownloadTone = 'muted' | 'accent' | 'danger';
export type DownloadActionKind =
  | 'pause'
  | 'resume'
  | 'retry'
  | 'restart'
  | 'newLink'
  | 'remove'
  | 'open'
  | 'pickFolder'
  | 'openNetworkSettings';

export interface DownloadAction {
  kind: DownloadActionKind;
  /** Icon name from the generated Pixelarticons set. */
  icon: 'pause' | 'play' | 'retry' | 'link' | 'trash' | 'folder' | 'settings' | 'external';
  label: string;
}

const GOVERNANCE_TEXT: Record<string, string> = {
  wifi_only: 'Paused: waiting for Wi-Fi',
  vpn_required: 'Paused: waiting for VPN',
  battery: 'Paused: battery is low',
  charging_only: 'Paused: waiting for charger',
  fgs_timeout: 'Paused: stopped in background',
  schedule: 'Paused: by schedule',
};

export const OFFLINE_TEXT = 'Waiting for a connection';
export const FOLDER_GONE_TEXT = "The folder isn't available. Is the SD card in?";
export const TOO_BIG_TEXT = "This file is bigger than the card's format allows (4 GB). Use phone storage.";
export const LOCAL_BLOCKED_TEXT = 'This link tried to send Maglev to a device on your network, so it was stopped.';
export const POLICY_BLOCKED_TEXT = 'Blocked by your Wi-Fi-only or VPN setting.';
export const PERMISSION_TEXT = "Maglev can't write to that folder.";
export const WIFI_CAPTION = 'Wi-Fi only is on in Settings → Network.';
export const NOT_A_FILE_BODY =
  'This is a web page, not a file. On the page, long-press the download button, tap Copy link address, then paste it here.';
export const STALLED_TEXT = 'Waiting for the server';
export const STALLED_ERROR_TEXT = 'The server stopped sending data.';
export const AUTH_REQUIRED_TEXT = 'This link needs you to sign in again. Paste the link again.';
export const NO_APP_TEXT = 'No app on this phone can open this file.';
export const PROBE_BLOCKED_BODY =
  'Your network settings block downloads right now. Open settings to change that, or add it anyway and it starts when downloads are allowed.';
export const AUTH_BODY =
  'This site wants you to sign in. Sign in on the site in your browser, copy the download link again, and paste it here.';

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
  | 'policyBlocked'
  | 'httpGone'
  | 'authRequired'
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
  if (c === 'BLOCKED') return 'policyBlocked';
  if (c === 'AUTH_REQUIRED') return 'authRequired';
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
  if (isSizeUnknown(d)) return d.downloaded > 0 ? `${formatBytes(d.downloaded)} so far` : 'size unknown';
  return `${Math.round(downloadProgress(d) * 100)} percent`;
}

/** 0 to 1. Unknown size reads as 0; check `isSizeUnknown` and show an indeterminate bar instead. */
export function downloadProgress(d: DownloadSnapshot): number {
  if (d.state === 'finished') return 1;
  if (!d.size || d.size <= 0) return 0;
  return Math.min(1, Math.max(0, d.downloaded / d.size));
}

/** The one status line under the bar. `etaLabel` is the stable label from `formatEta`. */
export function downloadStatus(d: DownloadSnapshot, etaLabel?: string): { text: string; tone: DownloadTone } {
  switch (d.state) {
    case 'resolving':
      return { text: 'Getting info…', tone: 'muted' };
    case 'queued':
      return { text: 'Queued', tone: 'muted' };
    case 'downloading': {
      if (d.stalled) return { text: STALLED_TEXT, tone: 'muted' };
      const speed = d.downBps > 0 ? formatSpeed(d.downBps) : '—';
      if (isSizeUnknown(d)) return { text: `${formatBytes(d.downloaded)} so far · ${speed}`, tone: 'muted' };
      const eta = etaLabel ?? formatEta(d.eta, null);
      if (d.eta >= 0 && eta !== '—') return { text: `${eta} left · ${speed}`, tone: 'muted' };
      return { text: `Downloading · ${speed}`, tone: 'muted' };
    }
    case 'paused':
      if (d.pausedBy === 'storage_full') return { text: 'Storage full', tone: 'danger' };
      if (d.pausedBy === 'storage_unavailable') return { text: FOLDER_GONE_TEXT, tone: 'danger' };
      if (d.pausedBy === 'offline') return { text: OFFLINE_TEXT, tone: 'muted' };
      if (d.pausedBy && GOVERNANCE_TEXT[d.pausedBy]) return { text: GOVERNANCE_TEXT[d.pausedBy], tone: 'muted' };
      return { text: 'Paused', tone: 'muted' };
    case 'verifying':
      return { text: 'Finishing…', tone: 'muted' };
    case 'finished':
      return { text: d.size ? `Done · ${formatBytes(d.size)}` : 'Done', tone: 'accent' };
    case 'needs_link':
      return {
        text: d.error?.code === 'AUTH_REQUIRED' ? 'Needs sign-in · Paste new link' : 'Link expired · Paste new link',
        tone: 'danger',
      };
    case 'error':
      return { text: errorLine(d), tone: 'danger' };
    default:
      return { text: 'Getting info…', tone: 'muted' };
  }
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
    case 'policyBlocked':
      return POLICY_BLOCKED_TEXT;
    case 'authRequired':
      return AUTH_REQUIRED_TEXT;
    case 'stalled':
      return STALLED_ERROR_TEXT;
    default:
      return d.error?.message || 'Something went wrong';
  }
}

/** A longer line the sheet shows (the card line is one row and may be cut). Null when there is none. */
export function downloadCaption(d: DownloadSnapshot): string | null {
  if (d.state === 'downloading' && d.stalled) return STALLED_TEXT;
  if (d.state === 'paused' && d.pausedBy === 'wifi_only') return WIFI_CAPTION;
  if (d.state === 'paused' && d.pausedBy === 'storage_unavailable') return FOLDER_GONE_TEXT;
  if (d.state === 'needs_link' && d.error?.code === 'AUTH_REQUIRED') return AUTH_BODY;
  if (d.state === 'error') {
    const k = errorKind(d.error?.code, d.error?.httpStatus);
    if (k === 'notAFile') return NOT_A_FILE_BODY;
    if (k === 'permission' || k === 'folderGone' || k === 'tooBig' || k === 'localBlocked' || k === 'policyBlocked' || k === 'authRequired' || k === 'stalled') return errorLine(d);
  }
  return null;
}

const A = {
  pause: { kind: 'pause', icon: 'pause', label: 'Pause' },
  resume: { kind: 'resume', icon: 'play', label: 'Resume' },
  retry: { kind: 'retry', icon: 'retry', label: 'Retry' },
  restart: { kind: 'restart', icon: 'retry', label: 'Restart' },
  open: { kind: 'open', icon: 'external', label: 'Open' },
  newLink: { kind: 'newLink', icon: 'link', label: 'Paste new link' },
  remove: { kind: 'remove', icon: 'trash', label: 'Remove' },
  pickFolder: { kind: 'pickFolder', icon: 'folder', label: 'Pick folder again' },
  openSettings: { kind: 'openNetworkSettings', icon: 'settings', label: 'Open settings' },
} as const satisfies Record<string, DownloadAction>;

/** Every action that makes sense now, the most useful first. The card shows the first; the sheet shows all. */
export function downloadActions(d: DownloadSnapshot): DownloadAction[] {
  switch (d.state) {
    case 'downloading':
    case 'queued':
      return [A.pause];
    case 'paused':
      if (d.pausedBy === 'storage_unavailable') return [A.pickFolder];
      if (d.pausedBy === 'wifi_only' || d.pausedBy === 'vpn_required') return [A.openSettings];
      if (isGovernancePause(d.pausedBy)) return [];
      return [A.resume];
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
          return [A.newLink];
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
  return d.state === 'needs_link' || (d.state === 'error' && errorKind(d.error?.code, d.error?.httpStatus) === 'authRequired');
}

/** What to tell the user when Open fails. */
export function openFailureText(code: string | undefined, message?: string): string {
  if ((code ?? '').toUpperCase() === 'NO_APP') return NO_APP_TEXT;
  return message || "Couldn't open that file.";
}

/** The card's one button, or null when nothing can be done now. */
export function downloadAction(d: DownloadSnapshot): DownloadAction | null {
  return downloadActions(d)[0] ?? null;
}

/** Where the settings-style actions go. Null for the ones the engine or the sheet handles. */
export function actionRoute(kind: DownloadActionKind): '/settings/storage' | '/settings/network' | null {
  if (kind === 'pickFolder') return '/settings/storage';
  if (kind === 'openNetworkSettings') return '/settings/network';
  return null;
}

/** What the add screen says when checking a link fails, and what its main button does. */
export function probeErrorView(
  code: string | undefined,
  message: string | undefined,
  httpStatus?: number | null,
): { body: string; primary: 'pasteAnother' | 'retry' | 'blocked' } {
  const k = (code ?? '').toUpperCase();
  // Trying again fails the same way; the user can change the setting or add it now and let it wait.
  if (k === 'BLOCKED') return { body: PROBE_BLOCKED_BODY, primary: 'blocked' };
  if (k === 'NOT_A_FILE') return { body: NOT_A_FILE_BODY, primary: 'pasteAnother' };
  if (k === 'AUTH_REQUIRED') return { body: AUTH_BODY, primary: 'pasteAnother' };
  const body = message || 'Something went wrong.';
  // A missing file will not appear on a second try; a network drop or a busy server might.
  if (k === 'HTTP_STATUS' && isFinal4xx(httpStatus)) return { body, primary: 'pasteAnother' };
  return { body, primary: 'retry' };
}

/** True while the download is working or waiting to work. */
export function isDownloadActive(d: DownloadSnapshot): boolean {
  return d.state === 'downloading' || d.state === 'queued' || d.state === 'resolving' || d.state === 'verifying';
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
