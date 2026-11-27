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
 * Why a torrent is stopped by its own condition. While set the engine keeps
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

/** Reserved: user, seed_limit. Any other value is a governance tag from Kotlin or a health tag. */
export type PausedBy =
  | 'user'
  | 'wifi_only'
  | 'battery'
  | 'charging_only'
  | 'seed_limit'
  | 'fgs_timeout'
  | 'schedule'
  /** Connected but not validated (captive portal). */
  | 'network_unvalidated'
  /** `network.vpnOnly` is on and no VPN is connected. */
  | 'vpn_required'
  /** Finished torrent on a metered link while `network.seedOnMobileData` is off. */
  | 'seed_metered'
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
  /** "Resume anyway" is active, so the Wi-Fi, battery, charging, schedule and seeding rules do not pause it. */
  allowedAnyway?: boolean;
  error?: { code: string; message: string } | null;
  outputFolder?: string;
  addedAt?: number;
  /** Per-torrent limits in bytes per second. 0 or undefined = no limit. */
  downLimitBps?: number;
  upLimitBps?: number;
  /** 0 to 1 while MOVING, otherwise null or undefined. */
  moveProgress?: number | null;
  /** Null or undefined when the torrent is healthy. */
  health?: HealthTag | null;
  /** Sum of the included, non-padding file lengths. */
  includedBytes?: number;
  /** Name of the largest included file, null until the metadata is known. Picks the card's file icon. */
  mainFile?: string | null;
  /** Downloaded bytes of every file, skipped ones too. Absent from an older engine. */
  heldBytes?: number;
  /** Web seeds configured for the torrent. */
  webSeeds?: number;
  /** Seconds a magnet has been looking for its metadata, null once it has it. */
  resolvingSecs?: number | null;
  /** Seconds spent downloading (not paused, queued, waiting, checking or seeding). 0 for items from before 0.26: show "—". */
  activeSecs?: number;
  /** Unix seconds when the item first finished. 0 until then. */
  finishedAt?: number;
  /** Payload bytes this engine downloaded for the item (not bytes already on disk). Average speed = sessionBytes / activeSecs. */
  sessionBytes?: number;
  /** Of the bytes moved (downloaded, plus uploaded for a torrent): on an unmetered link. */
  bytesWifi?: number;
  /** The same on a metered link. */
  bytesMobile?: number;
  /** Seconds a torrent with metadata has waited with no peer and no byte, null otherwise. */
  stalledSecs?: number | null;
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
// Native engine types, camelCase on the JS side.
// NativeConfig is the exception: it is passed to Rust as-is, so it keeps snake_case keys.
// ---------------------------------------------------------------------------

/** `UNSUPPORTED` is added by the bridge when no engine can answer. */
export type SubtitleErrorCode =
  | 'FILE_TOO_SMALL'
  | 'NOT_FOUND'
  | 'IO'
  | 'NAME_TAKEN'
  | 'REPLACE_DENIED'
  | 'VERIFY_FAILED'
  | 'CANT_WRITE'
  | 'NO_SPACE'
  | 'ARCHIVE_UNSAFE'
  | 'UNSUPPORTED';

export interface SubtitleError extends Error {
  code: SubtitleErrorCode;
}

/** An Error carrying a subtitle error code, the way a native rejection does. */
export function subtitleError(code: SubtitleErrorCode, message: string): SubtitleError {
  return Object.assign(new Error(message), { code }) as SubtitleError;
}

export interface SubtitleHashResult {
  /** 16 lowercase hex digits. */
  hash: string;
  /** File size in bytes. */
  bytes: number;
}

export interface SubtitleSaveResult {
  /** Path or document URI of the file that was written. */
  path: string;
}

export interface SubtitleZipEntry {
  name: string;
  base64: string;
}

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
  | 'INTERNAL'
  /** URL downloads. */
  | 'HTTP_STATUS'
  | 'AUTH_REQUIRED'
  /** A 403 with no sign-in details: the site refused the link. Never retried by itself. */
  | 'LINK_REFUSED'
  | 'LINK_EXPIRED'
  | 'FILE_CHANGED'
  | 'NOT_A_FILE'
  | 'CHECKSUM_MISMATCH'
  /** Opening a finished download: no app can open it. */
  | 'LAN_ADDRESS'
  | 'NO_APP'
  /** The server stopped sending data and the retries ran out. */
  | 'STALLED'
  /** Saving HLS and DASH streams. */
  | 'STREAM_PROTECTED'
  | 'STREAM_LIVE'
  | 'STREAM_UNSUPPORTED'
  | 'MUX_FAILED'
  /** Video sites (prototype). */
  | 'SITE_NOT_SUPPORTED'
  | 'SITE_NEEDS_LOGIN'
  | 'SITE_NO_VIDEO'
  | 'SITE_FAILED'
  | 'VIDEO_SITES_UNAVAILABLE';

/** Progress of a magnet looking for its metadata. */
export interface ResolveActivity {
  peersFound: number;
  dht: boolean;
  elapsedMs: number;
}

export type EngineResult<T = object> =
  | ({ ok: true } & T)
  | {
      ok: false;
      code: EngineErrorCode;
      message: string;
      id?: string;
      retryAfterSecs?: number;
      mergedTrackers?: number;
      /** Set with `HTTP_STATUS` (and `AUTH_REQUIRED`, `LINK_REFUSED`): the status the server answered. */
      httpStatus?: number;
    };

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
  /** Seconds to wait for peers before `no_peers`; 0 = never. */
  peer_timeout_secs: number;
  proxy_url: string | null;
  ip_filter_path: string | null;
}

/** `unreadable`: the setting is on but the file is missing, empty or has no rule we can read. */
export type BlocklistState = 'off' | 'on' | 'unreadable';

export interface BlocklistStatus {
  state: BlocklistState;
  /** Rules loaded. 0 unless `state` is `on` (and 0 on `on` for a gzip list not read yet). */
  rules: number;
}

/**
 * What `getEffectiveConfig` answers: the saved config (snake_case, as `NativeConfig`) plus two
 * camelCase fields. `restartPending` is true while the running session differs from the saved config in a
 * restart-required field (proxy, listening port, UPnP, DHT, local peer discovery, blocklist, connections per torrent).
 */
export interface EffectiveConfig extends NativeConfig {
  restartPending: boolean;
  blocklist: BlocklistStatus;
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
  /** Web seeds configured for the torrent. 0 when none. */
  webSeeds: number;
  etaSecs: number; // -1 = unknown
  ratio: number;
  seedingSecs: number;
  addedAt: number;
  outputFolder: string;
  error: SnapshotError | null;
  /** 0 = no per-torrent limit. */
  downLimitBps: number;
  upLimitBps: number;
  /** 0 to 1, non-null only while MOVING. */
  moveProgress: number | null;
  /** Why the torrent is stopped by its own condition. Null when healthy. */
  health: HealthTag | null;
  /** `pendingNeed = sum(max(0, includedBytes - progressBytes))` over unfinished torrents. */
  includedBytes: number;
  /** Name of the largest included file, null until the metadata is known. Absent from an older engine. */
  mainFile?: string | null;
  /** What deleting the files frees: downloaded bytes of every file, skipped ones too. */
  heldBytes?: number;
  /** Seconds a magnet has been looking for its metadata; null once it has it. */
  resolvingSecs: number | null;
  /** Seconds a torrent with metadata has waited with no peer and no byte; null otherwise. */
  stalledSecs?: number | null;
  /** Absent from an older engine. */
  allowedAnyway?: boolean;
  /** Seconds spent downloading (not paused, queued, waiting, checking or seeding). 0 for items from before 0.26: show "—". */
  activeSecs?: number;
  /** Unix seconds when the item first finished. 0 until then. */
  finishedAt?: number;
  /** Payload bytes this engine downloaded for the item (not bytes already on disk). Average speed = sessionBytes / activeSecs. */
  sessionBytes?: number;
  /** Of the bytes moved (downloaded, plus uploaded for a torrent): on an unmetered link. */
  bytesWifi?: number;
  /** The same on a metered link. */
  bytesMobile?: number;
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
  /** `included` is derived from it (`skip` means not included). */
  priority: FilePriority;
  /** Contiguous downloaded bytes from the start of the file. */
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

/** Whether a file is as expected, gone, or changed outside Maglev. */
export type FileHealthState = 'ok' | 'missing' | 'changed';

export interface FileHealthEntry {
  index: number;
  state: FileHealthState;
}

/** `stop` and `again` take the file indices, `folder` takes a folder path, `recheck` takes neither. */
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
  /** 0 or absent = no limit. */
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

export interface NetworkState {
  /** True on any link that is not an unmetered Wi-Fi or Ethernet one (mobile data, or Wi-Fi marked metered). */
  metered: boolean;
  connected: boolean;
}

/** Pushed whenever the default network changes while a listener is attached. Same meaning as {@link NetworkState}. */
export interface NetworkChangeEvent {
  connected: boolean;
  metered: boolean;
}

export interface GovernanceConfig {
  wifiOnly: boolean;
  ssidWhitelist: string[];
  chargingOnly: boolean;
  batteryCutoffPct: number;
  autoExitOnComplete: boolean;
  /** Restart unfinished transfers after a reboot or app update. */
  resumeAfterRestart: boolean;
  /** Pause while the active network is not a VPN. */
  vpnOnly: boolean;
  /** Keep seeding on mobile data. Default false. */
  seedOnMobileData: boolean;
  /** Quick share: add a shared magnet, .torrent or file link without the card. Saved for Kotlin. */
  quickAdd?: boolean;
  /** Quick share card theme: the saved Appearance mode. */
  appearanceMode?: 'oled' | 'dim' | 'light' | 'system';
}

export type NotificationActionName = 'pause_all' | 'resume_all' | 'shutdown';

export interface TelemetryEvent {
  torrents: Snapshot[];
  /** Downloads from http(s) links. Missing from an older engine. */
  downloads?: DownloadSnapshot[];
}

// ---------------------------------------------------------------------------
// Downloads from any link.
// ---------------------------------------------------------------------------

export type DownloadState =
  | 'resolving'
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'finished'
  | 'needs_link'
  | 'error';

export interface DownloadError {
  code: Extract<
    EngineErrorCode,
    'HTTP_STATUS' | 'AUTH_REQUIRED' | 'LINK_REFUSED' | 'LINK_EXPIRED' | 'FILE_CHANGED' | 'NOT_A_FILE' | 'CHECKSUM_MISMATCH' | 'NETWORK' | 'PERMISSION' | 'STALLED' | 'LAN_ADDRESS' | 'LOCAL_REDIRECT' | 'BLOCKED' | 'STREAM_PROTECTED' | 'STREAM_LIVE' | 'STREAM_UNSUPPORTED' | 'MUX_FAILED'
  >;
  message: string;
  httpStatus?: number | null;
}

export interface DownloadSnapshot {
  id: string;
  /** Scheme, host and path only. Never a user name, password or query. */
  urlDisplay: string;
  name: string;
  state: DownloadState;
  /** Why a `paused` download is stopped: `user`, `storage_full`, or a governance tag. */
  pausedBy: string | null;
  /** "Resume anyway" is active for this download. Absent means false. */
  allowedAnyway?: boolean;
  /** The page a browser download was found on, or null. Without its query when that looked like a secret. */
  pageUrl?: string | null;
  /** Bytes, or null while the server has not said. */
  size: number | null;
  downloaded: number;
  downBps: number;
  /** Seconds left, -1 = unknown. */
  eta: number;
  segmentsActive: number;
  /** This download's own speed limit in bytes per second. 0 = no limit. Saved, so it survives a restart. */
  downLimitBps: number;
  resumable: boolean;
  folder: string;
  addedAt: number;
  error: DownloadError | null;
  /** A one-line note, for example "Server sent the whole file again; starting over." */
  notice?: string | null;
  /** True while downloading but no bytes arrived for 30 s. Absent means false. */
  stalled?: boolean;
  /** Set for a saved HLS or DASH stream. `size` is an estimate until it finishes. */
  stream?: DownloadStream | null;
  /** True while the video and audio parts of a stream are being joined (state `verifying`). */
  muxNeeded?: boolean;
  /** Seconds spent downloading and then joining separate video and audio parts (not paused, queued or waiting). 0 for items from before 0.26: show "—". */
  activeSecs?: number;
  /** Unix seconds when the item first finished. 0 until then. */
  finishedAt?: number;
  /** Payload bytes this engine downloaded for the item (not bytes already on disk). Average speed = sessionBytes / activeSecs. */
  sessionBytes?: number;
  /** Of the bytes moved (downloaded, plus uploaded for a torrent): on an unmetered link. */
  bytesWifi?: number;
  /** The same on a metered link. */
  bytesMobile?: number;
}

/** The adaptive stream format of a saved link. */
export type StreamKind = 'hls' | 'dash';

export interface DownloadStream {
  kind: StreamKind;
  segmentsDone: number;
  segmentsTotal: number;
}

/** Which quality (and audio track) of a stream to save. Ids come from `probeStream`. */
export interface StreamSelection {
  kind: StreamKind;
  variantId: string;
  audioId?: string | null;
}

export interface StreamVariant {
  id: string;
  height: number | null;
  width: number | null;
  bandwidth: number;
  codecs: string | null;
  /** `bandwidth / 8 x duration`, null when either is unknown. */
  estBytes: number | null;
  /** `muxed` (audio inside), `separate` (its own track, joined at the end) or `none`. */
  audio: 'muxed' | 'separate' | 'none';
}

export interface StreamAudioTrack {
  id: string;
  lang: string | null;
  name: string | null;
  bandwidth: number | null;
}

/** Variants are sorted by height, tallest first. */
export interface StreamProbe {
  kind: StreamKind;
  title: string | null;
  durationSec: number;
  variants: StreamVariant[];
  audioTracks: StreamAudioTrack[];
}

export interface DownloadOptions {
  name?: string | null;
  folder?: string | null;
  paused?: boolean;
  /** 1 to 8. The engine downloads on one connection today. */
  segments?: number;
  headers?: {
    Cookie?: string;
    Referer?: string;
    'User-Agent'?: string;
    /** The page's origin ("https://host"). Streams send it on every request. */
    Origin?: string;
    /** WebView jar cookies per host. Streams send each host its own. */
    Cookies?: { host: string; cookie: string }[];
  };
  /** Refused with UNSUPPORTED until the engine can check it. */
  expectedHash?: { alg: 'sha256'; hex: string };
  downLimitBps?: number;
  /** The user allowed the typed host even though it is on their own network. The module sends it as `allow_lan`. */
  allowLan?: boolean;
  /**
   * The page the link was found on (in-app browser). The engine keeps it as
   * `pageUrl` on the download so the app can load the page again when the link expires or is refused. Saved without
   * its query when the query looks like a secret. Also accepted by `refreshDownloadUrl`, to update it.
   */
  pageUrl?: string;
  /** Save an HLS or DASH stream. The link is the playlist. */
  stream?: StreamSelection;
  /**
   * A video file and an audio file from a video site, joined at the end. The link passed to
   * `addDownload` is the video file's. `size` is set only when the site states it exactly. Not with `stream`.
   */
  parts?: { video: { url: string; size?: number }; audio: { url: string; size?: number } };
}

export interface UrlProbe {
  name: string;
  size: number | null;
  resumable: boolean;
  urlDisplay: string;
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

/** `path` is the plain folder path when Maglev can write there directly, null when the folder is staged. */
export type PickFolderResult = ({ ok?: true; path?: string | null } & DownloadFolder) | { cancelled: true };

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
// Scheduler and feeds
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
  | { kind: 'unavailable'; message: string; /** Engine error code of the failed start, when known. */ code?: string };

export type Unsubscribe = () => void;

/** The native engine API. Every method resolves a Result envelope. */
export interface MaglevEngineApi {
  // Engine
  init(config: NativeConfig): Promise<EngineResult>;
  shutdown(): Promise<EngineResult>;
  resolveMetadata(source: string, timeoutMs: number): Promise<EngineResult<Metadata>>;
  /** Peers seen while a magnet resolves; NOT_FOUND when no resolve is running. */
  getResolveActivity(infoHash: string): Promise<EngineResult<ResolveActivity>>;
  /** The pending `resolveMetadata` then returns CANCELLED. */
  cancelResolve(infoHash: string): Promise<EngineResult>;
  addTorrent(source: string, options: AddTorrentOptions): Promise<EngineResult<{ id: string; infoHash: string }>>;
  listTorrents(): Promise<EngineResult<{ torrents: Snapshot[]; downloads?: DownloadSnapshot[] }>>;
  getDetail(id: string): Promise<EngineResult<Detail>>;
  pause(id: string): Promise<EngineResult>;
  resume(id: string): Promise<EngineResult>;
  /** Resume and exempt this torrent from the rule pauses until it finishes, is removed or is paused. */
  resumeAnyway(id: string): Promise<EngineResult>;
  recheck(id: string): Promise<EngineResult>;
  pauseAll(): Promise<EngineResult>;
  resumeAll(): Promise<EngineResult>;
  delete(id: string, deleteFiles: boolean): Promise<EngineResult>;
  setIncludedFiles(id: string, indices: number[]): Promise<EngineResult>;
  /** Covers every file. Unknown index or all `skip` returns INVALID_SOURCE. */
  setFilePriorities(id: string, priorities: FilePriorityEntry[]): Promise<EngineResult>;
  /**
   * Stops downloading those files, deletes their data and frees the space; pieces shared with a
   * kept file are downloaded again. INVALID_SOURCE for an unknown index or when no included file would remain,
   * UNSUPPORTED while the torrent is moving or checking.
   */
  removeFiles(id: string, indices: number[]): Promise<EngineResult<{ freedBytes: number }>>;
  /**
   * `tag` is a health tag, or "" to clear it. Clearing `files_missing` or `storage_unavailable`
   * runs the files check first: if files are still gone the torrent stays stopped under `files_missing`.
   * INVALID_ARGUMENT for an unknown tag, NOT_FOUND for an unknown torrent.
   */
  setHealth(id: string, tag: HealthTag | ''): Promise<EngineResult>;
  /** One file scan now (the engine also scans every 30 s). `changed` counts torrents whose tag changed. */
  scanFileHealth(): Promise<EngineResult<{ changed: number }>>;
  /** The included files only. A torrent that can't be judged right now reports every file `ok`. */
  fileHealth(id: string): Promise<EngineResult<{ files: FileHealthEntry[] }>>;
  /**
   * What to do about missing or changed files. `folder` answers FILES_MISSING with
   * "Those files aren't in that folder." when they are not there. NOT_FOUND, INVALID_ARGUMENT, INVALID_STATE
   * (moving or checking).
   */
  resolveFiles(id: string, action: ResolveFilesAction, indices: number[], dir: string): Promise<EngineResult>;
  /** Only while DOWNLOADING or SEEDING. Rate limited to once per 60 s per torrent. */
  reannounce(id: string): Promise<EngineResult<{ retryAfterSecs?: number }>>;
  /**
   * One announce URL per entry (http, https or udp). Nothing is added unless every one is valid
   * (INVALID_ARGUMENT). Private torrents refuse (UNSUPPORTED). `announced` is true when a running torrent asked the new trackers at once.
   */
  addTrackers(id: string, urls: string[]): Promise<EngineResult<TrackersAdded>>;
  /** Removing the last tracker is allowed. NOT_FOUND when the torrent or the tracker is not there. */
  removeTracker(id: string, url: string): Promise<EngineResult<{ announced: boolean }>>;
  /** Writes `<name>.torrent` to the download folder. NOT_READY while a magnet still has no metadata. */
  exportTorrent(id: string): Promise<EngineResult<TorrentExport>>;
  /** Opens the share sheet for a file `exportTorrent` returned. */
  shareExportedTorrent(path: string): Promise<EngineResult>;
  getFreeSpace(): Promise<EngineResult<FreeSpace>>;
  openLiveUpdateSettings(): Promise<void>;
  /** Opens the Android notification settings for the "Completed" channel (or the app page below API 26). */
  openNotificationSettings(channel?: 'completed'): Promise<void>;
  setGlobalLimits(down: number, up: number): Promise<EngineResult>;
  applyConfig(config: NativeConfig): Promise<EngineResult<{ restartRequired: boolean }>>;
  getEffectiveConfig(): Promise<EngineResult<EffectiveConfig>>;
  /**
   * Debug log. Writes a text file to the app cache (version, phone, settings without secrets,
   * the last 2,000 log lines, URL queries removed) and resolves with its content:// uri. Share it with `shareDebugLog`.
   */
  exportDebugLog(): Promise<EngineResult<{ uri: string }>>;
  /** Opens the system share sheet for a uri `exportDebugLog` returned. */
  shareDebugLog(uri: string): Promise<EngineResult>;
  /**
   * Applies the restart-required settings now: stops the session (resume data saved, link
   * downloads checkpointed), starts it again from the saved config, and puts transfers back as they were (a paused one
   * stays paused). Resolves when the session is up again. INVALID_STATE while another restart runs; ENGINE_UNAVAILABLE
   * when the session can't start (call it again to retry). Telemetry refreshes the UI; `restartPending` is false after.
   */
  restartEngine(): Promise<EngineResult>;
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
  /** Opens a link download's folder in any state (downloading, paused, finished). Same result as `openFolder`. NOT_FOUND when the id or folder is unknown or no file manager can open it. */
  openDownloadFolder(id: string): Promise<EngineResult>;
  // Scheduler and feeds
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
  /** Launcher icon id now chosen. 'teal' when it cannot be read. */
  getAppIcon(): Promise<string>;
  /** Choose a launcher icon. Native applies it when the app leaves the foreground. Unknown id: INVALID_ARGUMENT. */
  setAppIcon(id: string): Promise<EngineResult>;
  requestLegacyStorage(): Promise<EngineResult>;
  // Subtitles. These reject with an Error whose `code` is a SubtitleErrorCode.
  /** OpenSubtitles 64-bit hash of a finished video (POSIX path or SAF document URI). Errors: FILE_TOO_SMALL, NOT_FOUND, IO. */
  subtitleHash(pathOrUri: string): Promise<SubtitleHashResult>;
  /**
   * Writes a subtitle next to the video. `videoPathOrUri` is an absolute POSIX path, `file://` path or a SAF document
   * URI inside a granted tree. Errors: NAME_TAKEN (name exists and `replace` is false), VERIFY_FAILED, CANT_WRITE, NO_SPACE.
   */
  saveSubtitle(videoPathOrUri: string, fileName: string, base64: string, replace: boolean): Promise<SubtitleSaveResult>;
  /** Subtitle members (.srt/.ass/.ssa/.vtt, base name) of a zip, in memory. Error: ARCHIVE_UNSAFE. */
  unzipSubtitles(base64: string): Promise<SubtitleZipEntry[]>;
  // In-app updates
  /** Who installed Maglev. `managedBy` is non-null when F-Droid, Obtainium, Google Play, Accrescent or another app store owns updates. */
  getInstallSource(): Promise<InstallSource>;
  /** Downloads and verifies the APK. Errors: NETWORK, HTTP_STATUS, STORAGE_FULL, BLOCKED (VPN only and no VPN), UPDATE_INVALID, MANAGED, CANCELLED. */
  downloadUpdate(url: string, sha256: string, size: number, requireVpn: boolean): Promise<EngineResult<{ path: string }>>;
  /** Online, on a metered link, on a VPN: the facts the update rules need. */
  getUpdateNetwork(): Promise<EngineResult<UpdateNetwork>>;
  cancelUpdateDownload(): Promise<EngineResult>;
  /** Errors: UPDATE_INVALID, MANAGED, INSTALL_FAILED, STORAGE_FULL. */
  /** `sha256` is the release hash from `pending`; native verifies against it, not the file name. */
  installUpdate(path: string, silent: boolean, sha256: string): Promise<EngineResult<{ status: 'started' | 'needs_permission' | 'needs_user' }>>;
  /** Opens "Install unknown apps" for Maglev. */
  openInstallPermissionSettings(): Promise<EngineResult>;
  /** Deletes downloaded updates except the pending one. */
  cleanupUpdates(keepPath: string | null, keepSha?: string | null): Promise<EngineResult>;
  /** kind: "available" or "ready". For "ready", `path` and `sha256` make the notice's Install action start the install. */
  postUpdateNotice(kind: 'available' | 'ready', version: string, path?: string | null, sha256?: string | null): Promise<EngineResult>;
  clearUpdateNotice(kind: 'available' | 'ready'): Promise<EngineResult>;
  // Lists that update themselves
  /** True only when `sigB64` is a valid ECDSA P-256 signature of `body` under the key embedded in the app. Never throws. */
  verifyListSignature(body: string, sigB64: string): Promise<boolean>;
  // Governance
  setGovernance(config: GovernanceConfig): Promise<EngineResult>;
  /** Every rule holding transfers right now. Empty when nothing blocks. Never throws. */
  getActiveBlocks(): Promise<ActiveBlock[]>;
  /** Fires with the full list whenever it changes. Returns an unsubscribe function. */
  addBlocksListener(listener: (blocks: ActiveBlock[]) => void): () => void;
  // URL downloads
  probeUrl(url: string, options: DownloadOptions, timeoutMs: number): Promise<EngineResult<UrlProbe>>;
  /** Errors: STREAM_PROTECTED, STREAM_LIVE, STREAM_UNSUPPORTED, plus the probeUrl ones. */
  probeStream(url: string, options: DownloadOptions, timeoutMs: number): Promise<EngineResult<StreamProbe>>;
  addDownload(url: string, options: DownloadOptions): Promise<EngineResult<{ id: string }>>;
  /** (Prototype.) The page's files as trimmed yt-dlp JSON text. Never throws. */
  videoSitesResolve(url: string): Promise<EngineResult<{ json: string }>>;
  /** The yt-dlp version the app downloaded itself, or null while the bundled one is in use. */
  videoSitesVersion(): Promise<string | null>;
  /** The yt-dlp version in use (null while the bundled one is) and when it was last checked (epoch ms, null if never). */
  videoSitesStatus(): Promise<{ version: string | null; lastCheckAt: number | null }>;
  /** Schedules (enabled) or cancels the daily background yt-dlp update; `mobileData` also allows a metered network. */
  videoSitesConfigure(enabled: boolean, mobileData: boolean): Promise<void>;
  /** Downloads the newest yt-dlp. `failed` is a normal answer (no network), not an error. */
  videoSitesUpdate(): Promise<EngineResult<{ status: 'updated' | 'current' | 'failed'; version: string | null }>>;
  pauseDownload(id: string): Promise<EngineResult>;
  resumeDownload(id: string): Promise<EngineResult>;
  /** The same for a link download. */
  resumeDownloadAnyway(id: string): Promise<EngineResult>;
  /** After FILE_CHANGED this restarts from zero. */
  retryDownload(id: string): Promise<EngineResult>;
  removeDownload(id: string, deleteFiles: boolean): Promise<EngineResult>;
  /** Allows the download's host and pins its addresses. Does not retry: call `retryDownload` next. NOT_FOUND, INVALID_STATE (not LAN_ADDRESS), NETWORK (host does not resolve). */
  allowLanHost(id: string): Promise<EngineResult>;
  /** Opens a finished download in another app. NO_APP when none can open it. */
  openDownload(id: string): Promise<EngineResult>;
  /** Opens the share sheet for a finished download. NOT_FOUND, INVALID_STATE (not finished). */
  shareDownload(id: string): Promise<EngineResult>;
  /** Whether the phone is online and on mobile data. Cheap: reads the active network. */
  getNetworkState(): Promise<EngineResult<NetworkState>>;
  /** Only for `needs_link`. FILE_CHANGED when the new link is another file. */
  refreshDownloadUrl(id: string, url: string, options: DownloadOptions): Promise<EngineResult>;
  setDownloadLimits(id: string, limits: { downLimitBps: number }): Promise<EngineResult>;
  // Events
  onTelemetry(listener: (event: TelemetryEvent) => void): Unsubscribe;
  onTorrentCompleted(listener: (event: TorrentCompletedEvent) => void): Unsubscribe;
  onNotificationAction(listener: (event: NotificationActionEvent) => void): Unsubscribe;
  onStorageStatus(listener: (event: StorageStatus) => void): Unsubscribe;
  /** Online/offline and Wi-Fi/mobile-data changes. Native watches the network only while a listener is attached. */
  onNetworkChanged(listener: (event: NetworkChangeEvent) => void): Unsubscribe;
  onUpdateProgress(listener: (event: UpdateProgressEvent) => void): Unsubscribe;
  onUpdateResult(listener: (event: UpdateResultEvent) => void): Unsubscribe;
}

export type ManagedBy = 'fdroid' | 'obtainium' | 'play' | 'accrescent' | 'store';
export interface InstallSource {
  installer: string | null;
  managedBy: ManagedBy | null;
  /** The installed versionCode (base * 10 + ABI digit), or null when it cannot be read. */
  versionCode?: number | null;
}
export interface UpdateNetwork {
  connected: boolean;
  metered: boolean;
  vpn: boolean;
}
export interface UpdateProgressEvent {
  bytes: number;
  /** 0 when the server did not say. */
  total: number;
}
/** From the install session. `ok: true` carries `status`; `ok: false` carries a code and a plain message. */
export type UpdateResultEvent =
  | { ok: true; status: 'needs_user' | 'installed' }
  | { ok: false; code: string; message: string };

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

/**
 * One rule that is holding transfers right now, as Kotlin governance last judged it.
 * `tag` is the same string that lands in `pausedBy` (except `offline`, which torrents never carry).
 */
export type ActiveBlockTag =
  | 'wifi_only'
  | 'battery'
  | 'charging_only'
  | 'network_unvalidated'
  | 'vpn_required'
  | 'offline'
  | 'schedule'
  | 'storage_full'
  | 'seed_metered';

export interface ActiveBlock {
  tag: ActiveBlockTag;
  /** wifi_only: `metered` (on mobile data) or `ssid` (on a Wi-Fi network that is not in the allowed list). */
  cause?: 'metered' | 'ssid';
  /** battery: the cut-off from settings and the current level, both 0-100. */
  thresholdPct?: number;
  levelPct?: number;
  /** schedule: epoch ms when the schedule next allows transfers, or null when unknown. */
  resumesAtMs?: number | null;
  /** Epoch ms when this block started (Kotlin's clock). */
  sinceMs: number;
}
