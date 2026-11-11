export type TorrentState =
  | 'INITIALIZING'
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'SEEDING'
  | 'PAUSED'
  | 'CHECKING'
  | 'ERROR'
  | 'COMPLETED'
  | 'MOVING';

import type { DownloadFolder } from './MaglevSettings.types.ts';

export * from './MaglevSettings.types.ts';

/**
 * NATIVE_CONTRACT 18.2 and 20. Why a torrent is stopped by its own condition. While set the engine keeps
 * the torrent paused; `paused_by` carries the same tag unless the user paused it first.
 */
export type HealthTag = 'files_missing' | 'files_changed' | 'storage_full' | 'storage_unavailable' | 'no_peers';

export const HEALTH_TAGS: readonly HealthTag[] = [
  'files_missing',
  'files_changed',
  'storage_full',
  'storage_unavailable',
  'no_peers',
];

/** Reserved: user, seed_limit. Any other value is a governance tag from Kotlin or a health tag (18.2). */
export type PausedBy =
  | 'user'
  | 'wifi_only'
  | 'battery'
  | 'charging_only'
  | 'seed_limit'
  | 'fgs_timeout'
  | 'schedule'
  /** NATIVE_CONTRACT 21: connected but not validated (captive portal). */
  | 'network_unvalidated'
  /** NATIVE_CONTRACT 21: `network.vpnOnly` is on and no VPN is connected. */
  | 'vpn_required'
  | HealthTag;

export interface TorrentTelemetry {
  id: string;
  finished?: boolean;
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
  /** Per-torrent limits in bytes per second. 0 or undefined = no limit. */
  downLimitBps?: number;
  upLimitBps?: number;
  /** 0 to 1 while MOVING, otherwise null or undefined. */
  moveProgress?: number | null;
  /** NATIVE_CONTRACT 18.2. Null or undefined when the torrent is healthy. */
  health?: HealthTag | null;
  /** NATIVE_CONTRACT 18.4. Sum of the included, non-padding file lengths. */
  includedBytes?: number;
  /** NATIVE_CONTRACT 16. Web seeds configured for the torrent. */
  webSeeds?: number;
  /** NATIVE_CONTRACT 20. Seconds a magnet has been looking for its metadata, null once it has it. */
  resolvingSecs?: number | null;
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
  streamReadyBytes?: number;
  tailReady?: boolean;
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
  | 'CANCELLED'
  | 'NETWORK'
  | 'NOT_FOUND'
  | 'DISK_FULL'
  | 'PERMISSION'
  | 'FILES_MISSING'
  | 'NOT_INITIALIZED'
  | 'ENGINE_UNAVAILABLE'
  | 'UNSUPPORTED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'NOT_READY'
  | 'INTERNAL';

/** NATIVE_CONTRACT 12.1. */
export interface ResolveActivity {
  peersFound: number;
  dht: boolean;
  elapsedMs: number;
}

export type EngineResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; code: EngineErrorCode; message: string; id?: string; retryAfterSecs?: number; mergedTrackers?: number };

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
  /** True once every included piece is present. Completion edges key off this, not the state string. */
  finished: boolean;
  progressBytes: number;
  totalBytes: number;
  uploadedBytes: number;
  downBps: number;
  upBps: number;
  peersLive: number;
  peersSeen: number;
  /** NATIVE_CONTRACT 16. Web seeds configured for the torrent. 0 when none. */
  webSeeds: number;
  etaSecs: number; // -1 = unknown
  ratio: number;
  seedingSecs: number;
  addedAt: number;
  outputFolder: string;
  error: SnapshotError | null;
  /** NATIVE_CONTRACT 11.2. 0 = no per-torrent limit. */
  downLimitBps: number;
  upLimitBps: number;
  /** NATIVE_CONTRACT 11.3. 0 to 1, non-null only while MOVING. */
  moveProgress: number | null;
  /** NATIVE_CONTRACT 18.2. */
  health: HealthTag | null;
  /** NATIVE_CONTRACT 18.4. SM-35: `pendingNeed = sum(max(0, includedBytes - progressBytes))` over unfinished torrents. */
  includedBytes: number;
  /** NATIVE_CONTRACT 20. Seconds a magnet has been looking for its metadata; null once it has it. */
  resolvingSecs: number | null;
}

export type FilePriority = 'first' | 'normal' | 'skip';

export interface FilePriorityEntry {
  index: number;
  priority: FilePriority;
}

export interface DetailFile {
  index: number;
  path: string;
  length: number;
  progressBytes: number;
  /** Size on disk of a skipped file (preallocated or partial data Remove can delete). 0 for included files and absent ones. */
  onDiskBytes?: number;
  included: boolean;
  /** NATIVE_CONTRACT 10.1. `included` is derived from it (`skip` means not included). */
  priority: FilePriority;
  /** NATIVE_CONTRACT 11.4. Contiguous downloaded bytes from the start of the file. */
  streamReadyBytes: number;
  /** True when the last piece of the file is present (players read the MP4 index there). */
  tailReady: boolean;
}

export interface DetailPeer {
  addr: string;
  client: string;
  downBps: number;
  upBps: number;
  progress: number;
}

export interface TrackersAdded {
  /** Addresses that were new to the torrent. */
  added: number;
  /** Addresses it already had. */
  skipped: number;
  announced: boolean;
}

export interface TorrentExport {
  /** The saved file. It exists and can be shared. */
  path: string;
  name: string;
  /** Where to tell the user it went, for example "Download/Maglev". */
  folder: string;
  bytes: number;
}

/** NATIVE_CONTRACT 18.3. */
export type FileHealthState = 'ok' | 'missing' | 'changed';

export interface FileHealthEntry {
  index: number;
  state: FileHealthState;
}

/** NATIVE_CONTRACT 18.3. `stop` and `again` take the file indices, `folder` takes a folder path, `recheck` takes neither. */
export type ResolveFilesAction = 'stop' | 'again' | 'folder' | 'recheck';

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
  /** When present, overrides `onlyFiles`. Covers every file. */
  filePriorities?: FilePriorityEntry[] | null;
  /** NATIVE_CONTRACT 11.2. 0 or absent = no limit. */
  downLimitBps?: number;
  upLimitBps?: number;
}

export interface FreeSpace {
  path: string;
  freeBytes: number;
  totalBytes: number;
  mode: 'direct' | 'staging';
  /** Staging mode only: free bytes on the SAF target volume, or null when unknown. */
  targetFreeBytes?: number | null;
}

export interface GovernanceConfig {
  wifiOnly: boolean;
  ssidWhitelist: string[];
  chargingOnly: boolean;
  batteryCutoffPct: number;
  autoExitOnComplete: boolean;
  /** NATIVE_CONTRACT 19: restart unfinished transfers after a reboot or app update. */
  resumeAfterRestart: boolean;
  /** NATIVE_CONTRACT 21: pause while the active network is not a VPN. */
  vpnOnly: boolean;
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
  /** Times Android killed Maglev while transfers were running (headless restarts after an unclean stop). */
  backgroundKills?: number;
  /** Manufacturer known for aggressive background killing (link to dontkillmyapp.com), else null. */
  /** Android 16+ Live Updates. 'n/a' below API 36. */
  liveUpdates?: 'granted' | 'denied' | 'n/a';
  oemHint?: 'xiaomi' | 'samsung' | 'huawei' | 'oneplus' | 'oppo' | 'vivo' | null;
}

// ---------------------------------------------------------------------------
// Wave 4 (NATIVE_CONTRACT section 11)
// ---------------------------------------------------------------------------

/** 11.2. Bytes per second; 0 = no limit. */
export interface TorrentLimits {
  downBps: number;
  upBps: number;
}

/** 11.3. `default` is Download/Maglev; `tree` comes from the folder picker. */
export type MoveTarget = { kind: 'default' } | { kind: 'tree'; uri: string };

/** 11.5. `days`: 0 = Monday ... 6 = Sunday. `start` and `end` are "HH:MM". */
export interface ScheduleRule {
  id: string;
  days: number[];
  start: string;
  end: string;
  action: 'pause' | 'limit';
  downBps?: number;
  upBps?: number;
}

export interface ScheduleConfig {
  enabled: boolean;
  rules: ScheduleRule[];
}

export interface ScheduleStatus {
  enabled: boolean;
  paused: boolean;
  activeRuleIds: string[];
  /** Epoch milliseconds of the next rule start or end, or null. */
  nextBoundary: number | null;
}

/** 11.6. `feedIds` empty = all feeds. */
export interface FeedRule {
  id: string;
  name: string;
  feedIds: string[];
  include: string;
  exclude: string;
  episodes: 'all' | 'new_only';
  startPaused: boolean;
  enabled: boolean;
}

export interface FeedAutomationFeed {
  id: string;
  url: string;
  name: string;
}

export interface FeedAutomationConfig {
  enabled: boolean;
  intervalMins: 15 | 30 | 60;
  feeds: FeedAutomationFeed[];
  rules: FeedRule[];
}

export interface FeedAutomationStatus {
  lastRunAt: number | null;
  lastError: string | null;
  addedTotal: number;
  pending: number;
}

export type EngineStatus =
  | { kind: 'starting'; message: string }
  | { kind: 'ready'; message: string; simulated: boolean }
  | { kind: 'unavailable'; message: string };

export type Unsubscribe = () => void;

/** Exact docs/NATIVE_CONTRACT.md section 6 API. Every method resolves a Result envelope. */
export interface MaglevEngineApi {
  // Engine
  init(config: NativeConfig): Promise<EngineResult>;
  shutdown(): Promise<EngineResult>;
  resolveMetadata(source: string, timeoutMs: number): Promise<EngineResult<Metadata>>;
  /** NATIVE_CONTRACT 12.1. Peers seen while a magnet resolves; NOT_FOUND when no resolve is running. */
  getResolveActivity(infoHash: string): Promise<EngineResult<ResolveActivity>>;
  /** NATIVE_CONTRACT 12.1. The pending `resolveMetadata` then returns CANCELLED. */
  cancelResolve(infoHash: string): Promise<EngineResult>;
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
  /** Covers every file. Unknown index or all `skip` returns INVALID_SOURCE. */
  setFilePriorities(id: string, priorities: FilePriorityEntry[]): Promise<EngineResult>;
  /**
   * NATIVE_CONTRACT 14. Stops downloading those files, deletes their data and frees the space; pieces shared with a
   * kept file are downloaded again. INVALID_SOURCE for an unknown index or when no included file would remain,
   * UNSUPPORTED while the torrent is moving or checking.
   */
  removeFiles(id: string, indices: number[]): Promise<EngineResult<{ freedBytes: number }>>;
  /**
   * NATIVE_CONTRACT 18.2. `tag` is a health tag, or "" to clear it. Clearing `files_missing` or `storage_unavailable`
   * runs the files check first: if files are still gone the torrent stays stopped under `files_missing`.
   * INVALID_ARGUMENT for an unknown tag, NOT_FOUND for an unknown torrent.
   */
  setHealth(id: string, tag: HealthTag | ''): Promise<EngineResult>;
  /** NATIVE_CONTRACT 18.3. One file scan now (the engine also scans every 30 s). `changed` counts torrents whose tag changed. */
  scanFileHealth(): Promise<EngineResult<{ changed: number }>>;
  /** NATIVE_CONTRACT 18.3. The included files only. A torrent that can't be judged right now reports every file `ok`. */
  fileHealth(id: string): Promise<EngineResult<{ files: FileHealthEntry[] }>>;
  /**
   * NATIVE_CONTRACT 18.3. What to do about missing or changed files. `folder` answers FILES_MISSING with
   * "Those files aren't in that folder." when they are not there. NOT_FOUND, INVALID_ARGUMENT, INVALID_STATE
   * (moving or checking).
   */
  resolveFiles(id: string, action: ResolveFilesAction, indices: number[], dir: string): Promise<EngineResult>;
  /** Only while DOWNLOADING or SEEDING. Rate limited to once per 60 s per torrent. */
  reannounce(id: string): Promise<EngineResult<{ retryAfterSecs?: number }>>;
  /**
   * NATIVE_CONTRACT 15. One announce URL per entry (http, https or udp). Nothing is added unless every one is valid
   * (INVALID_ARGUMENT). Private torrents refuse (UNSUPPORTED). `announced` is true when a running torrent asked the new trackers at once.
   */
  addTrackers(id: string, urls: string[]): Promise<EngineResult<TrackersAdded>>;
  /** NATIVE_CONTRACT 15. Removing the last tracker is allowed. NOT_FOUND when the torrent or the tracker is not there. */
  removeTracker(id: string, url: string): Promise<EngineResult<{ announced: boolean }>>;
  /** NATIVE_CONTRACT 15. Writes `<name>.torrent` to the download folder. NOT_READY while a magnet still has no metadata. */
  exportTorrent(id: string): Promise<EngineResult<TorrentExport>>;
  /** Opens the share sheet for a file `exportTorrent` returned. */
  shareExportedTorrent(path: string): Promise<EngineResult>;
  getFreeSpace(): Promise<EngineResult<FreeSpace>>;
  openLiveUpdateSettings(): Promise<void>;
  /** Opens the Android notification settings for the "Completed" channel (or the app page below API 26). */
  openNotificationSettings(channel?: 'completed'): Promise<void>;
  setGlobalLimits(down: number, up: number): Promise<EngineResult>;
  applyConfig(config: NativeConfig): Promise<EngineResult<{ restartRequired: boolean }>>;
  getEffectiveConfig(): Promise<EngineResult<NativeConfig>>;
  getPieceBitfield(id: string): Promise<number[]>;
  /** What this phone can decode and display (CodecProbe.kt). Cached natively for the process. */
  getPlaybackSupport(): Promise<PlaybackSupport>;
  streamUrl(id: string, fileIndex: number): Promise<EngineResult<{ url: string; mime: string }>>;
  version(): Promise<{ engine: string; version: string }>;
  // Storage
  pickDownloadFolder(): Promise<PickFolderResult>;
  /** Same picker, but the choice does not become the default download folder (used by Move). */
  pickFolder(): Promise<PickFolderResult>;
  getStorageStatus(): Promise<StorageStatus>;
  openFile(id: string, fileIndex: number): Promise<EngineResult>;
  shareFile(id: string, fileIndex: number): Promise<EngineResult>;
  openFolder(id: string): Promise<EngineResult>;
  // Wave 4 (NATIVE_CONTRACT section 11)
  /** 0 means no limit. Only error: NOT_FOUND. */
  setTorrentLimits(id: string, limits: TorrentLimits): Promise<EngineResult>;
  /** Returns at once; the move runs in the engine and shows as state MOVING. */
  moveStorage(id: string, target: MoveTarget): Promise<EngineResult>;
  /** Opens the stream in a player chooser. UNSUPPORTED when no player is installed. */
  openStream(url: string, mime: string, title: string): Promise<EngineResult>;
  setSchedule(config: ScheduleConfig): Promise<EngineResult>;
  getScheduleStatus(): Promise<ScheduleStatus>;
  setFeedAutomation(config: FeedAutomationConfig): Promise<EngineResult>;
  getFeedAutomationStatus(): Promise<FeedAutomationStatus>;
  runFeedCheckNow(): Promise<EngineResult>;
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

export type CodecSupport = 'hardware' | 'software' | 'none' | 'unknown';

/** Device decode and display support. Display fields are null when the phone cannot say. */
export interface PlaybackSupport {
  avc: CodecSupport;
  hevc: CodecSupport;
  /** HEVC Main10 profile. */
  hevc10: CodecSupport;
  av1: CodecSupport;
  /** AV1 Main10 profile. */
  av1_10: CodecSupport;
  vp9: CodecSupport;
  dolbyVision: CodecSupport;
  hdr10: boolean | null;
  hdr10plus: boolean | null;
  hlg: boolean | null;
  /** True only for the dev mock. Never set by the native probe. */
  mock?: boolean;
}
