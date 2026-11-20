import { Platform, requireOptionalNativeModule } from 'expo-modules-core';
import type {
  ActiveBlock,
  AddTorrentOptions,
  Detail,
  DownloadOptions,
  StreamProbe,
  DownloadSnapshot,
  EngineErrorCode,
  EngineResult,
  EngineStatus,
  FeedAutomationConfig,
  FeedAutomationStatus,
  FileHealthEntry,
  FilePriorityEntry,
  FreeSpace,
  NetworkState,
  HealthTag,
  ResolveFilesAction,
  TorrentExport,
  TrackersAdded,
  GovernanceConfig,
  SubtitleHashResult,
  SubtitleSaveResult,
  SubtitleZipEntry,
  BlocklistState,
  EffectiveConfig,
  MaglevEngineApi,
  Metadata,
  MoveTarget,
  NativeConfig,
  NativePermissionStatus,
  NotificationActionEvent,
  PickFolderResult,
  ResolveActivity,
  ScheduleConfig,
  ScheduleStatus,
  Snapshot,
  StorageStatus,
  PlaybackSupport,
  TelemetryEvent,
  TorrentCompletedEvent,
  TorrentLimits,
  UrlProbe,
  Unsubscribe,
  InstallSource,
  UpdateProgressEvent,
  UpdateNetwork,
  UpdateResultEvent,
} from './MaglevEngine.types.ts';
import { subtitleError } from './MaglevEngine.types.ts';
import type { MaglevSettings } from './MaglevSettings.types.ts';
import { ipFilter } from './MaglevIpFilter.ts';
import { settingsStore } from './MaglevSettingsStore.ts';
import { camelizeKeys, snakeizeKeys } from './snapshotMapping.ts';
import { restartReasons, toGovernance, toNativeConfig } from './toNativeConfig.ts';

/**
 * Thin typed wrapper over the Expo native module `MaglevEngine` (docs/NATIVE_CONTRACT.md section 6).
 *
 * Engine selection:
 * - Android with the native module present: native engine.
 * - Module missing or init returns ENGINE_UNAVAILABLE: simulator in `__DEV__` and on web (with a warning);
 *   in a release build there is NO fallback and `engineStatus` becomes `{ kind: 'unavailable' }`.
 */

const SIMULATOR_ALLOWED = __DEV__ || Platform.OS === 'web';

/** Returns the simulator only where allowed. Never reachable in a release build on a device. */
function simulatorIfAllowed(): MaglevEngineApi | null {
  // A literal require inside a branch Metro folds to `false` in release (__DEV__ and process.env.EXPO_OS are both
  // inlined per platform), so the mock engine never reaches the release bundle. Do not hoist it to an import.
  if (__DEV__ || process.env.EXPO_OS === 'web') {
    const { mockEngine } = require('./MaglevMockEngine.ts') as typeof import('./MaglevMockEngine.ts');
    return mockEngine;
  }
  return null;
}

let NativeModule: any = null;
try {
  NativeModule = Platform.OS === 'android' ? requireOptionalNativeModule('MaglevEngine') : null;
} catch {
  NativeModule = null;
}

const unavailable = (message: string, code: EngineErrorCode = 'ENGINE_UNAVAILABLE'): EngineResult<any> => ({
  ok: false,
  code,
  message,
});

/**
 * NATIVE_CONTRACT 41. The module answers the saved config plus `restart_pending` and `blocklist`. The config keeps
 * snake_case; the two new fields are exposed as `restartPending` and `blocklist: { state, rules }`. A missing or odd
 * `blocklist` reads as off; a missing `restart_pending` as false.
 */
export function toEffectiveConfig(snake: Record<string, unknown>): EngineResult<EffectiveConfig> {
  const { restart_pending, blocklist, ...config } = snake;
  const b = (blocklist ?? {}) as { state?: unknown; rules?: unknown };
  const state: BlocklistState = b.state === 'on' || b.state === 'unreadable' ? b.state : 'off';
  const rules = typeof b.rules === 'number' && b.rules > 0 ? Math.floor(b.rules) : 0;
  return {
    ...(config as unknown as NativeConfig),
    ok: true,
    restartPending: restart_pending === true,
    blocklist: { state, rules },
  } as EngineResult<EffectiveConfig>;
}

type StateListener = () => void;

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'wifi_only', 'battery', 'charging_only', 'network_unvalidated', 'vpn_required', 'offline', 'schedule', 'storage_full', 'seed_metered',
]);

/** Keeps only entries with a known tag and a numeric `sinceMs`. Input is already camelized or still raw. */
function cleanBlocks(raw: unknown): ActiveBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ActiveBlock[] = [];
  for (const item of camelizeKeys<unknown[]>(raw)) {
    const b = item as Partial<ActiveBlock> | null;
    if (!b || typeof b.tag !== 'string' || !BLOCK_TAGS.has(b.tag)) continue;
    out.push({ ...b, tag: b.tag, sinceMs: typeof b.sinceMs === 'number' ? b.sinceMs : 0 } as ActiveBlock);
  }
  return out;
}

/**
 * NATIVE_CONTRACT 39.3 E1. Every bridge method that reaches the native module is in exactly one group.
 *
 * USER_ACTION_METHODS change engine state because the user asked. Only these restart a stopped engine: when one
 * answers NOT_INITIALIZED the bridge starts the engine once with the last config and retries once. This is what
 * lets an add work after the notification "Shut down".
 *
 * READ_METHODS (reads, polling, config pushes, pickers, opening or sharing files) return their NOT_INITIALIZED
 * failure untouched, so a poll between "Shut down" and the activity closing cannot undo the shutdown. The UI's
 * "engine stopped" notice with Start engine (restart()) handles that failure.
 *
 * A new bridge method must be added to one of the two lists (grep `this.route(`).
 */
const USER_ACTION_METHODS: readonly string[] = [
  // Add flow (a paste, share, search or feed add, including the preflight lookups)
  'addTorrent', 'addDownload', 'resolveMetadata', 'probeUrl', 'probeStream',
  // Torrents
  'pause', 'resume', 'resumeAnyway', 'recheck', 'pauseAll', 'resumeAll', 'delete',
  'setIncludedFiles', 'setFilePriorities', 'removeFiles', 'resolveFiles', 'setHealth', 'scanFileHealth',
  'reannounce', 'addTrackers', 'removeTracker', 'moveStorage',
  // Limits
  'setGlobalLimits', 'setTorrentLimits', 'setDownloadLimits',
  // Link downloads
  'pauseDownload', 'resumeDownload', 'resumeDownloadAnyway', 'retryDownload', 'removeDownload',
  'allowLanHost', 'refreshDownloadUrl',
  // Feeds: "Check now" adds torrents
  'runFeedCheckNow',
];
export const READ_METHODS: readonly string[] = [
  'shutdown', 'restartEngine', 'cancelResolve', 'getResolveActivity', 'listTorrents', 'getDetail', 'fileHealth', 'exportTorrent',
  'shareExportedTorrent', 'getFreeSpace', 'applyConfig', 'getEffectiveConfig', 'exportDebugLog', 'shareDebugLog', 'getPieceBitfield', 'streamUrl',
  'version', 'pickDownloadFolder', 'pickFolder', 'getPlaybackSupport', 'getStorageStatus', 'openFile', 'shareFile',
  'openFolder', 'openDownloadFolder', 'openDownload', 'shareDownload', 'getActiveBlocks', 'getNetworkState',
  'openStream', 'setSchedule', 'getScheduleStatus', 'setFeedAutomation', 'getFeedAutomationStatus', 'setGovernance',
];
const RESTART_ON_NOT_INITIALIZED: ReadonlySet<string> = new Set(USER_ACTION_METHODS);

export class MaglevEngineBridge implements MaglevEngineApi {
  private impl: MaglevEngineApi | null = null;
  private usingNative = false;
  private status: EngineStatus = { kind: 'starting', message: 'Starting…' };
  private started = false;
  private startPromise: Promise<EngineStatus> | null = null;
  /** Set by expectStart(): a start is about to be requested. Calls wait for it. Settled when start() is called. */
  private startExpected: { promise: Promise<void>; release: () => void } | null = null;
  /** How long a call waits for a start that is in flight or expected (the 15 s safety net of app/_layout.tsx). */
  public static startWaitMs = 15_000;
  private lastConfig: NativeConfig | null = null;
  private restartNeeded = false;
  private warning: string | null = null;
  private lastSettings: MaglevSettings | null = null;
  private stateListeners = new Set<StateListener>();

  private telemetryListeners = new Set<(e: TelemetryEvent) => void>();
  private completedListeners = new Set<(e: TorrentCompletedEvent) => void>();
  private actionListeners = new Set<(e: NotificationActionEvent) => void>();
  private storageListeners = new Set<(e: StorageStatus) => void>();
  private blocksListeners = new Set<(blocks: ActiveBlock[]) => void>();
  private detach: Unsubscribe[] = [];

  // ---- state surface for the UI ------------------------------------------------

  public get engineStatus(): EngineStatus {
    return this.status;
  }

  /** True when a changed setting (port, dht, upnp, proxy) only applies after an app restart. */
  public get restartRequired(): boolean {
    return this.restartNeeded;
  }

  /** True when the real native engine is serving calls. False for the simulator or when unavailable. */
  public isNativeMode(): boolean {
    return this.usingNative;
  }

  /** Set when init fell back to the last persisted or default config because the supplied one was invalid. */
  public get configWarning(): string | null {
    return this.warning;
  }

  public subscribeState(listener: StateListener): Unsubscribe {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  private setState(patch: { status?: EngineStatus; restartNeeded?: boolean }): void {
    if (patch.status) this.status = patch.status;
    if (patch.restartNeeded !== undefined) this.restartNeeded = patch.restartNeeded;
    this.stateListeners.forEach((l) => l());
  }

  // ---- lifecycle ---------------------------------------------------------------

  /**
   * Starts the engine with the persisted settings and pushes governance and limits.
   * Idempotent: later calls return the first outcome.
   */
  public start(settings: MaglevSettings): Promise<EngineStatus> {
    this.lastSettings = settings;
    this.startExpected?.release();
    if (!this.startPromise) {
      this.startPromise = (async () => {
        const config = toNativeConfig(settings);
        const res = await this.init(config);
        if (res.ok) {
          await this.pushGovernanceAndLimits(settings, config);
          // Settings may have changed while init was in flight.
          if (this.lastSettings && this.lastSettings !== settings) await this.applySettings(this.lastSettings);
        } else {
          this.startPromise = null; // allow a retry after failure
        }
        return this.status;
      })();
    }
    return this.startPromise;
  }

  /**
   * Tells the bridge a start() is coming (the provider defers it one frame after the first paint, and child
   * screens mount before it). Engine calls made meanwhile wait for that start instead of failing with
   * "Engine not started", for at most `startWaitMs`. Without this (or a start) calls still fail fast.
   */
  public expectStart(): void {
    if (this.started || this.startPromise || this.startExpected) return;
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.startExpected = { promise, release };
  }

  /** Waits for an in-flight or expected start, up to `startWaitMs`. Returns at once when there is none. */
  private async awaitStart(): Promise<void> {
    if (this.usingNative || this.impl) return;
    const gate = this.startPromise ?? this.startExpected?.promise ?? null;
    if (!gate) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, MaglevEngineBridge.startWaitMs);
    });
    const settled = (async () => {
      await gate;
      if (this.startPromise) await this.startPromise;
    })().catch(() => {});
    await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
  }

  /** Re-attempts engine start with the latest settings after a failure. No-op while ready. */
  public async retry(settings?: MaglevSettings): Promise<EngineStatus> {
    if (this.started) return this.status;
    this.startPromise = null;
    this.setState({ status: { kind: 'starting', message: 'Starting…' } });
    const s = settings ?? this.lastSettings;
    if (!s) return this.status;
    return this.start(s);
  }

  /** Re-applies settings after a change: config, governance and global limits. */
  public async applySettings(settings: MaglevSettings): Promise<void> {
    this.lastSettings = settings;
    if (!this.started) return;
    const config = toNativeConfig(settings);
    const prev = this.lastConfig;
    const res = await this.applyConfig(config);
    if (res.ok && (res.restartRequired || (prev && restartReasons(prev, config).length > 0))) {
      this.setState({ restartNeeded: true });
    }
    await this.pushGovernanceAndLimits(settings, config);
  }

  private async pushGovernanceAndLimits(settings: MaglevSettings, config: NativeConfig): Promise<void> {
    await this.setGovernance(toGovernance(settings));
    await this.setGlobalLimits(config.download_limit_bps, config.upload_limit_bps);
  }

  public async init(config: NativeConfig): Promise<EngineResult> {
    this.lastConfig = config;
    if (NativeModule) {
      const res = await this.callNative<EngineResult>('init', config);
      if (res.ok) {
        const w = (res as { configWarning?: unknown }).configWarning;
        this.warning = typeof w === 'string' && w ? w : null;
        this.bind(null, true);
        return this.markReady('Native engine running.', false);
      }
      if (res.code !== 'ENGINE_UNAVAILABLE') {
        this.setState({ status: { kind: 'unavailable', message: res.message, code: res.code } });
        return res;
      }
      return this.fallbackOrFail(res.message, config);
    }
    return this.fallbackOrFail("The downloader isn't installed in this build.", config);
  }

  private async fallbackOrFail(reason: string, config: NativeConfig): Promise<EngineResult> {
    const sim = simulatorIfAllowed();
    if (sim) {
      console.warn(`[Maglev] ${reason} Falling back to the simulator engine.`);
      this.bind(sim, false);
      await sim.init(config);
      return this.markReady('Simulator engine (no real transfers).', true);
    }
    this.impl = null;
    this.setState({ status: { kind: 'unavailable', message: reason } });
    return unavailable(reason);
  }

  private markReady(message: string, simulated: boolean): EngineResult {
    this.started = true;
    this.setState({ status: { kind: 'ready', message, simulated } });
    return { ok: true };
  }

  /** Selects the implementation and (re)wires events once. */
  private bind(sim: MaglevEngineApi | null, native: boolean): void {
    this.detach.forEach((d) => d());
    this.detach = [];
    this.usingNative = native;
    if (native) {
      this.impl = null; // native calls go through callNative
      // `camelize` is false only for events Kotlin already ran through Json.camelize (EngineHost.kt: onTelemetry).
      const sub = (name: string, fan: (payload: any) => void, camelize = true) => {
        const s = NativeModule.addListener(name, (payload: unknown) => fan(camelize ? camelizeKeys(payload) : payload));
        this.detach.push(() => s.remove());
      };
      sub('onTelemetry', (p) => {
        const torrents: Snapshot[] = Array.isArray(p) ? p : (p?.torrents ?? []);
        const downloads: DownloadSnapshot[] = Array.isArray(p?.downloads) ? p.downloads : [];
        this.telemetryListeners.forEach((l) => l({ torrents, downloads }));
      }, false);
      sub('onTorrentCompleted', (p) => this.completedListeners.forEach((l) => l(p)));
      sub('onNotificationAction', (p) => this.actionListeners.forEach((l) => l(p)));
      sub('onStorageStatus', (p) => this.storageListeners.forEach((l) => l(p)));
      sub('onBlocksChanged', (p) => {
        const blocks = cleanBlocks(p?.blocks);
        this.blocksListeners.forEach((l) => l(blocks));
      });
    } else {
      if (!sim) return;
      this.impl = sim;
      this.detach.push(
        sim.onTelemetry((e) => this.telemetryListeners.forEach((l) => l(e))),
        sim.onTorrentCompleted((e) => this.completedListeners.forEach((l) => l(e))),
        sim.onNotificationAction((e) => this.actionListeners.forEach((l) => l(e))),
        sim.onStorageStatus((e) => this.storageListeners.forEach((l) => l(e))),
        sim.addBlocksListener((b) => this.blocksListeners.forEach((l) => l(b)))
      );
    }
  }

  // ---- dispatch ----------------------------------------------------------------

  private async callNative<T>(method: string, ...args: unknown[]): Promise<T> {
    try {
      const fn = NativeModule?.[method];
      if (typeof fn !== 'function') {
        return unavailable(`Native method "${method}" is missing.`) as T;
      }
      const raw = await fn.apply(NativeModule, args);
      return camelizeKeys<T>(raw);
    } catch (e: any) {
      // Expo rejections carry a code such as NO_APP. Keep it when it looks like an engine code.
      const code = typeof e?.code === 'string' && /^[A-Z][A-Z_]+$/.test(e.code) ? e.code : 'INTERNAL';
      return { ok: false, code, message: String(e?.message ?? e) } as T;
    }
  }

  /** One shared restart of the native engine after it was stopped behind the bridge's back. */
  private restartPromise: Promise<EngineResult> | null = null;

  /**
   * The engine can be stopped natively (notification "Shut down", auto-exit) while this JS runtime survives.
   * Starts it again with the last config. Kotlin init is idempotent. Parallel callers share one attempt.
   */
  private restartNative(config: NativeConfig): Promise<EngineResult> {
    if (!this.restartPromise) {
      this.restartPromise = (async () => {
        const res = await this.callNative<EngineResult>('init', config);
        if (!res.ok) return res; // The caller shows the reason with a "Start the downloader" action; screens stay where they are.
        this.setState({ status: { kind: 'ready', message: 'Native engine running.', simulated: false } });
        if (this.lastSettings) await this.pushGovernanceAndLimits(this.lastSettings, config);
        return res;
      })().finally(() => {
        this.restartPromise = null;
      });
    }
    return this.restartPromise;
  }

  /**
   * NATIVE_CONTRACT 39.3 E1: A native call. Only methods in RESTART_ON_NOT_INITIALIZED (user-initiated changes) restart the engine once, and
   * retry once, when it answers NOT_INITIALIZED. Reads and polling return the failure as it is.
   */
  private async callNativeRecovering<T>(method: string, ...args: unknown[]): Promise<T> {
    const first = await this.callNative<T>(method, ...args);
    const r = first as unknown as { ok?: boolean; code?: string };
    // NATIVE_CONTRACT 39.3 E1: reads and polling (anything not in USER_ACTION_METHODS) return the failure as it is.
    if (r?.ok !== false || r.code !== 'NOT_INITIALIZED' || !RESTART_ON_NOT_INITIALIZED.has(method) || !this.lastConfig) {
      return first;
    }
    // NATIVE_CONTRACT 39.3 E1: one shared restart (single flight), then one retry below.
    const restarted = await this.restartNative(this.lastConfig);
    // `engineStopped` tells the UI to offer "Start engine" with the real reason in `message`.
    if (!restarted.ok) return { ...restarted, engineStopped: true } as unknown as T;
    return this.callNative<T>(method, ...args);
  }

  /**
   * The "Start engine" button. Restarts the native engine with the last config (or starts it, when it never
   * came up). Resolves ok when the engine runs; otherwise the failure carries the real reason.
   */
  public async restart(settings?: MaglevSettings): Promise<EngineResult> {
    if (this.usingNative && this.lastConfig) return this.restartNative(this.lastConfig);
    const st = await this.retry(settings);
    return st.kind === 'ready' ? { ok: true } : unavailable(st.message);
  }

  /** Routes to native or simulator. Before a successful start, returns a typed failure. */
  private async route<T>(method: keyof MaglevEngineApi, ...args: unknown[]): Promise<T> {
    if (!this.usingNative && !this.impl) await this.awaitStart();
    if (this.usingNative) return this.callNativeRecovering<T>(method, ...args);
    if (this.impl) {
      try {
        return await (this.impl[method] as (...a: unknown[]) => Promise<T>)(...args);
      } catch (e: any) {
        return { ok: false, code: 'INTERNAL', message: String(e?.message ?? e) } as T;
      }
    }
    return (this.startPromise === null && this.status.kind === 'starting'
      ? unavailable('The downloader is not running.', 'NOT_INITIALIZED')
      : unavailable(this.status.message)) as T;
  }

  // ---- MaglevEngineApi ---------------------------------------------------------

  public shutdown(): Promise<EngineResult> {
    return this.route('shutdown');
  }
  public resolveMetadata(source: string, timeoutMs: number): Promise<EngineResult<Metadata>> {
    return this.route('resolveMetadata', source, timeoutMs);
  }
  public getResolveActivity(infoHash: string): Promise<EngineResult<ResolveActivity>> {
    return this.route('getResolveActivity', infoHash);
  }
  public cancelResolve(infoHash: string): Promise<EngineResult> {
    return this.route('cancelResolve', infoHash);
  }
  public addTorrent(source: string, options: AddTorrentOptions = {}) {
    // The module forwards options to Rust as JSON, so they keep the contract's snake_case keys.
    const wire = this.usingNative ? snakeizeKeys(options) : options;
    return this.route<EngineResult<{ id: string; infoHash: string }>>('addTorrent', source, wire);
  }
  public listTorrents() {
    return this.route<EngineResult<{ torrents: Snapshot[]; downloads?: DownloadSnapshot[] }>>('listTorrents');
  }
  public getDetail(id: string): Promise<EngineResult<Detail>> {
    return this.route('getDetail', id);
  }
  public pause(id: string): Promise<EngineResult> {
    return this.route('pause', id);
  }
  public resume(id: string): Promise<EngineResult> {
    return this.route('resume', id);
  }
  public resumeAnyway(id: string): Promise<EngineResult> {
    return this.route('resumeAnyway', id);
  }
  public recheck(id: string): Promise<EngineResult> {
    return this.route('recheck', id);
  }
  public pauseAll(): Promise<EngineResult> {
    return this.route('pauseAll');
  }
  public resumeAll(): Promise<EngineResult> {
    return this.route('resumeAll');
  }
  public delete(id: string, deleteFiles: boolean): Promise<EngineResult> {
    return this.route('delete', id, deleteFiles);
  }
  public setIncludedFiles(id: string, indices: number[]): Promise<EngineResult> {
    return this.route('setIncludedFiles', id, indices);
  }
  public setFilePriorities(id: string, priorities: FilePriorityEntry[]): Promise<EngineResult> {
    return this.route('setFilePriorities', id, priorities);
  }
  public removeFiles(id: string, indices: number[]): Promise<EngineResult<{ freedBytes: number }>> {
    return this.route('removeFiles', id, indices);
  }
  public setHealth(id: string, tag: HealthTag | ''): Promise<EngineResult> {
    return this.route('setHealth', id, tag);
  }
  public scanFileHealth(): Promise<EngineResult<{ changed: number }>> {
    return this.route('scanFileHealth');
  }
  public fileHealth(id: string): Promise<EngineResult<{ files: FileHealthEntry[] }>> {
    return this.route('fileHealth', id);
  }
  public resolveFiles(id: string, action: ResolveFilesAction, indices: number[], dir: string): Promise<EngineResult> {
    return this.route('resolveFiles', id, action, indices, dir);
  }
  public reannounce(id: string): Promise<EngineResult<{ retryAfterSecs?: number }>> {
    return this.route('reannounce', id);
  }
  public addTrackers(id: string, urls: string[]): Promise<EngineResult<TrackersAdded>> {
    return this.route('addTrackers', id, urls);
  }
  public removeTracker(id: string, url: string): Promise<EngineResult<{ announced: boolean }>> {
    return this.route('removeTracker', id, url);
  }
  public exportTorrent(id: string): Promise<EngineResult<TorrentExport>> {
    return this.route('exportTorrent', id);
  }
  public shareExportedTorrent(path: string): Promise<EngineResult> {
    return this.route('shareExportedTorrent', path);
  }
  public getFreeSpace(): Promise<EngineResult<FreeSpace>> {
    return this.route('getFreeSpace');
  }
  public async openLiveUpdateSettings(): Promise<void> {
    if (this.usingNative) await this.callNative('openLiveUpdateSettings');
  }
  public async openNotificationSettings(channel: 'completed' = 'completed'): Promise<void> {
    if (this.usingNative) await this.callNative('openNotificationSettings', channel);
  }
  public setGlobalLimits(down: number, up: number): Promise<EngineResult> {
    return this.route('setGlobalLimits', down, up);
  }
  public async applyConfig(config: NativeConfig): Promise<EngineResult<{ restartRequired: boolean }>> {
    this.lastConfig = config;
    return this.route('applyConfig', config);
  }
  public async getEffectiveConfig(): Promise<EngineResult<EffectiveConfig>> {
    const res = await this.route<EngineResult<EffectiveConfig>>('getEffectiveConfig');
    // The contract defines NativeConfig in snake_case; accept either casing from the module.
    return res.ok ? toEffectiveConfig(snakeizeKeys<Record<string, unknown>>(res)) : res;
  }
  public exportDebugLog(): Promise<EngineResult<{ uri: string }>> {
    return this.route('exportDebugLog');
  }
  public shareDebugLog(uri: string): Promise<EngineResult> {
    return this.route('shareDebugLog', uri);
  }
  public restartEngine(): Promise<EngineResult> {
    return this.route('restartEngine');
  }
  public async getPieceBitfield(id: string): Promise<number[]> {
    const res = await this.route<number[] | EngineResult>('getPieceBitfield', id);
    return Array.isArray(res) ? res : [];
  }
  public streamUrl(id: string, fileIndex: number): Promise<EngineResult<{ url: string; mime: string }>> {
    return this.route('streamUrl', id, fileIndex);
  }
  public async version(): Promise<{ engine: string; version: string }> {
    const res = await this.route<{ engine?: string; version?: string }>('version');
    return { engine: res?.engine ?? 'unavailable', version: res?.version ?? '' };
  }
  public async pickDownloadFolder(): Promise<PickFolderResult> {
    const res = await this.route<any>('pickDownloadFolder');
    if (res && res.ok === false) return { cancelled: true };
    return res;
  }
  public async pickFolder(): Promise<PickFolderResult> {
    const res = await this.route<any>('pickFolder');
    if (res && res.ok === false) return { cancelled: true };
    return res;
  }
  public async getPlaybackSupport(): Promise<PlaybackSupport> {
    const unknown: PlaybackSupport = {
      avc: 'unknown', hevc: 'unknown', hevc10: 'unknown', av1: 'unknown', av1_10: 'unknown',
      vp9: 'unknown', dolbyVision: 'unknown', hdr10: null, hdr10plus: null, hlg: null,
    };
    try {
      const res = await this.route<any>('getPlaybackSupport');
      return res && typeof res.avc === 'string' ? { ...unknown, ...res } : unknown;
    } catch {
      return unknown;
    }
  }
  public async getStorageStatus(): Promise<StorageStatus> {
    const res = await this.route<any>('getStorageStatus');
    return res && res.ok !== false ? res : { path: '', fallback: false, safLost: false };
  }
  public openFile(id: string, fileIndex: number): Promise<EngineResult> {
    return this.route('openFile', id, fileIndex);
  }
  public shareFile(id: string, fileIndex: number): Promise<EngineResult> {
    return this.route('shareFile', id, fileIndex);
  }
  public openFolder(id: string): Promise<EngineResult> {
    return this.route('openFolder', id);
  }
  public openDownloadFolder(id: string): Promise<EngineResult> {
    return this.route('openDownloadFolder', id);
  }
  // URL downloads (NATIVE_CONTRACT 17). The module snake_cases option keys for Rust itself.
  public probeUrl(url: string, options: DownloadOptions = {}, timeoutMs = 15_000): Promise<EngineResult<UrlProbe>> {
    return this.route('probeUrl', url, options, timeoutMs);
  }
  public probeStream(url: string, options: DownloadOptions = {}, timeoutMs = 15_000): Promise<EngineResult<StreamProbe>> {
    return this.route('probeStream', url, options, timeoutMs);
  }
  public addDownload(url: string, options: DownloadOptions = {}): Promise<EngineResult<{ id: string }>> {
    return this.route('addDownload', url, options);
  }
  public pauseDownload(id: string): Promise<EngineResult> {
    return this.route('pauseDownload', id);
  }
  public resumeDownload(id: string): Promise<EngineResult> {
    return this.route('resumeDownload', id);
  }
  public resumeDownloadAnyway(id: string): Promise<EngineResult> {
    return this.route('resumeDownloadAnyway', id);
  }
  public retryDownload(id: string): Promise<EngineResult> {
    return this.route('retryDownload', id);
  }
  public removeDownload(id: string, deleteFiles: boolean): Promise<EngineResult> {
    return this.route('removeDownload', id, deleteFiles);
  }
  public allowLanHost(id: string): Promise<EngineResult> {
    return this.route('allowLanHost', id);
  }
  public openDownload(id: string): Promise<EngineResult> {
    return this.route('openDownload', id);
  }
  public shareDownload(id: string): Promise<EngineResult> {
    return this.route('shareDownload', id);
  }
  /** NATIVE_CONTRACT 35. Never throws: any failure is an empty list. Unknown tags are dropped. */
  public async getActiveBlocks(): Promise<ActiveBlock[]> {
    try {
      const raw = await this.route<unknown>('getActiveBlocks');
      return cleanBlocks(raw);
    } catch {
      return [];
    }
  }
  public addBlocksListener(listener: (blocks: ActiveBlock[]) => void): () => void {
    this.blocksListeners.add(listener);
    return () => {
      this.blocksListeners.delete(listener);
    };
  }
  public getNetworkState(): Promise<EngineResult<NetworkState>> {
    return this.route('getNetworkState');
  }
  public refreshDownloadUrl(id: string, url: string, options: DownloadOptions = {}): Promise<EngineResult> {
    return this.route('refreshDownloadUrl', id, url, options);
  }
  public setDownloadLimits(id: string, limits: { downLimitBps: number }): Promise<EngineResult> {
    return this.route('setDownloadLimits', id, limits);
  }
  public setTorrentLimits(id: string, limits: TorrentLimits): Promise<EngineResult> {
    return this.route('setTorrentLimits', id, limits);
  }
  public moveStorage(id: string, target: MoveTarget): Promise<EngineResult> {
    return this.route('moveStorage', id, target);
  }
  public openStream(url: string, mime: string, title: string): Promise<EngineResult> {
    return this.route('openStream', url, mime, title);
  }
  public setSchedule(config: ScheduleConfig): Promise<EngineResult> {
    return this.route('setSchedule', config);
  }
  public async getScheduleStatus(): Promise<ScheduleStatus> {
    const res = await this.route<ScheduleStatus | EngineResult>('getScheduleStatus');
    return res && (res as { ok?: boolean }).ok !== false
      ? (res as ScheduleStatus)
      : { enabled: false, paused: false, activeRuleIds: [], nextBoundary: null };
  }
  public setFeedAutomation(config: FeedAutomationConfig): Promise<EngineResult> {
    return this.route('setFeedAutomation', config);
  }
  public async getFeedAutomationStatus(): Promise<FeedAutomationStatus> {
    const res = await this.route<FeedAutomationStatus | EngineResult>('getFeedAutomationStatus');
    return res && (res as { ok?: boolean }).ok !== false
      ? (res as FeedAutomationStatus)
      : { lastRunAt: null, lastError: null, addedTotal: 0, pending: 0 };
  }
  public runFeedCheckNow(): Promise<EngineResult> {
    return this.route('runFeedCheckNow');
  }
  public async getPermissionStatus(): Promise<NativePermissionStatus> {
    if (this.usingNative) {
      const res = await this.callNative<any>('getPermissionStatus');
      if (res && res.ok !== false) return res;
    }
    return { notifications: 'granted', batteryUnrestricted: true, legacyStorage: 'n/a', liveUpdates: 'n/a' };
  }
  public requestNotifications(): Promise<EngineResult> {
    return this.permissionCall('requestNotifications');
  }
  public async openBatterySettings(): Promise<void> {
    if (this.usingNative) await this.callNative('openBatterySettings');
  }
  public async getAppIcon(): Promise<string> {
    if (this.usingNative) {
      const res = await this.callNative<{ ok?: boolean; id?: string }>('getAppIcon');
      return res && res.ok !== false && typeof res.id === 'string' ? res.id : 'teal';
    }
    return this.impl ? this.impl.getAppIcon() : 'teal';
  }
  public async setAppIcon(id: string): Promise<EngineResult> {
    if (this.usingNative) return this.callNative<EngineResult>('setAppIcon', id);
    return this.impl ? this.impl.setAppIcon(id) : { ok: true };
  }
  public requestLegacyStorage(): Promise<EngineResult> {
    return this.permissionCall('requestLegacyStorage');
  }

  // ---- in-app updates (NATIVE_CONTRACT 27) ---------------------------------------
  // These talk to the native module directly (no engine start needed). Without it, only the dev simulator
  // answers, and it refuses to download or install.

  private updateCall<T>(method: string, ...args: unknown[]): Promise<T> {
    if (NativeModule) return this.callNative<T>(method, ...args);
    const sim = simulatorIfAllowed();
    if (!sim) return Promise.resolve(unavailable("The downloader isn't installed in this build.") as T);
    return (sim as unknown as Record<string, (...a: unknown[]) => Promise<T>>)[method](...args);
  }
  // ---- subtitles (NATIVE_CONTRACT 36.6) -------------------------------------------
  // Unlike the calls above these reject with an Error whose `code` is a SubtitleErrorCode.

  private async subtitleCall<T>(method: 'subtitleHash' | 'saveSubtitle' | 'unzipSubtitles', ...args: unknown[]): Promise<T> {
    if (NativeModule) {
      const fn = NativeModule[method];
      if (typeof fn !== 'function') throw subtitleError('UNSUPPORTED', `Native method "${method}" is missing.`);
      try {
        return (await fn.apply(NativeModule, args)) as T;
      } catch (e: any) {
        const known = typeof e?.code === 'string' && /^[A-Z][A-Z_]+$/.test(e.code);
        throw subtitleError(known ? e.code : 'IO', String(e?.message ?? e));
      }
    }
    const sim = simulatorIfAllowed();
    if (!sim) throw subtitleError('UNSUPPORTED', "The downloader isn't installed in this build.");
    return (sim[method] as (...a: unknown[]) => Promise<T>).apply(sim, args);
  }
  public subtitleHash(pathOrUri: string): Promise<SubtitleHashResult> {
    return this.subtitleCall('subtitleHash', pathOrUri);
  }
  public saveSubtitle(videoPathOrUri: string, fileName: string, base64: string, replace: boolean): Promise<SubtitleSaveResult> {
    return this.subtitleCall('saveSubtitle', videoPathOrUri, fileName, base64, replace);
  }
  public unzipSubtitles(base64: string): Promise<SubtitleZipEntry[]> {
    return this.subtitleCall('unzipSubtitles', base64);
  }

  public async getInstallSource(): Promise<InstallSource> {
    const res = await this.updateCall<Partial<InstallSource> & { ok?: boolean }>('getInstallSource');
    if (res && res.ok !== false) {
      return { installer: res.installer ?? null, managedBy: res.managedBy ?? null, versionCode: res.versionCode ?? null };
    }
    return { installer: null, managedBy: null, versionCode: null };
  }
  public downloadUpdate(url: string, sha256: string, size: number, requireVpn: boolean): Promise<EngineResult<{ path: string }>> {
    return this.updateCall('downloadUpdate', url, sha256, size, requireVpn);
  }
  public getUpdateNetwork(): Promise<EngineResult<UpdateNetwork>> {
    return this.updateCall('getUpdateNetwork');
  }
  /** NATIVE_CONTRACT 31.1. False when the native module is missing: an unverified list is never applied. */
  public async verifyListSignature(body: string, sigB64: string): Promise<boolean> {
    if (!NativeModule) return false;
    try {
      return (await this.callNative<boolean>('verifyListSignature', body, sigB64)) === true;
    } catch {
      return false;
    }
  }
  public cancelUpdateDownload(): Promise<EngineResult> {
    return this.updateCall('cancelUpdateDownload');
  }
  public installUpdate(path: string, silent: boolean, sha256: string): Promise<EngineResult<{ status: 'started' | 'needs_permission' | 'needs_user' }>> {
    return this.updateCall('installUpdate', path, silent, sha256);
  }
  public openInstallPermissionSettings(): Promise<EngineResult> {
    return this.updateCall('openInstallPermissionSettings');
  }
  public cleanupUpdates(keepPath: string | null, keepSha: string | null = null): Promise<EngineResult> {
    return this.updateCall('cleanupUpdates', keepPath, keepSha);
  }
  public postUpdateNotice(kind: 'available' | 'ready', version: string, path: string | null = null, sha256: string | null = null): Promise<EngineResult> {
    return this.updateCall('postUpdateNotice', kind, version, path, sha256);
  }
  public clearUpdateNotice(kind: 'available' | 'ready'): Promise<EngineResult> {
    return this.updateCall('clearUpdateNotice', kind);
  }
  public onUpdateProgress(listener: (e: UpdateProgressEvent) => void): Unsubscribe {
    if (!NativeModule) return () => {};
    const sub = NativeModule.addListener('onUpdateProgress', (p: unknown) => listener(camelizeKeys<UpdateProgressEvent>(p)));
    return () => sub.remove();
  }
  public onUpdateResult(listener: (e: UpdateResultEvent) => void): Unsubscribe {
    if (!NativeModule) return () => {};
    const sub = NativeModule.addListener('onUpdateResult', (p: unknown) => listener(camelizeKeys<UpdateResultEvent>(p)));
    return () => sub.remove();
  }
  private async permissionCall(method: string): Promise<EngineResult> {
    if (!this.usingNative) return { ok: true };
    const res = await this.callNative<any>(method);
    return res && res.ok === false ? res : { ok: true };
  }
  public setGovernance(config: GovernanceConfig): Promise<EngineResult> {
    return this.route('setGovernance', config);
  }

  // ---- events (stable across engine selection) ---------------------------------

  public onTelemetry(listener: (e: TelemetryEvent) => void): Unsubscribe {
    this.telemetryListeners.add(listener);
    return () => {
      this.telemetryListeners.delete(listener);
    };
  }
  public onTorrentCompleted(listener: (e: TorrentCompletedEvent) => void): Unsubscribe {
    this.completedListeners.add(listener);
    return () => {
      this.completedListeners.delete(listener);
    };
  }
  public onNotificationAction(listener: (e: NotificationActionEvent) => void): Unsubscribe {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  }
  public onStorageStatus(listener: (e: StorageStatus) => void): Unsubscribe {
    this.storageListeners.add(listener);
    return () => {
      this.storageListeners.delete(listener);
    };
  }

  /**
   * Parses a PeerGuardian/eMule .dat for the rule count and, on device, writes it to app storage so the
   * engine can load it through `NativeConfig.ip_filter_path` (applied on the next settings push).
   */
  public async loadIpFilterDat(content: string): Promise<number> {
    const count = ipFilter.parseDatContent(content);
    let path = '';
    if (this.usingNative && count > 0) {
      try {
        const { File, Paths } = require('expo-file-system');
        const file = new File(Paths.document, 'maglev-ipfilter.dat');
        file.create({ overwrite: true });
        file.write(content);
        path = String(file.uri).replace(/^file:\/\//, '');
      } catch {
        path = '';
      }
    }
    const net = settingsStore.getSettings().network;
    settingsStore.updateSettings({
      network: { ...net, ipFilterEnabled: count > 0, ipFilterRulesCount: count, ipFilterPath: path },
    });
    return count;
  }

  public get simulatorAllowed(): boolean {
    return SIMULATOR_ALLOWED;
  }
}

export const maglevEngine = new MaglevEngineBridge();
