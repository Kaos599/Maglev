/**
 * What a download card says and offers, per state (STATE_MACHINES_AND_SCREENS SM-30 "Copy").
 * Pure: no React, so `scripts/test-url-download.js` runs it directly.
 */
import type { DownloadSnapshot } from 'maglev-engine';
import { formatBytes, formatSpeed } from '../constants/format.ts';
import { formatEta } from './rates.ts';

export type DownloadTone = 'muted' | 'accent' | 'danger';
export type DownloadActionKind = 'pause' | 'resume' | 'retry' | 'restart' | 'newLink';

export interface DownloadAction {
  kind: DownloadActionKind;
  /** Icon name from the generated Pixelarticons set. */
  icon: 'pause' | 'play' | 'retry' | 'link';
  label: string;
}

const GOVERNANCE_TEXT: Record<string, string> = {
  wifi_only: 'Paused: waiting for Wi-Fi',
  battery: 'Paused: battery is low',
  charging_only: 'Paused: waiting for charger',
  fgs_timeout: 'Paused: stopped in background',
  schedule: 'Paused: by schedule',
};

/** Reasons the engine clears by itself. The card offers no Resume for them. */
export function isGovernancePause(pausedBy: string | null | undefined): boolean {
  return !!pausedBy && pausedBy !== 'user' && pausedBy !== 'storage_full';
}

/** 0 to 1. Unknown size reads as 0 (the bar is shown indeterminate while resolving). */
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
      const speed = d.downBps > 0 ? formatSpeed(d.downBps) : '—';
      const eta = etaLabel ?? formatEta(d.eta, null);
      if (d.eta >= 0 && eta !== '—') return { text: `${eta} left · ${speed}`, tone: 'muted' };
      return { text: `Downloading · ${speed}`, tone: 'muted' };
    }
    case 'paused':
      if (d.pausedBy === 'storage_full') return { text: 'Storage full', tone: 'danger' };
      if (d.pausedBy && GOVERNANCE_TEXT[d.pausedBy]) return { text: GOVERNANCE_TEXT[d.pausedBy], tone: 'muted' };
      return { text: 'Paused', tone: 'muted' };
    case 'verifying':
      return { text: 'Finishing…', tone: 'muted' };
    case 'finished':
      return { text: d.size ? `Done · ${formatBytes(d.size)}` : 'Done', tone: 'accent' };
    case 'needs_link':
      return { text: 'Link expired · Paste new link', tone: 'danger' };
    case 'error':
      return { text: errorLine(d), tone: 'danger' };
    default:
      return { text: 'Getting info…', tone: 'muted' };
  }
}

function errorLine(d: DownloadSnapshot): string {
  switch (d.error?.code) {
    case 'FILE_CHANGED':
      return 'The file changed on the server · Restart';
    case 'NOT_A_FILE':
      return 'This link opens a web page, not a file';
    case 'CHECKSUM_MISMATCH':
      return "File doesn't match the checksum";
    case 'HTTP_STATUS':
    case 'NETWORK':
    case 'PERMISSION':
      return d.error.message || 'Something went wrong';
    default:
      return d.error?.message || 'Something went wrong';
  }
}

/** The card's one button, or null when nothing can be done now. */
export function downloadAction(d: DownloadSnapshot): DownloadAction | null {
  switch (d.state) {
    case 'downloading':
    case 'queued':
      return { kind: 'pause', icon: 'pause', label: 'Pause' };
    case 'paused':
      if (isGovernancePause(d.pausedBy)) return null;
      return { kind: 'resume', icon: 'play', label: 'Resume' };
    case 'needs_link':
      return { kind: 'newLink', icon: 'link', label: 'Paste new link' };
    case 'error':
      if (d.error?.code === 'FILE_CHANGED') return { kind: 'restart', icon: 'retry', label: 'Restart' };
      // A web page or a wrong checksum will not change on a second try, but Retry probes again and says so.
      return { kind: 'retry', icon: 'retry', label: 'Retry' };
    default:
      return null;
  }
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
