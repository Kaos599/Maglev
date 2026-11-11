import type { PausedBy, TorrentState } from 'maglev-engine';
import type { ThemeColors } from '../../constants/theme';
import { formatSpeed } from '../../constants/format';
import { fileKind } from '../../utils/fileKind';
import { buildMagnet } from './magnet';
import { healthLabel, resolvingLine } from './fileHealthMachine';

export { buildMagnet };

/** Plain-language state label. Paused copy follows the paused_by table in STATE_MACHINES section 2.1. */
export function stateLabel(
  state: TorrentState,
  pausedBy: PausedBy | null | undefined,
  extra?: { moveProgress?: number | null; resumesAt?: string | null; resolving?: { peersSeen: number; secs: number } | null },
): string {
  switch (state) {
    case 'MOVING':
      return extra?.moveProgress != null ? `Moving files… ${Math.round(extra.moveProgress * 100)}%` : 'Moving files…';
    case 'INITIALIZING':
      return extra?.resolving ? resolvingLine(extra.resolving.peersSeen, extra.resolving.secs) : 'Getting info';
    case 'QUEUED':
      return 'Queued';
    case 'DOWNLOADING':
      return 'Downloading';
    case 'SEEDING':
      return 'Seeding';
    case 'CHECKING':
      return 'Checking';
    case 'ERROR':
      return 'Error';
    case 'COMPLETED':
      return 'Done';
    case 'PAUSED':
      switch (pausedBy) {
        case 'wifi_only':
          return 'Waiting for Wi-Fi';
        case 'battery':
        case 'charging_only':
          return 'Paused to save battery';
        case 'seed_limit':
          return 'Done';
        case 'schedule':
          return extra?.resumesAt ? `Scheduled pause · resumes ${extra.resumesAt}` : 'Scheduled pause';
        default:
          return healthLabel(pausedBy) ?? 'Paused';
      }
  }
}

export function stateColor(state: TorrentState, c: ThemeColors): string {
  switch (state) {
    case 'DOWNLOADING':
    case 'MOVING':
      return c.download;
    case 'SEEDING':
    case 'COMPLETED':
      return c.success;
    case 'ERROR':
      return c.danger;
    case 'PAUSED':
      return c.paused;
    default:
      return c.textMuted;
  }
}

const MEDIA_EXT = /\.(mp4|mkv|avi|mov|webm|m4v|wmv|flv|ts|mpg|mpeg|mp3|flac|ogg|opus|wav|m4a|aac|wma)$/i;

export function isMediaFile(path: string): boolean {
  return MEDIA_EXT.test(path);
}

export function fileName(path: string): string {
  return path.split('/').pop() || path;
}

export function fileExt(path: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(path);
  return m ? `.${m[1].toLowerCase()}` : 'other';
}

/** "HH:MM" in the device's 24-hour clock for an epoch-ms boundary. */
export function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface MoveFailure {
  text: string;
  /** Offer "Pick a folder again" next to the message. */
  pickAgain: boolean;
}

/** Plain-English text for a failed move (NATIVE_CONTRACT 11.3), with the recovery action. */
export function moveFailure(code: string, message?: string): MoveFailure {
  switch (code) {
    case 'PERMISSION':
      return { text: "Maglev can't write to that folder. Pick another one.", pickAgain: true };
    case 'DISK_FULL':
      return { text: 'Not enough free storage there. Free some space or pick another folder.', pickAgain: true };
    case 'NOT_FOUND':
      return { text: 'This torrent is no longer in your list.', pickAgain: false };
    case 'UNSUPPORTED':
      return { text: message || "Can't move this torrent right now. Try again in a moment.", pickAgain: true };
    default:
      return { text: message || "Couldn't move the files. Try again.", pickAgain: false };
  }
}

/** Whether a file can be offered for streaming: video and audio only (NATIVE_CONTRACT 11.4). */
export function isStreamable(path: string): boolean {
  const k = fileKind(path);
  return k === 'video' || k === 'audio';
}

const STREAM_MIN_BYTES = 8 * 1024 * 1024;

export interface StreamReadiness {
  ready: boolean;
  /** Whole percent of the file contiguously available from its start. */
  percent: number;
}

/** "Ready to play" when finished, or when the head is large enough and the tail is present. */
export function streamReadiness(file: {
  length: number;
  progressBytes: number;
  streamReadyBytes: number;
  tailReady: boolean;
}): StreamReadiness {
  const done = file.length > 0 && file.progressBytes >= file.length;
  const percent = file.length > 0 ? Math.min(100, Math.floor((file.streamReadyBytes / file.length) * 100)) : 0;
  const need = Math.min(STREAM_MIN_BYTES, file.length * 0.05);
  return { ready: done || (file.streamReadyBytes >= need && file.tailReady), percent };
}

/** "Down 1 MB/s · Up 512 KB/s" for the limits that are set, or undefined when there are none. */
export function limitText(l: { downBps: number; upBps: number }): string | undefined {
  const parts: string[] = [];
  if (l.downBps > 0) parts.push(`Down ${formatSpeed(l.downBps)}`);
  if (l.upBps > 0) parts.push(`Up ${formatSpeed(l.upBps)}`);
  return parts.length ? parts.join(' · ') : undefined;
}
