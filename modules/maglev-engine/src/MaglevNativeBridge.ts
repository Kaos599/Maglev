import { Platform, requireOptionalNativeModule } from 'expo-modules-core';
import type {
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
  HealthTag,
  ResolveFilesAction,
  TorrentExport,
  TrackersAdded,
  GovernanceConfig,
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
} from './MaglevEngine.types.ts';
import type { MaglevSettings } from './MaglevSettings.types.ts';
import { mockEngine } from './MaglevMockEngine.ts';
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
  if (__DEV__ || Platform.OS === 'web') {
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

type StateListener = () => void;

export class MaglevEngineBridge implements MaglevEngineApi {
  private impl: MaglevEngineApi | null = null;
  private usingNative = false;
  private status: EngineStatus = { kind: 'starting', message: 'Starting…' };
  private started = false;
  private startPromise: Promise<EngineStatus> | null = null;
  private lastConfig: NativeConfig | null = null;
  private restartNeeded = false;
  private warning: string | null = null;
  private lastSettings: MaglevSettings | null = null;
  private stateListeners = new Set<StateListener>();

  private telemetryListeners = new Set<(e: TelemetryEvent) => void>();
  private completedListeners = new Set<(e: TorrentCompletedEvent) => void>();
  private actionListeners = new Set<(e: NotificationActionEvent) => void>();
  private storageListeners = new Set<(e: StorageStatus) => void>();
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
        this.setState({ status: { kind: 'unavailable', message: res.message } });
        return res;
      }
      return this.fallbackOrFail(res.message, config);
    }
    return this.fallbackOrFail('The native engine module is not installed in this build.', config);
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
      const sub = (name: string, fan: (payload: any) => void) => {
        const s = NativeModule.addListener(name, (payload: unknown) => fan(camelizeKeys(payload)));
        this.detach.push(() => s.remove());
      };
      sub('onTelemetry', (p) => {
        const torrents: Snapshot[] = Array.isArray(p) ? p : (p?.torrents ?? []);
        const downloads: DownloadSnapshot[] = Array.isArray(p?.downloads) ? p.downloads : [];
        this.telemetryListeners.forEach((l) => l({ torrents, downloads }));
      });
      sub('onTorrentCompleted', (p) => this.completedListeners.forEach((l) => l(p)));
      sub('onNotificationAction', (p) => this.actionListeners.forEach((l) => l(p)));
      sub('onStorageStatus', (p) => this.storageListeners.forEach((l) => l(p)));
    } else {
      if (!sim) return;
      this.impl = sim;
      this.detach.push(
        sim.onTelemetry((e) => this.telemetryListeners.forEach((l) => l(e))),
        sim.onTorrentCompleted((e) => this.completedListeners.forEach((l) => l(e))),
        sim.onNotificationAction((e) => this.actionListeners.forEach((l) => l(e))),
        sim.onStorageStatus((e) => this.storageListeners.forEach((l) => l(e)))
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

  /** Routes to native or simulator. Before a successful start, returns a typed failure. */
  private async route<T>(method: keyof MaglevEngineApi, ...args: unknown[]): Promise<T> {
    if (this.usingNative) return this.callNative<T>(method, ...args);
    if (this.impl) {
      try {
        return await (this.impl[method] as (...a: unknown[]) => Promise<T>)(...args);
      } catch (e: any) {
        return { ok: false, code: 'INTERNAL', message: String(e?.message ?? e) } as T;
      }
    }
    return (this.startPromise === null && this.status.kind === 'starting'
      ? unavailable('Engine not started.', 'NOT_INITIALIZED')
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
  public async getEffectiveConfig(): Promise<EngineResult<NativeConfig>> {
    const res = await this.route<EngineResult<NativeConfig>>('getEffectiveConfig');
    // The contract defines NativeConfig in snake_case; accept either casing from the module.
    return res.ok ? (snakeizeKeys<EngineResult<NativeConfig>>(res)) : res;
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
  public requestLegacyStorage(): Promise<EngineResult> {
    return this.permissionCall('requestLegacyStorage');
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
