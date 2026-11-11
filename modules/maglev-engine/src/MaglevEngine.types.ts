export type TorrentState =
  | 'INITIALIZING'
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'SEEDING'
  | 'PAUSED'
  | 'CHECKING'
  | 'ERROR'
  | 'COMPLETED';

import type { DownloadFolder } from './MaglevSettings.types.ts';

export * from './MaglevSettings.types.ts';

export type PausedBy = 'user' | 'wifi_only' | 'battery' | 'charging_only' | 'seed_limit';

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
  pausedBy?: PausedBy | null;
  error?: { code: string; message: string } | null;
  outputFolder?: string;
  addedAt?: number;
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

// ---------------------------------------------------------------------------
// Native contract types (docs/NATIVE_CONTRACT.md section 3 and 6), camelCase on the JS side.
// NativeConfig is the exception: it is passed to Rust as-is, so it keeps snake_case keys.
// ---------------------------------------------------------------------------

export type EngineErrorCode =
  | 'INVALID_SOURCE'
  | 'DUPLICATE'
  | 'METADATA_TIMEOUT'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'DISK_FULL'
  | 'PERMISSION'
  | 'FILES_MISSING'
  | 'NOT_INITIALIZED'
  | 'ENGINE_UNAVAILABLE'
  | 'INTERNAL';

export type EngineResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: EngineErrorCode; message: string; id?: string };

export type NativeEncryption = 'prefer' | 'require' | 'disable';

export interface NativeConfig {
  listen_port: number;
  enable_upnp: boolean;
  enable_dht: boolean;
  enable_lsd: boolean;
  enable_pex: boolean;
  encryption: NativeEncryption;
  max_active_downloads: number;
  max_active_seeds: number;
  max_connections_per_torrent: number;
  download_limit_bps: number;
  upload_limit_bps: number;
  seed_ratio_limit: number;
  seed_time_limit_mins: number;
  proxy_url: string | null;
  ip_filter_path: string | null;
}

export interface MetadataFile {
  index: number;
  path: string;
  length: number;
}

export interface Metadata {
  infoHash: string;
  name: string;
  totalBytes: number;
  files: MetadataFile[];
}

export interface SnapshotError {
  code: 'DISK_FULL' | 'PERMISSION' | 'FILES_MISSING' | 'TRACKER' | 'INTERNAL';
  message: string;
}

export interface Snapshot {
  id: string;
  name: string;
  state: TorrentState;
  pausedBy: PausedBy | null;
  progressBytes: number;
  totalBytes: number;
  uploadedBytes: number;
  downBps: number;
  upBps: number;
  peersLive: number;
  peersSeen: number;
  etaSecs: number; // -1 = unknown
  ratio: number;
  seedingSecs: number;
  addedAt: number;
  outputFolder: string;
  error: SnapshotError | null;
}

export interface DetailFile {
  index: number;
  path: string;
  length: number;
  progressBytes: number;
  included: boolean;
}

export interface DetailPeer {
  addr: string;
  client: string;
  downBps: number;
  upBps: number;
  progress: number;
}

export interface DetailTracker {
  url: string;
  status: 'working' | 'updating' | 'error' | 'unknown';
  message: string | null;
}

export interface Detail {
  snapshot: Snapshot;
  files: DetailFile[];
  peers: DetailPeer[];
  trackers: DetailTracker[];
  pieceCount: number;
  pieceLength: number;
}

export interface AddTorrentOptions {
  onlyFiles?: number[] | null;
  paused?: boolean;
  outputFolder?: string | null;
  sequential?: boolean;
}

export interface GovernanceConfig {
  wifiOnly: boolean;
  ssidWhitelist: string[];
  chargingOnly: boolean;
  batteryCutoffPct: number;
  autoExitOnComplete: boolean;
}

export type NotificationActionName = 'pause_all' | 'resume_all' | 'shutdown';

export interface TelemetryEvent {
  torrents: Snapshot[];
}
export interface TorrentCompletedEvent {
  id: string;
  name: string;
}
export interface NotificationActionEvent {
  action: NotificationActionName;
}
export interface StorageStatus {
  path: string;
  fallback: boolean;
  safLost: boolean;
}

export type PickFolderResult = ({ ok?: true } & DownloadFolder) | { cancelled: true };

export type NotificationPermission = 'granted' | 'denied' | 'undetermined';
export interface NativePermissionStatus {
  notifications: NotificationPermission;
  batteryUnrestricted: boolean;
  legacyStorage: 'granted' | 'denied' | 'n/a';
}

export type EngineStatus =
  | { kind: 'ready'; message: string; simulated: boolean }
  | { kind: 'unavailable'; message: string };

export type Unsubscribe = () => void;

/** Exact docs/NATIVE_CONTRACT.md section 6 API. Every method resolves a Result envelope. */
export interface MaglevEngineApi {
  // Engine
  init(config: NativeConfig): Promise<EngineResult>;
  shutdown(): Promise<EngineResult>;
  resolveMetadata(source: string, timeoutMs: number): Promise<EngineResult<Metadata>>;
  addTorrent(source: string, options: AddTorrentOptions): Promise<EngineResult<{ id: string; infoHash: string }>>;
  listTorrents(): Promise<EngineResult<{ torrents: Snapshot[] }>>;
  getDetail(id: string): Promise<EngineResult<Detail>>;
  pause(id: string): Promise<EngineResult>;
  resume(id: string): Promise<EngineResult>;
  recheck(id: string): Promise<EngineResult>;
  pauseAll(): Promise<EngineResult>;
  resumeAll(): Promise<EngineResult>;
  delete(id: string, deleteFiles: boolean): Promise<EngineResult>;
  setIncludedFiles(id: string, indices: number[]): Promise<EngineResult>;
  setGlobalLimits(down: number, up: number): Promise<EngineResult>;
  applyConfig(config: NativeConfig): Promise<EngineResult<{ restartRequired: boolean }>>;
  getEffectiveConfig(): Promise<EngineResult<NativeConfig>>;
  getPieceBitfield(id: string): Promise<number[]>;
  streamUrl(id: string, fileIndex: number): Promise<EngineResult<{ url: string }>>;
  version(): Promise<{ engine: string; version: string }>;
  // Storage
  pickDownloadFolder(): Promise<PickFolderResult>;
  getStorageStatus(): Promise<StorageStatus>;
  openFile(id: string, fileIndex: number): Promise<EngineResult>;
  shareFile(id: string, fileIndex: number): Promise<EngineResult>;
  openFolder(id: string): Promise<EngineResult>;
  // Permissions
  getPermissionStatus(): Promise<NativePermissionStatus>;
  requestNotifications(): Promise<EngineResult>;
  openBatterySettings(): Promise<void>;
  requestLegacyStorage(): Promise<EngineResult>;
  // Governance
  setGovernance(config: GovernanceConfig): Promise<EngineResult>;
  // Events
  onTelemetry(listener: (event: TelemetryEvent) => void): Unsubscribe;
  onTorrentCompleted(listener: (event: TorrentCompletedEvent) => void): Unsubscribe;
  onNotificationAction(listener: (event: NotificationActionEvent) => void): Unsubscribe;
  onStorageStatus(listener: (event: StorageStatus) => void): Unsubscribe;
}
