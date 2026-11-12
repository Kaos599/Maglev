import type {
  AddTorrentOptions,
  AggregatedTelemetry,
  Detail,
  DownloadOptions,
  StreamProbe,
  EngineErrorCode,
  EngineResult,
  FeedAutomationConfig,
  FeedAutomationStatus,
  FileHealthEntry,
  FilePriorityEntry,
  FreeSpace,
  GovernanceConfig,
  HealthTag,
  MaglevEngineApi,
  Metadata,
  MoveTarget,
  NativeConfig,
  NativePermissionStatus,
  NotificationActionEvent,
  PausedBy,
  PickFolderResult,
  ResolveActivity,
  ResolveFilesAction,
  ScheduleConfig,
  ScheduleStatus,
  Snapshot,
  StorageStatus,
  PlaybackSupport,
  TelemetryEvent,
  TorrentCompletedEvent,
  TorrentDetailData,
  TorrentExport,
  TorrentFileInfo,
  TorrentLimits,
  TorrentState,
  TorrentTelemetry,
  TrackerInfo,
  TrackersAdded,
  Unsubscribe,
  UrlProbe,
} from './MaglevEngine.types.ts';
import { HEALTH_TAGS } from './MaglevEngine.types.ts';
import {
  DEFAULT_SETTINGS,
  type MaglevSettings,
  SPEED_PRESET_MAP,
} from './MaglevSettings.types.ts';
import { ipFilter } from './MaglevIpFilter.ts';
import { settingsStore } from './MaglevSettingsStore.ts';
import { parseSource, pseudoHash } from './magnet.ts';
import { checkTrackerLines, trackerKey } from './trackerUrl.ts';
import { restartReasons, toNativeConfig } from './toNativeConfig.ts';
import { MockDownloads } from './MaglevMockDownloads.ts';

const GOVERNANCE_TAGS: ReadonlySet<PausedBy | null> = new Set<PausedBy | null>(['wifi_only', 'battery', 'charging_only', 'network_unvalidated', 'vpn_required']);
const DEFAULT_PAYLOAD_BYTES = 1_610_612_736; // 1.5 GiB when a magnet carries no xl=

/** Thrown by the legacy synchronous `startTorrent`; carries the contract error code. */
export class MaglevEngineError extends Error {
  code: EngineErrorCode;
  id?: string;
  constructor(code: EngineErrorCode, message: string, id?: string) {
    super(message);
    this.name = 'MaglevEngineError';
    this.code = code;
    this.id = id;
  }
}

interface TorrentMeta {
  pausedBy: PausedBy | null;
  addedAt: number;
  priorState?: TorrentState;
  downLimitBps?: number;
  upLimitBps?: number;
  /** Simulated move (dev only): progress 0 to 1 and destination folder. */
  moveProgress?: number;
  moveDest?: string;
  /** NATIVE_CONTRACT 18.2. While set the torrent stays paused. */
  health?: HealthTag | null;
  /** NATIVE_CONTRACT 18.3 (dev only): files the simulator treats as deleted or changed outside Maglev. */
  fileStates?: Map<number, 'missing' | 'changed'>;
}

/** Messages for a Resume the engine refuses while a health tag is set, same as the Rust engine. */
const HEALTH_RESUME_REFUSAL: Partial<Record<HealthTag, { code: EngineErrorCode; message: string }>> = {
  files_missing: { code: 'FILES_MISSING', message: 'Some files are missing. Choose what to do with them first.' },
  files_changed: { code: 'UNSUPPORTED', message: 'Files were changed after downloading. Recheck them first.' },
  storage_unavailable: { code: 'UNSUPPORTED', message: "The SD card isn't there." },
  no_peers: { code: 'UNSUPPORTED', message: 'No one is sharing this yet. Tap Keep trying.' },
};

/** Simulated time a magnet needs to resolve (dev only). */
const MOCK_RESOLVE_MS = 7000;
const MOVE_STEPS = 6; // stepSimulation runs twice a second, so about 3 s
const DEFAULT_MOVE_DIR = '/storage/emulated/0/Download/Maglev';
const MAX_LIMIT_BPS = 4_294_967_295; // u32::MAX, larger values are clamped

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
};
function mimeFor(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream';
}

const ok = (): { ok: true } => ({ ok: true });
const fail = (code: EngineErrorCode, message: string, id?: string): EngineResult<any> =>
  id ? { ok: false, code, message, id } : { ok: false, code, message };

type Listener = (telemetry: AggregatedTelemetry) => void;

/**
 * Dev and web simulator. Implements the same `MaglevEngineApi` as the native module and enforces the
 * contract's validation and state rules. It also keeps a legacy synchronous surface (startTorrent,
 * getAggregatedTelemetry, stepSimulation, ...) used by the Node test suites.
 */
export class MaglevMockEngine implements MaglevEngineApi {
  private meta: Map<string, TorrentMeta> = new Map();
  private snapshotListeners: Set<(e: TelemetryEvent) => void> = new Set();
  private completedListeners: Set<(e: TorrentCompletedEvent) => void> = new Set();
  private notificationListeners: Set<(e: NotificationActionEvent) => void> = new Set();
  private storageListeners: Set<(e: StorageStatus) => void> = new Set();
  private nativeConfig: NativeConfig | null = null;
  private initialized = false;

  private torrents: Map<string, TorrentDetailData> = new Map();
  private pieceMatrices: Map<string, Uint8Array> = new Map();
  private listeners: Set<Listener> = new Set();
  private timer: any = null;
  private defaultStoragePath = '/storage/emulated/0/Android/data/com.maglev/files/Download';

  /** URL downloads (NATIVE_CONTRACT 17). They follow the same governance as torrents. */
  private downloads: MockDownloads = new MockDownloads({
    blockedReason: () => {
      if (this.socketsClamped) return 'wifi_only';
      const p = this.settings.power;
      if (!p.isCharging) {
        if (p.downloadOnlyWhileCharging) return 'charging_only';
        if (p.batteryCutoffThreshold > 0 && p.batteryPercentage < p.batteryCutoffThreshold) return 'battery';
      }
      return null;
    },
    folder: () => this.getDefaultStoragePath(),
    changed: () => this.broadcast(),
  });

  // System & Governance state
  private settings: MaglevSettings;
  private wakeLockHeld: boolean = false;
  private socketsClamped: boolean = false;
  private shutdownTriggered: boolean = false;

  constructor() {
    this.settings = JSON.parse(JSON.stringify(settingsStore.getSettings()));
    this.seedInitialMockData();
    this.recalculateGovernance();
    this.broadcast();

    // Subscribe to settings changes
    settingsStore.subscribe((newSettings) => {
      this.applySettings(newSettings);
    });
  }

  public getDefaultStoragePath(): string {
    return this.settings.storage.defaultPath || this.defaultStoragePath;
  }

  public getSettings(): MaglevSettings {
    return this.settings;
  }

  public getEffectiveDownloadLimit(): number {
    const bw = this.settings.bandwidth;
    if (bw.downloadPreset !== 'UNLIMITED' && bw.downloadPreset !== 'CUSTOM') {
      return SPEED_PRESET_MAP[bw.downloadPreset] || 0;
    }
    return bw.downloadLimitBytesPerSec;
  }

  public getEffectiveUploadLimit(): number {
    const bw = this.settings.bandwidth;
    if (bw.uploadPreset !== 'UNLIMITED' && bw.uploadPreset !== 'CUSTOM') {
      return SPEED_PRESET_MAP[bw.uploadPreset] || 0;
    }
    return bw.uploadLimitBytesPerSec;
  }

  public applySettings(settings: MaglevSettings): void {
    this.settings = JSON.parse(JSON.stringify(settings));
    this.nativeConfig = null;
    this.recalculateGovernance();
    this.broadcast();
  }

  public updateNetworkState(state: {
    networkType: 'WIFI' | 'CELLULAR' | 'NONE';
    ssid?: string;
  }): void {
    this.settings.network.networkType = state.networkType;
    if (state.ssid !== undefined) {
      this.settings.network.currentSsid = state.ssid;
    }
    this.recalculateGovernance();
    this.broadcast();
  }

  public updatePowerState(state: {
    isCharging: boolean;
    batteryPercentage: number;
  }): void {
    this.settings.power.isCharging = state.isCharging;
    this.settings.power.batteryPercentage = state.batteryPercentage;
    this.recalculateGovernance();
    this.broadcast();
  }

  public isSocketsClamped(): boolean {
    return this.socketsClamped;
  }

  public isWakeLockHeld(): boolean {
    return this.wakeLockHeld;
  }

  public isShutdownTriggered(): boolean {
    return this.shutdownTriggered;
  }

  public loadIpFilterDat(content: string): number {
    const count = ipFilter.parseDatContent(content);
    this.settings.network.ipFilterRulesCount = count;
    this.settings.network.ipFilterEnabled = count > 0;
    settingsStore.updateSettings({
      network: {
        ...this.settings.network,
        ipFilterEnabled: count > 0,
        ipFilterRulesCount: count,
      },
    });
    return count;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    // Immediately emit current state
    listener(this.getAggregatedTelemetry());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getAggregatedTelemetry(): AggregatedTelemetry {
    let totalDown = 0;
    let totalUp = 0;
    let activeDown = 0;
    let activeUp = 0;
    const items: TorrentTelemetry[] = [];

    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING') {
        totalDown += t.downloadSpeedBytes;
        activeDown++;
      } else if (t.state === 'SEEDING') {
        totalUp += t.uploadSpeedBytes;
        activeUp++;
      }
      items.push({
        id: t.id,
        name: t.name,
        state: t.state,
        downloadSpeedBytes: t.downloadSpeedBytes,
        uploadSpeedBytes: t.uploadSpeedBytes,
        progressPercent: t.progressPercent,
        downloadedBytes: t.downloadedBytes,
        uploadedBytes: t.uploadedBytes,
        totalSizeBytes: t.totalSizeBytes,
        etaSeconds: t.etaSeconds,
        peersConnected: t.peersConnected,
        peersTotal: t.peersTotal,
        seedsConnected: t.seedsConnected,
        ratio: t.ratio,
        sequential: t.sequential,
        seedDurationSeconds: t.seedDurationSeconds,
      });
    });

    return {
      totalDownloadSpeedBytes: totalDown,
      totalUploadSpeedBytes: totalUp,
      activeDownloads: activeDown,
      activeUploads: activeUp,
      torrents: items,
    };
  }

  /** Legacy synchronous add. Returns the torrent id; throws MaglevEngineError on INVALID_SOURCE / DUPLICATE. */
  public startTorrent(
    source: string,
    savePathOverride?: string,
    sequential: boolean = false,
    selectedFileIndices?: number[]
  ): string {
    const r = this.addInternal(source, {
      outputFolder: savePathOverride ?? null,
      sequential,
      onlyFiles: selectedFileIndices ?? null,
    });
    if (r.ok === false) throw new MaglevEngineError(r.code, r.message, r.id);
    return r.id;
  }

  private addInternal(
    source: string,
    options: AddTorrentOptions
  ): EngineResult<{ id: string; infoHash: string }> {
    const parsed = parseSource(source);
    if (!parsed) {
      return fail('INVALID_SOURCE', 'Not a valid magnet link (needs an info-hash) or .torrent source.');
    }
    const id = parsed.infoHash;
    if (this.torrents.has(id)) {
      // NATIVE_CONTRACT 21: the new source's trackers are merged into the existing torrent.
      const t = this.torrents.get(id)!;
      const have = new Set(t.trackers.map((tr) => trackerKey(tr.url)));
      const fresh: string[] = [];
      for (const url of parsed.trackers) {
        const key = trackerKey(url);
        if (!have.has(key)) {
          have.add(key);
          fresh.push(url);
        }
      }
      for (const url of fresh) t.trackers.push({ url, status: 'Announcing', seeds: 0, peers: 0 });
      if (fresh.length > 0) this.broadcast();
      return { ok: false, code: 'DUPLICATE', message: 'This torrent is already in your list.', id, mergedTrackers: fresh.length };
    }
    const name = parsed.name || `Torrent_${id.slice(0, 8)}`;
    const totalSize = parsed.exactLength && parsed.exactLength > 5120 ? parsed.exactLength : DEFAULT_PAYLOAD_BYTES;
    const only = options.onlyFiles && options.onlyFiles.length > 0 ? options.onlyFiles : null;
    const fp = options.filePriorities && options.filePriorities.length > 0 ? options.filePriorities : null;
    if (fp) {
      const bad = this.validatePriorities(fp, 3);
      if (bad) return fail('INVALID_SOURCE', bad);
    }
    const active = (i: number) => {
      if (fp) {
        const p = fp.find((e) => e.index === i)?.priority;
        return (p === 'first' ? 2 : p === 'skip' ? 0 : 1) as 0 | 1 | 2;
      }
      return (!only || only.includes(i) ? 1 : 0) as 0 | 1 | 2;
    };

    const files: TorrentFileInfo[] = [
      { index: 0, name, path: name, length: totalSize - 5120, progress: 0, priority: active(0) },
      { index: 1, name: `${name}.sha256`, path: `${name}.sha256`, length: 1024, progress: 0, priority: active(1) },
      { index: 2, name: 'release-notes.txt', path: 'release-notes.txt', length: 4096, progress: 0, priority: active(2) },
    ];
    const trackers: TrackerInfo[] = (parsed.trackers.length ? parsed.trackers : ['udp://tracker.opentrackr.org:1337/announce']).map(
      (url) => ({ url, status: 'Working' as const, seeds: 0, peers: 0 })
    );

    const effectiveSavePath =
      options.outputFolder ||
      (this.settings.storage.storageMode === 'SAF' && this.settings.storage.customSafPath
        ? this.settings.storage.customSafPath
        : this.settings.storage.defaultPath);

    const effDown = this.getEffectiveDownloadLimit();
    const baseDownSpeed = effDown > 0 ? effDown : 14_800_000;
    const paused = !!options.paused;

    const newTorrent: TorrentDetailData = {
      id,
      name,
      state: paused ? 'PAUSED' : 'DOWNLOADING',
      downloadSpeedBytes: paused ? 0 : baseDownSpeed,
      uploadSpeedBytes: 0,
      progressPercent: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      totalSizeBytes: totalSize,
      etaSeconds: Math.floor(totalSize / baseDownSpeed),
      peersConnected: 0,
      peersTotal: 0,
      seedsConnected: 0,
      ratio: 0.0,
      sequential: !!options.sequential,
      seedDurationSeconds: 0,
      savePath: effectiveSavePath,
      piecesTotal: 256,
      piecesVerified: 0,
      files,
      trackers,
    };

    this.pieceMatrices.set(id, new Uint8Array(256));
    this.torrents.set(id, newTorrent);
    this.meta.set(id, { pausedBy: paused ? 'user' : null, addedAt: Math.floor(Date.now() / 1000) });
    this.recalculateGovernance();
    this.broadcast();
    return { ok: true, id, infoHash: id };
  }

  public pauseTorrent(id: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    t.state = 'PAUSED';
    this.metaOf(id).pausedBy = 'user';
    t.downloadSpeedBytes = 0;
    t.uploadSpeedBytes = 0;
    this.recalculateGovernance();
    this.broadcast();
    return true;
  }

  public resumeTorrent(id: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    const effDown = this.getEffectiveDownloadLimit();
    const effUp = this.getEffectiveUploadLimit();
    this.metaOf(id).pausedBy = null;

    if (t.progressPercent >= 100) {
      t.state = 'SEEDING';
      t.uploadSpeedBytes = effUp > 0 ? effUp : 3_400_000;
    } else {
      t.state = 'DOWNLOADING';
      t.downloadSpeedBytes = effDown > 0 ? effDown : 14_800_000;
    }
    this.recalculateGovernance();
    this.broadcast();
    return true;
  }

  public pauseAll(): Promise<EngineResult> {
    this.torrents.forEach((t) => {
      t.state = 'PAUSED';
      this.metaOf(t.id).pausedBy = 'user';
      t.downloadSpeedBytes = 0;
      t.uploadSpeedBytes = 0;
    });
    this.recalculateGovernance();
    this.broadcast();
    return Promise.resolve(ok());
  }

  public resumeAll(): Promise<EngineResult> {
    const effDown = this.getEffectiveDownloadLimit();
    const effUp = this.getEffectiveUploadLimit();
    this.torrents.forEach((t) => {
      this.metaOf(t.id).pausedBy = null;
      if (t.progressPercent >= 100) {
        t.state = 'SEEDING';
        t.uploadSpeedBytes = effUp > 0 ? effUp : 2_500_000;
      } else {
        t.state = 'DOWNLOADING';
        t.downloadSpeedBytes = effDown > 0 ? effDown : 12_000_000;
      }
    });
    this.recalculateGovernance();
    this.broadcast();
    return Promise.resolve(ok());
  }

  public deleteTorrent(id: string, _deleteFiles: boolean = false): boolean {
    const removed = this.torrents.delete(id);
    this.pieceMatrices.delete(id);
    this.meta.delete(id);
    this.recalculateGovernance();
    this.broadcast();
    return removed;
  }

  public moveTorrentUp(id: string): boolean {
    const keys = Array.from(this.torrents.keys());
    const idx = keys.indexOf(id);
    if (idx > 0) {
      const prevKey = keys[idx - 1];
      const prevVal = this.torrents.get(prevKey)!;
      const currVal = this.torrents.get(id)!;
      const newMap = new Map<string, TorrentDetailData>();
      for (const k of keys) {
        if (k === prevKey) {
          newMap.set(id, currVal);
        } else if (k === id) {
          newMap.set(prevKey, prevVal);
        } else {
          newMap.set(k, this.torrents.get(k)!);
        }
      }
      this.torrents = newMap;
      this.recalculateGovernance();
      this.broadcast();
      return true;
    }
    return false;
  }

  public moveTorrentDown(id: string): boolean {
    const keys = Array.from(this.torrents.keys());
    const idx = keys.indexOf(id);
    if (idx !== -1 && idx < keys.length - 1) {
      const nextKey = keys[idx + 1];
      const nextVal = this.torrents.get(nextKey)!;
      const currVal = this.torrents.get(id)!;
      const newMap = new Map<string, TorrentDetailData>();
      for (const k of keys) {
        if (k === id) {
          newMap.set(nextKey, nextVal);
        } else if (k === nextKey) {
          newMap.set(id, currVal);
        } else {
          newMap.set(k, this.torrents.get(k)!);
        }
      }
      this.torrents = newMap;
      this.recalculateGovernance();
      this.broadcast();
      return true;
    }
    return false;
  }

  public setFilePriority(id: string, fileIndex: number, priority: 0 | 1 | 2): boolean {
    const t = this.torrents.get(id);
    if (!t || !t.files[fileIndex]) return false;
    t.files[fileIndex].priority = priority;
    return true;
  }

  /** Legacy matrix (2 = verified, 1 = in flight). The contract API `getPieceBitfield` swaps to 1 = have, 2 = partial. */
  public getPieceMatrix(id: string): Uint8Array {
    let matrix = this.pieceMatrices.get(id);
    if (!matrix) {
      matrix = new Uint8Array(256);
      this.pieceMatrices.set(id, matrix);
    }
    return matrix;
  }

  public getTorrentDetail(id: string): TorrentDetailData | null {
    return this.torrents.get(id) || null;
  }

  public startHttpStream(id: string, fileIndex: number): string {
    const t = this.torrents.get(id);
    if (t) {
      t.sequential = true;
    }
    const streamUrl = `http://127.0.0.1:8080/stream/${id}/${fileIndex}`;
    if (t) {
      t.streamUrl = streamUrl;
    }
    return streamUrl;
  }

  // ---------------------------------------------------------------------------
  // MaglevEngineApi (docs/NATIVE_CONTRACT.md section 6)
  // ---------------------------------------------------------------------------

  private metaOf(id: string): TorrentMeta {
    let m = this.meta.get(id);
    if (!m) {
      m = { pausedBy: null, addedAt: Math.floor(Date.now() / 1000) };
      this.meta.set(id, m);
    }
    return m;
  }

  private toSnapshot(t: TorrentDetailData): Snapshot {
    const m = this.metaOf(t.id);
    return {
      id: t.id,
      name: t.name,
      state: t.state,
      // The finished edge never fires while files are missing (NATIVE_CONTRACT 18.3).
      finished: t.totalSizeBytes > 0 && t.downloadedBytes >= t.totalSizeBytes && m.health !== 'files_missing',
      pausedBy: t.state === 'PAUSED' ? m.pausedBy : null,
      progressBytes: t.downloadedBytes,
      totalBytes: t.totalSizeBytes,
      uploadedBytes: t.uploadedBytes,
      downBps: t.downloadSpeedBytes,
      upBps: t.uploadSpeedBytes,
      peersLive: t.peersConnected,
      peersSeen: t.peersTotal,
      webSeeds: 0,
      etaSecs: t.state === 'DOWNLOADING' && t.downloadSpeedBytes > 0 ? t.etaSeconds : -1,
      ratio: t.ratio,
      seedingSecs: t.seedDurationSeconds || 0,
      addedAt: m.addedAt,
      outputFolder: t.savePath,
      error: null,
      downLimitBps: m.downLimitBps ?? 0,
      upLimitBps: m.upLimitBps ?? 0,
      moveProgress: t.state === 'MOVING' ? (m.moveProgress ?? 0) : null,
      health: m.health ?? null,
      includedBytes: t.files.filter((f) => f.priority > 0).reduce((n, f) => n + f.length, 0),
      // Dev torrents have their metadata at once; only the native engine has a magnet that is still looking.
      resolvingSecs: null,
    };
  }

  private snapshots(): Snapshot[] {
    return Array.from(this.torrents.values())
      .map((t) => this.toSnapshot(t))
      .sort((a, b) => a.addedAt - b.addedAt);
  }

  private applyNativeConfig(cfg: NativeConfig): boolean {
    const before = this.nativeConfig ?? toNativeConfig(this.settings);
    const net = this.settings.network;
    const bw = this.settings.bandwidth;
    net.listeningPort = cfg.listen_port;
    net.upnpEnabled = cfg.enable_upnp;
    net.dhtEnabled = cfg.enable_dht;
    net.lsdEnabled = cfg.enable_lsd;
    net.pexEnabled = cfg.enable_pex;
    net.encryption = cfg.encryption === 'require' ? 'REQUIRED' : cfg.encryption === 'disable' ? 'DISABLED' : 'PREFERRED';
    bw.maxActiveDownloads = cfg.max_active_downloads;
    bw.maxActiveUploads = cfg.max_active_seeds;
    bw.maxConnectionsPerTorrent = cfg.max_connections_per_torrent;
    bw.downloadPreset = cfg.download_limit_bps > 0 ? 'CUSTOM' : 'UNLIMITED';
    bw.downloadLimitBytesPerSec = cfg.download_limit_bps;
    bw.uploadPreset = cfg.upload_limit_bps > 0 ? 'CUSTOM' : 'UNLIMITED';
    bw.uploadLimitBytesPerSec = cfg.upload_limit_bps;
    bw.seedingRatioLimit = cfg.seed_ratio_limit as typeof bw.seedingRatioLimit;
    bw.seedingDurationLimitSeconds = (cfg.seed_time_limit_mins * 60) as typeof bw.seedingDurationLimitSeconds;
    this.nativeConfig = { ...cfg };
    this.recalculateGovernance();
    this.broadcast();
    return restartReasons(before, cfg).length > 0;
  }

  public async init(config: NativeConfig): Promise<EngineResult> {
    this.initialized = true;
    this.applyNativeConfig(config);
    return ok();
  }

  public async shutdown(): Promise<EngineResult> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.initialized = false;
    return ok();
  }

  /** Dev only: magnet resolves that are still pending, so activity and cancel can be simulated. */
  private pendingResolves = new Map<string, { startedAt: number; cancel: () => void }>();

  public async getResolveActivity(infoHash: string): Promise<EngineResult<ResolveActivity>> {
    const p = this.pendingResolves.get(infoHash);
    if (!p) return fail('NOT_FOUND', 'No resolve is running for this torrent.');
    const elapsedMs = Date.now() - p.startedAt;
    return { ok: true, peersFound: Math.min(40, Math.floor(elapsedMs / 400)), dht: true, elapsedMs };
  }

  public async cancelResolve(infoHash: string): Promise<EngineResult> {
    const p = this.pendingResolves.get(infoHash);
    if (!p) return fail('NOT_FOUND', 'No resolve is running for this torrent.');
    p.cancel();
    return ok();
  }

  public async resolveMetadata(source: string, _timeoutMs: number): Promise<EngineResult<Metadata>> {
    const parsed = parseSource(source);
    if (!parsed) return fail('INVALID_SOURCE', 'Not a valid magnet link (needs an info-hash) or .torrent source.');
    if (parsed.kind === 'magnet') {
      // A magnet takes a few seconds to find peers, like the real engine. Cancel ends the wait early.
      const hash = parsed.infoHash;
      const cancelled = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingResolves.delete(hash);
          resolve(false);
        }, MOCK_RESOLVE_MS);
        this.pendingResolves.set(hash, {
          startedAt: Date.now(),
          cancel: () => {
            clearTimeout(timer);
            this.pendingResolves.delete(hash);
            resolve(true);
          },
        });
      });
      if (cancelled) return fail('CANCELLED', 'Cancelled.');
    }
    const name = parsed.name || `Torrent_${parsed.infoHash.slice(0, 8)}`;
    const total = parsed.exactLength && parsed.exactLength > 5120 ? parsed.exactLength : DEFAULT_PAYLOAD_BYTES;
    return {
      ok: true,
      infoHash: parsed.infoHash,
      name,
      totalBytes: total,
      files: [
        { index: 0, path: `${name}/${name}`, length: total - 5120 },
        { index: 1, path: `${name}/${name}.sha256`, length: 1024 },
        { index: 2, path: `${name}/release-notes.txt`, length: 4096 },
      ],
    };
  }

  public async addTorrent(
    source: string,
    options: AddTorrentOptions = {}
  ): Promise<EngineResult<{ id: string; infoHash: string }>> {
    return this.addInternal(source, options);
  }

  public async listTorrents(): Promise<EngineResult<{ torrents: Snapshot[]; downloads: ReturnType<MockDownloads['snapshots']> }>> {
    return { ok: true, torrents: this.snapshots(), downloads: this.downloads.snapshots() };
  }

  // ---- URL downloads (NATIVE_CONTRACT 17) ----
  public probeUrl(url: string, options: DownloadOptions = {}, _timeoutMs = 15_000): Promise<EngineResult<UrlProbe>> {
    return this.downloads.probeUrl(url, options);
  }
  /** Dev and web only. The simulator can't fetch playlists, so it says so instead of inventing qualities. */
  public probeStream(_url: string, _options: DownloadOptions = {}, _timeoutMs = 15_000): Promise<EngineResult<StreamProbe>> {
    return Promise.resolve({ ok: false, code: 'STREAM_UNSUPPORTED', message: "Maglev can't save this kind of stream yet." });
  }
  public addDownload(url: string, options: DownloadOptions = {}): Promise<EngineResult<{ id: string }>> {
    return this.downloads.add(url, options);
  }
  public async pauseDownload(id: string): Promise<EngineResult> {
    return this.downloads.pause(id);
  }
  public async resumeDownload(id: string): Promise<EngineResult> {
    return this.downloads.resume(id);
  }
  public async retryDownload(id: string): Promise<EngineResult> {
    return this.downloads.retry(id);
  }
  public async removeDownload(id: string, deleteFiles: boolean): Promise<EngineResult> {
    return this.downloads.remove(id, deleteFiles);
  }
  public async allowLanHost(id: string): Promise<EngineResult> {
    const d = this.downloads.snapshots().find((s) => s.id === id);
    if (!d) return { ok: false, code: 'NOT_FOUND', message: 'No such download.' };
    if (d.state !== 'error' || d.error?.code !== 'LAN_ADDRESS') return { ok: false, code: 'INVALID_STATE', message: "This download doesn't need that." };
    return { ok: true };
  }
  public async openDownload(id: string): Promise<EngineResult> {
    return this.downloads.snapshots().some((d) => d.id === id) ? { ok: true } : { ok: false, code: 'NOT_FOUND', message: 'No such download.' };
  }
  public refreshDownloadUrl(id: string, url: string, options: DownloadOptions = {}): Promise<EngineResult> {
    return this.downloads.refreshUrl(id, url, options);
  }
  public async setDownloadLimits(id: string, limits: { downLimitBps: number }): Promise<EngineResult> {
    return this.downloads.setLimits(id, limits);
  }
  /** Test hook: advances the download simulation. */
  public stepDownloads(seconds = 1) {
    return this.downloads.step(seconds);
  }

  public async getDetail(id: string): Promise<EngineResult<Detail>> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    const pieceLength = Math.max(1, Math.ceil(t.totalSizeBytes / t.piecesTotal));
    return {
      ok: true,
      snapshot: this.toSnapshot(t),
      files: t.files.map((f) => {
        const progressBytes = Math.floor((f.length * t.progressPercent) / 100);
        return {
          index: f.index,
          path: f.path,
          length: f.length,
          progressBytes,
          included: f.priority > 0,
          priority: f.priority === 2 ? ('first' as const) : f.priority === 1 ? ('normal' as const) : ('skip' as const),
          streamReadyBytes: progressBytes,
          tailReady: f.length > 0 && progressBytes >= f.length,
        };
      }),
      peers: [],
      trackers: t.trackers.map((tr) => ({
        url: tr.url,
        status: tr.status === 'Working' ? 'working' : tr.status === 'Error' ? 'error' : 'updating',
        message: tr.lastError ?? null,
      })),
      pieceCount: t.piecesTotal,
      pieceLength,
    };
  }

  public async pause(id: string): Promise<EngineResult> {
    if (this.torrents.get(id)?.state === 'MOVING') return fail('UNSUPPORTED', 'Wait for the move to finish.');
    return this.pauseTorrent(id) ? ok() : fail('NOT_FOUND', 'Torrent not found.');
  }

  public async resume(id: string): Promise<EngineResult> {
    if (this.torrents.get(id)?.state === 'MOVING') return fail('UNSUPPORTED', 'Wait for the move to finish.');
    const m = this.meta.get(id);
    if (m?.health) {
      // A full disk is cleared by the user's Resume (a new write error puts it back); the rest refuse.
      const refusal = HEALTH_RESUME_REFUSAL[m.health];
      if (refusal) return fail(refusal.code, refusal.message);
      m.health = null;
    }
    return this.resumeTorrent(id) ? ok() : fail('NOT_FOUND', 'Torrent not found.');
  }

  public async recheck(id: string): Promise<EngineResult> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    const m = this.metaOf(id);
    m.priorState = t.state === 'CHECKING' ? m.priorState : t.state;
    t.state = 'CHECKING';
    t.downloadSpeedBytes = 0;
    t.uploadSpeedBytes = 0;
    this.broadcast();
    return ok();
  }

  public async delete(id: string, deleteFiles: boolean): Promise<EngineResult> {
    return this.deleteTorrent(id, deleteFiles) ? ok() : fail('NOT_FOUND', 'Torrent not found.');
  }

  public async setIncludedFiles(id: string, indices: number[]): Promise<EngineResult> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    const include = new Set(indices);
    t.files.forEach((f) => {
      f.priority = include.has(f.index) ? (f.priority > 0 ? f.priority : 1) : 0;
    });
    return ok();
  }

  /** Returns an error message, or null when the list is valid (known indices, at least one file kept). */
  private validatePriorities(list: FilePriorityEntry[], fileCount: number): string | null {
    for (const e of list) {
      if (!Number.isInteger(e.index) || e.index < 0 || e.index >= fileCount) return `Unknown file ${e.index}.`;
      if (e.priority !== 'first' && e.priority !== 'normal' && e.priority !== 'skip') return 'Unknown priority.';
    }
    if (list.every((e) => e.priority === 'skip')) return 'Keep at least one file.';
    return null;
  }

  public async setFilePriorities(id: string, priorities: FilePriorityEntry[]): Promise<EngineResult> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    const bad = this.validatePriorities(priorities, t.files.length);
    if (bad) return fail('INVALID_SOURCE', bad);
    for (const e of priorities) {
      const f = t.files.find((x) => x.index === e.index);
      if (f) f.priority = e.priority === 'first' ? 2 : e.priority === 'normal' ? 1 : 0;
    }
    this.broadcast();
    return ok();
  }

  /**
   * Mirrors `nativeRemoveFiles` (NATIVE_CONTRACT 14): same validation and error codes as the Rust engine.
   * The mock tracks progress for the whole torrent, so a removed file frees `length * progress` bytes and
   * leaves the totals (and `finished`) consistent. Dev and web builds only.
   */
  public async removeFiles(id: string, indices: number[]): Promise<EngineResult<{ freedBytes: number }>> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'MOVING') return fail('UNSUPPORTED', 'Wait for the move to finish.');
    if (t.state === 'CHECKING') return fail('UNSUPPORTED', 'Wait until the torrent has been checked, then remove files.');
    if (!Array.isArray(indices) || indices.length === 0) return fail('INVALID_SOURCE', 'Pick at least one file to remove.');
    const remove = new Set<number>();
    for (const i of indices) {
      if (!Number.isInteger(i) || !t.files.some((f) => f.index === i)) {
        return fail('INVALID_SOURCE', "One of those files isn't in the torrent.");
      }
      remove.add(i);
    }
    const kept = t.files.filter((f) => f.priority > 0 && !remove.has(f.index));
    if (kept.length === 0) return fail('INVALID_SOURCE', 'Keep at least one file in the torrent.');

    let freed = 0;
    let removedLength = 0;
    for (const f of t.files) {
      if (!remove.has(f.index)) continue;
      if (f.priority > 0) removedLength += f.length;
      freed += Math.floor((f.length * t.progressPercent) / 100);
      f.priority = 0;
      f.progress = 0;
    }
    t.downloadedBytes = Math.max(0, t.downloadedBytes - freed);
    t.totalSizeBytes = Math.max(1, t.totalSizeBytes - removedLength);
    t.progressPercent = parseFloat(((t.downloadedBytes / t.totalSizeBytes) * 100).toFixed(1));
    this.broadcast();
    return { ok: true, freedBytes: freed };
  }

  // ---------------------------------------------------------------------------
  // Health (NATIVE_CONTRACT 18). Dev and web builds only: there is no disk here, so a file is "missing"
  // or "changed" only after `simulateFileChange` says so.
  // ---------------------------------------------------------------------------

  /** Dev only: pretend files were deleted or changed outside Maglev. The next scan sets the tag. */
  public simulateFileChange(id: string, kind: 'missing' | 'changed', indices: number[]): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    const m = this.metaOf(id);
    m.fileStates = m.fileStates ?? new Map();
    for (const i of indices) if (t.files.some((f) => f.index === i)) m.fileStates.set(i, kind);
    return true;
  }

  /** Applies a health tag: the torrent stops, unless the user paused it first (that pause wins). */
  private applyHealth(t: TorrentDetailData, tag: HealthTag): void {
    const m = this.metaOf(t.id);
    m.health = tag;
    if (t.state !== 'PAUSED') {
      t.state = 'PAUSED';
      t.downloadSpeedBytes = 0;
      t.uploadSpeedBytes = 0;
    }
    if (m.pausedBy !== 'user' && m.pausedBy !== 'seed_limit') m.pausedBy = tag;
  }

  /** Clears the tag; a torrent that the tag paused goes back to work. */
  private clearHealth(t: TorrentDetailData): void {
    const m = this.metaOf(t.id);
    const tag = m.health;
    m.health = null;
    if (tag && m.pausedBy === tag) this.resumeTorrent(t.id);
    else this.broadcast();
  }

  public async setHealth(id: string, tag: HealthTag | ''): Promise<EngineResult> {
    if (tag !== '' && !HEALTH_TAGS.includes(tag)) return fail('INVALID_ARGUMENT', "That isn't a known health state");
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    const m = this.metaOf(id);
    if (tag === '') {
      const previous = m.health;
      if ((previous === 'files_missing' || previous === 'storage_unavailable') && this.hasFileStates(m, 'missing')) {
        // Files are still gone: the torrent stays stopped, now under files_missing.
        this.applyHealth(t, 'files_missing');
        this.broadcast();
        return ok();
      }
      this.clearHealth(t);
    } else {
      this.applyHealth(t, tag);
      this.broadcast();
    }
    return ok();
  }

  private hasFileStates(m: TorrentMeta, kind: 'missing' | 'changed'): boolean {
    for (const v of m.fileStates?.values() ?? []) if (v === kind) return true;
    return false;
  }

  public async scanFileHealth(): Promise<EngineResult<{ changed: number }>> {
    let changed = 0;
    this.torrents.forEach((t) => {
      const m = this.metaOf(t.id);
      if (t.state === 'MOVING' || t.state === 'CHECKING') return;
      if (m.health && m.health !== 'files_missing' && m.health !== 'files_changed') return;
      const found: HealthTag | null = this.hasFileStates(m, 'missing')
        ? 'files_missing'
        : this.hasFileStates(m, 'changed')
          ? 'files_changed'
          : null;
      if (found && m.health !== found) {
        this.applyHealth(t, found);
        changed++;
      } else if (!found && m.health) {
        this.clearHealth(t);
        changed++;
      }
    });
    if (changed > 0) this.broadcast();
    return { ok: true, changed };
  }

  public async fileHealth(id: string): Promise<EngineResult<{ files: FileHealthEntry[] }>> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'MOVING') return fail('INVALID_STATE', 'This torrent is moving. Wait for the move to finish.');
    const states = this.metaOf(id).fileStates;
    return {
      ok: true,
      files: t.files
        .filter((f) => f.priority > 0)
        .map((f) => ({ index: f.index, state: states?.get(f.index) ?? ('ok' as const) })),
    };
  }

  public async resolveFiles(
    id: string,
    action: ResolveFilesAction,
    indices: number[],
    dir: string
  ): Promise<EngineResult> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'MOVING') return fail('INVALID_STATE', 'This torrent is moving. Wait for the move to finish.');
    if (t.state === 'CHECKING') return fail('INVALID_STATE', 'Wait until the torrent has been checked.');
    const m = this.metaOf(id);
    const states = (m.fileStates = m.fileStates ?? new Map());
    if (action === 'stop' || action === 'again') {
      if (!Array.isArray(indices) || indices.length === 0) return fail('INVALID_ARGUMENT', 'Pick at least one file');
      for (const i of indices) {
        if (!Number.isInteger(i) || !t.files.some((f) => f.index === i)) {
          return fail('INVALID_ARGUMENT', "One of those files isn't in the torrent");
        }
      }
      if (action === 'stop') {
        const left = t.files.filter((f) => f.priority > 0 && !indices.includes(f.index));
        if (left.length === 0) return fail('INVALID_SOURCE', 'Keep at least one file in the torrent.');
        for (const f of t.files) if (indices.includes(f.index)) f.priority = 0;
      }
      for (const i of indices) states.delete(i);
    } else if (action === 'folder') {
      if (!dir.trim() || !dir.startsWith('/')) return fail('INVALID_ARGUMENT', 'Pick a folder');
      // There is no disk to look at: every missing file counts as found in the chosen folder.
      for (const [i, v] of [...states]) if (v === 'missing') states.delete(i);
    } else if (action === 'recheck') {
      for (const [i, v] of [...states]) if (v === 'changed') states.delete(i);
    } else {
      return fail('INVALID_ARGUMENT', "That isn't something Maglev can do with these files");
    }
    const left = this.hasFileStates(m, 'missing') ? 'files_missing' : this.hasFileStates(m, 'changed') ? 'files_changed' : null;
    if (left) this.applyHealth(t, left);
    else this.clearHealth(t);
    return ok();
  }

  private lastReannounce: Map<string, number> = new Map();

  public async reannounce(id: string): Promise<EngineResult<{ retryAfterSecs?: number }>> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state !== 'DOWNLOADING' && t.state !== 'SEEDING') {
      return fail('UNSUPPORTED', 'Peers can only be refreshed while downloading or seeding.');
    }
    const now = Date.now();
    const last = this.lastReannounce.get(id);
    if (last !== undefined && now - last < 60_000) {
      return {
        ok: false,
        code: 'UNSUPPORTED',
        message: 'Try again in a moment.',
        retryAfterSecs: Math.ceil((60_000 - (now - last)) / 1000),
      };
    }
    this.lastReannounce.set(id, now);
    return ok();
  }

  public async addTrackers(id: string, urls: string[]): Promise<EngineResult<TrackersAdded>> {
    const checked = checkTrackerLines(urls);
    if (!checked.ok) return fail('INVALID_ARGUMENT', checked.message);
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'MOVING') return fail('UNSUPPORTED', 'Wait for the move to finish.');
    const have = new Set(t.trackers.map((tr) => trackerKey(tr.url)));
    const fresh = checked.urls.filter((u) => !have.has(trackerKey(u)));
    for (const url of fresh) t.trackers.push({ url, status: 'Announcing', seeds: 0, peers: 0 });
    if (fresh.length > 0) this.broadcast();
    return {
      ok: true,
      added: fresh.length,
      skipped: checked.urls.length - fresh.length,
      announced: fresh.length > 0 && (t.state === 'DOWNLOADING' || t.state === 'SEEDING'),
    };
  }

  public async removeTracker(id: string, url: string): Promise<EngineResult<{ announced: boolean }>> {
    if (!url.trim()) return fail('INVALID_ARGUMENT', 'Choose which tracker to remove');
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'MOVING') return fail('UNSUPPORTED', 'Wait for the move to finish.');
    const key = trackerKey(url);
    const at = t.trackers.findIndex((tr) => trackerKey(tr.url) === key);
    if (at < 0) return fail('NOT_FOUND', "That tracker isn't in the list");
    t.trackers.splice(at, 1);
    this.broadcast();
    return { ok: true, announced: t.state === 'DOWNLOADING' || t.state === 'SEEDING' };
  }

  public async exportTorrent(id: string): Promise<EngineResult<TorrentExport>> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'INITIALIZING') {
      return fail('NOT_READY', "Maglev is still getting this torrent's details. Try again in a moment.");
    }
    if (t.state === 'MOVING') return fail('UNSUPPORTED', 'Wait for the move to finish.');
    const cleaned = t.name
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 120)
      .trim();
    const name = `${cleaned || 'torrent'}.torrent`;
    return { ok: true, path: `/storage/emulated/0/Download/Maglev/${name}`, name, folder: 'Download/Maglev', bytes: 4096 };
  }

  public async shareExportedTorrent(path: string): Promise<EngineResult> {
    return path.toLowerCase().endsWith('.torrent')
      ? ok()
      : fail('NOT_FOUND', "The saved file isn't there any more. Save it again.");
  }

  public async getFreeSpace(): Promise<EngineResult<FreeSpace>> {
    return {
      ok: true,
      path: this.getDefaultStoragePath(),
      freeBytes: 21_400_000_000,
      totalBytes: 128_000_000_000,
      mode: 'direct',
      targetFreeBytes: null,
    };
  }

  public async openLiveUpdateSettings(): Promise<void> {}

  public async openNotificationSettings(_channel?: 'completed'): Promise<void> {}

  public async setGlobalLimits(down: number, up: number): Promise<EngineResult> {
    const bw = this.settings.bandwidth;
    bw.downloadPreset = down > 0 ? 'CUSTOM' : 'UNLIMITED';
    bw.downloadLimitBytesPerSec = Math.max(0, down);
    bw.uploadPreset = up > 0 ? 'CUSTOM' : 'UNLIMITED';
    bw.uploadLimitBytesPerSec = Math.max(0, up);
    this.recalculateGovernance();
    this.broadcast();
    return ok();
  }

  public async applyConfig(config: NativeConfig): Promise<EngineResult<{ restartRequired: boolean }>> {
    return { ok: true, restartRequired: this.applyNativeConfig(config) };
  }

  public async getEffectiveConfig(): Promise<EngineResult<NativeConfig>> {
    return { ok: true, ...(this.nativeConfig ?? toNativeConfig(this.settings)) };
  }

  /** Contract bitfield: 256 cells, 0 = missing, 1 = have, 2 = partial. */
  public async getPieceBitfield(id: string): Promise<number[]> {
    if (!this.torrents.has(id)) return new Array(256).fill(0);
    const legacy = this.getPieceMatrix(id);
    return Array.from(legacy, (v) => (v === 2 ? 1 : v === 1 ? 2 : 0));
  }

  public async streamUrl(id: string, fileIndex: number): Promise<EngineResult<{ url: string; mime: string }>> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    const f = t.files.find((x) => x.index === fileIndex);
    if (!f) return fail('NOT_FOUND', 'File not found.');
    if (f.priority === 0) return fail('UNSUPPORTED', 'This file is skipped, so it is not being downloaded.');
    return { ok: true, url: `http://127.0.0.1:8080/stream/${id}/${fileIndex}`, mime: mimeFor(f.path) };
  }

  public async setTorrentLimits(id: string, limits: TorrentLimits): Promise<EngineResult> {
    if (!this.torrents.has(id)) return fail('NOT_FOUND', 'Torrent not found.');
    const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_LIMIT_BPS) : 0);
    const m = this.metaOf(id);
    m.downLimitBps = clamp(limits.downBps);
    m.upLimitBps = clamp(limits.upBps);
    this.broadcast();
    return ok();
  }

  public async moveStorage(id: string, target: MoveTarget): Promise<EngineResult> {
    const t = this.torrents.get(id);
    if (!t) return fail('NOT_FOUND', 'Torrent not found.');
    if (t.state === 'INITIALIZING' || t.state === 'CHECKING' || t.state === 'MOVING') {
      return fail('UNSUPPORTED', 'Wait for this torrent to finish its current step, then try again.');
    }
    let dest = DEFAULT_MOVE_DIR;
    if (target.kind === 'tree') {
      if (!target.uri) return fail('PERMISSION', 'Maglev does not have permission to write to that folder.');
      dest = `/storage/emulated/0/${decodeURIComponent(target.uri.split('/').pop() ?? '').replace(/^primary:/, '')}`;
    }
    if (dest === t.savePath) return fail('UNSUPPORTED', 'This torrent is already in that folder.');
    const m = this.metaOf(id);
    m.priorState = t.state;
    m.moveProgress = 0;
    m.moveDest = dest;
    t.state = 'MOVING';
    t.downloadSpeedBytes = 0;
    t.uploadSpeedBytes = 0;
    this.broadcast();
    return ok();
  }

  public async openStream(_url: string, _mime: string, _title: string): Promise<EngineResult> {
    return ok();
  }

  private schedule: ScheduleConfig = { enabled: false, rules: [] };
  private feedAutomation: FeedAutomationConfig = { enabled: false, intervalMins: 30, feeds: [], rules: [] };

  /** Same shape checks as the native side: HH:MM times, days 0 to 6, known action. */
  public async setSchedule(config: ScheduleConfig): Promise<EngineResult> {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    for (const r of config?.rules ?? []) {
      if (!r.id || !time.test(r.start) || !time.test(r.end)) return fail('INVALID_SOURCE', 'Use times like 22:00.');
      if (!Array.isArray(r.days) || r.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
        return fail('INVALID_SOURCE', 'Pick days from Monday to Sunday.');
      }
      if (r.action !== 'pause' && r.action !== 'limit') return fail('INVALID_SOURCE', 'Unknown schedule action.');
    }
    this.schedule = JSON.parse(JSON.stringify(config));
    return ok();
  }

  public async getScheduleStatus(): Promise<ScheduleStatus> {
    return { enabled: this.schedule.enabled, paused: false, activeRuleIds: [], nextBoundary: null };
  }

  public async setFeedAutomation(config: FeedAutomationConfig): Promise<EngineResult> {
    if (![15, 30, 60].includes(config?.intervalMins)) return fail('INVALID_SOURCE', 'Check every 15, 30 or 60 minutes.');
    for (const r of config.rules ?? []) {
      for (const pattern of [r.include, r.exclude]) {
        const m = /^\/(.+)\/$/.exec(pattern ?? '');
        if (m) {
          try {
            new RegExp(m[1], 'i');
          } catch {
            return fail('INVALID_SOURCE', 'One of the rules has an invalid pattern.');
          }
        }
      }
    }
    this.feedAutomation = JSON.parse(JSON.stringify(config));
    return ok();
  }

  public async getFeedAutomationStatus(): Promise<FeedAutomationStatus> {
    return { lastRunAt: null, lastError: null, addedTotal: 0, pending: 0 };
  }

  public async runFeedCheckNow(): Promise<EngineResult> {
    return this.feedAutomation.enabled ? ok() : fail('UNSUPPORTED', 'Turn on automatic downloads first.');
  }

  public async version(): Promise<{ engine: string; version: string }> {
    return { engine: 'simulator', version: 'dev' };
  }

  public async pickDownloadFolder(): Promise<PickFolderResult> {
    return { uri: 'content://simulator/tree/Downloads', displayName: 'Downloads (simulated)', mode: 'staging' };
  }

  public async pickFolder(): Promise<PickFolderResult> {
    return this.pickDownloadFolder();
  }

  /** Mock: a plausible mid-range phone. Marked `mock: true`. Dev and web only. */
  public async getPlaybackSupport(): Promise<PlaybackSupport> {
    return {
      avc: 'hardware', hevc: 'hardware', hevc10: 'hardware', av1: 'software', av1_10: 'software',
      vp9: 'hardware', dolbyVision: 'none', hdr10: true, hdr10plus: false, hlg: true, mock: true,
    };
  }

  public async getStorageStatus(): Promise<StorageStatus> {
    return { path: this.getDefaultStoragePath(), fallback: false, safLost: false };
  }

  public async openFile(id: string, _fileIndex: number): Promise<EngineResult> {
    return this.torrents.has(id) ? ok() : fail('NOT_FOUND', 'Torrent not found.');
  }

  public async shareFile(id: string, fileIndex: number): Promise<EngineResult> {
    return this.openFile(id, fileIndex);
  }

  public async openFolder(id: string): Promise<EngineResult> {
    return this.openFile(id, 0);
  }

  public async getPermissionStatus(): Promise<NativePermissionStatus> {
    return { notifications: 'granted', batteryUnrestricted: true, legacyStorage: 'n/a', liveUpdates: 'n/a' };
  }

  public async requestNotifications(): Promise<EngineResult> {
    return ok();
  }

  public async openBatterySettings(): Promise<void> {}

  public async requestLegacyStorage(): Promise<EngineResult> {
    return ok();
  }

  public async setGovernance(g: GovernanceConfig): Promise<EngineResult> {
    const net = this.settings.network;
    const pwr = this.settings.power;
    net.wifiOnly = g.wifiOnly;
    net.ssidWhitelistEnabled = g.ssidWhitelist.length > 0;
    net.allowedSsids = [...g.ssidWhitelist];
    pwr.downloadOnlyWhileCharging = g.chargingOnly;
    pwr.batteryCutoffThreshold = g.batteryCutoffPct as typeof pwr.batteryCutoffThreshold;
    pwr.autoExitOnComplete = g.autoExitOnComplete;
    this.recalculateGovernance();
    this.broadcast();
    return ok();
  }

  public onTelemetry(listener: (event: TelemetryEvent) => void): Unsubscribe {
    this.snapshotListeners.add(listener);
    if (!this.timer) this.startTelemetryLoop();
    listener({ torrents: this.snapshots(), downloads: this.downloads.snapshots() });
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  public onTorrentCompleted(listener: (event: TorrentCompletedEvent) => void): Unsubscribe {
    this.completedListeners.add(listener);
    return () => {
      this.completedListeners.delete(listener);
    };
  }

  public onNotificationAction(listener: (event: NotificationActionEvent) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  public onStorageStatus(listener: (event: StorageStatus) => void): Unsubscribe {
    this.storageListeners.add(listener);
    return () => {
      this.storageListeners.delete(listener);
    };
  }

  /**
   * Evaluates network, power, battery, and bandwidth governance constraints.
   */
  private recalculateGovernance(): void {
    const net = this.settings.network;
    const pwr = this.settings.power;
    const bw = this.settings.bandwidth;

    // 1. Evaluate Network Safety (CONTRACT-2.1)
    let shouldClampNetwork = false;

    if (net.networkType === 'NONE') {
      shouldClampNetwork = true;
    } else if (net.wifiOnly && net.networkType === 'CELLULAR') {
      shouldClampNetwork = true;
    } else if (net.networkType === 'WIFI' && net.ssidWhitelistEnabled && net.allowedSsids.length > 0) {
      const current = net.currentSsid || '';
      if (!net.allowedSsids.includes(current)) {
        shouldClampNetwork = true;
      }
    }

    this.socketsClamped = shouldClampNetwork;

    // 2. Evaluate Battery & Power Governance (CONTRACT-2.3)
    let shouldPausePower = false;

    if (!pwr.isCharging) {
      if (pwr.downloadOnlyWhileCharging) {
        shouldPausePower = true;
      }
      if (pwr.batteryCutoffThreshold > 0 && pwr.batteryPercentage < pwr.batteryCutoffThreshold) {
        shouldPausePower = true;
      }
    }

    // 2b. Governance pause tags: never override a user pause; resume only what governance paused.
    const govReason: PausedBy | null = shouldClampNetwork
      ? 'wifi_only'
      : shouldPausePower
        ? pwr.downloadOnlyWhileCharging && !pwr.isCharging
          ? 'charging_only'
          : 'battery'
        : null;
    this.torrents.forEach((t) => {
      const m = this.metaOf(t.id);
      if (t.state === 'ERROR') return;
      if (govReason) {
        if (t.state !== 'PAUSED') {
          t.state = 'PAUSED';
          m.pausedBy = govReason;
          t.downloadSpeedBytes = 0;
          t.uploadSpeedBytes = 0;
        } else if (GOVERNANCE_TAGS.has(m.pausedBy)) {
          m.pausedBy = govReason;
        }
      } else if (t.state === 'PAUSED' && GOVERNANCE_TAGS.has(m.pausedBy)) {
        m.pausedBy = null;
        t.state = t.progressPercent >= 100 ? 'SEEDING' : 'DOWNLOADING';
      }
    });

    // 3. Count active transfers and manage WakeLock & Rate Limit Clamping
    const effectiveDown = this.getEffectiveDownloadLimit();
    const effectiveUp = this.getEffectiveUploadLimit();
    const maxActive = bw.maxActiveDownloads > 0 ? bw.maxActiveDownloads : 3;

    // Enforce active queue cap: demote excess DOWNLOADING to QUEUED
    let activeDownCount = 0;
    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING') {
        activeDownCount++;
        if (activeDownCount > maxActive) {
          t.state = 'QUEUED';
          t.downloadSpeedBytes = 0;
          t.uploadSpeedBytes = 0;
        }
      }
    });

    // Auto-promote QUEUED torrents when active download slots open
    if (activeDownCount < maxActive) {
      this.torrents.forEach((t) => {
        if (t.state === 'QUEUED' && activeDownCount < maxActive) {
          t.state = 'DOWNLOADING';
          activeDownCount++;
        }
      });
    }

    // Seed slots (contract section 9): finished torrents beyond max_active_seeds are COMPLETED, never QUEUED.
    const maxSeeds = bw.maxActiveUploads > 0 ? bw.maxActiveUploads : Number.MAX_SAFE_INTEGER;
    let seedSlots = 0;
    this.torrents.forEach((t) => {
      if (t.state === 'SEEDING' || t.state === 'COMPLETED') {
        if (seedSlots < maxSeeds) {
          seedSlots++;
          t.state = 'SEEDING';
        } else {
          t.state = 'COMPLETED';
          t.downloadSpeedBytes = 0;
          t.uploadSpeedBytes = 0;
        }
      }
    });

    let downloadingCount = 0;
    let seedingCount = 0;
    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING') downloadingCount++;
      else if (t.state === 'SEEDING') seedingCount++;
    });

    let activeCount = 0;
    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING' || t.state === 'SEEDING') {
        if (shouldClampNetwork || shouldPausePower) {
          t.downloadSpeedBytes = 0;
          t.uploadSpeedBytes = 0;
        } else {
          activeCount++;
          if (t.state === 'DOWNLOADING') {
            t.downloadSpeedBytes = effectiveDown > 0 && downloadingCount > 0
              ? Math.floor(effectiveDown / downloadingCount)
              : 14_800_000;
          } else if (t.state === 'SEEDING') {
            t.uploadSpeedBytes = effectiveUp > 0 && seedingCount > 0
              ? Math.floor(effectiveUp / seedingCount)
              : 3_400_000;
          }
        }
      }
    });

    if (activeCount > 0 && !shouldClampNetwork && !shouldPausePower) {
      this.wakeLockHeld = true;
    } else {
      this.wakeLockHeld = false;
    }

    // 4. Check Auto-Shutdown on Complete (Task 2.8)
    if (pwr.autoExitOnComplete && this.torrents.size > 0) {
      let allDone = true;
      this.torrents.forEach((t) => {
        if (t.state === 'DOWNLOADING') {
          allDone = false;
        } else if (t.state === 'SEEDING') {
          if (bw.seedingRatioLimit > 0 && t.ratio < bw.seedingRatioLimit) {
            allDone = false;
          }
        }
      });
      if (allDone && activeCount === 0) {
        this.shutdownTriggered = true;
        this.wakeLockHeld = false;
      }
    }
  }

  private startTelemetryLoop(): void {
    if (this.timer) clearInterval(this.timer);
    // Contract: telemetry once per second
    this.timer = setInterval(() => {
      this.stepSimulation(); // each step advances 0.5 s of simulated transfer
      this.stepSimulation();
      this.downloads.step(1);
      this.broadcast();
    }, 1000);
    this.timer?.unref?.();
  }

  public stepSimulation(): void {
    this.torrents.forEach((t) => {
      if (t.state === 'CHECKING') t.state = this.metaOf(t.id).priorState ?? 'PAUSED';
      if (t.state === 'MOVING') {
        const m = this.metaOf(t.id);
        m.moveProgress = Math.min(1, (m.moveProgress ?? 0) + 1 / MOVE_STEPS);
        if (m.moveProgress >= 1) {
          if (m.moveDest) t.savePath = m.moveDest;
          t.state = m.priorState ?? 'PAUSED';
          m.moveProgress = undefined;
          m.moveDest = undefined;
        }
      }
    });
    const net = this.settings.network;
    const pwr = this.settings.power;
    const bw = this.settings.bandwidth;

    // If sockets clamped or power paused, do not advance transfers
    if (this.socketsClamped) {
      this.torrents.forEach((t) => {
        t.downloadSpeedBytes = 0;
        t.uploadSpeedBytes = 0;
      });
      return;
    }

    if (!pwr.isCharging) {
      if (pwr.downloadOnlyWhileCharging || (pwr.batteryCutoffThreshold > 0 && pwr.batteryPercentage < pwr.batteryCutoffThreshold)) {
        this.torrents.forEach((t) => {
          t.downloadSpeedBytes = 0;
          t.uploadSpeedBytes = 0;
        });
        return;
      }
    }

    const effectiveDownLimit = this.getEffectiveDownloadLimit();
    const effectiveUpLimit = this.getEffectiveUploadLimit();

    let downloadingTorrents: TorrentDetailData[] = [];
    let seedingTorrents: TorrentDetailData[] = [];

    this.torrents.forEach((t) => {
      if (t.state === 'DOWNLOADING') downloadingTorrents.push(t);
      else if (t.state === 'SEEDING') seedingTorrents.push(t);
    });

    // Enforce active torrent caps (Task 2.10)
    if (downloadingTorrents.length > bw.maxActiveDownloads) {
      for (let i = bw.maxActiveDownloads; i < downloadingTorrents.length; i++) {
        downloadingTorrents[i].state = 'PAUSED';
        downloadingTorrents[i].downloadSpeedBytes = 0;
        downloadingTorrents[i].uploadSpeedBytes = 0;
      }
      downloadingTorrents = downloadingTorrents.slice(0, bw.maxActiveDownloads);
    }

    // Apply Token-Bucket Clamping to Downloading Torrents
    const targetDownPerTorrent =
      effectiveDownLimit > 0 && downloadingTorrents.length > 0
        ? Math.floor(effectiveDownLimit / downloadingTorrents.length)
        : 14_800_000;

    downloadingTorrents.forEach((t) => {
      t.downloadSpeedBytes = targetDownPerTorrent;
      t.peersTotal = Math.min(40, bw.maxConnectionsPerTorrent);

      // Increment downloaded bytes (0.5 sec tick)
      const delta = Math.floor(t.downloadSpeedBytes * 0.5);
      t.downloadedBytes = Math.min(t.totalSizeBytes, t.downloadedBytes + delta);
      t.progressPercent = parseFloat(((t.downloadedBytes / t.totalSizeBytes) * 100).toFixed(1));

      if (t.downloadSpeedBytes > 0) {
        t.etaSeconds = Math.max(0, Math.floor((t.totalSizeBytes - t.downloadedBytes) / t.downloadSpeedBytes));
      }

      // Update piece matrix
      const matrix = this.getPieceMatrix(t.id);
      const verifiedCount = Math.floor((t.progressPercent / 100) * 256);
      t.piecesVerified = verifiedCount;
      for (let i = 0; i < 256; i++) {
        if (i < verifiedCount) {
          matrix[i] = 2; // Verified cyan
        } else if (i < verifiedCount + 4 && i < 256) {
          matrix[i] = 1; // In flight lime
        } else {
          matrix[i] = 0; // Unavailable
        }
      }

      // Check completion
      if (t.downloadedBytes >= t.totalSizeBytes) {
        t.state = 'SEEDING';
        t.downloadSpeedBytes = 0;
        t.uploadSpeedBytes = effectiveUpLimit > 0 ? effectiveUpLimit : 3_400_000;
        t.etaSeconds = 0;
        t.progressPercent = 100.0;
        t.seedDurationSeconds = 0;
        this.completedListeners.forEach((l) => l({ id: t.id, name: t.name }));

        // Auto-Move Completed Downloads (Task 2.11)
        if (this.settings.storage.autoMoveCompleted && this.settings.storage.autoMoveDestinationPath) {
          t.savePath = this.settings.storage.autoMoveDestinationPath;
        }
      }
    });

    // Apply Token-Bucket Clamping to Seeding Torrents & Seeding Governance (CONTRACT-2.5)
    const targetUpPerTorrent =
      effectiveUpLimit > 0 && seedingTorrents.length > 0
        ? Math.floor(effectiveUpLimit / seedingTorrents.length)
        : 3_400_000;

    seedingTorrents.forEach((t) => {
      t.uploadSpeedBytes = targetUpPerTorrent;
      t.seedDurationSeconds = (t.seedDurationSeconds || 0) + 1;

      const deltaUp = Math.floor(t.uploadSpeedBytes * 0.5);
      t.uploadedBytes += deltaUp;
      if (t.downloadedBytes > 0) {
        t.ratio = parseFloat((t.uploadedBytes / t.downloadedBytes).toFixed(2));
      }

      // Check Seeding Governance Limits
      let stopSeeding = false;
      if (bw.seedingRatioLimit > 0 && t.ratio >= bw.seedingRatioLimit) {
        stopSeeding = true;
      }
      if (bw.seedingDurationLimitSeconds > 0 && (t.seedDurationSeconds || 0) >= bw.seedingDurationLimitSeconds) {
        stopSeeding = true;
      }

      if (stopSeeding) {
        t.state = 'PAUSED';
        this.metaOf(t.id).pausedBy = 'seed_limit';
        t.uploadSpeedBytes = 0;
        t.downloadSpeedBytes = 0;
      }
    });
  }

  private broadcast(): void {
    const payload = this.getAggregatedTelemetry();
    if (this.snapshotListeners.size > 0) {
      const event: TelemetryEvent = { torrents: this.snapshots(), downloads: this.downloads.snapshots() };
      this.snapshotListeners.forEach((l) => {
        try {
          l(event);
        } catch {
          // ignore listener error
        }
      });
    }
    this.listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (e) {
        // Ignore listener error
      }
    });
  }

  private seedInitialMockData(): void {
    const seededAt = Math.floor(Date.now() / 1000);
    this.meta.set(pseudoHash('card-ubuntu'), { pausedBy: null, addedAt: seededAt - 3 });
    this.meta.set(pseudoHash('card-blender'), { pausedBy: null, addedAt: seededAt - 2 });
    this.meta.set(pseudoHash('card-arch'), { pausedBy: 'user', addedAt: seededAt - 1 });

    const id1 = pseudoHash('card-ubuntu');
    const name1 = 'Ubuntu-26.04-Desktop.iso';
    const total1 = 4_509_715_660; // 4.2 GB
    const downloaded1 = 3_328_599_654; // 74.2%

    const matrix1 = new Uint8Array(256);
    const verified1 = Math.floor(0.742 * 256);
    for (let i = 0; i < 256; i++) {
      if (i < verified1) matrix1[i] = 2;
      else if (i < verified1 + 6) matrix1[i] = 1;
      else matrix1[i] = 0;
    }
    this.pieceMatrices.set(id1, matrix1);

    this.torrents.set(id1, {
      id: id1,
      name: name1,
      state: 'DOWNLOADING',
      downloadSpeedBytes: 14_800_000,
      uploadSpeedBytes: 850_000,
      progressPercent: 74.2,
      downloadedBytes: downloaded1,
      uploadedBytes: 154_000_000,
      totalSizeBytes: total1,
      etaSeconds: 135, // 2m 15s
      peersConnected: 28,
      peersTotal: 40,
      seedsConnected: 6,
      ratio: 0.05,
      sequential: false,
      seedDurationSeconds: 0,
      savePath: this.defaultStoragePath,
      piecesTotal: 256,
      piecesVerified: verified1,
      files: [{ index: 0, name: name1, path: name1, length: total1, progress: 74.2, priority: 1 }],
      trackers: [{ url: 'udp://tracker.ubuntu.com:6969/announce', status: 'Working', seeds: 48, peers: 92 }],
    });

    const id2 = pseudoHash('card-blender');
    const name2 = 'Blender-5.2-Linux.tar.xz';
    const total2 = 1_932_735_283; // 1.8 GB
    const matrix2 = new Uint8Array(256);
    matrix2.fill(2);
    this.pieceMatrices.set(id2, matrix2);

    this.torrents.set(id2, {
      id: id2,
      name: name2,
      state: 'SEEDING',
      downloadSpeedBytes: 0,
      uploadSpeedBytes: 3_400_000,
      progressPercent: 100.0,
      downloadedBytes: total2,
      uploadedBytes: 5_447_453_900,
      totalSizeBytes: total2,
      etaSeconds: 0,
      peersConnected: 14,
      peersTotal: 40,
      seedsConnected: 22,
      ratio: 2.82,
      sequential: true,
      seedDurationSeconds: 3600,
      savePath: this.defaultStoragePath,
      piecesTotal: 256,
      piecesVerified: 256,
      streamUrl: `http://127.0.0.1:8080/stream/${id2}/0`,
      files: [{ index: 0, name: name2, path: name2, length: total2, progress: 100.0, priority: 1 }],
      trackers: [{ url: 'udp://tracker.blender.org:6969/announce', status: 'Working', seeds: 35, peers: 28 }],
    });

    const id3 = pseudoHash('card-arch');
    const name3 = 'archlinux-2025.02.01-x86_64.iso';
    const total3 = 956_301_312; // 912 MB
    const downloaded3 = 432_013_312; // 412 MB (45.2%)
    const matrix3 = new Uint8Array(256);
    const verified3 = Math.floor(0.452 * 256);
    for (let i = 0; i < 256; i++) {
      if (i < verified3) matrix3[i] = 2;
      else matrix3[i] = 0;
    }
    this.pieceMatrices.set(id3, matrix3);

    this.torrents.set(id3, {
      id: id3,
      name: name3,
      state: 'PAUSED',
      downloadSpeedBytes: 0,
      uploadSpeedBytes: 0,
      progressPercent: 45.2,
      downloadedBytes: downloaded3,
      uploadedBytes: 12_000_000,
      totalSizeBytes: total3,
      etaSeconds: 0,
      peersConnected: 0,
      peersTotal: 40,
      seedsConnected: 0,
      ratio: 0.03,
      sequential: false,
      seedDurationSeconds: 0,
      savePath: this.defaultStoragePath,
      piecesTotal: 256,
      piecesVerified: verified3,
      files: [{ index: 0, name: name3, path: name3, length: total3, progress: 45.2, priority: 1 }],
      trackers: [{ url: 'udp://tracker.archlinux.org:6969/announce', status: 'Paused', seeds: 0, peers: 0 }],
    });
  }
}

export const mockEngine = new MaglevMockEngine();
