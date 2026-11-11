import type { PausedBy, TorrentState } from 'maglev-engine';
import type { ThemeColors } from '../../constants/theme';

/** Plain-language state label. Paused copy follows the paused_by table in STATE_MACHINES section 2.1. */
export function stateLabel(state: TorrentState, pausedBy: PausedBy | null | undefined): string {
  switch (state) {
    case 'INITIALIZING':
      return 'Getting info';
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
        default:
          return 'Paused';
      }
  }
}

export function stateColor(state: TorrentState, c: ThemeColors): string {
  switch (state) {
    case 'DOWNLOADING':
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

/** Torrent info-hash is the engine id; build a magnet link from it. */
export function buildMagnet(infoHash: string, name: string): string {
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`;
}
