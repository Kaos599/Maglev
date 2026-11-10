import type {
  AggregatedTelemetry,
  PieceMatrix,
  TorrentDetailData,
  TorrentFileInfo,
  TorrentTelemetry,
  TrackerInfo,
} from './MaglevEngine.types.ts';
import {
  DEFAULT_SETTINGS,
  type MaglevSettings,
  SPEED_PRESET_MAP,
} from './MaglevSettings.types.ts';
import { ipFilter } from './MaglevIpFilter.ts';
import { settingsStore } from './MaglevSettingsStore.ts';

type Listener = (telemetry: AggregatedTelemetry) => void;

export class MaglevMockEngine {
  private torrents: Map<string, TorrentDetailData> = new Map();
  private pieceMatrices: Map<string, Uint8Array> = new Map();
  private listeners: Set<Listener> = new Set();
  private timer: any = null;
  private defaultStoragePath = '/storage/emulated/0/Android/data/com.maglev/files/Download';

  // System & Governance state
  private settings: MaglevSettings;
  private wakeLockHeld: boolean = false;
  private socketsClamped: boolean = false;
  private shutdownTriggered: boolean = false;

  constructor() {
    this.settings = JSON.parse(JSON.stringify(settingsStore.getSettings()));
    // Starts with 0 torrents. Clean empty transfer list by default.
    this.recalculateGovernance();
    this.broadcast();

    // Subscribe to settings changes
    settingsStore.subscribe((newSettings) => {
      this.applySettings(newSettings);
    });
  }

  /**
   * Explicit test/demo helper to seed sample torrents.
   * Not called in production so the user begins with a clean empty state.
   */
  public seedMockTorrents(): void {
    this.seedInitialMockData();
    this.recalculateGovernance();
    this.broadcast();
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

  public startTorrent(
    magnetUri: string,
    savePathOverride?: string,
    sequential: boolean = false,
    selectedFileIndices?: number[]
  ): string {
    const id = this.extractHashOrGenerate(magnetUri);
    // Concurrency guard: return existing session if already registered
    if (this.torrents.has(id)) {
      return id;
    }
    const name = this.extractName(magnetUri) || 'Ubuntu-24.04-desktop-amd64.iso';
    const totalSize = 4_294_967_296; // 4.0 GB

    const isPrimaryActive = !selectedFileIndices || selectedFileIndices.includes(0);
    const isShaActive = !selectedFileIndices || selectedFileIndices.includes(1);
    const isNotesActive = !selectedFileIndices || selectedFileIndices.includes(2);

    const files: TorrentFileInfo[] = [
      {
        index: 0,
        name: `${name}`,
        path: `${name}`,
        length: totalSize,
        progress: 0,
        priority: (isPrimaryActive ? 1 : 0) as 0 | 1 | 2,
      },
      {
        index: 1,
        name: `${name}.sha256`,
        path: `${name}.sha256`,
        length: 1024,
        progress: 0,
        priority: (isShaActive ? 1 : 0) as 0 | 1 | 2,
      },
      {
        index: 2,
        name: 'release-notes.txt',
        path: 'release-notes.txt',
        length: 4096,
        progress: 0,
        priority: (isNotesActive ? 1 : 0) as 0 | 1 | 2,
      },
    ];

    const trackers: TrackerInfo[] = [
      {
        url: 'udp://tracker.opentrackr.org:1337/announce',
        status: 'Working',
        seeds: 42,
        peers: 86,
      },
      {
        url: 'udp://open.stealth.si:80/announce',
        status: 'Working',
        seeds: 19,
        peers: 31,
      },
    ];

    const effectiveSavePath =
      savePathOverride ||
      (this.settings.storage.storageMode === 'SAF' && this.settings.storage.customSafPath
        ? this.settings.storage.customSafPath
        : this.settings.storage.defaultPath);

    const effDown = this.getEffectiveDownloadLimit();
    const effUp = this.getEffectiveUploadLimit();
    const baseDownSpeed = effDown > 0 ? effDown : 14_800_000;
    const baseUpSpeed = effUp > 0 ? effUp : 1_200_000;

    const newTorrent: TorrentDetailData = {
      id,
      name,
      state: 'DOWNLOADING',
      downloadSpeedBytes: baseDownSpeed,
      uploadSpeedBytes: baseUpSpeed,
      progressPercent: 0,
      downloadedBytes: 0,
      uploadedBytes: 0,
      totalSizeBytes: totalSize,
      etaSeconds: Math.floor(totalSize / baseDownSpeed),
      peersConnected: 28,
      peersTotal: Math.min(40, this.settings.bandwidth.maxConnectionsPerTorrent),
      seedsConnected: 12,
      ratio: 0.0,
      sequential,
      seedDurationSeconds: 0,
      savePath: effectiveSavePath,
      piecesTotal: 256,
      piecesVerified: 0,
      files,
      trackers,
    };

    const matrix = new Uint8Array(256);
    this.pieceMatrices.set(id, matrix);
    this.torrents.set(id, newTorrent);
    this.recalculateGovernance();
    this.broadcast();
    return id;
  }

  public pauseTorrent(id: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    t.state = 'PAUSED';
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

  public pauseAll(): void {
    this.torrents.forEach((t) => {
      t.state = 'PAUSED';
      t.downloadSpeedBytes = 0;
      t.uploadSpeedBytes = 0;
    });
    this.recalculateGovernance();
    this.broadcast();
  }

  public resumeAll(): void {
    const effDown = this.getEffectiveDownloadLimit();
    const effUp = this.getEffectiveUploadLimit();
    this.torrents.forEach((t) => {
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
  }

  public deleteTorrent(id: string, _deleteFiles: boolean = false): boolean {
    const removed = this.torrents.delete(id);
    this.pieceMatrices.delete(id);
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

  public getPieceBitfield(id: string): Uint8Array {
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

  public addTracker(id: string, trackerUrl: string): boolean {
    const t = this.torrents.get(id);
    if (!t) return false;
    t.trackers.push({
      url: trackerUrl,
      status: 'Announcing',
      seeds: 0,
      peers: 0,
    });
    return true;
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
    // Strict SLA: 500ms cadence
    this.timer = setInterval(() => {
      this.stepSimulation();
      this.broadcast();
    }, 500);
  }

  public stepSimulation(): void {
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
      const matrix = this.getPieceBitfield(t.id);
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
        t.uploadSpeedBytes = 0;
        t.downloadSpeedBytes = 0;
      }
    });
  }

  private broadcast(): void {
    const payload = this.getAggregatedTelemetry();
    this.listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch (e) {
        // Ignore listener error
      }
    });
  }

  private extractHashOrGenerate(magnet: string): string {
    const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : `mg_${Date.now().toString(16)}`;
  }

  private extractName(magnet: string): string | null {
    const match = magnet.match(/dn=([^&]+)/);
    return match ? decodeURIComponent(match[1].replace(/\+/g, ' ')) : null;
  }

  private seedInitialMockData(): void {
    const id1 = 'card-ubuntu';
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

    const id2 = 'card-blender';
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

    const id3 = 'card-arch';
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

  public async takePersistableSafPermission(uriStr: string): Promise<boolean> {
    return true;
  }

  public isAllFilesAccessGranted(): boolean {
    return true;
  }

  public async requestAllFilesAccess(): Promise<boolean> {
    return true;
  }
}

export const mockEngine = new MaglevMockEngine();
