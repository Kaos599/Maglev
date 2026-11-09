export type TorrentState = 'DOWNLOADING' | 'SEEDING' | 'PAUSED' | 'QUEUED' | 'ERROR';

export * from './MaglevSettings.types.ts';

export interface TorrentTelemetry {
  id: string;
  name: string;
  state: TorrentState;
  downloadSpeedBytes: number;
  uploadSpeedBytes: number;
  progressPercent: number;
  downloadedBytes: number;
  uploadedBytes: number;
  totalSizeBytes: number;
  etaSeconds: number;
  peersConnected: number;
  peersTotal: number;
  seedsConnected: number;
  ratio: number;
  sequential?: boolean;
  seedDurationSeconds?: number;
}

export interface AggregatedTelemetry {
  totalDownloadSpeedBytes: number;
  totalUploadSpeedBytes: number;
  activeDownloads: number;
  activeUploads: number;
  torrents: TorrentTelemetry[];
}

export interface TrackerInfo {
  url: string;
  status: 'Working' | 'Announcing' | 'Error' | 'Paused';
  seeds: number;
  peers: number;
  lastError?: string;
}

export interface TorrentFileInfo {
  index: number;
  name: string;
  path: string;
  length: number;
  progress: number;
  priority: 0 | 1 | 2; // 0 = skip, 1 = normal, 2 = high
}

export interface TorrentDetailData extends TorrentTelemetry {
  savePath: string;
  piecesTotal: number;
  piecesVerified: number;
  files: TorrentFileInfo[];
  trackers: TrackerInfo[];
  streamUrl?: string;
}

export type PieceMatrix = Uint8Array; // 256 bytes (16x16)
